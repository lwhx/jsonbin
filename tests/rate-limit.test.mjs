import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

async function harness(t) {
  const h = await createSystemHarness('ratelimit-' + crypto.randomUUID());
  t.after(() => h.close());
  return h;
}

test('bearer requests are limited per key and 429s stay uncounted in usage', async t => {
  const h = await harness(t);
  const created = await (await h.request('/keys', { method: 'POST', value: {
    name: '限流密钥', scopes: ['bin:read'], rateLimitPerMinute: 3,
  } })).json();
  assert.equal(created.key.rateLimitPerMinute, 3);

  const usage = async () => (await (await h.request('/keys')).json()).items.find(k => k.id === created.key.id).usageTotal;
  const call = () => h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: `Bearer ${created.token}` },
  }), h.env);

  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal(await usage(), 3, 'three authorized requests counted');

  const limited = await call();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate_limit_exceeded' });
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After in window range: ${retryAfter}`);
  assert.equal(await usage(), 3, 'the rejected request must not be counted');

  // A different key is unaffected; session requests are exempt.
  const other = await (await h.request('/keys', { method: 'POST', value: { name: '另一密钥', scopes: ['bin:read'] } })).json();
  assert.equal((await h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: `Bearer ${other.token}` } }), h.env)).status, 200);
  assert.equal((await h.request('/bins')).status, 200);

  // Raising the limit (or setting null) immediately restores service within the same window.
  const etag = (await h.request(`/keys/${created.key.id}`)).headers.get('etag');
  const patched = await h.request(`/keys/${created.key.id}`, { method: 'PATCH', headers: { 'If-Match': etag }, value: { rateLimitPerMinute: null } });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).key.rateLimitPerMinute, null);
  assert.equal((await call()).status, 200, 'null means unlimited even mid-window');

  // Validation bounds.
  for (const bad of [0, -1, 1.5, 10001, 'x']) {
    assert.equal((await h.request(`/keys/${created.key.id}`, { method: 'PATCH', headers: { 'If-Match': etag }, value: { rateLimitPerMinute: bad } })).status, 422, String(bad));
  }
});

test('anonymous public reads are limited per IP and the window resets', async t => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: { name: '公开仓', visibility: 'public', value: { open: true } } })).json();
  const ip = '203.0.113.77';
  // Never seed against a window that is about to roll over.
  const msIntoWindow = Date.now() % 60000;
  if (msIntoWindow > 58000) await new Promise(r => setTimeout(r, 60000 - msIntoWindow + 50));
  const window = Math.floor(Date.now() / 60000);
  const call = extraIp => h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': extraIp ?? ip },
  }), h.env);

  // Seed the IP's current window at the limit instead of spending 240
  // wall-clock requests: the verdict is deterministic even under CI load.
  await h.env.CACHE.put(`rl:a:${ip}:${window}`, '240');
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  // A different IP is a different bucket.
  assert.equal((await call('198.51.100.21')).status, 200);

  // Only the ACTIVE window counts: a saturated previous window never limits.
  await h.env.CACHE.delete(`rl:a:${ip}:${window}`);
  await h.env.CACHE.put(`rl:a:${ip}:${window - 1}`, '240');
  assert.equal((await call()).status, 200);

  // Counters are disposable KV state: deleting the active window restores access.
  await h.env.CACHE.put(`rl:a:${ip}:${window}`, '240');
  assert.equal((await call()).status, 429);
  await h.env.CACHE.delete(`rl:a:${ip}:${window}`);
  assert.equal((await call()).status, 200);
});

test('an explicit null key rate limit is honored as unlimited (F16)', async t => {
  const h = await harness(t);
  const key = await (await h.request('/keys', { method: 'POST', value: { name: 'unlimited', scopes: ['bin:read'], rateLimitPerMinute: null } })).json();
  assert.equal(key.key.rateLimitPerMinute, null);
  // Seed this minute's counter past the 120 default: an unlimited key sails
  // through, while a default-limited key would 429 on this very request.
  const window = Math.floor(Date.now() / 60000);
  await h.env.CACHE.put(`rl:k:${key.key.id}:${window}`, '200');
  const res = await h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: `Bearer ${key.token}` } }), h.env);
  assert.equal(res.status, 200, 'null must mean unlimited, not the 120 default');
});

test('failed password attempts are limited per IP and only failures consume the budget', async t => {
  const h = await harness(t);
  // Keep every assertion inside one fixed window.
  const msIntoWindow = Date.now() % 60000;
  if (msIntoWindow > 55000) await new Promise(r => setTimeout(r, 60000 - msIntoWindow + 50));
  const attempt = (ip, password = 'wrong-password') => h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username: h.env.ADMIN_USERNAME, password }),
  }), h.env);

  // Five failed verifications exhaust the budget; the sixth is rejected outright.
  for (let i = 0; i < 5; i++) assert.equal((await attempt('203.0.113.5')).status, 401);
  const blocked = await attempt('203.0.113.5');
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: 'rate_limit_exceeded' });
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  // Another IP is a different bucket, and correct credentials still succeed.
  assert.equal((await attempt('198.51.100.9', h.env.ADMIN_PASSWORD)).status, 200);

  // The budget is disposable KV state: clearing it restores the endpoint.
  const window = Math.floor(Date.now() / 60000);
  await h.env.CACHE.delete(`rl:l:203.0.113.5:${window}`);
  assert.equal((await attempt('203.0.113.5', h.env.ADMIN_PASSWORD)).status, 200);
});
