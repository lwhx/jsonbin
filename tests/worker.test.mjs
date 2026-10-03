import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, cookie, bucket;
const password = randomBytes(32).toString('hex');
export async function request(path, { method = 'GET', value, etag, authenticated = true } = {}) {
  return mf.dispatchFetch('http://localhost/api/v1' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
}
async function create(value = { hello: 'world' }) {
  const response = await request('/bins', { method: 'POST', value: { name: 'test', value } });
  assert.equal(response.status, 201);
  return response.json();
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{
    name: 'jsonbin-tests', modules: true, scriptPath: 'dist/jsonbin/index.js',
    compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], kvNamespaces: ['CACHE'],
    bindings: { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex') },
  }] }));
  bucket = await mf.getR2Bucket('DATA', 'jsonbin-tests');
  const login = await request('/auth/login', { method: 'POST', value: { username: 'test', password } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => { await mf?.dispose(); });

test('health reports package version and local storage bindings', async () => {
  const health = await (await request('/system/health')).json();
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(health.version, pkg.version);
  assert.deepEqual(health.storage, { r2: true, kv: true });
});
test('unauthenticated requests are rejected', async () => {
  assert.equal((await request('/bins', { authenticated: false })).status, 401);
});
test('CRUD persists JSON, increments version, rejects stale ETag and retains deleted versions', async () => {
  const bin = await create();
  const path = '/bins/' + bin.meta.id;
  const updated = await request(path, { method: 'PUT', etag: bin.etag, value: { value: { updated: true } } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).meta.currentVersion, 2);
  assert.deepEqual((await (await request(path)).json()).value, { updated: true });
  assert.equal((await request(path, { method: 'PUT', etag: bin.etag, value: { value: {} } })).status, 412);
  assert.equal((await request(path, { method: 'DELETE' })).status, 200);
  assert.equal((await request(path)).status, 404);
  assert.ok(await bucket.get(`trash/bins/${bin.meta.id}/meta.json`));
  assert.deepEqual(await (await bucket.get(`bins/${bin.meta.id}/versions/000001.json`)).json(), { hello: 'world' });
});
test('KV supports write, read and delete', async () => {
  const cache = await mf.getKVNamespace('CACHE', 'jsonbin-tests');
  await cache.put('test', 'ok'); assert.equal(await cache.get('test'), 'ok');
  await cache.delete('test'); assert.equal(await cache.get('test'), null);
});

test('quoted, bare and weak ETags compare consistently', async () => {
  for (const transform of [tag => tag, tag => tag.replaceAll('"', ''), tag => 'W/' + tag]) {
    const bin = await create();
    assert.equal((await request('/bins/' + bin.meta.id, {
      method: 'PUT', etag: transform(bin.etag), value: { value: null },
    })).status, 200);
  }
});
test('JSON scalar values round trip and missing value is rejected', async () => {
  const bin = await create();
  for (const value of [null, false, 0, '', [], { nested: [1, null] }]) {
    const response = await request('/bins/' + bin.meta.id, { method: 'PUT', value: { value } });
    assert.equal(response.status, 200);
    assert.deepEqual((await (await request('/bins/' + bin.meta.id)).json()).value, value);
  }
  assert.equal((await request('/bins/' + bin.meta.id, { method: 'PUT', value: {} })).status, 422);
  assert.equal((await request('/bins', { method: 'POST', value: { name: 'missing' } })).status, 422);
});
test('concurrent updates never overwrite immutable versions', async () => {
  const bin = await create();
  const path = '/bins/' + bin.meta.id;
  const responses = await Promise.all(['first', 'second'].map(value => request(path, {
    method: 'PUT', etag: bin.etag, value: { value },
  })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 412]);
  const winner = await responses.find(r => r.status === 200).json();
  const current = await (await request(path)).json();
  assert.deepEqual(current, winner);
  const key = `bins/${bin.meta.id}/versions/${String(winner.meta.currentVersion).padStart(6, '0')}.json`;
  assert.equal(await (await bucket.get(key)).json(), winner.value);
  const old = await bucket.get(`bins/${bin.meta.id}/versions/000001.json`);
  assert.deepEqual(await old.json(), bin.value);
});
test('orphan version objects are preserved and do not block future saves', async () => {
  const bin = await create();
  const key = `bins/${bin.meta.id}/versions/000002.json`;
  await bucket.put(key, JSON.stringify('orphan'));
  const saved = await request('/bins/' + bin.meta.id, { method: 'PUT', etag: bin.etag, value: { value: 'new' } });
  assert.equal(saved.status, 200);
  assert.equal(await (await bucket.get(key)).json(), 'orphan');
  assert.equal((await saved.json()).meta.currentVersion, 3);
});
test('locked bins return 423 and missing bins return 404', async () => {
  const bin = await create();
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, locked: true }));
  assert.equal((await request('/bins/' + bin.meta.id, { method: 'PUT', value: { value: {} } })).status, 423);
  assert.equal((await request('/bins/missing', { method: 'PUT', value: { value: {} } })).status, 404);
});

test('metadata editing changes ETag without changing JSON or version history', async () => {
  const bin = await create();
  const path = '/bins/' + bin.meta.id + '/meta';
  const saved = await request(path, { method: 'PATCH', etag: bin.etag,
    value: { name: '  renamed  ', description: 'description', visibility: 'public' } });
  assert.equal(saved.status, 200);
  const updated = await saved.json();
  assert.equal(updated.meta.name, 'renamed');
  assert.equal(updated.meta.visibility, 'public');
  assert.equal(updated.meta.description, 'description');
  assert.equal(updated.meta.currentVersion, 1);
  assert.deepEqual(updated.value, bin.value);
  assert.notEqual(updated.etag, bin.etag);
  assert.equal(saved.headers.get('etag'), updated.etag);
  assert.equal((await request(path, { method: 'PATCH', etag: bin.etag, value: { name: 'stale' } })).status, 412);
  assert.equal((await request('/bins/' + bin.meta.id, { authenticated: false })).status, 401);
});
test('metadata validation rejects empty, oversized, unknown and invalid fields', async () => {
  const bin = await create(); const path = '/bins/' + bin.meta.id + '/meta';
  for (const value of [{}, { name: ' ' }, { name: 'a'.repeat(161) }, { description: 'a'.repeat(1001) },
    { visibility: 'invalid' }, { currentVersion: 9 }, { locked: false }]) {
    assert.equal((await request(path, { method: 'PATCH', value })).status, 422, JSON.stringify(value));
  }
  assert.equal((await request(path, { method: 'PATCH', authenticated: false, value: { name: 'x' } })).status, 401);
  assert.equal((await request('/bins/missing/meta', { method: 'PATCH', value: { name: 'x' } })).status, 404);
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, locked: true }));
  assert.equal((await request(path, { method: 'PATCH', value: { name: 'x' } })).status, 423);
});
