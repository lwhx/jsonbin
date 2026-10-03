import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, cookie, bucket;
const password = randomBytes(32).toString('hex');
export async function request(path, { method = 'GET', value, etag, authenticated = true, authorization, origin } = {}) {
  return mf.dispatchFetch('http://localhost/api/v1' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
      ...(authorization !== undefined ? { Authorization: authorization } : {}),
      ...(origin !== undefined ? { Origin: origin } : {}),
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

async function collectionRequest(path = '', { method = 'GET', value, etag, authenticated = true } = {}) {
  return mf.dispatchFetch('http://localhost/api/v1/collections' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(etag ? { 'If-Match': etag } : {}) },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
}
async function createCollection(name = 'collection test') {
  const response = await collectionRequest('', { method: 'POST', value: { name, description: 'description' } });
  assert.equal(response.status, 201); const record = await response.json();
  assert.equal(response.headers.get('etag'), record.etag); return record;
}

test('collections CRUD validates inputs, uses stable unique slugs and requires ETags', async () => {
  const first = await createCollection(' first '); const second = await createCollection('first');
  assert.equal(first.meta.name, 'first'); assert.notEqual(first.meta.slug, second.meta.slug);
  assert.equal(first.meta.status, 'active');
  const path = '/' + first.meta.id;
  const detail = await collectionRequest(path); assert.equal(detail.status, 200);
  assert.equal((await detail.json()).binCount, 0);
  assert.equal((await collectionRequest(path, { method: 'PATCH', value: { name: 'renamed' } })).status, 428);
  const edited = await collectionRequest(path, { method: 'PATCH', etag: first.etag, value: { name: 'renamed', description: 'updated' } });
  assert.equal(edited.status, 200); const updated = await edited.json();
  assert.equal(updated.meta.name, 'renamed'); assert.equal(updated.meta.description, 'updated');
  assert.equal(updated.meta.slug, first.meta.slug); assert.equal(updated.meta.createdAt, first.meta.createdAt);
  assert.equal((await collectionRequest(path, { method: 'PATCH', etag: first.etag, value: { name: 'stale' } })).status, 412);
  assert.equal((await collectionRequest(path, { method: 'DELETE' })).status, 428);
  assert.equal((await collectionRequest(path, { method: 'DELETE', etag: first.etag })).status, 412);
  for (const value of [{}, { name: ' ' }, { name: 'x'.repeat(161) }, { name: 'ok', description: 'x'.repeat(1001) }, { name: 'ok', status: 'deleted' }]) {
    assert.equal((await collectionRequest('', { method: 'POST', value })).status, 422);
  }
  for (const value of [{}, { name: '' }, { slug: 'change' }, { binCount: 10 }]) {
    assert.equal((await collectionRequest(path, { method: 'PATCH', etag: updated.etag, value })).status, 422);
  }
  for (const [suffix, method, value] of [['', 'GET'], ['', 'POST', { name: 'secret' }], [path, 'GET'], [path, 'PATCH', { name: 'secret' }], [path, 'DELETE'], [path + '/bins', 'GET']]) {
    assert.equal((await collectionRequest(suffix, { method, value, etag: updated.etag, authenticated: false })).status, 401);
  }
  assert.equal((await collectionRequest('/missing')).status, 404);
  assert.equal((await collectionRequest('/missing/bins')).status, 404);
  assert.equal((await collectionRequest('/missing', { method: 'PATCH', value: { name: 'missing' }, etag: '"unknown"' })).status, 404);
  assert.equal((await collectionRequest('/missing', { method: 'DELETE', etag: '"unknown"' })).status, 404);
  assert.equal((await collectionRequest(path, { method: 'DELETE', etag: updated.etag })).status, 200);
  assert.equal((await collectionRequest(path)).status, 404);
  assert.equal((await collectionRequest(path, { method: 'DELETE', etag: updated.etag })).status, 200);
  assert.ok(!(await (await collectionRequest()).json()).items.some(item => item.id === first.meta.id));
});

test('Bin membership moves and clears without changing JSON or version history', async () => {
  const first = await createCollection(); const second = await createCollection();
  const createdResponse = await request('/bins', { method: 'POST', value: { name: 'member', value: false, collectionId: first.meta.id } });
  assert.equal(createdResponse.status, 201); const bin = await createdResponse.json(); const path = '/bins/' + bin.meta.id;
  assert.equal(bin.meta.collectionId, first.meta.id);
  assert.equal((await (await collectionRequest('/' + first.meta.id + '/bins')).json()).total, 1);
  let list = await (await collectionRequest()).json(); assert.equal(list.items.find(item => item.id === first.meta.id).binCount, 1);
  const movedResponse = await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { collectionId: second.meta.id } });
  assert.equal(movedResponse.status, 200); const moved = await movedResponse.json();
  assert.equal(moved.meta.collectionId, second.meta.id); assert.equal(moved.value, false); assert.equal(moved.meta.currentVersion, 1);
  assert.equal((await (await collectionRequest('/' + first.meta.id + '/bins')).json()).total, 0);
  assert.equal((await (await collectionRequest('/' + second.meta.id + '/bins')).json()).total, 1);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { collectionId: null } })).status, 412);
  const cleared = await request(path + '/meta', { method: 'PATCH', etag: moved.etag, value: { collectionId: null } });
  assert.equal(cleared.status, 200); const detached = await cleared.json();
  assert.equal(detached.meta.collectionId, null); assert.equal(detached.meta.currentVersion, 1); assert.equal(detached.value, false);
  assert.equal((await (await collectionRequest('/' + second.meta.id + '/bins')).json()).total, 0);
  assert.equal((await (await request(path + '/versions')).json()).total, 1);
  for (const collectionId of ['not-a-uuid', 1]) assert.equal((await request(path + '/meta', { method: 'PATCH', etag: detached.etag, value: { collectionId } })).status, 422);
  const missing = crypto.randomUUID();
  assert.equal((await request('/bins', { method: 'POST', value: { name: 'bad member', value: {}, collectionId: missing } })).status, 409);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: detached.etag, value: { collectionId: missing } })).status, 409);
  assert.equal((await (await request(path)).json()).meta.collectionId, null);
});

test('collection deletion detaches locked and unlocked Bins while retaining immutable versions', async () => {
  const collection = await createCollection();
  const bins = [];
  for (const name of ['unlocked', 'locked']) {
    const bin = await (await request('/bins', { method: 'POST', value: { name, value: { name }, collectionId: collection.meta.id } })).json();
    bins.push(bin);
  }
  await bucket.put(`bins/${bins[1].meta.id}/meta.json`, JSON.stringify({ ...bins[1].meta, locked: true }));
  const originals = await Promise.all(bins.map(async bin => (await bucket.get(`bins/${bin.meta.id}/versions/000001.json`)).text()));
  const deleted = await collectionRequest('/' + collection.meta.id, { method: 'DELETE', etag: collection.etag });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).detached, 2);
  for (let i = 0; i < bins.length; i++) {
    const after = await (await request('/bins/' + bins[i].meta.id)).json();
    assert.equal(after.meta.collectionId, null); assert.equal(after.meta.currentVersion, 1);
    assert.equal(after.meta.locked, i === 1); assert.deepEqual(after.value, bins[i].value);
    assert.equal(await (await bucket.get(`bins/${bins[i].meta.id}/versions/000001.json`)).text(), originals[i]);
  }
  assert.equal((await collectionRequest('/' + collection.meta.id)).status, 404);
  assert.equal((await collectionRequest('/' + collection.meta.id + '/bins')).status, 404);
  assert.equal((await request('/bins/' + bins[0].meta.id + '/meta', { method: 'PATCH', value: { collectionId: collection.meta.id } })).status, 409);
});

test('deleting marker blocks new members, remains visible, and deletion cleanup can resume', async () => {
  const collection = await createCollection();
  const bin = await (await request('/bins', { method: 'POST', value: { name: 'resume', value: null, collectionId: collection.meta.id } })).json();
  await bucket.put(`collections/${collection.meta.id}/meta.json`, JSON.stringify({ ...collection.meta, status: 'deleting' }));
  assert.equal((await (await collectionRequest('/' + collection.meta.id)).json()).meta.status, 'deleting');
  assert.ok((await (await collectionRequest()).json()).items.some(item => item.id === collection.meta.id));
  assert.equal((await collectionRequest('/' + collection.meta.id, { method: 'PATCH', etag: collection.etag, value: { name: 'resurrect' } })).status, 409);
  assert.equal((await request('/bins', { method: 'POST', value: { name: 'new member', value: {}, collectionId: collection.meta.id } })).status, 409);
  const result = await collectionRequest('/' + collection.meta.id, { method: 'DELETE', etag: collection.etag });
  assert.equal(result.status, 200); assert.equal((await result.json()).detached, 1);
  assert.equal((await (await request('/bins/' + bin.meta.id)).json()).meta.collectionId, null);
});

test('concurrent membership change and collection deletion leave no dangling relation', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const collection = await createCollection(); const bin = await create({ concurrent: true });
    const [moved, deleted] = await Promise.all([
      request('/bins/' + bin.meta.id + '/meta', { method: 'PATCH', etag: bin.etag, value: { collectionId: collection.meta.id } }),
      collectionRequest('/' + collection.meta.id, { method: 'DELETE', etag: collection.etag }),
    ]);
    assert.ok([200, 409].includes(moved.status)); assert.equal(deleted.status, 200);
    const current = await (await request('/bins/' + bin.meta.id)).json();
    assert.equal(current.meta.collectionId, null); assert.deepEqual(current.value, bin.value); assert.equal(current.meta.currentVersion, 1);
  }
});

test('collection cleanup never overwrites concurrent JSON saves or a move to another collection', async () => {
  for (const operation of ['json', 'move']) {
    const source = await createCollection(); const destination = await createCollection();
    const original = await (await request('/bins', { method: 'POST', value: { name: 'concurrent cleanup', value: { original: true }, collectionId: source.meta.id } })).json();
    const path = '/bins/' + original.meta.id;
    const [change, deletion] = await Promise.all([
      operation === 'json'
        ? request(path, { method: 'PUT', etag: original.etag, value: { value: { saved: true } } })
        : request(path + '/meta', { method: 'PATCH', etag: original.etag, value: { collectionId: destination.meta.id } }),
      collectionRequest('/' + source.meta.id, { method: 'DELETE', etag: source.etag }),
    ]);
    assert.ok([200, 412].includes(change.status)); assert.equal(deletion.status, 200);
    const final = await (await request(path)).json();
    assert.notEqual(final.meta.collectionId, source.meta.id);
    if (change.status === 200) {
      if (operation === 'json') { assert.deepEqual(final.value, { saved: true }); assert.equal(final.meta.currentVersion, 2); }
      else { assert.equal(final.meta.collectionId, destination.meta.id); assert.deepEqual(final.value, original.value); }
    } else { assert.deepEqual(final.value, original.value); assert.equal(final.meta.currentVersion, 1); }
  }
});

const modelDefinition = { type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false };
async function model(schema = modelDefinition) {
  const response = await request('/schemas', { method: 'POST', value: { name: '计数模型', schema } });
  assert.equal(response.status, 201); return response.json();
}
async function boundBin(schema, value = { count: 1 }, schemaLocked = false) {
  const response = await request('/bins', { method: 'POST', value: { name: '绑定模型', value, schemaId: schema.meta.id, schemaLocked } });
  assert.equal(response.status, 201); return response.json();
}

test('schema CRUD requires session and conditional writes; listing and sample validation use the latest revision', async () => {
  assert.equal((await request('/schemas', { authenticated: false })).status, 401);
  assert.equal((await request('/schemas', { method: 'POST', authenticated: false, value: { name: 'x', schema: true } })).status, 401);
  const schema = await model(), path = '/schemas/' + schema.meta.id;
  for (const [suffix, method] of [['', 'GET'], ['', 'PUT'], ['', 'DELETE'], ['/validate', 'POST']]) {
    assert.equal((await request(path + suffix, { method, authenticated: false })).status, 401);
  }
  const fetched = await request(path);
  assert.equal(fetched.headers.get('etag'), schema.etag); assert.deepEqual(await fetched.json(), schema);
  assert.ok((await (await request('/schemas')).json()).items.some(item => item.id === schema.meta.id));
  assert.equal((await request(path, { method: 'PUT', value: { name: 'x', schema: true } })).status, 428);
  const changed = await request(path, { method: 'PUT', etag: schema.etag, value: { name: '允许全部', description: '已编辑', schema: true } });
  assert.equal(changed.status, 200); const next = await changed.json();
  assert.equal(next.meta.currentRevision, 2); assert.equal(next.meta.description, '已编辑');
  assert.equal((await request(path, { method: 'PUT', etag: schema.etag, value: { name: 'stale', schema: false } })).status, 412);
  assert.deepEqual(await (await request(path + '/validate', { method: 'POST', value: { value: null } })).json(), { valid: true, issues: [], revision: 2 });
  assert.equal((await request(path + '/validate', { method: 'POST', value: {} })).status, 422);
  assert.equal((await request(path, { method: 'DELETE' })).status, 428);
  assert.equal((await request(path, { method: 'DELETE', etag: schema.etag })).status, 412);
  assert.equal((await request(path, { method: 'DELETE', etag: next.etag })).status, 200);
  assert.equal((await request(path)).status, 404);
  assert.equal((await request(path + '/validate', { method: 'POST', value: { value: null } })).status, 404);
  assert.ok(!(await (await request('/schemas')).json()).items.some(item => item.id === schema.meta.id));
  assert.deepEqual(await (await bucket.get(`schemas/${schema.meta.id}/revisions/000001.json`)).json(), modelDefinition);
});
test('schema definitions reject malformed keywords, dialects, refs, patterns and nonproductive recursion', async () => {
  for (const schema of [null, [], { type: 'invalid' }, { required: 'count' }, { minimum: '0' }, { minLength: -1 },
    { type: ['string', 'string'] }, { enum: [] }, { properties: { bad: 12 } }, { $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { $ref: 'https://example.test/model' }, { $ref: '#/definitions/missing' }, { $ref: '#' }, { allOf: [{ $ref: '#' }] },
    { format: 'unknown-format' }, { pattern: '[' }, { patternProperties: { '[': true } }, { unevaluatedProperties: false }, { properties: { child: { $id: 'child' } } }]) {
    const response = await request('/schemas', { method: 'POST', value: { name: 'bad', schema } });
    assert.equal(response.status, 422, JSON.stringify(schema));
  }
  assert.equal((await request('/schemas', { method: 'POST', value: { name: 'x', schema: true, extra: true } })).status, 422);
  let deep = true; for (let i = 0; i < 70; i++) deep = { not: deep };
  assert.equal((await request('/schemas', { method: 'POST', value: { name: 'deep', schema: deep } })).status, 422);
  assert.equal((await request('/schemas', { method: 'POST', value: { name: 'large', schema: { description: 'x'.repeat(65537) } } })).status, 422);
});
test('boolean schemas, local escaped refs, recursive properties and format constraints validate without code generation', async () => {
  for (const definition of [true, false]) {
    const schema = await model(definition);
    for (const value of [null, false, 0, '', [], {}]) {
      const response = await request(`/schemas/${schema.meta.id}/validate`, { method: 'POST', value: { value } });
      assert.equal(response.status, 200); assert.equal((await response.json()).valid, definition);
    }
  }
  const local = await model({ definitions: { 'a/b~c': { type: 'string', minLength: 2 } }, properties: { text: { $ref: '#/definitions/a~1b~0c' } } });
  assert.equal((await (await request(`/schemas/${local.meta.id}/validate`, { method: 'POST', value: { value: { text: 'ok' } } })).json()).valid, true);
  assert.equal((await (await request(`/schemas/${local.meta.id}/validate`, { method: 'POST', value: { value: { text: 7 } } })).json()).valid, false);
  const recursive = await model({ type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#' } }, required: ['name'] });
  const tree = { name: 'root', child: { name: 'leaf' } };
  assert.equal((await (await request(`/schemas/${recursive.meta.id}/validate`, { method: 'POST', value: { value: tree } })).json()).valid, true);
  const dependencies = await model({ definitions: { counter: { ...modelDefinition, additionalProperties: true } }, dependencies: { type: { $ref: '#/definitions/counter' } } });
  for (const [value, expected] of [[{ type: true, count: 1 }, true], [{ type: true, count: 'bad' }, false], [{ other: true }, true]]) {
    assert.equal((await (await request(`/schemas/${dependencies.meta.id}/validate`, { method: 'POST', value: { value } })).json()).valid, expected);
  }
  const dependencyRef = await model({ dependencies: { type: { type: 'object' } }, $ref: '#/dependencies/type' });
  assert.equal((await (await request(`/schemas/${dependencyRef.meta.id}/validate`, { method: 'POST', value: { value: {} } })).json()).valid, true);
  const format = await model({ type: 'string', format: 'email' });
  assert.equal((await (await request(`/schemas/${format.meta.id}/validate`, { method: 'POST', value: { value: 'bad' } })).json()).valid, false);
});
test('failed creation and updates expose field paths and preserve Bin metadata, ETag and version files', async () => {
  const schema = await model();
  const before = (await (await request('/bins')).json()).total;
  const rejected = await request('/bins', { method: 'POST', value: { name: 'bad', schemaId: schema.meta.id, value: { count: 'bad' } } });
  assert.equal(rejected.status, 422); const body = await rejected.json();
  assert.equal(body.error, 'schema_validation_failed'); assert.ok(body.issues.some(issue => issue.path === '#/count' && issue.keyword === 'type'));
  assert.equal((await (await request('/bins')).json()).total, before);
  const bin = await boundBin(schema), path = '/bins/' + bin.meta.id;
  const response = await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: -17 } } });
  assert.equal(response.status, 422); assert.ok(!JSON.stringify(await response.json()).includes('-17'));
  assert.deepEqual(await (await request(path)).json(), bin);
  assert.equal((await bucket.list({ prefix: `bins/${bin.meta.id}/versions/` })).objects.length, 1);
  assert.equal((await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 2 } } })).status, 200);
});
test('binding validates current JSON; historical restore validates the pinned schema and does not append invalid content', async () => {
  const schema = await model(), bin = await create({ count: 'old' }), path = '/bins/' + bin.meta.id;
  const rejected = await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { schemaId: schema.meta.id } });
  assert.equal(rejected.status, 422); assert.deepEqual(await (await request(path)).json(), bin);
  const updated = await (await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 3 } } })).json();
  const bound = await request(path + '/meta', { method: 'PATCH', etag: updated.etag, value: { schemaId: schema.meta.id } });
  assert.equal(bound.status, 200); const record = await bound.json();
  assert.equal(record.meta.currentVersion, 2); assert.equal(record.meta.schemaRevision, 1);
  assert.equal((await request(path + '/versions/1/restore', { method: 'POST', etag: record.etag })).status, 422);
  assert.deepEqual(await (await request(path)).json(), record);
  assert.equal((await bucket.list({ prefix: `bins/${bin.meta.id}/versions/` })).objects.length, 2);
  assert.equal((await request(path + '/versions/2/restore', { method: 'POST', etag: record.etag })).status, 200);
});
test('model edits keep existing Bin constraints until an explicit upgrade and failed upgrades leave the binding unchanged', async () => {
  const schema = await model(), bin = await boundBin(schema), path = '/bins/' + bin.meta.id;
  const newDefinition = { ...modelDefinition, properties: { count: { type: 'integer', minimum: 5 } } };
  const changed = await (await request('/schemas/' + schema.meta.id, { method: 'PUT', etag: schema.etag, value: { name: '新模型', schema: newDefinition } })).json();
  let record = await (await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { name: '改名', schemaId: schema.meta.id } })).json();
  assert.equal(record.meta.schemaRevision, 1);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: record.etag, value: { refreshSchema: true } })).status, 422);
  assert.deepEqual(await (await request(path)).json(), record);
  record = await (await request(path, { method: 'PUT', etag: record.etag, value: { value: { count: 8 } } })).json();
  const upgraded = await request(path + '/meta', { method: 'PATCH', etag: record.etag, value: { refreshSchema: true } });
  assert.equal(upgraded.status, 200); const latest = await upgraded.json();
  assert.equal(latest.meta.schemaRevision, changed.meta.currentRevision); assert.equal(latest.meta.currentVersion, record.meta.currentVersion);
  assert.ok(!Object.hasOwn(latest.meta, 'refreshSchema'));
  assert.equal((await request(path, { method: 'PUT', etag: latest.etag, value: { value: { count: 1 } } })).status, 422);
});
test('schema lock protects binding changes, unbind and upgrades even in an unlock request; valid JSON remains writable', async () => {
  const schema = await model(), other = await model(true), bin = await boundBin(schema, { count: 2 }, true), path = '/bins/' + bin.meta.id;
  for (const fields of [{ schemaId: null }, { schemaId: other.meta.id }, { refreshSchema: true }, { schemaLocked: false, schemaId: null }]) {
    assert.equal((await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: fields })).status, 423);
  }
  assert.deepEqual(await (await request(path)).json(), bin);
  const valid = await (await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 7 } } })).json();
  assert.equal(valid.meta.schemaLocked, true); assert.equal(valid.meta.currentVersion, 2);
  const unlocked = await (await request(path + '/meta', { method: 'PATCH', etag: valid.etag, value: { schemaLocked: false } })).json();
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: unlocked.etag, value: { schemaId: null, refreshSchema: true } })).status, 422);
  const detached = await (await request(path + '/meta', { method: 'PATCH', etag: unlocked.etag, value: { schemaId: null } })).json();
  assert.equal(detached.meta.schemaRevision, null); assert.equal(detached.meta.schemaId, null);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: unlocked.etag, value: { schemaId: other.meta.id } })).status, 412);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: detached.etag, value: { schemaLocked: true } })).status, 422);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: detached.etag, value: { refreshSchema: true } })).status, 422);
  assert.equal((await request('/bins', { method: 'POST', value: { name: 'no model', value: null, schemaLocked: true } })).status, 422);
});
test('archived schemas reject new bindings and upgrades but preserve validation for existing locked bindings', async () => {
  const schema = await model(), bin = await boundBin(schema, { count: 2 }, true), path = '/bins/' + bin.meta.id;
  assert.equal((await request('/schemas/' + schema.meta.id, { method: 'DELETE', etag: schema.etag })).status, 200);
  assert.equal((await request('/bins', { method: 'POST', value: { name: 'new', value: { count: 2 }, schemaId: schema.meta.id } })).status, 409);
  assert.equal((await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 'bad' } } })).status, 422);
  let record = await (await request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 3 } } })).json();
  record = await (await request(path + '/meta', { method: 'PATCH', etag: record.etag, value: { schemaId: schema.meta.id, schemaLocked: false } })).json();
  assert.equal(record.meta.schemaRevision, 1);
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: record.etag, value: { refreshSchema: true } })).status, 409);
  assert.equal((await request(path + '/versions/1/restore', { method: 'POST', etag: record.etag })).status, 200);
});
test('concurrent model edits reserve immutable snapshots and publish only one metadata revision', async () => {
  const schema = await model(), path = '/schemas/' + schema.meta.id;
  await bucket.put(`schemas/${schema.meta.id}/revisions/000008.json`, JSON.stringify({ const: 'orphan' }));
  const responses = await Promise.all([true, false].map(definition => request(path, { method: 'PUT', etag: schema.etag, value: { name: 'concurrent', schema: definition } })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 412]);
  const winner = await responses.find(r => r.status === 200).json();
  assert.ok(winner.meta.currentRevision >= 9); assert.deepEqual(await (await request(path)).json(), winner);
  assert.deepEqual(await (await bucket.get(`schemas/${schema.meta.id}/revisions/${String(winner.meta.currentRevision).padStart(6, '0')}.json`)).json(), winner.schema);
  assert.deepEqual(await (await bucket.get(`schemas/${schema.meta.id}/revisions/000001.json`)).json(), schema.schema);
  assert.deepEqual(await (await bucket.get(`schemas/${schema.meta.id}/revisions/000008.json`)).json(), { const: 'orphan' });
});

test('racing schema binding and incompatible JSON save cannot publish a Bin that violates its binding', async () => {
  const schema = await model(), bin = await create({ count: 1 }), path = '/bins/' + bin.meta.id;
  const responses = await Promise.all([
    request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { schemaId: schema.meta.id } }),
    request(path, { method: 'PUT', etag: bin.etag, value: { value: { count: 'incompatible' } } }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
  const current = await (await request(path)).json();
  if (current.meta.schemaId) {
    assert.equal(current.meta.schemaId, schema.meta.id); assert.deepEqual(current.value, { count: 1 });
  } else {
    assert.deepEqual(current.value, { count: 'incompatible' });
  }
  const required = await (await request(`/schemas/${schema.meta.id}/validate`, { method: 'POST', value: { value: {} } })).json();
  assert.ok(required.issues.some(issue => issue.path === '#/count' && issue.keyword === 'required'));
});

const keyScopes = ['bin:read', 'bin:create', 'bin:update', 'bin:delete', 'collection:read', 'collection:write', 'schema:read', 'schema:write', 'history:read'];
async function apiKey(scopes = ['bin:read'], extra = {}) {
  const response = await request('/keys', { method: 'POST', value: { name: '测试密钥', scopes, ...extra } });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store'); return response.json();
}
const bearerRequest = (token, path, options = {}) => request(path, { authenticated: false, authorization: `Bearer ${token}`, ...options });

test('API keys are session-only, return a token only on creation and never persist or list the secret or digest', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const path = method === 'DELETE' ? '/keys/' + crypto.randomUUID() : '/keys';
    assert.equal((await request(path, { method, authenticated: false })).status, 401);
  }
  const created = await apiKey(keyScopes, { name: '  自动化  ', expiresAt: new Date(Date.now() + 86400000).toISOString() });
  assert.match(created.token, /^jb_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.name, '自动化'); assert.equal(created.key.lastUsedAt, null);
  const stored = await (await bucket.get(`keys/${created.key.id}/meta.json`)).json();
  assert.equal(stored.digestAlgorithm, 'sha256'); assert.ok(stored.digest); assert.ok(!JSON.stringify(stored).includes(created.token));
  assert.ok(!Object.hasOwn(created.key, 'digest')); assert.ok(!Object.hasOwn(created.key, 'digestAlgorithm'));
  const response = await request('/keys'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const listed = await response.json(); const publicRecord = listed.items.find(item => item.id === created.key.id);
  assert.deepEqual(publicRecord, created.key); assert.ok(!JSON.stringify(listed).includes(created.token));
  assert.ok(!Object.hasOwn(publicRecord, 'token')); assert.ok(!Object.hasOwn(publicRecord, 'digest'));
  for (const [path, method] of [['/keys', 'GET'], ['/keys', 'POST'], ['/keys/' + created.key.id, 'DELETE']]) {
    assert.equal((await bearerRequest(created.token, path, { method, value: method === 'POST' ? { name: 'escalation', scopes: keyScopes } : undefined })).status, 401);
    assert.equal((await bearerRequest(created.token, path, { method, authenticated: true })).status, 401);
  }
  assert.equal((await bearerRequest(created.token, '/auth/me')).status, 401);
});
test('key creation rejects invalid names, scopes, duplicate scopes, past expiry and unknown fields', async () => {
  for (const value of [{ name: '', scopes: ['bin:read'] }, { name: 'x'.repeat(161), scopes: ['bin:read'] },
    { name: 'x', scopes: [] }, { name: 'x', scopes: ['unknown'] }, { name: 'x', scopes: ['bin:read', 'bin:read'] },
    { name: 'x', scopes: ['bin:read'], expiresAt: 'bad' }, { name: 'x', scopes: ['bin:read'], expiresAt: '2000-01-01T00:00:00Z' },
    { name: 'x', scopes: ['bin:read'], token: 'chosen-secret' }]) {
    assert.equal((await request('/keys', { method: 'POST', value })).status, 422);
  }
});
test('Bearer precedence rejects malformed or unknown credentials even alongside a valid admin cookie', async () => {
  const key = await apiKey();
  for (const [caseIndex, authorization] of ['Basic anything', 'Bearer', 'Bearer invalid', `Bearer ${key.token} extra`, `Bearer ${key.token.slice(0, -1)}!`,
    `Bearer ${key.token.slice(0, -1)}${key.token.at(-1) === 'A' ? 'B' : 'A'}`, `Bearer jb_live_${'0'.repeat(32)}_${'a'.repeat(43)}`].entries()) {
    for (const authenticated of [true, false]) {
      const response = await request('/bins', { authorization, authenticated });
      assert.equal(response.status, 401, `credential case ${caseIndex}, cookie ${authenticated}`); assert.match(response.headers.get('www-authenticate'), /invalid_token/);
    }
  }
  assert.equal((await request('/bins', { authenticated: false, authorization: `bearer ${key.token}` })).status, 200);
  assert.equal((await bearerRequest(key.token, '/bins', { method: 'POST', authenticated: true, value: { name: 'forbidden', value: null } })).status, 403);
});
test('every existing resource route enforces the exact Bearer scopes, including collection members and historical restoration', async () => {
  const id = crypto.randomUUID();
  const routes = [
    ['/bins', 'GET', ['bin:read'], undefined, 200], ['/bins', 'POST', ['bin:create'], {}, 422],
    [`/bins/${id}`, 'GET', ['bin:read'], undefined, 404], [`/bins/${id}`, 'PUT', ['bin:update'], { value: null }, 404],
    [`/bins/${id}/meta`, 'PATCH', ['bin:update'], { name: 'x' }, 404], [`/bins/${id}`, 'DELETE', ['bin:delete'], undefined, 404],
    [`/bins/${id}/versions`, 'GET', ['history:read'], undefined, 404], [`/bins/${id}/versions/1`, 'GET', ['history:read'], undefined, 404],
    [`/bins/${id}/versions/1/restore`, 'POST', ['bin:update', 'history:read'], undefined, 404],
    ['/collections', 'GET', ['collection:read'], undefined, 200], ['/collections', 'POST', ['collection:write'], {}, 422],
    [`/collections/${id}`, 'GET', ['collection:read'], undefined, 404], [`/collections/${id}/bins`, 'GET', ['collection:read', 'bin:read'], undefined, 404],
    [`/collections/${id}`, 'PATCH', ['collection:write'], { name: 'x' }, 404], [`/collections/${id}`, 'DELETE', ['collection:write'], undefined, 404],
    ['/schemas', 'GET', ['schema:read'], undefined, 200], ['/schemas', 'POST', ['schema:write'], {}, 422],
    [`/schemas/${id}`, 'GET', ['schema:read'], undefined, 404], [`/schemas/${id}`, 'PUT', ['schema:write'], { name: 'x', schema: true }, 404],
    [`/schemas/${id}`, 'DELETE', ['schema:write'], undefined, 404], [`/schemas/${id}/validate`, 'POST', ['schema:read'], { value: null }, 404],
  ];
  for (const scope of keyScopes) {
    const key = await apiKey([scope]);
    for (const [path, method, required, value, allowedStatus] of routes) {
      const response = await bearerRequest(key.token, path, { method, value, etag: '"unused"' });
      const allowed = required.every(item => item === scope);
      assert.equal(response.status, allowed ? allowedStatus : 403, `${scope}: ${method} ${path}`);
      if (!allowed) assert.deepEqual((await response.json()).requiredScopes, required);
    }
  }
  for (const required of [['bin:update', 'history:read'], ['collection:read', 'bin:read']]) {
    const key = await apiKey(required), path = required[0] === 'bin:update' ? `/bins/${id}/versions/1/restore` : `/collections/${id}/bins`;
    assert.equal((await bearerRequest(key.token, path, { method: required[0] === 'bin:update' ? 'POST' : 'GET', etag: '"unused"' })).status, 404);
  }
});
test('authorized external clients can CRUD models, collections and Bins while retaining ETag, JSON Schema, locks and restore checks', async () => {
  const key = await apiKey(keyScopes);
  const schemaResponse = await bearerRequest(key.token, '/schemas', { method: 'POST', value: { name: '外部模型', schema: modelDefinition } });
  assert.equal(schemaResponse.status, 201); const schema = await schemaResponse.json();
  const collectionResponse = await bearerRequest(key.token, '/collections', { method: 'POST', value: { name: '外部集合' } });
  assert.equal(collectionResponse.status, 201); const collection = await collectionResponse.json();
  const response = await bearerRequest(key.token, '/bins', { method: 'POST', value: { name: '外部数据仓', value: { count: 1 }, schemaId: schema.meta.id, schemaLocked: true, collectionId: collection.meta.id } });
  assert.equal(response.status, 201); const bin = await response.json(), path = '/bins/' + bin.meta.id;
  assert.equal((await bearerRequest(key.token, path + '/meta', { method: 'PATCH', etag: bin.etag, value: { schemaId: null } })).status, 423);
  assert.equal((await bearerRequest(key.token, path, { method: 'PUT', etag: bin.etag, value: { value: { count: 'invalid' } } })).status, 422);
  const metaObject = await bucket.get(`bins/${bin.meta.id}/meta.json`);
  const savedMeta = await metaObject.json();
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...savedMeta, locked: true }));
  assert.equal((await bearerRequest(key.token, path, { method: 'PUT', etag: bin.etag, value: { value: { count: 2 } } })).status, 423);
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify(savedMeta, null, 2));
  const updatedResponse = await bearerRequest(key.token, path, { method: 'PUT', etag: bin.etag, value: { value: { count: 2 } } });
  assert.equal(updatedResponse.status, 200); const updated = await updatedResponse.json();
  assert.equal((await bearerRequest(key.token, path, { method: 'PUT', etag: bin.etag, value: { value: { count: 3 } } })).status, 412);
  assert.equal((await bearerRequest(key.token, path + '/versions')).status, 200);
  assert.equal((await bearerRequest(key.token, path + '/versions/1')).status, 200);
  assert.equal((await bearerRequest(key.token, path + '/versions/1/restore', { method: 'POST' })).status, 428);
  assert.equal((await bearerRequest(key.token, path + '/versions/1/restore', { method: 'POST', etag: updated.etag })).status, 200);
  assert.equal((await bearerRequest(key.token, `/collections/${collection.meta.id}/bins`)).status, 200);
  assert.equal((await bearerRequest(key.token, path, { method: 'DELETE' })).status, 200);
  assert.equal((await bearerRequest(key.token, `/collections/${collection.meta.id}`, { method: 'DELETE', etag: collection.etag })).status, 200);
  assert.equal((await bearerRequest(key.token, `/schemas/${schema.meta.id}`, { method: 'DELETE', etag: schema.etag })).status, 200);
});
test('last-used time is recorded for permitted authentication only, expiry and revocation reject future requests', async () => {
  const key = await apiKey();
  const path = `keys/${key.key.id}/meta.json`, stored = () => bucket.get(path).then(object => object.json());
  assert.equal((await bearerRequest(key.token, '/collections')).status, 403); assert.equal((await stored()).lastUsedAt, null);
  assert.equal((await bearerRequest(key.token, '/bins')).status, 200); assert.ok((await stored()).lastUsedAt);
  let value = await stored();
  await bucket.put(path, JSON.stringify({ ...value, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.equal((await bearerRequest(key.token, '/bins')).status, 401); assert.equal((await stored()).lastUsedAt, value.lastUsedAt);
  await bucket.put(path, JSON.stringify({ ...value, expiresAt: null }));
  const revokedResponse = await request('/keys/' + key.key.id, { method: 'DELETE' });
  assert.equal(revokedResponse.status, 200); const revoked = (await revokedResponse.json()).key;
  assert.ok(revoked.revokedAt); assert.ok(!Object.hasOwn(revoked, 'digest'));
  assert.equal((await bearerRequest(key.token, '/bins')).status, 401);
  assert.deepEqual((await (await request('/keys/' + key.key.id, { method: 'DELETE' })).json()).key, revoked);
  assert.equal((await request('/keys/' + crypto.randomUUID(), { method: 'DELETE' })).status, 404);
});
test('concurrent authentication and revocation never reactivate a revoked key or overwrite its revocation timestamp', async () => {
  const key = await apiKey();
  const responses = await Promise.all([
    ...Array.from({ length: 8 }, () => bearerRequest(key.token, '/bins')),
    request('/keys/' + key.key.id, { method: 'DELETE' }),
    request('/keys/' + key.key.id, { method: 'DELETE' }),
  ]);
  for (const response of responses.slice(0, 8)) assert.ok([200, 401].includes(response.status));
  for (const response of responses.slice(8)) assert.equal(response.status, 200);
  const records = await Promise.all(responses.slice(8).map(response => response.json()));
  assert.equal(records[0].key.revokedAt, records[1].key.revokedAt);
  const stored = await (await bucket.get(`keys/${key.key.id}/meta.json`)).json();
  assert.equal(stored.revokedAt, records[0].key.revokedAt);
  for (const response of await Promise.all(Array.from({ length: 4 }, () => bearerRequest(key.token, '/bins')))) assert.equal(response.status, 401);
});

test('Cookie writes reject foreign or null Origins while trusted Session scripts and scoped Bearer clients keep working', async () => {
  const id = crypto.randomUUID();
  for (const origin of ['https://foreign.example', 'null']) {
    for (const [path, method] of [['/keys', 'POST'], ['/keys/' + id, 'DELETE'], ['/bins', 'POST'], ['/bins/' + id, 'PUT'], ['/collections', 'POST'], ['/schemas', 'POST']]) {
      const response = await request(path, { method, origin, value: method === 'DELETE' ? undefined : {} });
      assert.equal(response.status, 403); assert.equal((await response.json()).error, 'origin_not_allowed');
    }
  }
  const sameOrigin = await request('/keys', { method: 'POST', origin: 'http://localhost', value: { name: '同源密钥', scopes: ['bin:create'] } });
  assert.equal(sameOrigin.status, 201); const key = await sameOrigin.json();
  const external = await bearerRequest(key.token, '/bins', { method: 'POST', origin: 'https://external.example', value: { name: '脚本创建', value: null } });
  assert.equal(external.status, 201);
  assert.equal((await request('/keys', { method: 'POST', value: { name: '可信脚本', scopes: ['bin:read'] } })).status, 201);
});
