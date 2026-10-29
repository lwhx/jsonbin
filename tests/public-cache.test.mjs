import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

class MemoryResponseCache {
  entries = new Map();

  async match(request) {
    return this.entries.get(request.url)?.clone();
  }

  async put(request, response) {
    // Store the fully consumed representation, just as Cache API does.
    const bytes = await response.arrayBuffer();
    this.entries.set(request.url, new Response(bytes, {
      status: response.status,
      headers: response.headers,
    }));
  }
}

test('anonymous current JSON uses a versioned internal cache, but never bypasses live quota or access', async t => {
  const h = await createSystemHarness('public-cache-' + crypto.randomUUID());
  t.after(() => h.close());

  const store = new MemoryResponseCache();
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: { open: async () => store },
  });
  t.after(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches);
    else delete globalThis.caches;
  });

  const createdResponse = await h.request('/bins', {
    method: 'POST',
    value: { name: 'Public Cache', slug: 'public-cache-example', visibility: 'public', value: { rev: 1, enabled: true } },
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const id = created.meta.id;
  const path = '/bins/' + id;
  const calls = { meta: 0, versions: 0 };
  const data = h.adapt({ get: async (key, ...args) => {
    if (key === `bins/${id}/meta.json`) calls.meta++;
    if (String(key).startsWith(`bins/${id}/versions/`)) calls.versions++;
    return h.bucket.get(key, ...args);
  } });
  const env = { ...h.env, DATA: data };
  let pending = [];
  const anon = (suffix = path, headers = {}, bindings = env) => h.worker.fetch(
    new Request('https://example.test/api/v1' + suffix, {
      headers: { 'CF-Connecting-IP': '203.0.113.88', ...headers },
    }),
    bindings,
    { waitUntil: promise => pending.push(promise), passThroughOnException() {} },
  );
  const settle = async () => {
    await Promise.all(pending);
    pending = [];
  };

  const first = await anon();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('etag'), created.etag);
  assert.equal(first.headers.get('x-jsonbin-version'), '1');
  const firstBody = await first.json();
  assert.deepEqual(firstBody, created, 'stream preserves the existing meta/value/etag envelope');
  await settle();
  assert.equal(calls.versions, 1, 'first response must read the R2 version');
  assert.equal(store.entries.size, 1, 'store a versioned internal cache entry');

  const second = await anon();
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstBody);
  await settle();
  assert.equal(calls.versions, 1, 'cache hit skips the R2 value body');
  assert.ok(calls.meta >= 2, 'cache hit must still read authoritative metadata');

  const unchanged = await anon(path, { 'If-None-Match': created.etag });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  await settle();
  assert.equal(calls.versions, 1, 'a matching ETag never reads the value body');

  const invalidBearer = await anon(path, { Authorization: 'Bearer invalid' });
  assert.equal(invalidBearer.status, 401, 'explicit credentials must not use anonymous cache');
  await invalidBearer.text();
  await settle();
  assert.equal(calls.versions, 1);

  const yaml = await anon(path, { Accept: 'text/yaml' });
  assert.equal(yaml.status, 200);
  assert.match(yaml.headers.get('content-type') || '', /yaml/);
  await yaml.text();
  await settle();
  assert.equal(calls.versions, 2, 'non-JSON negotiation must use the existing route');
  assert.equal(store.entries.size, 1);

  const deniedLimiter = {
    idFromName: identity => identity,
    get: () => ({ fetch: async () => Response.json({ allowed: false, retryAfterSeconds: 13 }) }),
  };
  const denied = await anon(path, {}, { ...env, RATE_LIMITER: deniedLimiter });
  assert.equal(denied.status, 429, 'a cache hit cannot bypass the atomic anonymous quota');
  assert.equal(denied.headers.get('retry-after'), '13');
  await denied.text();
  await settle();
  assert.equal(calls.versions, 2);

  const updatedResponse = await h.request(path, {
    method: 'PUT',
    headers: { 'If-Match': created.etag },
    value: { value: { rev: 2, enabled: false } },
  });
  assert.equal(updatedResponse.status, 200);
  const updated = await updatedResponse.json();
  const afterUpdate = await anon();
  assert.equal(afterUpdate.status, 200);
  assert.deepEqual((await afterUpdate.json()).value, updated.value);
  assert.equal(afterUpdate.headers.get('etag'), updated.etag);
  await settle();
  assert.equal(calls.versions, 3, 'new metadata ETag selects a new cache version');
  assert.equal(store.entries.size, 2);

  const privateResponse = await h.request(path + '/meta', {
    method: 'PATCH',
    headers: { 'If-Match': updated.etag },
    value: { visibility: 'private' },
  });
  assert.equal(privateResponse.status, 200);
  assert.equal((await anon()).status, 401, 'a private Bin must never be served from an old public cache entry');
  await settle();
  assert.equal(calls.versions, 3, 'private read does not fetch any R2 version');
  assert.equal(store.entries.size, 2, 'only previous public snapshots remain internally cached');
});
