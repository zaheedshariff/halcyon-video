import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isHealthPath, isPublicSite, resolveAllowedHosts, trustProxy } from '../tools/public-host.mjs';

test('Railway hosts are allowed without turning the host check off', () => {
  const hosts = resolveAllowedHosts({
    RAILWAY_ENVIRONMENT: 'production',
    RAILWAY_PUBLIC_DOMAIN: 'halcyon-friends.up.railway.app',
  }, ['my-nas']);
  assert.notEqual(hosts, true);
  assert.ok(Array.isArray(hosts));
  assert.ok(hosts.includes('my-nas'));
  assert.ok(hosts.includes('.up.railway.app'));
  assert.ok(hosts.includes('.railway.internal'));
  assert.ok(hosts.includes('halcyon-friends.up.railway.app'));
  assert.equal(resolveAllowedHosts({ HALCYON_ALLOWED_HOSTS: 'all' }, ['my-nas']), true);
  assert.equal(isPublicSite({}), false);
  assert.equal(isPublicSite({ HALCYON_PUBLIC_SITE: '1' }), true);
  assert.equal(isPublicSite({ RAILWAY_ENVIRONMENT: 'production' }), true);
  assert.equal(trustProxy({ RAILWAY_PROJECT_ID: 'proj' }), true);
  assert.equal(trustProxy({}), false);
  assert.equal(isHealthPath('/healthz'), true);
  assert.equal(isHealthPath('/health?ready=1'), true);
  assert.equal(isHealthPath('/healthz/../'), false);
  assert.equal(isHealthPath('/src/main.ts'), false);
});

test('the Railway deploy files lock the public site and probe a quiet health route', () => {
  const railway = readFileSync(new URL('../railway.json', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../Dockerfile.railway', import.meta.url), 'utf8');
  assert.match(railway, /"healthcheckPath": "\/healthz"/);
  assert.match(railway, /Dockerfile\.railway/);
  assert.match(dockerfile, /HALCYON_PUBLIC_SITE=1/);
  assert.match(dockerfile, /\/healthz/);
  assert.match(dockerfile, /tools\/serve-public\.mjs/);
  assert.doesNotMatch(dockerfile, /VITE_JELLYFIN_PASSWORD=/);
});
