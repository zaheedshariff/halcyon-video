import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createIntegrationProxy, createLocalEndpointGuard, isForbiddenProxyAddress, trustedNetworkControlsEnabled } from '../tools/integration-proxy.mjs';

const upstreamCalls: { url: string; key?: string; auth?: string; body: string }[] = [];
let upstream: http.Server, proxy: http.Server, base: string, origin: string;
let responseMode = 'catalog';
const secret = 'SERVER-ONLY-SECRET';
async function listen(server: http.Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
test.before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    upstreamCalls.push({ url: req.url!, key: req.headers['x-api-key'] as string,
      auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (responseMode === 'redirect') { res.writeHead(302, { location: '/secret' }); return res.end(); }
    if (responseMode === 'error') { res.writeHead(401); return res.end(secret + ' private@example.test'); }
    if (responseMode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
    if (responseMode === 'large') { res.writeHead(200, { 'content-length': 9 * 1024 * 1024 }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 1, title: 'Film', email: 'private@example.test', apiKey: secret,
      recoveryLinkExpirationDate: 'secret', requestedBy: { name: 'Private User', email: 'private@example.test' },
      mediaInfo: { status: 2, status4k: 1, serviceUrl: 'http://private-box/', requests: [{ modifiedBy: { email: 'private@example.test' } }] },
      credits: { cast: [{ name: 'Public Actor' }], crew: [{ name: 'Public Director', job: 'Director' }] },
      results: [{ id: 4, media: { tmdbId: 1, mediaType: 'movie', status: 2 }, requestedBy: { email: 'private@example.test' } }] }));
  });
  base = await listen(upstream);
  const middleware = createIntegrationProxy({ jellyseerr: { url: base + '/seerr', apiKey: secret } });
  proxy = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  origin = await listen(proxy);
});
test.after(async () => { await Promise.all([upstream, proxy].map(s => new Promise<void>(r => s.close(() => r())))); });
test.beforeEach(() => { upstreamCalls.length = 0; responseMode = 'catalog'; });
const request = (path: string, init: RequestInit = {}) => fetch(origin + '/dev-proxy', {
  ...init, headers: { 'x-proxy-target': base + '/seerr' + path, ...init.headers },
});

test('anonymous requests cannot trigger downloads or other writes', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = await request('/api/v1/request', { method, body: '{}' });
    assert.equal(r.status, 403); await r.text();
  }
  assert.equal(upstreamCalls.length, 0);
});
test('unconfigured destinations are denied even with supplied credentials', async () => {
  for (const target of ['http://example.test/', 'http://169.254.169.254/latest/meta-data/', base + '/outside', base + '/seerr-other/api/v1/movie/1']) {
    for (const auth of [{}, { 'x-api-key': 'visitor' }]) {
      const r = await request('/api/v1/movie/1', { headers: { 'x-proxy-target': target, ...auth } });
      assert.equal(r.status, 403); await r.text();
    }
  }
  assert.equal(upstreamCalls.length, 0);
});
test('account and administration routes, encoded paths and endpoint lookalikes are denied', async () => {
  for (const path of ['/api/v1/user', '/api/v1/settings/main', '/api/v1/request/4', '/api/v1/movie/1/../../user', '/api/v1/movie/%31', '/api/v1/movie/1/ratings']) {
    const r = await request(path); assert.ok([400, 403].includes(r.status), path); await r.text();
  }
  const r = await fetch(origin + '/dev-proxy-other', { headers: { 'x-proxy-target': base + '/seerr/api/v1/movie/1' } });
  assert.equal(r.status, 404); await r.text(); assert.equal(upstreamCalls.length, 0);
});
test('configured base paths work and catalog responses expose only public fields', async () => {
  const r = await request('/api/v1/movie/1'); assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.title, 'Film'); assert.equal(body.credits.cast[0].name, 'Public Actor');
  assert.deepEqual(body.mediaInfo, { status: 2, status4k: 1 });
  assert.deepEqual(body.results, [{ id: 4, media: { tmdbId: 1, mediaType: 'movie', status: 2 } }]);
  assert.ok(!JSON.stringify(body).includes('private')); assert.ok(!JSON.stringify(body).includes(secret));
  assert.equal(upstreamCalls[0].key, secret); assert.equal(r.headers.get('cache-control'), 'no-store');
});
test('connection checks return status without exposing the administrator identity', async () => {
  const r = await request('/api/v1/auth/me'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
});
test('redirects never forward credentials or bypass the route policy', async () => {
  responseMode = 'redirect'; const r = await request('/api/v1/movie/1'); assert.equal(r.status, 502);
  assert.equal(upstreamCalls.length, 1); assert.ok(!(await r.text()).includes(secret));
});
test('upstream errors retain status but omit response data', async () => {
  responseMode = 'error'; const r = await request('/api/v1/movie/1'); assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'Integration request failed', status: 401 });
});
test('active HTML and oversized upstream content are not served', async () => {
  for (const mode of ['html', 'large']) { responseMode = mode; const r = await request('/api/v1/movie/1'); assert.equal(r.status, 502); await r.text(); }
});
test('a visitor request uses only visitor credentials and returns an acknowledgment', async () => {
  const r = await request('/api/v1/request', { method: 'POST', headers: { 'x-api-key': 'visitor' },
    body: JSON.stringify({ mediaType: 'movie', mediaId: 1, userId: 1, isAutoRequest: true, serverId: 2 }) });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.equal(upstreamCalls[0].key, 'visitor');
  assert.deepEqual(JSON.parse(upstreamCalls[0].body), { mediaType: 'movie', mediaId: 1 });
});
test('invalid credentials cannot fall back to the operator key', async () => {
  responseMode = 'error'; const r = await request('/api/v1/request', { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: '{"mediaType":"movie","mediaId":1}' });
  assert.equal(r.status, 401); await r.text(); assert.equal(upstreamCalls[0].key, 'wrong'); assert.equal(upstreamCalls.length, 1);
});
test('malformed, oversized and cross-site requests do not reach the upstream', async () => {
  const malformed = await request('/api/v1/request', { method: 'POST', headers: { 'x-api-key': 'visitor' }, body: '{bad' });
  assert.equal(malformed.status, 400); await malformed.text();
  const big = await request('/api/v1/request', { method: 'POST', headers: { 'x-api-key': 'visitor' }, body: 'x'.repeat(65537) });
  assert.equal(big.status, 413); await big.text();
  const cross = await request('/api/v1/movie/1', { headers: { origin: 'https://attacker.test' } });
  assert.equal(cross.status, 403); await cross.text(); assert.equal(upstreamCalls.length, 0);
});
test('sensitive local endpoints reject public, forwarded, and cross-site requests', () => {
  const guard = createLocalEndpointGuard({});
  for (const url of ['/__play', '/__play/status', '/__feedback', '/__remote/seed', '/__remote/status', '/__remote/instance']) {
    for (const headers of [{ host: 'public.example' }, { host: 'localhost', 'x-forwarded-host': 'public.example' }, { host: 'localhost', origin: 'https://attacker.test' }]) {
      let next = false; const res = { statusCode: 0, setHeader() {}, end() {} };
      guard({ url, headers, socket: { remoteAddress: '127.0.0.1' } }, res, () => { next = true; });
      assert.equal(next, false); assert.equal(res.statusCode, 403);
    }
  }
  let next = false;
  guard({ url: '/__feedback', headers: { host: 'localhost:1420', origin: 'http://localhost:1420' }, socket: { remoteAddress: '127.0.0.1' } }, {}, () => { next = true; });
  assert.equal(next, true);
});

test('trusted-network controls stay available on a private install and closed on Railway', () => {
  assert.equal(trustedNetworkControlsEnabled({}), false);
  assert.equal(trustedNetworkControlsEnabled({ HALCYON_TRUSTED_NETWORK_CONTROLS: '1' }), true);
  assert.equal(trustedNetworkControlsEnabled({ HALCYON_TRUSTED_NETWORK_CONTROLS: '1', RAILWAY_ENVIRONMENT: 'production' }), false);
  assert.equal(trustedNetworkControlsEnabled({
    HALCYON_TRUSTED_NETWORK_CONTROLS: '1',
    HALCYON_PUBLIC_SITE: '1',
    HALCYON_ALLOW_TRUSTED_NETWORK_CONTROLS: '1',
  }), true);

  const closed = createLocalEndpointGuard({ HALCYON_TRUSTED_NETWORK_CONTROLS: '1', RAILWAY_ENVIRONMENT: 'production' });
  let next = false;
  const res = { statusCode: 0, setHeader() {}, end() {} };
  closed({ url: '/__remote/status', headers: { host: 'app.up.railway.app', 'x-forwarded-for': '203.0.113.4' }, socket: { remoteAddress: '10.0.0.8' } }, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);

  const open = createLocalEndpointGuard({ HALCYON_TRUSTED_NETWORK_CONTROLS: '1' });
  let allowed = false;
  open({ url: '/__play', headers: { host: 'lan.example' }, socket: { remoteAddress: '192.168.1.20' } }, {}, () => { allowed = true; });
  assert.equal(allowed, true);
});

test('link-local, metadata, and rebinding targets are not fetched', async () => {
  assert.equal(isForbiddenProxyAddress('169.254.169.254', { blockPrivate: false }), true);
  assert.equal(isForbiddenProxyAddress('2130706433', { blockPrivate: false }), true);
  assert.equal(isForbiddenProxyAddress('metadata.google.internal', { blockPrivate: false }), true);
  assert.equal(isForbiddenProxyAddress('127.0.0.1', { blockPrivate: false }), false);
  assert.equal(isForbiddenProxyAddress('127.0.0.1', { blockPrivate: true }), true);
  assert.equal(isForbiddenProxyAddress('10.1.1.1', { blockPrivate: true }), true);
  assert.equal(isForbiddenProxyAddress('10.1.1.1', { blockPrivate: false }), false);

  const calls: string[] = [];
  const middleware = createIntegrationProxy(
    { jellyseerr: { url: 'http://catalog.example/seerr', apiKey: 'SERVER-ONLY-SECRET' } },
    {
      env: {},
      fetchImpl: async () => { calls.push('fetch'); return new Response('{}', { headers: { 'content-type': 'application/json' } }); },
      lookupImpl: async () => [{ address: '169.254.169.254', family: 4 }],
    },
  );
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  try {
    const rebound = await fetch(`http://127.0.0.1:${port}/dev-proxy`, {
      headers: { 'x-proxy-target': 'http://catalog.example/seerr/api/v1/movie/1' },
    });
    assert.equal(rebound.status, 403);
    assert.equal((await rebound.text()).includes('SERVER-ONLY-SECRET'), false);
    assert.equal(calls.length, 0);

    const metadata = await fetch(`http://127.0.0.1:${port}/dev-proxy`, {
      headers: { 'x-proxy-target': 'http://169.254.169.254/latest/meta-data/' },
    });
    assert.equal(metadata.status, 403);
    await metadata.text();
    assert.equal(calls.length, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a public site will not proxy to loopback even when that URL is configured', async () => {
  const before = upstreamCalls.length;
  const middleware = createIntegrationProxy(
    { jellyseerr: { url: base + '/seerr', apiKey: secret } },
    { env: { RAILWAY_ENVIRONMENT: 'production' } },
  );
  const server = http.createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/dev-proxy`, {
      headers: { 'x-proxy-target': base + '/seerr/api/v1/movie/1' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.text()).includes(secret), false);
    assert.equal(upstreamCalls.length, before);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
