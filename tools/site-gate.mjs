// Membership door for a publicly hosted store.
// The password lives in server env only. Nothing here is safe to put in a
// VITE_* variable: Vite would copy it into the browser bundle.
// SPDX-License-Identifier: GPL-3.0-or-later

import crypto from 'node:crypto';
import { isPublicSite, trustProxy } from './public-host.mjs';

const COOKIE = 'halcyon_session';
const MIN_SECRET = 8;
const MAX_SECRET = 200;
const MAX_FRIENDS = 30;
const MAX_BODY = 2048;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,40}$/u;

const DEFAULT_LIMITS = {
  maxFails: 8,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
  proxyMaxFails: 80,
};

export function siteGatePlugin(env = process.env) {
  const attach = () => (server) => {
    server.middlewares.use(createSiteGate({ env }));
  };
  return {
    name: 'halcyon-site-gate',
    configureServer: attach(),
    configurePreviewServer: attach(),
  };
}

export function parseSiteSecrets(env) {
  const accounts = [];
  let invalid = false;
  const shared = env.HALCYON_SITE_PASSWORD;
  if (typeof shared === 'string' && shared.length > 0) {
    if (shared.length >= MIN_SECRET && shared.length <= MAX_SECRET) {
      accounts.push({ name: 'member', secret: shared, shared: true });
    } else {
      invalid = true;
    }
  }
  const raw = env.HALCYON_SITE_FRIENDS;
  if (typeof raw === 'string' && raw.trim()) {
    const friends = parseFriends(raw.trim());
    if (!friends) {
      invalid = true;
    } else {
      for (const friend of friends) {
        if (friend.secret.length >= MIN_SECRET && friend.secret.length <= MAX_SECRET && validName(friend.name)) {
          accounts.push({ name: friend.name, secret: friend.secret, shared: false });
        } else {
          invalid = true;
        }
      }
    }
  }
  const sharedAccount = accounts.find(account => account.shared);
  const friends = accounts.filter(account => !account.shared).slice(0, MAX_FRIENDS);
  const usable = sharedAccount ? [sharedAccount, ...friends] : friends;
  if ((typeof shared === 'string' && shared.length > 0 && !sharedAccount && !friends.length)
    || (typeof raw === 'string' && raw.trim() && !usable.length)) {
    invalid = true;
  }
  return { accounts: usable, invalid };
}

export function siteGateMode(env) {
  const { accounts, invalid } = parseSiteSecrets(env);
  if (accounts.length) return 'enforce';
  if (invalid || isPublicSite(env) || env.HALCYON_REQUIRE_SITE_LOGIN === '1') return 'locked';
  return 'off';
}

function parseFriends(raw) {
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
      return Object.entries(obj).map(([name, secret]) => ({
        name: String(name).trim(),
        secret: typeof secret === 'string' ? secret : '',
      }));
    } catch {
      return null;
    }
  }
  const friends = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(':');
    if (idx <= 0) return null;
    friends.push({ name: entry.slice(0, idx).trim(), secret: entry.slice(idx + 1) });
  }
  return friends;
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function sessionTtlMs(env) {
  const days = Number(env.HALCYON_SESSION_DAYS);
  const n = Number.isFinite(days) && days > 0 ? days : 14;
  return Math.min(90, Math.max(1, n)) * 24 * 60 * 60 * 1000;
}

function sessionDaysLabel(env) {
  return String(Math.round(sessionTtlMs(env) / (24 * 60 * 60 * 1000)));
}

function hashSecret(password, salt, fast) {
  if (fast) return crypto.createHash('sha256').update(salt).update('\0').update(password).digest();
  return crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
}

function saltFor(name, secret) {
  return crypto.createHash('sha256').update('halcyon-site-salt-v1\0').update(name).update('\0').update(secret).digest();
}

function buildVerifiers(accounts, fast) {
  return accounts.map(account => {
    const salt = saltFor(account.name.toLowerCase(), account.secret);
    return {
      name: account.name,
      shared: account.shared,
      salt,
      hash: hashSecret(account.secret, salt, fast),
    };
  });
}

function sessionKey(env, verifiers) {
  const hash = crypto.createHash('sha256');
  hash.update(String(env.HALCYON_SESSION_SECRET || ''));
  hash.update('\0halcyon-site-session-v1\0');
  for (const verifier of verifiers) {
    hash.update(verifier.name);
    hash.update('\0');
    hash.update(verifier.hash);
    hash.update('\0');
  }
  return hash.digest();
}

function passwordsMatch(password, verifier, fast) {
  const got = hashSecret(password, verifier.salt, fast);
  return got.length === verifier.hash.length && crypto.timingSafeEqual(got, verifier.hash);
}

export function issueSession(name, secret, now, ttlMs) {
  const body = Buffer.from(JSON.stringify({ v: 1, name, exp: now + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function openSession(token, secret, now) {
  if (typeof token !== 'string' || token.length < 3 || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (!payload || payload.v !== 1 || typeof payload.name !== 'string' || typeof payload.exp !== 'number') return null;
  if (!Number.isFinite(payload.exp) || payload.exp < now) return null;
  if (!validName(payload.name)) return null;
  return { name: payload.name, exp: payload.exp };
}

export function cookieIsSecure(req, env) {
  if (env.HALCYON_COOKIE_SECURE === '0') return false;
  if (env.HALCYON_COOKIE_SECURE === '1') return true;
  const host = String(req.headers?.host || '').trim().toLowerCase();
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : host.replace(/:\d+$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '::1') {
    return false;
  }
  return true;
}

function cookiePair(token, req, env, maxAge) {
  const parts = [`${COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`];
  if (cookieIsSecure(req, env)) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(req) {
  const raw = req.headers?.cookie || '';
  for (const part of String(raw).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === COOKIE) return trimmed.slice(eq + 1);
  }
  return '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function clientAddress(req, env) {
  const socketIp = String(req.socket?.remoteAddress || 'unknown');
  if (!trustProxy(env)) return { clientIp: socketIp, socketIp };
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  if (forwarded && forwarded.length <= 64 && /^[0-9a-fA-F:.]+$/.test(forwarded)) {
    return { clientIp: forwarded, socketIp };
  }
  return { clientIp: socketIp, socketIp };
}

function loginOriginOk(req) {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (!host) return false;
  if (origin) {
    try { return new URL(origin).host === host; } catch { return false; }
  }
  const referer = req.headers?.referer || req.headers?.referrer;
  if (!referer) return true;
  try { return new URL(referer).host === host; } catch { return false; }
}

function wantsJson(req) {
  const type = String(req.headers?.['content-type'] || '');
  return type.includes('application/json');
}

function wantsDoor(req, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/login') return true;
  if (/\.html?$/i.test(pathname)) return true;
  const accept = String(req.headers?.accept || '');
  return accept.includes('text/html') && !/\.[a-z0-9]+$/i.test(pathname);
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) {
      const error = new Error('size');
      error.code = 'SIZE';
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function securityHeaders(res, { html = false } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (html) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  }
}

function sendJson(res, status, body) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, method) {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (method === 'HEAD') return res.end();
  res.end(body);
}

function pageShell(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center;
    padding: max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
    background:
      radial-gradient(ellipse at 50% -10%, rgba(255,204,0,.18), transparent 46%),
      linear-gradient(180deg, #071a4a 0%, #000714 58%, #1a0c08 100%);
    color: #f6f1e6;
    font-family: "Trebuchet MS", "Gill Sans", sans-serif;
  }
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(to bottom, rgba(0,0,0,.18) 0 1px, transparent 1px 3px);
  }
  .card {
    position: relative; width: min(460px, calc(100% - 28px));
    padding: 28px 26px 20px;
    background: linear-gradient(180deg, rgba(8,16,42,.94), rgba(5,8,18,.96));
    border: 3px solid #ffcc00;
    box-shadow: 0 0 0 7px #1a49c2, 0 28px 70px rgba(0,0,0,.5);
  }
  .eyebrow { margin: 0 0 8px; letter-spacing: .42em; font-size: 12px; color: #ffcc00; }
  h1 {
    margin: 0; font-family: Impact, "Arial Black", sans-serif; font-weight: 400;
    font-size: 52px; letter-spacing: .06em; line-height: .88;
  }
  h1 span { display: block; margin-top: 4px; font-size: 20px; letter-spacing: .46em; color: #b9d0ff; }
  .lede { color: #e4dccb; line-height: 1.45; margin: 16px 0 0; }
  label { display: block; margin: 16px 0 6px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #ffcc00; }
  label span { letter-spacing: 0; text-transform: none; color: #b3aa98; }
  input {
    width: 100%; padding: 12px; border: 2px solid #31477f; background: #070b16; color: #fff;
    font: 16px/1.2 "Trebuchet MS", sans-serif; min-height: 48px;
  }
  input:focus { outline: 2px solid #ffcc00; border-color: #ffcc00; }
  button, .back {
    display: block; width: 100%; margin-top: 18px; border: 0; cursor: pointer; text-align: center;
    background: #ffcc00; color: #1a1200; text-decoration: none; touch-action: manipulation;
    font-family: Impact, "Arial Black", sans-serif; letter-spacing: .12em; font-size: 22px; padding: 12px;
    min-height: 48px;
  }
  button:hover, .back:hover { background: #ffe066; }
  .error { margin-top: 14px; padding: 10px 12px; background: #3c1222; color: #ffd5e0; }
  .fine { color: #b7ad9b; font-size: 13px; line-height: 1.45; }
  .ticket { border-top: 1px dashed rgba(255,204,0,.45); margin-top: 18px; padding-top: 12px; }
</style>
</head>
<body>
<main class="card">
<p class="eyebrow">MEMBERS ONLY</p>
<h1>HALCYON <span>VIDEO</span></h1>
${inner}
</main>
</body>
</html>`;
}

function loginPage({ error, name, locked, days }) {
  const safeName = validName(name) ? escapeHtml(name) : '';
  const inner = locked
    ? `<p class="lede">The membership desk is not open yet. Whoever runs this store still needs to set a server password before friends can come in.</p>
       <p class="fine">That setting is <strong>HALCYON_SITE_PASSWORD</strong> on the server. It never belongs in a VITE_ variable.</p>`
    : `<p class="lede">The lights are on and the new releases are out. This aisle is for friends — use the password on your membership card.</p>
       <form method="post" action="/login" autocomplete="on">
         <label for="name">Name on the card <span>(only if you were given your own)</span></label>
         <input id="name" name="name" maxlength="40" autocomplete="username" value="${safeName}">
         <label for="password">Password</label>
         <input id="password" name="password" type="password" required maxlength="200" autocomplete="current-password" autofocus>
         <button type="submit">Come on in</button>
       </form>
       ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
       <div class="ticket">
         <p class="fine">Be kind, rewind. This browser stays signed in for ${escapeHtml(days)} days. Once you are inside, link your own Plex account at plex.tv/link — nobody here shares a Plex login.</p>
       </div>`;
  return pageShell('Halcyon Video — Membership', inner);
}

function logoutConfirmPage() {
  return pageShell('Halcyon Video — Leave', `
    <p class="lede">Heading out? The counter will forget this browser.</p>
    <form method="post" action="/logout">
      <button type="submit">Sign out</button>
    </form>`);
}

function logoutPage() {
  return pageShell('Halcyon Video — Signed out', `
    <p class="lede">You are signed out. The lights stay on whenever you want to come back.</p>
    <a class="back" href="/login">Back to the desk</a>`);
}

function sendHtml(res, status, html, method) {
  securityHeaders(res, { html: true });
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (method === 'HEAD') return res.end();
  res.end(html);
}

export function createSiteGate({
  env = process.env,
  fastHash = false,
  now = Date.now,
  limits: limitOverrides,
  log = true,
} = {}) {
  const mode = siteGateMode(env);
  const { accounts, invalid } = parseSiteSecrets(env);
  const fast = fastHash === true;
  const verifiers = mode === 'enforce' ? buildVerifiers(accounts, fast) : [];
  const secret = mode === 'enforce' ? sessionKey(env, verifiers) : Buffer.alloc(32);
  const dummy = {
    salt: saltFor('dummy', 'not-a-real-membership-password'),
    hash: null,
  };
  dummy.hash = hashSecret('not-a-real-membership-password', dummy.salt, fast);
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const buckets = new Map();
  const revoked = new Set();
  const ttlMs = sessionTtlMs(env);

  function tokenId(token) {
    return crypto.createHash('sha256').update(token).digest('base64url');
  }

  if (log && mode === 'locked') {
    const why = invalid
      ? 'A membership password was set, but it is missing or shorter than 8 characters.'
      : 'HALCYON_SITE_PASSWORD is not set.';
    console.error(`[site-gate] The store is locked. ${why} Set HALCYON_SITE_PASSWORD on the server. Do not use a VITE_ variable.`);
  } else if (log && mode === 'enforce') {
    const named = verifiers.filter(verifier => !verifier.shared).length;
    console.log(`[site-gate] Membership door is on (${named} named card${named === 1 ? '' : 's'}). Sessions last ${sessionDaysLabel(env)} days.`);
  }
  if (log && invalid && mode === 'enforce') {
    console.error('[site-gate] Part of HALCYON_SITE_FRIENDS was ignored. Use Name:password pairs, or a JSON object, with passwords of at least 8 characters.');
  }

  function currentSession(req) {
    if (mode !== 'enforce') return null;
    const token = readCookie(req);
    if (!token || revoked.has(tokenId(token))) return null;
    return openSession(token, secret, now());
  }

  function bucketLocked(key, maxFails) {
    const entry = buckets.get(key);
    if (!entry) return false;
    const time = now();
    entry.fails = entry.fails.filter(stamp => time - stamp < limits.windowMs);
    if (entry.lockedUntil > time) return true;
    if (entry.fails.length >= maxFails) {
      entry.lockedUntil = time + limits.lockMs;
      return true;
    }
    return false;
  }

  function markFailure(key, maxFails) {
    const time = now();
    const entry = buckets.get(key) || { fails: [], lockedUntil: 0 };
    entry.fails = entry.fails.filter(stamp => time - stamp < limits.windowMs);
    entry.fails.push(time);
    if (entry.fails.length >= maxFails) entry.lockedUntil = time + limits.lockMs;
    buckets.set(key, entry);
    if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
  }

  function authenticate(password, name) {
    // At most two slow hashes. A named card is checked only when that name
    // was typed, so a public login form cannot be turned into a loop over
    // every friend's password.
    const shared = verifiers.find(verifier => verifier.shared);
    const friends = verifiers.filter(verifier => !verifier.shared);
    const typed = typeof name === 'string' ? name.trim() : '';
    if (typed && validName(typed)) {
      const friend = friends.find(verifier => verifier.name.toLowerCase() === typed.toLowerCase());
      if (friend && passwordsMatch(password, friend, fast)) return friend.name;
      if (shared && passwordsMatch(password, shared, fast)) return typed;
      passwordsMatch(password, dummy, fast);
      return null;
    }
    if (shared && passwordsMatch(password, shared, fast)) return 'member';
    passwordsMatch(password, dummy, fast);
    return null;
  }

  async function handleLogin(req, res) {
    if (!loginOriginOk(req)) return sendJson(res, 403, { error: 'Cross-site request denied' });
    const { clientIp, socketIp } = clientAddress(req, env);
    const proxyKey = `sock:${socketIp}`;
    const locked = bucketLocked(clientIp, limits.maxFails)
      || (socketIp !== clientIp && bucketLocked(proxyKey, limits.proxyMaxFails));
    if (locked) {
      res.setHeader('Retry-After', String(Math.ceil(limits.lockMs / 1000)));
      const message = 'Too many tries. The desk is closed for a few minutes.';
      if (wantsJson(req)) return sendJson(res, 429, { error: message });
      return sendHtml(res, 429, loginPage({ error: message, name: '', locked: false, days: sessionDaysLabel(env) }), req.method);
    }
    let fields;
    try {
      const raw = await readBody(req);
      if (wantsJson(req)) fields = JSON.parse(raw.toString('utf8') || '{}');
      else fields = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
    } catch {
      const message = 'That card could not be read. Try again.';
      if (wantsJson(req)) return sendJson(res, 400, { error: message });
      return sendHtml(res, 400, loginPage({ error: message, name: '', locked: false, days: sessionDaysLabel(env) }), req.method);
    }
    const password = typeof fields.password === 'string' ? fields.password : '';
    const name = typeof fields.name === 'string' ? fields.name : '';
    let matched = null;
    if (password.length >= MIN_SECRET && password.length <= MAX_SECRET) matched = authenticate(password, name);
    else passwordsMatch(password.slice(0, MAX_SECRET), dummy, fast);
    if (!matched) {
      markFailure(clientIp, limits.maxFails);
      if (socketIp !== clientIp) markFailure(proxyKey, limits.proxyMaxFails);
      const message = 'That does not match the card on the counter.';
      if (wantsJson(req)) return sendJson(res, 401, { error: message });
      return sendHtml(res, 401, loginPage({ error: message, name, locked: false, days: sessionDaysLabel(env) }), req.method);
    }
    buckets.delete(clientIp);
    const token = issueSession(matched, secret, now(), ttlMs);
    res.setHeader('Set-Cookie', cookiePair(token, req, env, Math.floor(ttlMs / 1000)));
    if (wantsJson(req)) return sendJson(res, 200, { ok: true, name: matched });
    res.statusCode = 303;
    res.setHeader('Location', '/');
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  return function siteGate(req, res, next) {
    return Promise.resolve().then(async () => {
      const pathname = String(req.url || '/').split('?')[0] || '/';
      if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/healthz' || pathname === '/health')) {
        return sendText(res, 200, 'ok\n', req.method);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/__halcyon/session') {
        const session = currentSession(req);
        return sendJson(res, 200, {
          required: mode !== 'off',
          authenticated: Boolean(session),
          ...(session ? { name: session.name } : {}),
        });
      }
      if (req.method === 'GET' && pathname === '/logout') {
        return sendHtml(res, 200, logoutConfirmPage(), req.method);
      }
      if (req.method === 'POST' && pathname === '/logout') {
        if (!loginOriginOk(req)) return sendJson(res, 403, { error: 'Cross-site request denied' });
        const token = readCookie(req);
        if (token) {
          revoked.add(tokenId(token));
          if (revoked.size > 10000) revoked.delete(revoked.keys().next().value);
        }
        res.setHeader('Set-Cookie', cookiePair('', req, env, 0));
        return sendHtml(res, 200, logoutPage(), req.method);
      }
      if (mode === 'off') return next();
      if (req.method === 'GET' && pathname === '/login') {
        const session = currentSession(req);
        if (session) {
          res.statusCode = 303;
          res.setHeader('Location', '/');
          res.setHeader('Cache-Control', 'no-store');
          return res.end();
        }
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && pathname === '/login') {
        return sendHtml(res, mode === 'locked' ? 200 : 200, loginPage({
          error: '',
          name: '',
          locked: mode === 'locked',
          days: sessionDaysLabel(env),
        }), req.method);
      }
      if (req.method === 'POST' && pathname === '/login') {
        if (mode === 'locked') {
          const message = 'The membership desk is not open yet.';
          if (wantsJson(req)) return sendJson(res, 503, { error: message });
          return sendHtml(res, 503, loginPage({ error: message, name: '', locked: true, days: sessionDaysLabel(env) }), req.method);
        }
        return handleLogin(req, res);
      }
      if (currentSession(req)) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        return next();
      }
      if (wantsDoor(req, pathname)) {
        return sendHtml(res, 200, loginPage({
          error: '',
          name: '',
          locked: mode === 'locked',
          days: sessionDaysLabel(env),
        }), req.method);
      }
      const status = mode === 'locked' ? 503 : 401;
      return sendJson(res, status, {
        error: mode === 'locked' ? 'Membership desk is not open' : 'Sign in required',
      });
    }).catch(error => {
      if (res.headersSent) return;
      console.error(`[site-gate] ${error?.code === 'SIZE' ? 'login body too large' : 'request failed'}`);
      sendJson(res, error?.code === 'SIZE' ? 413 : 400, { error: 'That card could not be read. Try again.' });
    });
  };
}
