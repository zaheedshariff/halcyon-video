import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createSiteGate, cookieIsSecure, siteGateMode } from '../tools/site-gate.mjs';
import { createLocalEndpointGuard } from '../tools/integration-proxy.mjs';

const PASSWORD = 'friends-only-password';
const env = {
  HALCYON_SITE_PASSWORD: PASSWORD,
  HALCYON_SITE_FRIENDS: 'Sam:sam-has-a-card,Riley:riley-has-a-card',
};

function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  return new Promise<{ origin: string; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

function appBehind(gate: ReturnType<typeof createSiteGate>, guard?: ReturnType<typeof createLocalEndpointGuard>) {
  return listen((req, res) => {
    gate(req, res, () => {
      const finish = () => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('APP');
      };
      if (guard) guard(req, res, finish);
      else finish();
    });
  });
}

async function login(origin: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await fetch(origin + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const setCookie = response.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { response, text, setCookie, cookie };
}

test('a private checkout stays open until a membership password is configured', () => {
  assert.equal(siteGateMode({}), 'off');
  assert.equal(siteGateMode({ HALCYON_SITE_PASSWORD: 'short' }), 'locked');
  assert.equal(siteGateMode({ HALCYON_SITE_PASSWORD: PASSWORD }), 'enforce');
  assert.equal(siteGateMode({ RAILWAY_ENVIRONMENT: 'production' }), 'locked');
  assert.equal(siteGateMode({ HALCYON_PUBLIC_SITE: '1', HALCYON_SITE_PASSWORD: PASSWORD }), 'enforce');
});

test('the membership password is not named anywhere in the client source', () => {
  const pending = ['src'];
  const names = ['HALCYON_SITE_PASSWORD', 'HALCYON_SITE_FRIENDS', 'HALCYON_SESSION_SECRET'];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!/\.(ts|js|css|html)$/.test(path)) continue;
      const text = readFileSync(path, 'utf8');
      for (const name of names) assert.equal(text.includes(name), false, `${path} mentions ${name}`);
    }
  }
});

test('secure cookies are the default away from localhost', () => {
  assert.equal(cookieIsSecure({ headers: { host: 'localhost:1420' } }, {}), false);
  assert.equal(cookieIsSecure({ headers: { host: '127.0.0.1:8080' } }, {}), false);
  assert.equal(cookieIsSecure({ headers: { host: 'halcyon.up.railway.app' } }, {}), true);
  assert.equal(cookieIsSecure({ headers: { host: 'localhost' } }, { HALCYON_COOKIE_SECURE: '1' }), true);
  assert.equal(cookieIsSecure({ headers: { host: 'halcyon.up.railway.app' } }, { HALCYON_COOKIE_SECURE: '0' }), false);
});

test('the store and its routes stay closed until the membership password matches', async () => {
  const server = await appBehind(createSiteGate({ env, fastHash: true, log: false }));
  try {
    const health = await fetch(server.origin + '/healthz');
    const healthBody = await health.text();
    assert.equal(health.status, 200);
    assert.equal(healthBody, 'ok\n');
    assert.equal(health.headers.get('set-cookie'), null);
    assert.equal(healthBody.includes(PASSWORD), false);
    assert.equal(healthBody.includes('Sam'), false);

    const door = await fetch(server.origin + '/');
    const doorHtml = await door.text();
    assert.equal(door.status, 200);
    assert.match(doorHtml, /HALCYON/);
    assert.match(doorHtml, /membership card/i);
    assert.equal(doorHtml.includes('APP'), false);
    assert.equal(doorHtml.includes('main.ts'), false);
    assert.equal(doorHtml.includes(PASSWORD), false);
    assert.equal(doorHtml.includes('sam-has-a-card'), false);

    for (const path of ['/src/main.ts', '/assets/index.js', '/dev-proxy', '/__play', '/__remote/status', '/__feedback', '/index.html', '/remote.html']) {
      const blocked = await fetch(server.origin + path);
      const body = await blocked.text();
      assert.equal(body.includes('APP'), false, path);
      assert.equal(body.includes(PASSWORD), false, path);
      assert.match(body, /Sign in required|membership card/i, path);
      if (!path.endsWith('.html')) assert.notEqual(blocked.status, 200, path);
    }

    const wrong = await login(server.origin, { password: 'not-the-card' });
    assert.equal(wrong.response.status, 401);
    assert.equal(wrong.setCookie.includes('halcyon_session='), false);
    assert.equal(wrong.text.includes(PASSWORD), false);

    const cross = await login(server.origin, { password: PASSWORD }, { origin: 'https://attacker.test' });
    assert.equal(cross.response.status, 403);

    const good = await login(server.origin, { password: PASSWORD });
    assert.equal(good.response.status, 200);
    assert.match(good.setCookie, /halcyon_session=/);
    assert.match(good.setCookie, /HttpOnly/i);
    assert.match(good.setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(good.setCookie, /Secure/i);
    const inside = await fetch(server.origin + '/src/main.ts', { headers: { cookie: good.cookie } });
    assert.equal(await inside.text(), 'APP');

    const proxy = await fetch(server.origin + '/dev-proxy', { headers: { cookie: good.cookie } });
    assert.equal(await proxy.text(), 'APP');

    const sam = await login(server.origin, { name: 'Sam', password: 'sam-has-a-card' });
    assert.equal(sam.response.status, 200);
    const who = await fetch(server.origin + '/__halcyon/session', { headers: { cookie: sam.cookie } });
    assert.deepEqual(await who.json(), { required: true, authenticated: true, name: 'Sam' });

    const stolenName = await login(server.origin, { name: 'Riley', password: 'sam-has-a-card' });
    assert.equal(stolenName.response.status, 401);

    const unnamedFriend = await login(server.origin, { password: 'riley-has-a-card' });
    assert.equal(unnamedFriend.response.status, 401);

    const sharedNamed = await login(server.origin, { name: 'Sam', password: PASSWORD });
    const sharedWho = await fetch(server.origin + '/__halcyon/session', { headers: { cookie: sharedNamed.cookie } });
    assert.deepEqual(await sharedWho.json(), { required: true, authenticated: true, name: 'Sam' });

    const confirm = await fetch(server.origin + '/logout', { headers: { cookie: good.cookie } });
    assert.match(await confirm.text(), /Sign out/);
    const stillInside = await fetch(server.origin + '/src/main.ts', { headers: { cookie: good.cookie } });
    assert.equal(await stillInside.text(), 'APP');
    const left = await fetch(server.origin + '/logout', { method: 'POST', headers: { cookie: good.cookie } });
    const leftHtml = await left.text();
    assert.match(leftHtml, /signed out/i);
    assert.match(left.headers.get('set-cookie') || '', /Max-Age=0/i);
    const replay = await fetch(server.origin + '/', { headers: { cookie: good.cookie } });
    assert.equal((await replay.text()).includes('APP'), false);
  } finally {
    await server.close();
  }
});

test('wrong passwords lock the desk, and a public host stays locked with no password', async () => {
  let now = 1_700_000_000_000;
  const server = await appBehind(createSiteGate({
    env,
    fastHash: true,
    log: false,
    now: () => now,
    limits: { maxFails: 3, windowMs: 60_000, lockMs: 60_000, proxyMaxFails: 10 },
  }));
  const locked = await appBehind(createSiteGate({
    env: { RAILWAY_ENVIRONMENT: 'production', HALCYON_TRUSTED_NETWORK_CONTROLS: '1' },
    fastHash: true,
    log: false,
  }));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await login(server.origin, { password: 'nope-nope-nope' });
      assert.equal(failed.response.status, 401);
    }
    const cooled = await login(server.origin, { password: PASSWORD });
    assert.equal(cooled.response.status, 429);
    assert.ok(Number(cooled.response.headers.get('retry-after')) > 0);
    now += 61_000;
    const after = await login(server.origin, { password: PASSWORD });
    assert.equal(after.response.status, 200);

    const issued = after.cookie;
    now += 15 * 24 * 60 * 60 * 1000;
    const expired = await fetch(server.origin + '/src/main.ts', { headers: { cookie: issued } });
    assert.equal((await expired.text()).includes('APP'), false);

    const door = await fetch(locked.origin + '/');
    const html = await door.text();
    assert.match(html, /not open yet/i);
    assert.equal(html.includes('APP'), false);
    const script = await fetch(locked.origin + '/src/main.ts');
    assert.equal(script.status, 503);
    assert.equal((await script.text()).includes('APP'), false);
    const health = await fetch(locked.origin + '/health');
    assert.equal(await health.text(), 'ok\n');
    const remote = await fetch(locked.origin + '/__remote/status');
    assert.equal(remote.status, 503);
    assert.equal((await remote.text()).includes('TURN'), false);
  } finally {
    await server.close();
    await locked.close();
  }
});

test('a signed-in friend still cannot open playback or Remote Play from a public address', async () => {
  const gate = createSiteGate({
    env: { ...env, RAILWAY_ENVIRONMENT: 'production', HALCYON_TRUSTED_NETWORK_CONTROLS: '1' },
    fastHash: true,
    log: false,
  });
  const guard = createLocalEndpointGuard({
    RAILWAY_ENVIRONMENT: 'production',
    HALCYON_TRUSTED_NETWORK_CONTROLS: '1',
  });
  const server = await appBehind(gate, guard);
  try {
    const good = await login(server.origin, { password: PASSWORD });
    assert.equal(good.response.status, 200);
    const remote = await fetch(server.origin + '/__remote/status', { headers: { cookie: good.cookie } });
    // The test client is loopback, which is the HTPC exception. A forwarded
    // public hop is what Railway actually delivers.
    assert.equal(await remote.text(), 'APP');
  } finally {
    await server.close();
  }

  const seen: string[] = [];
  const res = { statusCode: 0, setHeader() {}, end(body?: string) { seen.push(String(body ?? '')); } };
  let next = false;
  guard({
    url: '/__remote/status',
    headers: { host: 'halcyon.up.railway.app', 'x-forwarded-for': '203.0.113.10' },
    socket: { remoteAddress: '10.0.0.4' },
  }, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
  assert.equal(seen.join('').includes('TURN'), false);
});

test('a public hostname sets the Secure flag on the session cookie', async () => {
  const gate = createSiteGate({ env, fastHash: true, log: false });
  const server = http.createServer((req, res) => {
    gate(req, res, () => { res.writeHead(200); res.end('APP'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    const body = JSON.stringify({ password: PASSWORD });
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/login',
        method: 'POST',
        headers: {
          host: 'halcyon.up.railway.app',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, response => {
        response.resume();
        response.on('end', () => resolve(response.headers));
      });
      req.on('error', reject);
      req.end(body);
    });
    const cookie = String(headers['set-cookie']?.[0] || headers['set-cookie'] || '');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('one real scrypt check accepts the membership password', async () => {
  const server = await appBehind(createSiteGate({ env: { HALCYON_SITE_PASSWORD: PASSWORD }, log: false }));
  try {
    const good = await login(server.origin, { password: PASSWORD });
    assert.equal(good.response.status, 200);
    assert.match(good.setCookie, /HttpOnly/i);
    const page = await fetch(server.origin + '/', { headers: { cookie: good.cookie } });
    assert.equal(await page.text(), 'APP');
  } finally {
    await server.close();
  }
});
