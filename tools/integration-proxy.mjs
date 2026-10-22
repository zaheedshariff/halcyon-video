// Server-only integration boundary. All destinations come from operator config;
// browser CORS and Host checks are not authentication or proxy authorization.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { operatorServiceForTarget, operatorRequestAllowed, operatorAuthHeaders, targetBelongsTo } from '../src/operator-defaults.ts';

import { SeerrIdentityError, seerrUserHeaders } from './seerr-user-auth.mjs';
import { isPublicSite } from './public-host.mjs';

const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const CATALOG_KEYS = new Set(('id title name originalTitle overview posterPath backdropPath releaseDate firstAirDate runtime voteAverage voteCount genreIds genres mediaType mediaInfo status status4k tmdbId credits cast crew job character productionCompanies collection parts results page totalPages totalResults pageInfo pages pageSize media total items limit offset slug romCount rom_count platform platform_id platforms summary rating fs_name fs_name_no_ext file_name first_release_date release_date metadatum igdb_metadata ss_metadata sibling_roms path_cover_l path_cover_large path_cover_s url_cover box2d_side_path box2d_side_url box2d_back_path box2d_back_url physical_path physical_url url_logo').split(' '));

// Explicit public catalog fields, recursively: new upstream account/settings
// fields never become public by default. Request actors and internal URLs vanish.
export function publicCatalog(value, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map(v => publicCatalog(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => CATALOG_KEYS.has(key))
    .map(([key, v]) => [key, publicCatalog(v, depth + 1)]));
  return value;
}
function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
function sameSite(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
async function readBounded(stream, max) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > max) throw new Error('size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.internal',
  'metadata',
  'instance-data',
]);

export function proxyBlocksPrivateNetworks(env = process.env) {
  return env.HALCYON_PROXY_BLOCK_PRIVATE === '1' || isPublicSite(env);
}

function bareHost(hostname) {
  let host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

function forbiddenV4(ip, blockPrivate) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  // Unspecified and link-local, including the cloud metadata address.
  if (a === 0 || (a === 169 && b === 254)) return true;
  if (!blockPrivate) return false;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function forbiddenV6(ip, blockPrivate) {
  const normalized = ip.toLowerCase();
  if (normalized === '::' || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length);
    if (isIP(v4) === 4) return forbiddenV4(v4, blockPrivate);
  }
  if (!blockPrivate) return false;
  if (normalized === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  return false;
}

/** Literal addresses this proxy must never dial, even if an operator listed them. */
export function isForbiddenProxyAddress(hostname, { blockPrivate = false } = {}) {
  const host = bareHost(hostname);
  if (!host) return true;
  if (METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal')) return true;
  // Decimal and hex IP spellings, and octal dotted quads, are not hostnames.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  if (host.split('.').some(part => /^0\d+$/.test(part))) return true;
  const mapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  if (isIP(mapped) === 4) return forbiddenV4(mapped, blockPrivate);
  if (isIP(host) === 6) return forbiddenV6(host, blockPrivate);
  return false;
}

/**
 * An allowlisted name can still be an SSRF hole if it resolves to link-local,
 * metadata, or (on a public site) loopback and private ranges. Checked again
 * at dial time; redirects are already refused.
 */
export async function resolvesToForbidden(hostname, env = process.env, lookupImpl = dnsLookup) {
  const host = bareHost(hostname);
  const blockPrivate = proxyBlocksPrivateNetworks(env);
  if (isForbiddenProxyAddress(host, { blockPrivate })) return true;
  if (isIP(host)) return false;
  let records;
  try {
    records = await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    return blockPrivate;
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) return blockPrivate;
  return list.some(record => isForbiddenProxyAddress(record?.address, { blockPrivate }));
}

export function createIntegrationProxy(config, { fetchImpl = fetch, env = process.env, lookupImpl = dnsLookup } = {}) {
  const extra = (env.HALCYON_PROXY_ALLOWED_URLS || '').split(',').map(x => x.trim()).filter(Boolean);
  let active = 0;
  return async (req, res, next) => {
    if ((req.url || '').split('?')[0] !== '/dev-proxy') return next();
    if (!sameSite(req)) return json(res, 403, { error: 'Cross-site request denied' });
    const target = String(req.headers['x-proxy-target'] || '');
    let u;
    try {
      u = new URL(target);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || /[%\\]/.test(u.pathname)) throw 0;
    } catch { return json(res, 400, { error: 'Invalid proxy target' }); }
    if (isForbiddenProxyAddress(u.hostname, { blockPrivate: proxyBlocksPrivateNetworks(env) })) {
      return json(res, 403, { error: 'Destination is not allowed' });
    }
    const service = operatorServiceForTarget(config, target);
    const base = service ? config[service].url : extra.find(url => targetBelongsTo(target, url));
    if (!base) return json(res, 403, { error: 'Destination is not configured by this server operator' });
    if (await resolvesToForbidden(u.hostname, env, lookupImpl)) {
      return json(res, 403, { error: 'Destination is not allowed' });
    }
    const method = String(req.method || 'GET').toUpperCase();
    const ownAuth = !!(req.headers['x-api-key'] || req.headers.authorization);
    const kind = service || (u.pathname.includes('/api/v1/') ? 'jellyseerr' : 'romm');
    const relativePath = u.pathname.slice(new URL(base).pathname.replace(/\/+$/, '').length);
    const movieRequest = kind === 'jellyseerr' && method === 'POST' && relativePath === '/api/v1/request' && !u.search;
    const ownRequest = ownAuth && movieRequest;
    const userRequest = !ownAuth && service === 'jellyseerr' && movieRequest && !!req.headers['x-halcyon-jellyfin-token'];
    const writeRequest = ownRequest || userRequest;
    if ((!service && !ownAuth) || (!writeRequest && !operatorRequestAllowed(kind, method, target, base))) {
      return json(res, 403, { error: 'This operation requires your own service credentials; shared credentials are read-only' });
    }
    if (active >= 16) return json(res, 503, { error: 'Integration busy; retry later' });
    active++;
    try {
      if (Number(req.headers['content-length']) > MAX_BODY) return json(res, 413, { error: 'Payload too large' });
      let body;
      try { body = await readBounded(req, MAX_BODY); }
      catch { return json(res, 413, { error: 'Payload too large' }); }
      if (writeRequest) {
        let data;
        try { data = JSON.parse(body.toString()); } catch { return json(res, 400, { error: 'Invalid request' }); }
        if (data?.mediaType !== 'movie' || !Number.isSafeInteger(data.mediaId) || data.mediaId <= 0) return json(res, 400, { error: 'Invalid movie request' });
        body = Buffer.from(JSON.stringify({ mediaType: 'movie', mediaId: data.mediaId }));
      } else if (body.length) return json(res, 400, { error: 'Read requests cannot carry a body' });
      const signal = AbortSignal.timeout(20000);
      const headers = { accept: 'application/json', 'content-type': 'application/json' };
      if (userRequest) {
        Object.assign(headers, await seerrUserHeaders(config.jellyseerr, req.headers['x-halcyon-jellyfin-token'], fetchImpl, signal));
      } else if (ownAuth) {
        for (const key of ['x-api-key', 'authorization']) if (req.headers[key]) headers[key] = String(req.headers[key]);
      } else Object.assign(headers, operatorAuthHeaders(service, config[service]));
      // Never follow redirects with secrets (including X-Api-Key), even within
      // one origin: each permitted route has to pass the policy itself.
      const r = await fetchImpl(target, { method, headers, body: writeRequest ? body : undefined,
        redirect: 'manual', signal });
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        return json(res, 502, { error: 'Integration redirects are disabled' });
      }
      if (!r.ok || writeRequest || method === 'HEAD' || relativePath === '/api/v1/auth/me') {
        await r.body?.cancel();
        return json(res, r.status, r.ok ? { ok: true } : { error: 'Integration request failed', status: r.status });
      }
      if (Number(r.headers.get('content-length')) > MAX_RESPONSE) {
        await r.body?.cancel();
        return json(res, 502, { error: 'Integration response too large' });
      }
      const bytes = await readBounded(r.body || [], MAX_RESPONSE);
      const contentType = (r.headers.get('content-type') || '').split(';')[0];
      if (kind === 'romm' && relativePath.startsWith('/assets/') && ['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
        res.statusCode = r.status;
        res.setHeader('Content-Type', contentType);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end(bytes);
      }
      if (!contentType.includes('json')) return json(res, 502, { error: 'Invalid integration response' });
      return json(res, r.status, publicCatalog(JSON.parse(bytes.toString())));
    } catch (error) {
      if (error instanceof SeerrIdentityError) return json(res, error.status, {
        error: error.message, ...(error.code ? { code: error.code, upstreamStatus: error.upstreamStatus } : {}),
      });
      // Upstream URLs, bodies and exception messages can contain credentials.
      return json(res, 502, { error: 'Integration unavailable' });
    } finally { active--; }
  };
}
export function integrationProxyPlugin(config, env = process.env) {
  const handler = createIntegrationProxy(config, { env });
  return { name: 'integration-proxy', configureServer(s) { s.middlewares.use(handler); },
    configurePreviewServer(s) { s.middlewares.use(handler); } };
}

// Playback control, feedback files and seeded Remote Play were unintentionally
// exposed by public reverse proxies. Default to direct loopback access only.
// A public host (Railway, or HALCYON_PUBLIC_SITE=1) keeps them closed even if
// HALCYON_TRUSTED_NETWORK_CONTROLS=1. Opening them there also requires
// HALCYON_ALLOW_TRUSTED_NETWORK_CONTROLS=1, which a friends site should not set.
export function trustedNetworkControlsEnabled(env = process.env) {
  if (env.HALCYON_TRUSTED_NETWORK_CONTROLS !== '1') return false;
  if (isPublicSite(env) && env.HALCYON_ALLOW_TRUSTED_NETWORK_CONTROLS !== '1') return false;
  return true;
}

export function createLocalEndpointGuard(env = process.env) {
  return (req, res, next) => {
    const pathname = (req.url || '').split('?')[0];
    if (!/^\/__(?:play|feedback|remote)/.test(pathname)) return next();
    if (!sameSite(req)) return json(res, 403, { error: 'Cross-site request denied' });
    if (trustedNetworkControlsEnabled(env)) return next();
    const peer = req.socket?.remoteAddress;
    let host;
    try { host = new URL(`http://${req.headers.host}`).hostname; } catch { host = ''; }
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    const forwarded = Object.keys(req.headers).some(h => h === 'forwarded' || h.startsWith('x-forwarded-'));
    if (loopback.includes(peer) && ['localhost', '127.0.0.1', '[::1]'].includes(host) && !forwarded) return next();
    return json(res, 403, { error: 'Local controls require direct loopback access' });
  };
}
export function localEndpointGuardPlugin(env = process.env) {
  if (env.HALCYON_TRUSTED_NETWORK_CONTROLS === '1' && !trustedNetworkControlsEnabled(env)) {
    console.warn('[local-controls] HALCYON_TRUSTED_NETWORK_CONTROLS is set, but this is a public site. Playback, feedback, and Remote Play stay closed.');
  } else if (trustedNetworkControlsEnabled(env)) {
    console.warn('[local-controls] Trusted-network controls are ON. Do not expose this server to the public internet.');
  }
  const handler = createLocalEndpointGuard(env);
  return { name: 'local-control-boundary', configureServer(s) { s.middlewares.use(handler); },
    configurePreviewServer(s) { s.middlewares.use(handler); } };
}
