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

test('history lists stored versions with upload metadata and serves immutable values', async () => {
  const bin = await create({ original: true });
  const path = '/bins/' + bin.meta.id;
  const saved = await request(path, { method: 'PUT', etag: bin.etag, value: { value: null } });
  assert.equal(saved.status, 200);
  const updated = await saved.json();
  const listing = await (await request(path + '/versions')).json();
  assert.equal(listing.currentVersion, 2); assert.equal(listing.total, 2);
  assert.deepEqual(listing.items.map(item => item.version), [2, 1]);
  for (const item of listing.items) {
    const stored = await bucket.head(`bins/${bin.meta.id}/versions/${String(item.version).padStart(6, '0')}.json`);
    assert.equal(item.size, stored.size);
    assert.equal(item.createdAt, stored.uploaded.toISOString());
  }
  const first = await request(path + '/versions/1');
  const historical = await first.json();
  assert.deepEqual(historical.value, { original: true });
  assert.equal(first.headers.get('etag'), historical.etag);
  assert.equal(first.headers.get('x-jsonbin-version'), '1');
  assert.equal((await (await request(path + '/versions/2')).json()).value, null);
  const changedMeta = await request(path + '/meta', { method: 'PATCH', etag: updated.etag, value: { name: 'renamed' } });
  assert.equal(changedMeta.status, 200);
  assert.equal((await (await request(path + '/versions')).json()).total, 2);
  assert.deepEqual(await (await request(path + '/versions/1')).json(), historical);
});

test('restore appends a new version, preserves metadata and never rewrites history', async () => {
  const bin = await create(false);
  const path = '/bins/' + bin.meta.id;
  const second = await (await request(path, { method: 'PUT', etag: bin.etag, value: { value: { changed: true } } })).json();
  const renamed = await (await request(path + '/meta', { method: 'PATCH', etag: second.etag, value: { name: 'keep name', visibility: 'public' } })).json();
  const originals = await Promise.all([1, 2].map(async n => (await bucket.get(`bins/${bin.meta.id}/versions/${String(n).padStart(6, '0')}.json`)).text()));
  const response = await request(path + '/versions/1/restore', { method: 'POST', etag: 'W/' + renamed.etag });
  assert.equal(response.status, 200);
  const restored = await response.json();
  assert.equal(restored.value, false); assert.equal(restored.meta.currentVersion, 3);
  assert.equal(restored.meta.name, 'keep name'); assert.equal(restored.meta.visibility, 'public');
  assert.equal(restored.meta.createdAt, bin.meta.createdAt);
  assert.equal(response.headers.get('etag'), restored.etag);
  assert.equal(response.headers.get('x-jsonbin-version'), '3');
  assert.equal((await (await request(path)).json()).value, false);
  assert.equal((await (await request(path + '/versions')).json()).total, 3);
  for (let i = 0; i < originals.length; i++) {
    assert.equal(await (await bucket.get(`bins/${bin.meta.id}/versions/${String(i + 1).padStart(6, '0')}.json`)).text(), originals[i]);
  }
  await bucket.put(`bins/${bin.meta.id}/versions/000004.json`, '"retained orphan"');
  const next = await request(path + '/versions/2/restore', { method: 'POST', etag: restored.etag });
  assert.equal(next.status, 200); assert.equal((await next.json()).meta.currentVersion, 5);
  assert.equal(await (await bucket.get(`bins/${bin.meta.id}/versions/000004.json`)).json(), 'retained orphan');
});

test('history and restore enforce authentication, version validation, ETags and locks', async () => {
  const bin = await create(); const path = '/bins/' + bin.meta.id;
  for (const suffix of ['/versions', '/versions/1', '/versions/1/restore']) {
    assert.equal((await request(path + suffix, { method: suffix.endsWith('restore') ? 'POST' : 'GET', authenticated: false })).status, 401);
  }
  for (const version of ['0', '-1', '1.5', 'abc', '01', '9007199254740992']) {
    assert.equal((await request(path + '/versions/' + version)).status, 422);
    assert.equal((await request(path + '/versions/' + version + '/restore', { method: 'POST', etag: bin.etag })).status, 422);
  }
  assert.equal((await request(path + '/versions/1/restore', { method: 'POST' })).status, 428);
  assert.equal((await request(path + '/versions/99')).status, 404);
  assert.equal((await request(path + '/versions/99/restore', { method: 'POST', etag: bin.etag })).status, 404);
  assert.equal((await request('/bins/missing/versions')).status, 404);
  const updated = await (await request(path, { method: 'PUT', value: { value: 'new' } })).json();
  assert.equal((await request(path + '/versions/1/restore', { method: 'POST', etag: bin.etag })).status, 412);
  assert.equal((await (await request(path + '/versions')).json()).total, 2);
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...updated.meta, locked: true }));
  assert.equal((await request(path + '/versions/1/restore', { method: 'POST', etag: updated.etag })).status, 423);
  assert.equal((await request(path + '/versions/1')).status, 200);
  await request(path, { method: 'DELETE' });
  for (const suffix of ['/versions', '/versions/1', '/versions/1/restore']) {
    assert.equal((await request(path + suffix, { method: suffix.endsWith('restore') ? 'POST' : 'GET', etag: updated.etag })).status, 404);
  }
  assert.ok(await bucket.head(`bins/${bin.meta.id}/versions/000001.json`));
});

test('concurrent restorations have one winner and leave historical objects intact', async () => {
  const bin = await create({ first: true }); const path = '/bins/' + bin.meta.id;
  const second = await (await request(path, { method: 'PUT', value: { value: { second: true } } })).json();
  const responses = await Promise.all([1, 2].map(version => request(path + `/versions/${version}/restore`, { method: 'POST', etag: second.etag })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 412]);
  const winner = await responses.find(r => r.status === 200).json();
  assert.deepEqual(await (await request(path)).json(), winner);
  assert.ok(winner.meta.currentVersion > 2);
  assert.deepEqual((await (await request(path + '/versions/1')).json()).value, { first: true });
  assert.deepEqual((await (await request(path + '/versions/2')).json()).value, { second: true });
});

test('version listing traverses R2 pages, sorts numerically and ignores noncanonical keys', async () => {
  const bin = await create(); const prefix = `bins/${bin.meta.id}/versions/`;
  for (let start = 2; start <= 1002; start += 50) {
    await Promise.all(Array.from({ length: Math.min(50, 1003 - start) }, (_, i) => bucket.put(prefix + String(start + i).padStart(6, '0') + '.json', 'null')));
  }
  await bucket.put(prefix + '1000000.json', 'false');
  await bucket.put(prefix + 'notes.txt', 'ignore');
  await bucket.put(prefix + '0000001.json', 'ignore');
  const listing = await (await request('/bins/' + bin.meta.id + '/versions')).json();
  assert.equal(listing.total, 1003);
  assert.equal(listing.items[0].version, 1000000);
  assert.equal(listing.items.at(-1).version, 1);
  assert.equal(new Set(listing.items.map(item => item.version)).size, 1003);
  assert.equal(listing.currentVersion, 1);
});
