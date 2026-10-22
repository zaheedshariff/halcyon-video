// Public-host decisions shared by the membership door, the proxy, and Vite.
// SPDX-License-Identifier: GPL-3.0-or-later

/** True when this process is meant to face the public internet. */
export function isPublicSite(env = process.env) {
  return env.HALCYON_PUBLIC_SITE === '1'
    || Boolean(env.RAILWAY_ENVIRONMENT)
    || Boolean(env.RAILWAY_PROJECT_ID);
}

/**
 * Trust X-Forwarded-* only from a reverse proxy we chose. Railway injects
 * those headers; a laptop on the LAN does not.
 */
export function trustProxy(env = process.env) {
  return env.HALCYON_TRUST_PROXY === '1' || isPublicSite(env);
}

export function isHealthPath(url) {
  const pathname = String(url || '').split('?')[0];
  return pathname === '/healthz' || pathname === '/health';
}

function railwayHosts(env) {
  const onRailway = Boolean(
    env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_PUBLIC_DOMAIN || env.RAILWAY_PRIVATE_DOMAIN
  );
  if (!onRailway) return [];
  const hosts = ['.up.railway.app', '.railway.app', '.railway.internal'];
  for (const key of ['RAILWAY_PUBLIC_DOMAIN', 'RAILWAY_PRIVATE_DOMAIN']) {
    const raw = String(env[key] || '').trim().toLowerCase().replace(/\.$/, '');
    if (!raw) continue;
    const host = raw.replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
    if (host) hosts.push(host);
  }
  const staticUrl = String(env.RAILWAY_STATIC_URL || '').trim();
  if (staticUrl) {
    try { hosts.push(new URL(staticUrl).hostname.toLowerCase()); } catch { /* ignore bad urls */ }
  }
  return hosts;
}

/**
 * Hostnames Vite will answer. "all" still disables the check — that remains
 * a private-network choice, never something Railway turns on by itself.
 * Railway's own domains are added so a generated *.up.railway.app name works
 * without publishing the server to every Host header on the internet.
 */
export function resolveAllowedHosts(env, ownNames = []) {
  const configured = String(env.HALCYON_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim())
    .filter(Boolean);
  if (configured.some(host => host.toLowerCase() === 'all')) return true;
  const normalized = configured.map(host => host.toLowerCase());
  return [...new Set([...ownNames, ...normalized, ...railwayHosts(env)])];
}
