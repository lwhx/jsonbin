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
  const call = () => h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': ip },
  }), h.env);

  for (let i = 0; i < 240; i++) {
    const response = await call();
    if (response.status !== 200) { assert.fail(`request ${i} unexpectedly ${response.status}`); }
  }
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  // A different IP is a different bucket.
  assert.equal((await h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': '198.51.100.21' },
  }), h.env)).status, 200);

  // Deleting the window counter restores access, proving counters are disposable KV state.
  const window = Math.floor(Date.now() / 60000);
  await h.env.CACHE.delete(`rl:a:${ip}:${window}`);
  assert.equal((await call()).status, 200);

  // Private resources keep authentication semantics (401, not 429).
  const priv = await (await h.request('/bins', { method: 'POST', value: { name: '私有仓', value: null } })).json();
  assert.equal((await h.worker.fetch(new Request(`https://example.test/api/v1/bins/${priv.meta.id}`, {
    headers: { 'CF-Connecting-IP': '198.51.100.22' },
  }), h.env)).status, 401);
});
