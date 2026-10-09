import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, cookie, bucket;
const password = randomBytes(32).toString('hex');
const sessionSecret = randomBytes(32).toString('hex');
export async function request(path, { method = 'GET', value, etag, authenticated = true, authorization, origin, body, contentType = 'application/json', headers = {} } = {}) {
  return mf.dispatchFetch('http://localhost/api/v1' + path, {
    method,
    headers: {
      'Content-Type': contentType,
      'CF-Connecting-IP': '203.0.113.28',
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
      ...(authorization !== undefined ? { Authorization: authorization } : {}),
      ...(origin !== undefined ? { Origin: origin } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body } : value !== undefined ? { body: JSON.stringify(value) } : {}),
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
    compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], kvNamespaces: ['CACHE'], durableObjects: { RATE_LIMITER: { className: 'ApiRateLimiter', useSQLite: true } },
    bindings: { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: sessionSecret },
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
  assert.ok((await (await bucket.get(`bins/${bin.meta.id}/meta.json`)).json()).deletedAt);
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
  assert.equal((await request('/bins/' + bin.meta.id, { authenticated: false })).status, 200);
});
test('metadata validation rejects empty, oversized, unknown and invalid fields', async () => {
  const bin = await create(); const path = '/bins/' + bin.meta.id + '/meta';
  for (const value of [{}, { name: ' ' }, { name: 'a'.repeat(161) }, { description: 'a'.repeat(1001) },
    { visibility: 'invalid' }, { currentVersion: 9 }, { locked: 'false' }]) {
    assert.equal((await request(path, { method: 'PATCH', value })).status, 422, JSON.stringify(value));
  }
  assert.equal((await request(path, { method: 'PATCH', authenticated: false, value: { name: 'x' } })).status, 401);
  // Metadata is uniformly preconditioned: no If-Match -> 428, regardless of fields.
  for (const field of [{ name: 'x' }, { slug: 'unprotected-slug' }, { tags: ['t'] }, { favorite: true }, { pinned: true },
    { visibility: 'public' }, { collectionId: null }, { schemaId: null }, { contentSearchMode: 'all' }, { locked: true }, { expiresAt: null }]) {
    assert.equal((await request(path, { method: 'PATCH', value: field })).status, 428, JSON.stringify(field));
  }
  assert.equal((await request('/bins/missing/meta', { method: 'PATCH', etag: '"x"', value: { name: 'x' } })).status, 404);
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, locked: true }));
  assert.equal((await request(path, { method: 'PATCH', etag: bin.etag, value: { name: 'x' } })).status, 423);
});

test('P13: custom slug, alias endpoints, tags, favorite and pinned filtering', async () => {
  const slug = 'my-test-slug';
  const createdRes = await request('/bins', {
    method: 'POST',
    value: {
      name: 'Slug Bin',
      slug,
      tags: ['cloudflare', 'config'],
      favorite: true,
      pinned: true,
      value: { hello: 'slug-world' },
    },
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  assert.equal(created.meta.slug, slug);
  assert.deepEqual(created.meta.tags, ['cloudflare', 'config']);
  assert.equal(created.meta.favorite, true);
  assert.equal(created.meta.pinned, true);

  const conflictRes = await request('/bins', {
    method: 'POST',
    value: {
      name: 'Conflict Bin',
      slug,
      value: { foo: 'bar' },
    },
  });
  assert.equal(conflictRes.status, 409);
  assert.equal((await conflictRes.json()).error, 'slug_conflict');

  const readBySlug = await request('/b/' + slug);
  assert.equal(readBySlug.status, 200);
  const readData = await readBySlug.json();
  assert.equal(readData.meta.id, created.meta.id);
  assert.deepEqual(readData.value, { hello: 'slug-world' });

  const readValueBySlug = await request(`/b/${slug}/value/hello`);
  assert.equal(readValueBySlug.status, 200);
  const valueData = await readValueBySlug.json();
  assert.equal(valueData.value, 'slug-world');

  const newSlug = 'my-updated-slug';
  const metaUpdateRes = await request('/bins/' + created.meta.id + '/meta', {
    method: 'PATCH',
    etag: created.etag,
    value: { slug: newSlug, favorite: false },
  });
  assert.equal(metaUpdateRes.status, 200);
  const updatedMeta = await metaUpdateRes.json();
  assert.equal(updatedMeta.meta.slug, newSlug);
  assert.equal(updatedMeta.meta.favorite, false);

  assert.equal((await request('/b/' + slug)).status, 404);
  assert.equal((await request('/b/' + newSlug)).status, 200);

  await create();
  const listAll = await (await request('/bins')).json();
  assert.equal(listAll.items[0].id, created.meta.id);
  assert.equal(listAll.items[0].pinned, true);

  const tagFilter = await (await request('/bins?tag=cloudflare')).json();
  assert.equal(tagFilter.items.length, 1);
  assert.equal(tagFilter.items[0].id, created.meta.id);

  const favFilter = await (await request('/bins?favorite=true')).json();
  assert.equal(favFilter.items.some(i => i.id === created.meta.id), false);
});

test('P15: clone Bin creates private copy preserving JSON, tags, and schema revision', async () => {
  const schema = await (await request('/schemas', {
    method: 'POST',
    value: { name: 'Simple Schema', schema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
  })).json();

  const bin = await (await request('/bins', {
    method: 'POST',
    value: {
      name: 'Original Bin',
      slug: 'original-slug',
      tags: ['important', 'v1'],
      favorite: true,
      pinned: true,
      value: { count: 42 },
      schemaId: schema.meta.id,
    },
  })).json();

  // 1. Precondition required
  const noEtag = await request(`/bins/${bin.meta.id}/clone`, { method: 'POST', etag: undefined });
  console.log("NoEtag status:", noEtag.status, await noEtag.text());
  assert.equal(noEtag.status, 428);

  // 2. ETag conflict
  const wrongEtag = await request(`/bins/${bin.meta.id}/clone`, { method: 'POST', headers: { 'If-Match': '"wrong"' } });
  assert.equal(wrongEtag.status, 412);

  // 3. Successful Clone
  const clonedRes = await request(`/bins/${bin.meta.id}/clone`, { method: 'POST', etag: bin.etag });
  assert.equal(clonedRes.status, 201);
  const cloned = await clonedRes.json();

  assert.notEqual(cloned.meta.id, bin.meta.id);
  assert.equal(cloned.meta.name, 'Original Bin - 副本');
  assert.equal(cloned.meta.slug, null); // Slug not cloned
  assert.equal(cloned.meta.favorite, false); // favorite reset
  assert.equal(cloned.meta.pinned, false); // pinned reset
  assert.equal(cloned.meta.visibility, 'private'); // visibility reset to private
  assert.equal(cloned.meta.schemaId, schema.meta.id);
  assert.equal(cloned.meta.schemaRevision, 1);
  assert.deepEqual(cloned.meta.tags, ['important', 'v1']);
  assert.deepEqual(cloned.value, { count: 42 });

  // 4. Save as Template
  const tplRes = await request(`/bins/${bin.meta.id}/save-as-template`, {
    method: 'POST',
    etag: bin.etag,
    value: { name: 'My Template' },
  });
  assert.equal(tplRes.status, 201);
  const tpl = await tplRes.json();
  assert.equal(tpl.meta.name, 'My Template');
  assert.equal(tpl.meta.schemaId, schema.meta.id);
  assert.deepEqual(tpl.value, { count: 42 });

  // 5. Template list and create bin from template
  const tplListRes = await request('/templates');
  const tplList = await tplListRes.json();
  assert.equal(tplList.items.some(t => t.id === tpl.meta.id), true);

  const fromTplRes = await request(`/templates/${tpl.meta.id}/create-bin`, {
    method: 'POST',
    value: { name: 'From Template Bin' },
  });
  assert.equal(fromTplRes.status, 201);
  const fromTplBin = await fromTplRes.json();
  assert.equal(fromTplBin.meta.name, 'From Template Bin');
  assert.deepEqual(fromTplBin.value, { count: 42 });
  assert.equal(fromTplBin.meta.schemaId, schema.meta.id);
});

test('P16: batch operations execute independent CAS and report per-item status', async () => {
  const bin1 = await create({ item: 1 });
  const bin2 = await create({ item: 2 });
  const bin3 = await create({ item: 3 });

  // Lock bin3
  await request(`/bins/${bin3.meta.id}/meta`, {
    method: 'PATCH',
    etag: bin3.etag,
    value: { locked: true },
  });
  const lockedBin3 = await (await request(`/bins/${bin3.meta.id}`)).json();

  // Run batch add_tags
  const batchRes = await request('/bins/batch', {
    method: 'POST',
    value: {
      operation: 'add_tags',
      items: [
        { id: bin1.meta.id, etag: bin1.etag }, // Should succeed
        { id: bin2.meta.id, etag: '"wrong_etag"' }, // Should fail with etag_conflict
        { id: lockedBin3.meta.id, etag: lockedBin3.etag }, // Should fail with locked
      ],
      payload: {
        tags: ['batch-test'],
      },
    },
  });

  assert.equal(batchRes.status, 200);
  const data = await batchRes.json();
  assert.equal(data.results.length, 3);
  assert.deepEqual(data.results, [
    { id: bin1.meta.id, status: 'updated' },
    { id: bin2.meta.id, status: 'etag_conflict' },
    { id: lockedBin3.meta.id, status: 'locked' },
  ]);

  // Check bin1 was updated with tag
  const check1 = await (await request(`/bins/${bin1.meta.id}`)).json();
  assert.deepEqual(check1.meta.tags, ['batch-test']);

  // Check duplicate IDs rejected by batch validation
  const duplicateBatch = await request('/bins/batch', {
    method: 'POST',
    value: {
      operation: 'set_favorite',
      items: [
        { id: bin1.meta.id, etag: bin1.etag },
        { id: bin1.meta.id, etag: bin1.etag },
      ],
    },
  });
  assert.equal(duplicateBatch.status, 422);
});

test('oversized batch, metadata and publish bodies are rejected by the byte budget before parsing', async () => {
  const oversized = 'x'.repeat(64 * 1024 + 1);
  // The batch budget applies before authentication: no credentials needed.
  const batch = await request('/bins/batch', { method: 'POST', authenticated: false, body: oversized });
  assert.equal(batch.status, 413);
  assert.deepEqual(await batch.json(), { error: 'payload_too_large' });

  const bin = await create();
  const meta = await request(`/bins/${bin.meta.id}/meta`, { method: 'PATCH', etag: bin.etag, body: oversized });
  assert.equal(meta.status, 413);
  assert.deepEqual(await meta.json(), { error: 'payload_too_large' });

  const publish = await request(`/bins/${bin.meta.id}/publish`, { method: 'POST', etag: bin.etag, body: oversized });
  assert.equal(publish.status, 413);
  assert.deepEqual(await publish.json(), { error: 'payload_too_large' });
});

test('P17: GET /api/v1/openapi.json serves valid OpenAPI 3.1 schema covering routes and security', async () => {
  const res = await request('/openapi.json');
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.title, 'JSONBin API');
  assert.equal(Boolean(spec.paths['/bins']), true);
  assert.equal(Boolean(spec.paths['/bins/batch']), true);
  assert.equal(Boolean(spec.paths['/bins/{id}/clone']), true);
  assert.equal(Boolean(spec.paths['/templates']), true);
  assert.equal(Boolean(spec.components.securitySchemes.CookieAuth), true);
  assert.equal(Boolean(spec.components.securitySchemes.BearerAuth), true);
});

test('P19: searchJsonContent scans active Bins with contentSearchMode and matches keys or values', async () => {
  const binOff = await create({ secret: 'hidden-off-value' });
  const binKeys = await create({ myCustomKey: 'myCustomValue' });
  const binAll = await create({ user: 'alice', config: { server: 'node-01' } });

  // Update contentSearchMode
  await request(`/bins/${binKeys.meta.id}/meta`, {
    method: 'PATCH',
    etag: binKeys.etag,
    value: { contentSearchMode: 'keys' },
  });
  await request(`/bins/${binAll.meta.id}/meta`, {
    method: 'PATCH',
    etag: binAll.etag,
    value: { contentSearchMode: 'all' },
  });

  // 1. Search for value 'hidden-off-value' in binOff (contentSearchMode: off) -> 0 matches
  const resOff = await request('/search/content?q=hidden-off-value');
  assert.equal(resOff.status, 200);
  assert.equal((await resOff.json()).items.length, 0);

  // 2. Search for key 'myCustomKey' in binKeys -> 1 match
  const resKey = await request('/search/content?q=myCustomKey');
  assert.equal(resKey.status, 200);
  const dataKey = await resKey.json();
  assert.equal(dataKey.items.some(i => i.binId === binKeys.meta.id && i.matchType === 'key'), true);

  // 3. Search for value 'myCustomValue' in binKeys (mode keys only) -> should not match value
  const resValInKeys = await request('/search/content?q=myCustomValue');
  assert.equal(resValInKeys.status, 200);
  assert.equal((await resValInKeys.json()).items.some(i => i.binId === binKeys.meta.id), false);

  // 4. Search for value 'alice' in binAll (mode all) -> 1 match
  const resAll = await request('/search/content?q=alice');
  assert.equal(resAll.status, 200);
  const dataAll = await resAll.json();
  assert.equal(dataAll.items.some(i => i.binId === binAll.meta.id && i.matchType === 'value' && i.snippet === 'alice'), true);
});

test('P20: configuration publish, rollback and /published endpoints honor pointers', async () => {
  const bin = await create({ env: 'development', port: 3000 });
  const path = `/bins/${bin.meta.id}`;

  // Update to v2
  const v2Res = await request(path, {
    method: 'PUT',
    etag: bin.etag,
    value: { value: { env: 'staging', port: 4000 } },
  });
  const v2 = await v2Res.json();
  assert.equal(v2.meta.currentVersion, 2);

  // 1. Initially no published version -> 404
  const noPubRes = await request(`${path}/published`);
  assert.equal(noPubRes.status, 404);

  // 2. Publish v1 explicitly
  const pubV1Res = await request(`${path}/publish`, {
    method: 'POST',
    etag: v2.etag,
    value: { version: 1 },
  });
  assert.equal(pubV1Res.status, 200);
  const pubV1 = await pubV1Res.json();
  assert.equal(pubV1.meta.publishedVersion, 1);
  assert.equal(pubV1.meta.currentVersion, 2); // currentVersion remains untouched!

  // 3. Read published endpoint -> returns v1 content
  const readPub1 = await (await request(`${path}/published`)).json();
  assert.deepEqual(readPub1.value, { env: 'development', port: 3000 });

  // 4. Update to v3
  const v3Res = await request(path, {
    method: 'PUT',
    etag: pubV1.etag,
    value: { value: { env: 'production', port: 8080 } },
  });
  const v3 = await v3Res.json();
  assert.equal(v3.meta.currentVersion, 3);

  // Published remains v1
  const readPubStill1 = await (await request(`${path}/published`)).json();
  assert.deepEqual(readPubStill1.value, { env: 'development', port: 3000 });

  // 5. Publish currentVersion (defaults to latest v3)
  const pubV3Res = await request(`${path}/publish`, {
    method: 'POST',
    etag: v3.etag,
  });
  assert.equal(pubV3Res.status, 200);
  const pubV3 = await pubV3Res.json();
  assert.equal(pubV3.meta.publishedVersion, 3);

  // 6. Rollback publication to v2
  const rollbackRes = await request(`${path}/rollback`, {
    method: 'POST',
    etag: pubV3.etag,
    value: { version: 2 },
  });
  assert.equal(rollbackRes.status, 200);
  const rolledBack = await rollbackRes.json();
  assert.equal(rolledBack.meta.publishedVersion, 2);

  // Read published endpoint -> returns v2 content!
  const readPub2 = await (await request(`${path}/published`)).json();
  assert.deepEqual(readPub2.value, { env: 'staging', port: 4000 });
});

test('version change message: saved with X-JSONBin-Message and returned in version history', async () => {
  const bin = await create({ initial: true });
  const path = '/bins/' + bin.meta.id;

  // Save v2 with a message header
  const updated = await request(path, {
    method: 'PUT',
    etag: bin.etag,
    headers: { 'X-JSONBin-Message': encodeURIComponent('修复支付网关超时配置') },
    value: { value: { initial: false, timeout: 15 } },
  });
  assert.equal(updated.status, 200);
  const v2 = await updated.json();
  assert.equal(v2.meta.currentVersion, 2);

  // Save v3 without a message
  const updated3 = await request(path, {
    method: 'PUT',
    etag: v2.etag,
    value: { value: { initial: false, timeout: 30 } },
  });
  assert.equal(updated3.status, 200);

  // List versions: v2 has the message, v3 does not
  const versions = await (await request(path + '/versions')).json();
  assert.equal(versions.items.length, 3);
  const v2Item = versions.items.find(v => v.version === 2);
  const v3Item = versions.items.find(v => v.version === 3);
  assert.equal(v2Item.message, '修复支付网关超时配置');
  assert.equal(v3Item.message, undefined);
});

test('content negotiation: YAML, TOML and .env exports on bin and published endpoints', async () => {
  const bin = await create({ DB_HOST: '10.0.0.1', PORT: 8080, name: 'prod' });
  const path = '/bins/' + bin.meta.id;

  // 1. YAML via Accept header
  const yamlRes = await request(path, { headers: { Accept: 'application/x-yaml' } });
  assert.equal(yamlRes.status, 200);
  assert.match(yamlRes.headers.get('content-type') || '', /yaml/);
  const yamlText = await yamlRes.text();
  assert.match(yamlText, /DB_HOST: 10\.0\.0\.1/);
  assert.match(yamlText, /PORT: 8080/);

  // 2. TOML via Accept header
  const tomlRes = await request(path, { headers: { Accept: 'application/toml' } });
  assert.equal(tomlRes.status, 200);
  const tomlText = await tomlRes.text();
  assert.match(tomlText, /DB_HOST = "10\.0\.0\.1"/);
  assert.match(tomlText, /PORT = 8080/);

  // 3. .env via Accept header
  const envRes = await request(path, { headers: { Accept: 'text/x-env' } });
  assert.equal(envRes.status, 200);
  const envText = await envRes.text();
  assert.match(envText, /DB_HOST=10\.0\.0\.1/);
  assert.match(envText, /PORT=8080/);
  assert.match(envText, /NAME=prod/);
  // 4. Publish then fetch published as YAML
  const pubRes = await request(path + '/publish', { method: 'POST', etag: (await (await request(path)).json()).etag });
  assert.equal(pubRes.status, 200);

  const pubYamlRes = await request(path + '/published', { headers: { Accept: 'text/yaml' } });
  assert.equal(pubYamlRes.status, 200);
  assert.match(await pubYamlRes.text(), /DB_HOST: 10\.0\.0\.1/);

  // 5. Default stays JSON
  const jsonRes = await request(path);
  assert.match(jsonRes.headers.get('content-type') || '', /application\/json/);
});

test('P22: JSON Patch RFC 6902 operations (add, remove, replace, move, copy, test)', async () => {
  const bin = await create({
    server: { port: 8080, host: '127.0.0.1' },
    items: ['item1', 'item2'],
    successRate: 90,
  });
  const path = '/bins/' + bin.meta.id;

  // 1. Successful JSON Patch with multiple operations
  const patchRes = await request(path, {
    method: 'PATCH',
    etag: bin.etag,
    contentType: 'application/json-patch+json',
    value: [
      { op: 'test', path: '/successRate', value: 90 },
      { op: 'replace', path: '/successRate', value: 99 },
      { op: 'add', path: '/items/-', value: 'item3' },
      { op: 'copy', from: '/server/port', path: '/oldPort' },
      { op: 'move', from: '/server/host', path: '/server/hostname' },
    ],
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.meta.currentVersion, 2);
  assert.equal(patched.value.successRate, 99);
  assert.deepEqual(patched.value.items, ['item1', 'item2', 'item3']);
  assert.equal(patched.value.oldPort, 8080);
  assert.equal(patched.value.server.hostname, '127.0.0.1');
  assert.equal(patched.value.server.host, undefined);

  // 2. Test failure returns 409 conflict and prevents version bump
  const testFailRes = await request(path, {
    method: 'PATCH',
    etag: patched.etag,
    contentType: 'application/json-patch+json',
    value: [
      { op: 'test', path: '/successRate', value: 50 }, // Should fail
      { op: 'replace', path: '/successRate', value: 100 },
    ],
  });
  assert.equal(testFailRes.status, 409);
  const failData = await testFailRes.json();
  assert.equal(failData.error, 'json_patch_test_failed');
  assert.equal(failData.operation, 0);
  assert.equal(failData.path, '/successRate');

  // Value must remain untouched
  const checkUnchanged = await (await request(path)).json();
  assert.equal(checkUnchanged.meta.currentVersion, 2);
  assert.equal(checkUnchanged.value.successRate, 99);

  // 3. Remove operation
  const removeRes = await request(path, {
    method: 'PATCH',
    etag: patched.etag,
    contentType: 'application/json-patch+json',
    value: [{ op: 'remove', path: '/oldPort' }],
  });
  assert.equal(removeRes.status, 200);
  const afterRemove = await removeRes.json();
  assert.equal(afterRemove.meta.currentVersion, 3);
  assert.equal(afterRemove.value.oldPort, undefined);

  // 4. Backward compatibility: application/json without header still does RFC 7396 Merge Patch
  const mergeRes = await request(path, {
    method: 'PATCH',
    etag: afterRemove.etag,
    contentType: 'application/json',
    value: { successRate: 100 },
  });
  assert.equal(mergeRes.status, 200);
  const afterMerge = await mergeRes.json();
  assert.equal(afterMerge.value.successRate, 100);
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
  assert.equal((await request(path, { method: 'DELETE' })).status, 423);
  const locked = await (await request(path)).json();
  const unlocked = await (await request(path + '/meta', { method: 'PATCH', etag: locked.etag, value: { locked: false } })).json();
  assert.equal((await request(path, { method: 'DELETE', etag: unlocked.etag })).status, 200);
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
  const detachedEtag = (await (await request('/bins/' + bins[0].meta.id)).json()).etag;
  assert.equal((await request('/bins/' + bins[0].meta.id + '/meta', { method: 'PATCH', etag: detachedEtag, value: { collectionId: collection.meta.id } })).status, 409);
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
  const { usageApproximate, usageAsOf, usageStatus, ...legacyFields } = publicRecord;
  assert.deepEqual(legacyFields, created.key, 'all pre-existing API Key fields retain their original contract');
  assert.equal(usageApproximate, true);
  assert.equal(usageStatus, 'ok');
  assert.ok(Number.isFinite(Date.parse(usageAsOf)), 'approximate usage indicates snapshot time');
  assert.ok(!JSON.stringify(listed).includes(created.token));
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
    ['/search?q=example', 'GET', ['bin:read', 'collection:read', 'schema:read'], undefined, 200],
    ['/search?q=example&type=bin', 'GET', ['bin:read', 'collection:read'], undefined, 200],
    ['/search?q=example&type=collection', 'GET', ['collection:read'], undefined, 200],
    ['/search?q=example&type=schema', 'GET', ['schema:read'], undefined, 200],
    ['/bins', 'GET', ['bin:read'], undefined, 200], ['/bins', 'POST', ['bin:create'], {}, 422],
    [`/bins/${id}`, 'GET', ['bin:read'], undefined, 404], [`/bins/${id}`, 'PUT', ['bin:update'], { value: null }, 404],
    [`/bins/${id}`, 'PATCH', ['bin:update'], {}, 404],
    [`/bins/${id}/value`, 'GET', ['bin:read'], undefined, 404], [`/bins/${id}/value/child`, 'GET', ['bin:read'], undefined, 404],
    [`/bins/${id}/value`, 'PUT', ['bin:update'], { value: null }, 404], [`/bins/${id}/value/child`, 'PUT', ['bin:update'], { value: null }, 404],
    [`/bins/${id}/meta`, 'PATCH', ['bin:update'], { name: 'x' }, 404], [`/bins/${id}`, 'DELETE', ['bin:delete'], undefined, 404],
    [`/bins/${id}/versions`, 'GET', ['history:read'], undefined, 404], [`/bins/${id}/versions/1`, 'GET', ['history:read'], undefined, 404],
    [`/bins/${id}/versions/1/restore`, 'POST', ['bin:update', 'history:read'], undefined, 404],
    ['/trash/bins', 'GET', ['bin:read'], undefined, 200],
    [`/trash/bins/${id}/restore`, 'POST', ['bin:update', 'history:read'], undefined, 404],
    [`/trash/bins/${id}`, 'DELETE', ['bin:delete'], undefined, 404],
    ['/trash/bins/purge', 'POST', ['bin:delete'], {}, 422],
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
    if (required[0] === 'bin:update') assert.equal((await bearerRequest(key.token, `/trash/bins/${id}/restore`, { method: 'POST', etag: '"unused"' })).status, 404);
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
test('request-time key R2 metadata is unchanged, expiry and revocation reject future requests', async () => {
  const key = await apiKey();
  const path = `keys/${key.key.id}/meta.json`, stored = () => bucket.get(path).then(object => object.json());
  assert.equal((await bearerRequest(key.token, '/collections')).status, 403); assert.equal((await stored()).lastUsedAt, null);
  assert.equal((await bearerRequest(key.token, '/bins')).status, 200);
  assert.equal((await stored()).lastUsedAt, null, 'usage bookkeeping must not write R2 per request');
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
    for (const [path, method] of [['/keys', 'POST'], ['/keys/' + id, 'DELETE'], ['/bins', 'POST'], ['/bins/' + id, 'PUT'], ['/collections', 'POST'], ['/schemas', 'POST'], ['/trash/bins/' + id + '/restore', 'POST'], ['/trash/bins/' + id, 'DELETE'], ['/trash/bins/purge', 'POST']]) {
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

test('Merge Patch follows RFC 7396 examples and always appends immutable versions', async () => {
  const cases = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }], [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}], [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }], [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }], [['a', 'b'], ['c', 'd'], ['c', 'd']],
    [{ a: 'b' }, ['c'], ['c']], [{ a: 'foo' }, null, null], [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }], [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ];
  for (const [original, patch, expected] of cases) {
    const bin = await create(original), path = '/bins/' + bin.meta.id;
    const response = await request(path, { method: 'PATCH', etag: bin.etag, value: patch, contentType: 'application/merge-patch+json' });
    assert.equal(response.status, 200); const record = await response.json();
    assert.deepEqual(record.value, expected); assert.equal(record.meta.currentVersion, 2);
    assert.equal(response.headers.get('etag'), record.etag); assert.equal(response.headers.get('x-jsonbin-version'), '2');
    assert.deepEqual((await (await request(path + '/versions/1')).json()).value, original);
  }
});

test('deep paths read and update objects, empty keys, escaped keys and array elements, append with dash and replace root', async () => {
  const value = { settings: { theme: 'dark' }, items: [{ count: 1 }, false], 'a/b': { '~key': 'escaped' }, '': null, '中文 空格': 'unicode', '%2F': 'once' };
  let bin = await create(value); const path = '/bins/' + bin.meta.id;
  for (const [suffix, expected] of [['', value], ['/settings/theme', 'dark'], ['/items/1', false], ['/a~1b/~0key', 'escaped'], ['/', null], ['/' + encodeURIComponent('中文 空格'), 'unicode'], ['/%252F', 'once']]) {
    const response = await request(path + '/value' + suffix); assert.equal(response.status, 200);
    const record = await response.json(); assert.deepEqual(record.value, expected);
    assert.equal(record.etag, bin.etag); assert.equal(response.headers.get('etag'), bin.etag); assert.equal(record.version, 1);
  }
  for (const [suffix, value] of [['/items/0/count', 2], ['/settings/new', null], ['/items/-', { appended: true }], ['/a~1b/~0key', 9], ['/', 'empty']]) {
    const response = await request(path + '/value' + suffix, { method: 'PUT', etag: bin.etag, value: { value } });
    assert.equal(response.status, 200); bin = await response.json();
    const readSuffix = suffix === '/items/-' ? '/items/2' : suffix;
    assert.deepEqual((await (await request(path + '/value' + readSuffix)).json()).value, value);
  }
  assert.deepEqual(bin.value.items, [{ count: 2 }, false, { appended: true }]);
  assert.equal(bin.value.settings.theme, 'dark'); assert.equal(bin.meta.currentVersion, 6);
  const root = await request(path + '/value', { method: 'PUT', etag: bin.etag, value: { value: false } });
  assert.equal(root.status, 200); assert.equal((await root.json()).value, false);
  assert.deepEqual((await (await request(path + '/versions/1')).json()).value, value);
});

test('paths never traverse prototypes, create missing parents or sparse arrays; invalid JSON and paths leave versions unchanged', async () => {
  const bin = await create({ items: [1], scalar: null }), path = '/bins/' + bin.meta.id;
  for (const suffix of ['/absent/child', '/items/01', '/items/-1', '/items/1', '/items/1e0', '/items/9007199254740992', '/scalar/child', '/constructor/prototype', '/__proto__/polluted']) {
    assert.equal((await request(path + '/value' + suffix)).status, 404, suffix);
    assert.equal((await request(path + '/value' + suffix, { method: 'PUT', etag: bin.etag, value: { value: true } })).status, 404, suffix);
  }
  for (const suffix of ['/bad~2', '/bad~', '/bad%ZZ', '/bad%FF', '/' + Array(129).fill('x').join('/')]) {
    assert.equal((await request(path + '/value' + suffix)).status, 422);
    assert.equal((await request(path + '/value' + suffix, { method: 'PUT', etag: bin.etag, value: { value: true } })).status, 422);
  }
  for (const [suffix, method] of [['', 'PATCH'], ['/value/items/0', 'PUT']]) {
    assert.equal((await request(path + suffix, { method, value: {} })).status, 428);
    for (const body of ['', '{bad']) assert.equal((await request(path + suffix, { method, etag: bin.etag, body })).status, 422);
  }
  for (const value of [{}, { value: null, extra: true }, null]) {
    assert.equal((await request(path + '/value/items/0', { method: 'PUT', etag: bin.etag, value })).status, 422);
  }
  let patch = { x: true }; for (let i = 0; i < 130; i++) patch = { x: patch };
  assert.equal((await request(path, { method: 'PATCH', etag: bin.etag, value: patch })).status, 422);
  assert.deepEqual(await (await request(path)).json(), bin);
  assert.equal((await (await request(path + '/versions')).json()).total, 1);
});

test('prototype-related keys remain literal JSON data in merges and path writes', async () => {
  const original = JSON.parse('{"__proto__":{"existing":true},"constructor":{"prototype":{"safe":true}}}');
  let bin = await create(original); const path = '/bins/' + bin.meta.id;
  let response = await request(path, { method: 'PATCH', etag: bin.etag, body: '{"__proto__":{"new":true},"constructor":{"prototype":{"added":true}}}' });
  assert.equal(response.status, 200); bin = await response.json();
  assert.deepEqual(bin.value.__proto__, { existing: true, new: true });
  assert.deepEqual(bin.value.constructor.prototype, { safe: true, added: true });
  response = await request(path + '/value/__proto__/new', { method: 'PUT', etag: bin.etag, value: { value: false } });
  assert.equal(response.status, 200); bin = await response.json(); assert.equal(bin.value.__proto__.new, false);
  const clean = await create({});
  assert.equal((await request('/bins/' + clean.meta.id + '/value/new')).status, 404);
  assert.equal((await request('/bins/' + clean.meta.id + '/value/added')).status, 404);
});

test('Merge Patch and deep writes validate the complete pinned schema before reserving a version', async () => {
  const schema = await model(), bin = await boundBin(schema, { count: 2 }, true), path = '/bins/' + bin.meta.id;
  for (const [suffix, method, value] of [['', 'PATCH', { count: null }], ['', 'PATCH', { count: 'bad' }], ['/value/count', 'PUT', { value: 'bad' }]]) {
    const response = await request(path + suffix, { method, value, etag: bin.etag });
    assert.equal(response.status, 422); const body = await response.json();
    assert.equal(body.error, 'schema_validation_failed'); assert.ok(body.issues.some(issue => issue.path === '#/count'));
  }
  assert.deepEqual(await (await request(path)).json(), bin); assert.equal((await (await request(path + '/versions')).json()).total, 1);
  let saved = await (await request(path, { method: 'PATCH', value: { count: 5 }, etag: bin.etag })).json();
  const response = await request(path + '/value/count', { method: 'PUT', value: { value: 6 }, etag: saved.etag });
  assert.equal(response.status, 200); saved = await response.json();
  assert.equal(saved.meta.schemaLocked, true); assert.equal(saved.meta.schemaRevision, 1); assert.deepEqual(saved.value, { count: 6 });
});

test('data lock blocks all mutations and deletion, requires isolated conditional unlock, and preserves the schema lock', async () => {
  const schema = await model(), bin = await boundBin(schema, { count: 2 }, true), path = '/bins/' + bin.meta.id;
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { locked: true } })).status, 428);
  const response = await request(path + '/meta', { method: 'PATCH', value: { locked: true }, etag: bin.etag });
  assert.equal(response.status, 200); const locked = await response.json(); assert.equal(locked.meta.currentVersion, 1);
  assert.notEqual(locked.etag, bin.etag); assert.equal(locked.meta.locked, true);
  for (const [suffix, method, value] of [['', 'PUT', { value: { count: 3 } }], ['', 'PATCH', { count: 3 }], ['/value/count', 'PUT', { value: 3 }],
    ['/meta', 'PATCH', { name: 'changed' }], ['/meta', 'PATCH', { locked: false, name: 'bypass' }], ['/meta', 'PATCH', { locked: false, schemaLocked: false }],
    ['/versions/1/restore', 'POST'], ['', 'DELETE']]) {
    assert.equal((await request(path + suffix, { method, value, etag: locked.etag })).status, 423, `${method} ${suffix}`);
  }
  for (const suffix of ['', '/value/count', '/versions', '/versions/1']) assert.equal((await request(path + suffix)).status, 200);
  assert.deepEqual(await (await request(path)).json(), locked);
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { locked: false } })).status, 428);
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { locked: false }, etag: bin.etag })).status, 412);
  const unlocked = await (await request(path + '/meta', { method: 'PATCH', value: { locked: false }, etag: locked.etag })).json();
  assert.equal(unlocked.meta.locked, false); assert.equal(unlocked.meta.schemaLocked, true); assert.equal(unlocked.meta.currentVersion, 1);
  assert.equal((await request(path, { method: 'PATCH', value: { count: 4 }, etag: unlocked.etag })).status, 200);
});

test('public access exposes only the current snapshot and paths, respects explicit credentials and immediately follows visibility changes', async () => {
  const bin = await create({ secret: 'old private version' }), path = '/bins/' + bin.meta.id;
  const privateRead = await request(path, { authenticated: false }); assert.equal(privateRead.status, 401);
  assert.equal(privateRead.headers.get('cache-control'), 'no-store');
  const updated = await (await request(path, { method: 'PUT', etag: bin.etag, value: { value: { shared: true } } })).json();
  const published = await (await request(path + '/meta', { method: 'PATCH', etag: updated.etag, value: { visibility: 'public' } })).json();
  for (const suffix of ['', '/value', '/value/shared']) {
    const response = await request(path + suffix, { authenticated: false }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('etag'), published.etag);
    assert.deepEqual((await response.json()).value, suffix === '/value/shared' ? true : { shared: true });
    assert.equal((await request(path + suffix, { authenticated: false, authorization: 'Bearer invalid' })).status, 401);
  }
  for (const suffix of ['/versions', '/versions/1']) assert.equal((await request(path + suffix, { authenticated: false })).status, 401);
  assert.equal((await request('/bins', { authenticated: false })).status, 401);
  for (const [suffix, method, value] of [['', 'PUT', { value: {} }], ['', 'PATCH', {}], ['/value/shared', 'PUT', { value: false }], ['/meta', 'PATCH', { locked: false }], ['', 'DELETE'], ['/versions/1/restore', 'POST']]) {
    assert.equal((await request(path + suffix, { authenticated: false, method, value, etag: published.etag })).status, 401);
  }
  const lowScope = await apiKey(['bin:create']), readScope = await apiKey(['bin:read']);
  for (const suffix of ['', '/value/shared']) {
    assert.equal((await bearerRequest(lowScope.token, path + suffix, { authenticated: true })).status, 403);
    assert.equal((await bearerRequest(readScope.token, path + suffix)).status, 200);
  }
  await request('/keys/' + readScope.key.id, { method: 'DELETE' });
  assert.equal((await bearerRequest(readScope.token, path)).status, 401);
  const locked = await (await request(path + '/meta', { method: 'PATCH', etag: published.etag, value: { locked: true } })).json();
  assert.equal((await request(path + '/value/shared', { authenticated: false })).status, 200);
  const unlocked = await (await request(path + '/meta', { method: 'PATCH', etag: locked.etag, value: { locked: false } })).json();
  assert.equal((await request(path + '/meta', { method: 'PATCH', etag: unlocked.etag, value: { visibility: 'private' } })).status, 200);
  for (const suffix of ['', '/value/shared']) assert.equal((await request(path + suffix, { authenticated: false })).status, 401);
});

test('concurrent partial writes have one winner and a retry explicitly merges against the latest snapshot', async () => {
  const bin = await create({ left: 0, right: 0 }), path = '/bins/' + bin.meta.id;
  const responses = await Promise.all([
    request(path, { method: 'PATCH', value: { left: 1 }, etag: bin.etag }),
    request(path + '/value/right', { method: 'PUT', value: { value: 2 }, etag: bin.etag }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
  const winner = await responses.find(response => response.status === 200).json();
  assert.deepEqual(await (await request(path)).json(), winner);
  const loserIndex = responses.findIndex(response => response.status === 412);
  const response = await request(path, { method: 'PATCH', value: loserIndex === 0 ? { left: 1 } : { right: 2 }, etag: winner.etag });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).value, { left: 1, right: 2 });
  assert.deepEqual((await (await request(path + '/versions/1')).json()).value, bin.value);
});

test('public authorization and response share a snapshot when visibility and JSON change during a read', async () => {
  const { default: app } = await import('../dist/jsonbin/index.js');
  for (const suffix of ['', '/value/message']) {
    const bin = await (await request('/bins', { method: 'POST', value: { name: 'snapshot', visibility: 'public', value: { message: 'public' } } })).json();
    const path = '/bins/' + bin.meta.id; let changed = false;
    const data = { get: async (key, ...args) => {
      const object = await bucket.get(key, ...args);
      if (key === `bins/${bin.meta.id}/meta.json` && !changed) {
        changed = true;
        const privateBin = await (await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { visibility: 'private' } })).json();
        assert.equal((await request(path, { method: 'PUT', etag: privateBin.etag, value: { value: { message: 'private secret' } } })).status, 200);
      }
      return object;
    } };
    const limiter = await mf.getDurableObjectNamespace('RATE_LIMITER', 'jsonbin-tests');
    const response = await app.fetch(new Request('https://example.test/api/v1' + path + suffix, {
      headers: { 'CF-Connecting-IP': '203.0.113.33' },
    }), { DATA: data, SESSION_SECRET: sessionSecret, RATE_LIMITER: limiter });
    assert.equal(response.status, 200); assert.equal(changed, true);
    assert.deepEqual((await response.json()).value, suffix ? 'public' : { message: 'public' });
    assert.equal((await request(path + suffix, { authenticated: false })).status, 401);
  }
});

test('locking competes atomically with partial writes and deletion; deleted Bins cannot reappear in reads or collection counts', async () => {
  const collection = await (await request('/collections', { method: 'POST', value: { name: 'lock races' } })).json();
  for (const method of ['PATCH', 'DELETE']) {
    const bin = await (await request('/bins', { method: 'POST', value: { name: 'race', value: { count: 0 }, collectionId: collection.meta.id } })).json();
    const path = '/bins/' + bin.meta.id;
    const responses = await Promise.all([
      request(path + '/meta', { method: 'PATCH', value: { locked: true }, etag: bin.etag }),
      request(path, { method, value: method === 'PATCH' ? { count: 1 } : undefined, etag: bin.etag }),
    ]);
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.ok(responses.every(response => [200, 404, 412, 423].includes(response.status)));
    const currentResponse = await request(path);
    if (currentResponse.status === 200) {
      let current = await currentResponse.json();
      if (responses[0].status === 200) { assert.equal(current.meta.locked, true); assert.deepEqual(current.value, bin.value); }
      if (current.meta.locked) current = await (await request(path + '/meta', { method: 'PATCH', value: { locked: false }, etag: current.etag })).json();
      assert.equal((await request(path, { method: 'DELETE', etag: current.etag })).status, 200);
    } else assert.equal(currentResponse.status, 404);
    assert.equal((await request(path, { method: 'DELETE' })).status, 200); // The deleted state is idempotent.
    assert.equal((await request(path, { method: 'PATCH', etag: bin.etag, value: {} })).status, 404);
    assert.equal((await request(path + '/meta', { method: 'PATCH', etag: bin.etag, value: { locked: false } })).status, 404);
    for (const suffix of ['', '/value', '/versions', '/versions/1']) assert.equal((await request(path + suffix)).status, 404);
    assert.ok(!(await (await request('/bins')).json()).items.some(item => item.id === bin.meta.id));
    assert.ok((await (await bucket.get(`bins/${bin.meta.id}/meta.json`)).json()).deletedAt);
    assert.ok(await bucket.head(`bins/${bin.meta.id}/versions/000001.json`));
  }
  assert.equal((await (await request('/collections/' + collection.meta.id + '/bins')).json()).total, 0);
  assert.equal((await (await request('/collections')).json()).items.find(item => item.id === collection.meta.id).binCount, 0);
});

async function trashItem(id) {
  const response = await request('/trash/bins'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return (await response.json()).items.find(item => item.meta.id === id);
}
async function trashed(value = { retained: true }) {
  const bin = await create(value);
  assert.equal((await request('/bins/' + bin.meta.id, { method: 'DELETE', etag: bin.etag })).status, 200);
  return trashItem(bin.meta.id);
}
function bucketProxy(overrides) {
  return new Proxy(bucket, { get(target, property) {
    if (Object.hasOwn(overrides, property)) return overrides[property];
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
  } });
}
async function nativeRequest(data, path, { method = 'GET', etag, value } = {}) {
  const { default: worker } = await import('../dist/jsonbin/index.js');
  return worker.fetch(new Request('https://example.test/api/v1' + path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), { DATA: data, SESSION_SECRET: sessionSecret });
}

test('TTL creation and updates validate future ISO timestamps, require conditional changes and preserve JSON versions', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();
  let response = await request('/bins', { method: 'POST', value: { name: 'TTL', value: false, expiresAt: future } });
  assert.equal(response.status, 201); const bin = await response.json(), path = '/bins/' + bin.meta.id;
  assert.equal(bin.meta.expiresAt, future);
  for (const expiresAt of ['bad', '', '2000-01-01T00:00:00Z', '2099-01-01T00:00:00', 123, false]) {
    assert.equal((await request('/bins', { method: 'POST', value: { name: 'invalid TTL', value: null, expiresAt } })).status, 422);
    assert.equal((await request(path + '/meta', { method: 'PATCH', value: { expiresAt }, etag: bin.etag })).status, 422);
  }
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { expiresAt: null } })).status, 428);
  response = await request(path + '/meta', { method: 'PATCH', value: { expiresAt: null }, etag: bin.etag });
  assert.equal(response.status, 200); const cleared = await response.json();
  assert.equal(cleared.meta.expiresAt, null); assert.equal(cleared.meta.currentVersion, 1); assert.equal(cleared.value, false);
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { expiresAt: future }, etag: bin.etag })).status, 412);
  const offset = '2099-01-01T08:00:00+08:00';
  const normalized = await (await request(path + '/meta', { method: 'PATCH', value: { expiresAt: offset }, etag: cleared.etag })).json();
  assert.equal(normalized.meta.expiresAt, '2099-01-01T00:00:00.000Z');
  const locked = await (await request(path + '/meta', { method: 'PATCH', value: { locked: true }, etag: normalized.etag })).json();
  assert.equal((await request(path + '/meta', { method: 'PATCH', value: { expiresAt: null }, etag: locked.etag })).status, 423);
});

test('expired public and locked Bins immediately disappear from normal APIs and collection counts before cron runs', async () => {
  const collection = await (await request('/collections', { method: 'POST', value: { name: 'TTL members' } })).json();
  const bin = await (await request('/bins', { method: 'POST', value: { name: 'expired', value: { private: true }, visibility: 'public', collectionId: collection.meta.id } })).json();
  const path = '/bins/' + bin.meta.id, expiredAt = '2000-01-01T00:00:00.000Z';
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, expiresAt: expiredAt, locked: true }));
  for (const suffix of ['', '/value/private', '/versions', '/versions/1']) assert.equal((await request(path + suffix)).status, 404, suffix);
  for (const suffix of ['', '/value/private']) assert.equal((await request(path + suffix, { authenticated: false })).status, 401);
  for (const [suffix, method, value] of [['', 'PUT', { value: {} }], ['', 'PATCH', {}], ['/value/private', 'PUT', { value: false }], ['/meta', 'PATCH', { expiresAt: null }], ['/versions/1/restore', 'POST'], ['', 'DELETE']]) {
    assert.equal((await request(path + suffix, { method, value, etag: bin.etag })).status, 404, `${method} ${suffix}`);
  }
  assert.ok(!(await (await request('/bins')).json()).items.some(item => item.id === bin.meta.id));
  assert.equal((await (await request('/collections/' + collection.meta.id + '/bins')).json()).total, 0);
  assert.equal((await (await request('/collections')).json()).items.find(item => item.id === collection.meta.id).binCount, 0);
  const item = await trashItem(bin.meta.id); assert.equal(item.status, 'expired'); assert.equal(item.meta.deletedAt, expiredAt);
  assert.equal(item.meta.deletionReason, 'expired'); assert.equal(item.meta.locked, true);
  const readKey = await apiKey(['bin:read']);
  assert.equal((await bearerRequest(readKey.token, path)).status, 404);
  const restoredResponse = await request('/trash/bins/' + bin.meta.id + '/restore', { method: 'POST', etag: item.etag });
  assert.equal(restoredResponse.status, 200); const restored = await restoredResponse.json();
  assert.equal(restored.meta.expiresAt, null); assert.equal(restored.meta.visibility, 'private'); assert.equal(restored.meta.locked, true);
  assert.deepEqual(restored.value, bin.value); assert.equal(restored.meta.currentVersion, 1); assert.equal(await trashItem(bin.meta.id), undefined);
});

test('scheduled cleanup archives expired locked Bins conditionally and leaves active data untouched', async () => {
  const { default: worker } = await import('../dist/jsonbin/index.js');
  assert.equal(typeof worker.scheduled, 'function');
  const active = await create({ active: true }), expired = await create({ expired: true });
  await bucket.put(`bins/${expired.meta.id}/meta.json`, JSON.stringify({ ...expired.meta, locked: true, expiresAt: '2000-01-01T00:00:00Z' }));
  await worker.scheduled({}, { DATA: bucket });
  assert.deepEqual(await (await request('/bins/' + active.meta.id)).json(), active);
  const item = await trashItem(expired.meta.id); assert.equal(item.status, 'deleted'); assert.equal(item.meta.deletionReason, 'expired');
  assert.equal(item.meta.locked, true); assert.ok(await bucket.head(`bins/${expired.meta.id}/versions/000001.json`));
  const before = item.etag; await worker.scheduled({}, { DATA: bucket });
  assert.equal((await trashItem(expired.meta.id)).etag, before);
});

test('cron cannot overwrite a concurrent deadline extension after reading an expired snapshot', async () => {
  const { default: worker } = await import('../dist/jsonbin/index.js');
  const bin = await create(), key = `bins/${bin.meta.id}/meta.json`, future = new Date(Date.now() + 3600000).toISOString();
  await bucket.put(key, JSON.stringify({ ...bin.meta, expiresAt: '2000-01-01T00:00:00Z' }));
  let injected = false;
  const data = bucketProxy({ put: async (path, value, options) => {
    if (path === key && JSON.parse(value).deletionReason === 'expired') {
      injected = true;
      // Model a valid update that began before the deadline and commits while cron is running.
      await bucket.put(key, JSON.stringify({ ...bin.meta, expiresAt: future }));
    }
    return bucket.put(path, value, options);
  } });
  await worker.scheduled({}, { DATA: data }); assert.equal(injected, true);
  assert.equal((await (await request('/bins/' + bin.meta.id)).json()).meta.expiresAt, future);
  assert.equal(await trashItem(bin.meta.id), undefined);
});

test('trash authentication and preconditions protect every mutation and active Bins cannot be purged', async () => {
  const item = await trashed(), path = '/trash/bins/' + item.meta.id;
  for (const [suffix, method, value] of [['', 'DELETE'], ['/restore', 'POST']]) {
    assert.equal((await request(path + suffix, { method, value, authenticated: false, etag: item.etag })).status, 401);
    assert.equal((await request(path + suffix, { method, value })).status, 428);
    assert.equal((await request(path + suffix, { method, value, etag: 'stale' })).status, 412);
  }
  assert.equal((await request('/trash/bins', { authenticated: false })).status, 401);
  assert.equal((await request('/trash/bins/purge', { method: 'POST', authenticated: false, value: { items: [{ id: item.meta.id, etag: item.etag }] } })).status, 401);
  const active = await create();
  assert.equal((await request('/trash/bins/' + active.meta.id, { method: 'DELETE', etag: active.etag })).status, 404);
  assert.deepEqual(await (await request('/bins/' + active.meta.id)).json(), active);
  assert.ok(await bucket.head(`bins/${active.meta.id}/versions/000001.json`));
});

test('restore keeps all versions and pinned schema locks, detaches unavailable collections, clears expiry and requires a fresh trash snapshot', async () => {
  const schema = await model(), collection = await (await request('/collections', { method: 'POST', value: { name: 'restore relation' } })).json();
  const bin = await (await request('/bins', { method: 'POST', value: { name: 'restore', value: { count: 1 }, visibility: 'public', schemaId: schema.meta.id, schemaLocked: true, collectionId: collection.meta.id, expiresAt: new Date(Date.now() + 3600000).toISOString() } })).json();
  const path = '/bins/' + bin.meta.id;
  const updated = await (await request(path, { method: 'PATCH', etag: bin.etag, value: { count: 2 } })).json();
  await request(path, { method: 'DELETE', etag: updated.etag }); const item = await trashItem(bin.meta.id);
  await request('/collections/' + collection.meta.id, { method: 'DELETE', etag: collection.etag });
  await request('/schemas/' + schema.meta.id, { method: 'DELETE', etag: schema.etag });
  const response = await request('/trash/bins/' + bin.meta.id + '/restore', { method: 'POST', etag: item.etag });
  assert.equal(response.status, 200); const restored = await response.json();
  assert.equal(restored.meta.currentVersion, 2); assert.equal(restored.meta.collectionId, null); assert.equal(restored.meta.expiresAt, null);
  assert.equal(restored.meta.schemaLocked, true); assert.equal(restored.meta.schemaRevision, 1); assert.equal(restored.meta.visibility, 'private');
  assert.equal(restored.meta.deletedAt, undefined); assert.deepEqual(restored.value, { count: 2 });
  assert.equal(response.headers.get('etag'), restored.etag);
  assert.deepEqual((await (await request(path + '/versions/1')).json()).value, { count: 1 });
  assert.equal((await (await request(path + '/versions')).json()).total, 2);
  assert.equal((await request(path, { method: 'PATCH', etag: restored.etag, value: { count: 'invalid' } })).status, 422);
  await request(path, { method: 'DELETE', etag: restored.etag });
  assert.equal((await request('/trash/bins/' + bin.meta.id, { method: 'DELETE', etag: item.etag })).status, 412);
  assert.equal((await request('/trash/bins/' + bin.meta.id + '/restore', { method: 'POST', etag: item.etag })).status, 412);
});

test('missing versions and invalid schema data cannot be restored and remain available in trash', async () => {
  const schema = await model(), bin = await boundBin(schema, { count: 2 }, true);
  await request('/bins/' + bin.meta.id, { method: 'DELETE' }); const item = await trashItem(bin.meta.id), path = '/trash/bins/' + bin.meta.id + '/restore';
  const versionKey = `bins/${bin.meta.id}/versions/000001.json`;
  await bucket.put(versionKey, JSON.stringify({ count: 'invalid' }));
  assert.equal((await request(path, { method: 'POST', etag: item.etag })).status, 422);
  assert.equal((await trashItem(bin.meta.id)).etag, item.etag);
  await bucket.delete(versionKey);
  assert.equal((await request(path, { method: 'POST', etag: item.etag })).status, 409);
  assert.equal((await trashItem(bin.meta.id)).etag, item.etag);
});

test('legacy trash records can be restored or purged while canonical active and terminal records suppress stale archives', async () => {
  for (const action of ['restore', 'purge']) {
    const bin = await create({ legacy: action }), key = `bins/${bin.meta.id}/meta.json`, legacyKey = `trash/bins/${bin.meta.id}/meta.json`;
    const legacy = { ...bin.meta, deletedAt: '2026-01-01T00:00:00Z' };
    await bucket.put(legacyKey, JSON.stringify(legacy)); await bucket.delete(key);
    const item = await trashItem(bin.meta.id); assert.ok(item);
    const path = '/trash/bins/' + bin.meta.id + (action === 'restore' ? '/restore' : '');
    const response = await request(path, { method: action === 'restore' ? 'POST' : 'DELETE', etag: item.etag });
    assert.equal(response.status, 200); assert.equal(await bucket.head(legacyKey), null);
    await bucket.put(legacyKey, JSON.stringify(legacy)); // A stale P6 archival retry must not resurrect a record.
    assert.equal(await trashItem(bin.meta.id), undefined);
    if (action === 'restore') assert.deepEqual((await (await request('/bins/' + bin.meta.id)).json()).value, bin.value);
    else {
      assert.equal((await request(path + '/restore', { method: 'POST', etag: item.etag })).status, 404);
      const { default: worker } = await import('../dist/jsonbin/index.js'); await worker.scheduled({}, { DATA: bucket });
      assert.equal(await bucket.head(legacyKey), null);
    }
  }
});

test('permanent deletion paginates all versions and orphans, is retryable, and retains only a minimal non-restorable marker', async () => {
  const item = await trashed({ confidential: true }), id = item.meta.id;
  await bucket.put(`bins/${id}/versions/000002.json`, '"orphan"'); await bucket.put(`bins/${id}/versions/000003.json`, 'false');
  await bucket.put(`trash/bins/${id}/meta.json`, JSON.stringify(item.meta));
  let pages = 0;
  const data = bucketProxy({ list: async options => {
    if (options.prefix === `bins/${id}/versions/`) { pages++; return bucket.list({ ...options, limit: 1 }); }
    return bucket.list(options);
  } });
  const response = await nativeRequest(data, '/trash/bins/' + id, { method: 'DELETE', etag: item.etag });
  assert.equal(response.status, 200); assert.ok(pages >= 3);
  assert.equal((await bucket.list({ prefix: `bins/${id}/versions/` })).objects.length, 0);
  assert.equal(await bucket.head(`trash/bins/${id}/meta.json`), null);
  assert.deepEqual(await (await bucket.get(`bins/${id}/meta.json`)).json(), { id, deletedAt: item.meta.deletedAt, purgeState: 'purged' });
  assert.equal(await trashItem(id), undefined);
  assert.equal((await request('/trash/bins/' + id, { method: 'DELETE', etag: item.etag })).status, 200);
  assert.equal((await request('/trash/bins/' + id + '/restore', { method: 'POST', etag: item.etag })).status, 404);
});

test('failed physical deletion blocks restoration and cron resumes the cleanup without exposing JSON', async () => {
  const item = await trashed(), id = item.meta.id;
  const data = bucketProxy({ delete: async keys => {
    if (Array.isArray(keys) && keys.some(key => key.startsWith(`bins/${id}/versions/`))) throw new Error('simulated_cleanup_failure');
    return bucket.delete(keys);
  } });
  assert.equal((await nativeRequest(data, '/trash/bins/' + id, { method: 'DELETE', etag: item.etag })).status, 500);
  assert.equal((await trashItem(id)).status, 'purging');
  assert.equal((await request('/trash/bins/' + id + '/restore', { method: 'POST', etag: item.etag })).status, 409);
  assert.equal((await request('/bins/' + id)).status, 404);
  const { default: worker } = await import('../dist/jsonbin/index.js'); await worker.scheduled({}, { DATA: bucket });
  assert.equal(await trashItem(id), undefined); assert.equal((await bucket.list({ prefix: `bins/${id}/versions/` })).objects.length, 0);
});

test('concurrent restore and permanent deletion have one winner and never delete a restored Bin', async () => {
  for (const legacy of [false, true]) {
    const item = await trashed({ race: true }), id = item.meta.id;
    if (legacy) { await bucket.put(`trash/bins/${id}/meta.json`, JSON.stringify(item.meta, null, 2)); await bucket.delete(`bins/${id}/meta.json`); }
    const current = await trashItem(id), path = '/trash/bins/' + id;
    const responses = await Promise.all([
      request(path + '/restore', { method: 'POST', etag: current.etag }), request(path, { method: 'DELETE', etag: current.etag }),
    ]);
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.ok(responses.every(response => [200, 404, 409, 412].includes(response.status)));
    if (responses[0].status === 200) {
      const restored = await responses[0].json(); assert.deepEqual(await (await request('/bins/' + id)).json(), restored);
      assert.deepEqual((await (await request('/bins/' + id + '/versions/1')).json()).value, { race: true });
    } else {
      assert.equal((await request('/bins/' + id)).status, 404); assert.equal((await bucket.list({ prefix: `bins/${id}/versions/` })).objects.length, 0);
    }
  }
});

test('bulk empty uses approved item ETags, reports partial conflicts and never includes newly trashed or restored records', async () => {
  const first = await trashed(), second = await trashed(), later = await trashed();
  const restored = await (await request('/trash/bins/' + first.meta.id + '/restore', { method: 'POST', etag: first.etag })).json();
  await request('/bins/' + first.meta.id, { method: 'DELETE', etag: restored.etag }); // A new deletion generation must not be erased.
  const response = await request('/trash/bins/purge', { method: 'POST', value: { items: [first, second].map(item => ({ id: item.meta.id, etag: item.etag })) } });
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).results, [{ id: first.meta.id, status: 412 }, { id: second.meta.id, status: 200 }]);
  assert.ok(await trashItem(first.meta.id)); assert.equal(await trashItem(second.meta.id), undefined); assert.ok(await trashItem(later.meta.id));
  for (const value of [{ items: [] }, { items: [{ id: later.meta.id }] }, { items: [{ id: 'bad', etag: 'tag' }] },
    { items: [{ id: later.meta.id, etag: 'tag' }, { id: later.meta.id, etag: 'tag' }] }, { items: Array(101).fill({ id: later.meta.id, etag: 'tag' }) }, { all: true }]) {
    assert.equal((await request('/trash/bins/purge', { method: 'POST', value })).status, 422);
  }
});

test('an in-flight append finishing after permanent deletion removes its late orphan and cannot revive the Bin', async () => {
  const bin = await create({ original: true }), id = bin.meta.id;
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
  const data = bucketProxy({ put: async (key, value, options) => {
    if (key === `bins/${id}/versions/000002.json`) { reached(); await gate; }
    return bucket.put(key, value, options);
  } });
  const saving = nativeRequest(data, '/bins/' + id, { method: 'PUT', etag: bin.etag, value: { value: { late: true } } });
  await waiting;
  try {
    assert.equal((await request('/bins/' + id, { method: 'DELETE', etag: bin.etag })).status, 200);
    const item = await trashItem(id);
    assert.equal((await request('/trash/bins/' + id, { method: 'DELETE', etag: item.etag })).status, 200);
  } finally { release(); }
  assert.equal((await saving).status, 412);
  assert.equal((await bucket.list({ prefix: `bins/${id}/versions/` })).objects.length, 0);
  assert.equal((await request('/bins/' + id)).status, 404); assert.equal(await trashItem(id), undefined);
});

async function activityFixture(timestamp, action = 'bin.created') {
  const id = crypto.randomUUID(), resourceId = crypto.randomUUID();
  const entry = { id, action, resourceType: action.startsWith('key.') ? 'key' : 'bin', resourceId,
    actor: { type: 'session', id: 'local-admin' }, provider: 'password', timestamp: new Date(timestamp).toISOString(),
    summary: action === 'key.created' ? '创建 API 密钥' : '创建数据仓', requestId: crypto.randomUUID() };
  const key = `activity/${String(8640000000000000 - timestamp).padStart(16, '0')}-${id}.json`;
  await bucket.put(key, JSON.stringify(entry), { customMetadata: { action, resourceType: entry.resourceType } });
  return { key, entry };
}
async function clearActivities() {
  let cursor;
  do { const page = await bucket.list({ prefix: 'activity/', cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(o => o.key)); cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
test('activity is Session-only and rejects malformed or foreign cursors', async () => {
  await clearActivities();
  const response = await request('/activity'); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { items: [], nextCursor: null, retentionLimit: 2000 });
  assert.equal((await request('/activity', { authenticated: false })).status, 401);
  for (const scopes of [...keyScopes.map(scope => [scope]), keyScopes, ['bin:update', 'history:read']]) {
    const key = await apiKey(scopes);
    assert.equal((await bearerRequest(key.token, '/activity', { authenticated: true })).status, 401);
  }
  for (const suffix of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=01', '?limit=1&limit=2', '?action=no', '?resourceType=no', '?unknown=x', '?cursor=bad', '?cursor=' + 'x'.repeat(2049)]) {
    assert.equal((await request('/activity' + suffix)).status, 400, suffix.slice(0, 50));
  }
  const forged = Buffer.from(JSON.stringify({ v: 1, after: 'keys/private/meta.json', action: null, resourceType: null })).toString('base64url');
  assert.equal((await request('/activity?cursor=' + forged)).status, 400);
});
test('activity pagination is ordered, filtered and bounded with damaged or removed anchors', async () => {
  await clearActivities(); const now = Date.now();
  const fixtures = await Promise.all(Array.from({ length: 1005 }, (_, i) => activityFixture(now - i, i === 1004 ? 'key.created' : 'bin.created')));
  await activityFixture(now, 'bin.created');
  const first = await (await request('/activity?limit=2')).json(); assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor); assert.ok(first.items[0].timestamp >= first.items[1].timestamp);
  await bucket.delete(fixtures.find(f => f.entry.id === first.items[1].id)?.key ?? `activity/${String(8640000000000000 - now).padStart(16, '0')}-${first.items[1].id}.json`);
  await activityFixture(now + 1);
  const second = await (await request('/activity?limit=2&cursor=' + first.nextCursor)).json();
  assert.equal(second.items.length, 2); assert.ok(second.items.every(e => !first.items.some(old => old.id === e.id)));
  assert.ok(second.items[0].timestamp <= first.items[1].timestamp);
  assert.equal((await request('/activity?action=key.created&cursor=' + first.nextCursor)).status, 400);
  const sparse = await (await request('/activity?action=key.created')).json();
  assert.equal(sparse.items.length, 0); assert.ok(sparse.nextCursor);
  const tail = await (await request('/activity?action=key.created&cursor=' + sparse.nextCursor)).json();
  assert.equal(tail.items.length, 1); assert.equal(tail.items[0].action, 'key.created');
  for (const { key } of fixtures.slice(0, 45)) await bucket.put(key, '{invalid', { customMetadata: { action: 'bin.created', resourceType: 'bin' } });
  const damaged = await (await request('/activity')).json(); assert.ok(damaged.nextCursor);
  assert.ok(damaged.items.length < 40);
  await clearActivities();
});

async function allActivities(query = '') {
  const entries = []; let cursor;
  do { const response = await request('/activity?limit=100' + query + (cursor ? '&cursor=' + cursor : ''));
    assert.equal(response.status, 200); const page = await response.json(); entries.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return entries;
}
test('activity records login and Bin writes with trustworthy identities and no sensitive payload', async () => {
  await clearActivities(); const canary = randomBytes(24).toString('hex');
  assert.equal((await request('/auth/login', { method: 'POST', value: { username: canary, password: canary } })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', value: { username: 'test', password } })).status, 200);
  const created = await (await request('/bins', { method: 'POST', value: { name: canary, description: canary, value: { [canary]: canary } } })).json();
  const key = await apiKey(['bin:update']); const path = '/bins/' + created.meta.id;
  let current = created;
  for (const [method, suffix, value] of [['PUT', '', { value: { [canary]: 'old' } }], ['PATCH', '', { changed: canary }], ['PUT', '/value/' + canary, { value: canary }]]) {
    const response = await bearerRequest(key.token, path + suffix, { method, etag: current.etag, value });
    assert.equal(response.status, 200); current = await response.json();
  }
  const metadata = await request(path + '/meta', { method: 'PATCH', etag: current.etag, value: { description: canary } });
  assert.equal(metadata.status, 200); current = await metadata.json();
  assert.equal((await request(path, { method: 'PUT', etag: created.etag, value: { value: canary } })).status, 412);
  assert.equal((await request(path, { method: 'PUT', value: {} })).status, 422);
  const restored = await request(path + '/versions/1/restore', { method: 'POST', etag: current.etag }); assert.equal(restored.status, 200);
  const events = await allActivities(); const binEvents = events.filter(e => e.resourceId === created.meta.id);
  assert.deepEqual(binEvents.map(e => e.action).sort(), ['bin.created', 'bin.metadata_updated', 'bin.updated', 'bin.updated', 'bin.updated', 'bin.version_restored'].sort());
  assert.ok(binEvents.filter(e => e.action === 'bin.updated').every(e => e.actor.type === 'api_key' && e.actor.id === key.key.id));
  assert.ok(binEvents.filter(e => e.action !== 'bin.updated').every(e => e.actor.type === 'session' && e.actor.id === 'local-admin'));
  assert.ok(events.some(e => e.action === 'auth.login_failed' && e.actor.type === 'anonymous' && e.actor.id === null));
  assert.ok(events.some(e => e.action === 'auth.login_succeeded' && e.provider === 'password'));
  for (const secret of [canary, password, cookie, key.token]) assert.ok(!JSON.stringify(events).includes(secret));
  const pages = await bucket.list({ prefix: 'activity/', include: ['customMetadata'] });
  assert.ok(!JSON.stringify(pages.objects.map(o => o.customMetadata)).includes(canary));
  const before = events.length; await request('/bins'); await request('/system/health'); await request('/auth/config');
  assert.equal((await allActivities()).length, before);
});

test('activity covers resource administration and only successful trash batch items', async () => {
  await clearActivities(); const marker = randomBytes(24).toString('hex');
  const collection = await (await request('/collections', { method: 'POST', value: { name: marker, description: marker } })).json();
  const renamed = await (await request('/collections/' + collection.meta.id, { method: 'PATCH', etag: collection.etag, value: { name: marker + '2' } })).json();
  assert.equal((await request('/collections/' + collection.meta.id, { method: 'DELETE', etag: renamed.etag })).status, 200);
  const schema = await (await request('/schemas', { method: 'POST', value: { name: marker, schema: { description: marker } } })).json();
  const revised = await (await request('/schemas/' + schema.meta.id, { method: 'PUT', etag: schema.etag, value: { name: marker, schema: true } })).json();
  assert.equal((await request('/schemas/' + schema.meta.id + '/validate', { method: 'POST', value: { value: marker } })).status, 200);
  assert.equal((await request('/schemas/' + schema.meta.id, { method: 'DELETE', etag: revised.etag })).status, 200);
  const key = await apiKey(keyScopes, { name: marker });
  assert.equal((await request('/keys/' + key.key.id, { method: 'DELETE' })).status, 200);
  const restored = await create(), purged = await create(), conflict = await create();
  for (const bin of [restored, purged, conflict]) assert.equal((await request('/bins/' + bin.meta.id, { method: 'DELETE', etag: bin.etag })).status, 200);
  const trash = (await (await request('/trash/bins')).json()).items;
  const old = trash.find(item => item.meta.id === restored.meta.id);
  assert.equal((await request('/trash/bins/' + old.meta.id + '/restore', { method: 'POST', etag: old.etag })).status, 200);
  const batch = await (await request('/trash/bins/purge', { method: 'POST', value: { items: [
    { id: purged.meta.id, etag: trash.find(i => i.meta.id === purged.meta.id).etag },
    { id: conflict.meta.id, etag: '"stale"' },
  ] } })).json(); assert.deepEqual(batch.results.map(r => r.status), [200, 412]);
  const entries = await allActivities();
  for (const [id, actions] of [[collection.meta.id, ['collection.created', 'collection.updated', 'collection.deleted']],
    [schema.meta.id, ['schema.created', 'schema.updated', 'schema.deleted']], [key.key.id, ['key.created', 'key.revoked']]]) {
    assert.deepEqual(entries.filter(e => e.resourceId === id).map(e => e.action).sort(), actions.sort());
  }
  assert.equal(entries.filter(e => e.action === 'bin.restored' && e.resourceId === restored.meta.id).length, 1);
  assert.equal(entries.filter(e => e.action === 'bin.purged' && e.resourceId === purged.meta.id).length, 1);
  assert.equal(entries.filter(e => e.action === 'bin.purged' && e.resourceId === conflict.meta.id).length, 0);
  for (const secret of [marker, key.token, key.key.prefix]) assert.ok(!JSON.stringify(entries).includes(secret));
});
test('Cron retains newest 2000 activities and records actual lifecycle transitions only once', async () => {
  await clearActivities(); const now = Date.now();
  const fixtures = await Promise.all(Array.from({ length: 2010 }, (_, i) => activityFixture(now - 1000 - i)));
  await bucket.put('activity/not-a-record.json', 'keep'); await bucket.put('other/untouched.json', 'keep');
  const bin = await create();
  await bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, expiresAt: new Date(now - 10).toISOString() }));
  await mf.getWorker('jsonbin-tests').then(worker => worker.scheduled({ scheduledTime: now, cron: '*/15 * * * *' }));
  const events = await allActivities(); assert.equal(events.length, 2000);
  assert.equal(events.filter(e => e.action === 'bin.expired' && e.resourceId === bin.meta.id && e.actor.type === 'system').length, 1);
  assert.equal(await bucket.get(fixtures.at(-1).key), null); assert.ok(await bucket.get(fixtures[0].key));
  assert.equal(await (await bucket.get('activity/not-a-record.json')).text(), 'keep'); assert.ok(await bucket.get('other/untouched.json'));
  const trash = (await (await request('/trash/bins')).json()).items.find(i => i.meta.id === bin.meta.id);
  assert.equal((await request('/trash/bins/' + bin.meta.id, { method: 'DELETE', etag: trash.etag })).status, 200);
  await mf.getWorker('jsonbin-tests').then(worker => worker.scheduled({ scheduledTime: now, cron: '*/15 * * * *' }));
  await mf.getWorker('jsonbin-tests').then(worker => worker.scheduled({ scheduledTime: now, cron: '*/15 * * * *' }));
  assert.equal((await allActivities()).filter(e => e.action === 'bin.purged' && e.resourceId === bin.meta.id).length, 1);
  await clearActivities();
});

test('activity skips an invalid key at an R2 page boundary without hiding older matches', async () => {
  await clearActivities(); const now = Date.now();
  await Promise.all(Array.from({ length: 201 }, (_, i) => activityFixture(now - i, i === 200 ? 'key.created' : 'bin.created')));
  await bucket.put(`activity/${String(8640000000000000 - (now - 198)).padStart(16, '0')}-not-a-record.json`, 'not JSON');
  const page = await (await request('/activity?resourceType=key')).json();
  assert.equal(page.items.length, 1); assert.equal(page.items[0].action, 'key.created'); assert.equal(page.nextCursor, null);
  await clearActivities();
});

test('audit: concurrent publish and update have one winner and never silently overwrite metadata', async () => {
  const bin = await create({ stage: 'init' });
  const path = `/bins/${bin.meta.id}`;
  const [updateRes, publishRes] = await Promise.all([
    request(path, { method: 'PUT', etag: bin.etag, value: { value: { stage: 'updated' } } }),
    request(`${path}/publish`, { method: 'POST', etag: bin.etag }),
  ]);
  assert.deepEqual([updateRes.status, publishRes.status].sort(), [200, 412]);
  const current = await (await request(path)).json();
  if (updateRes.status === 200) {
    assert.equal(current.meta.currentVersion, 2);
    assert.deepEqual(current.value, { stage: 'updated' });
    assert.equal(current.meta.publishedVersion ?? null, null);
  } else {
    assert.equal(current.meta.currentVersion, 1);
    assert.equal(current.meta.publishedVersion, 1);
  }
});

test('audit: two concurrent publishes with the same ETag leave a single winner', async () => {
  const bin = await create({ stage: 'init' });
  const path = `/bins/${bin.meta.id}`;
  const [first, second] = await Promise.all([
    request(`${path}/publish`, { method: 'POST', etag: bin.etag, value: { version: 1 } }),
    request(`${path}/publish`, { method: 'POST', etag: bin.etag }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 412]);
  assert.equal((await (await request(path)).json()).meta.publishedVersion, 1);
});

test('audit: concurrent template updates never overwrite immutable version history', async () => {
  const created = await request('/templates', { method: 'POST', value: { name: '并发模板', value: { rev: 1 } } });
  assert.equal(created.status, 201);
  const tpl = await created.json();

  const [first, second] = await Promise.all([
    request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: tpl.etag, value: { value: { rev: 'A' } } }),
    request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: tpl.etag, value: { value: { rev: 'B' } } }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 412]);
  const winnerValue = first.status === 200 ? { rev: 'A' } : { rev: 'B' };

  // History is immutable: v1 keeps the original value, v2 holds exactly the winner's value.
  assert.deepEqual(await (await bucket.get(`templates/${tpl.meta.id}/versions/000001.json`)).json(), { rev: 1 });
  assert.deepEqual(await (await bucket.get(`templates/${tpl.meta.id}/versions/000002.json`)).json(), winnerValue);

  const current = await (await request(`/templates/${tpl.meta.id}`)).json();
  assert.equal(current.meta.currentVersion, 2);
  assert.deepEqual(current.value, winnerValue);
});

test('audit: racing template update and delete leave exactly one legitimate winner', async () => {
  const created = await request('/templates', { method: 'POST', value: { name: '竞争模板', value: { v: 1 } } });
  const tpl = await created.json();

  const [updated, deleted] = await Promise.all([
    request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: tpl.etag, value: { value: { v: 2 } } }),
    request(`/templates/${tpl.meta.id}`, { method: 'DELETE', etag: tpl.etag }),
  ]);
  // The loser either sees the conflict (412) or the template already gone (404).
  assert.equal(updated.status === 200, deleted.status === 412);
  assert.ok([200, 404, 412].includes(updated.status) && [200, 404, 412].includes(deleted.status));

  if (updated.status === 200) {
    // Update won: the freshly committed version must survive.
    const current = await (await request(`/templates/${tpl.meta.id}`)).json();
    assert.equal(current.meta.currentVersion, 2);
    assert.deepEqual(current.value, { v: 2 });
    assert.ok(await bucket.get(`templates/${tpl.meta.id}/versions/000002.json`));
  } else {
    assert.equal((await request(`/templates/${tpl.meta.id}`)).status, 404);
  }
});

test('audit: restricted key clone authorizes the target collection before any R2 write', async () => {
  const allowed = await (await request('/collections', { method: 'POST', value: { name: 'Clone Allowed' } })).json();
  const denied = await (await request('/collections', { method: 'POST', value: { name: 'Clone Denied' } })).json();
  const binAllowed = await (await request('/bins', { method: 'POST', value: { name: 'In Allowed', collectionId: allowed.meta.id, value: { ok: 1 } } })).json();
  const binDenied = await (await request('/bins', { method: 'POST', value: { name: 'In Denied', collectionId: denied.meta.id, value: { no: 1 } } })).json();
  const binLoose = await (await request('/bins', { method: 'POST', value: { name: 'No Collection', value: { loose: true } } })).json();

  const binCount = async () => { let n = 0, cursor; do { const page = await bucket.list({ prefix: 'bins/', cursor, limit: 1000 }); n += page.objects.filter(o => o.key.endsWith('/meta.json')).length; cursor = page.truncated ? page.cursor : undefined; } while (cursor); return n; };

  // Source bin whitelisted by id, but its collection is not grantable -> 403 before the clone writes.
  const keyDenied = await (await request('/keys', { method: 'POST', value: {
    name: 'clone-denied', scopes: ['bin:read', 'bin:create'],
    resourceAccess: { mode: 'restricted', binIds: [binDenied.meta.id, binLoose.meta.id, binAllowed.meta.id], collectionIds: [] },
  } })).json();
  const before = await binCount();
  const deniedRes = await request(`/bins/${binDenied.meta.id}/clone`, { method: 'POST', etag: binDenied.etag, authorization: `Bearer ${keyDenied.token}` });
  assert.equal(deniedRes.status, 403);
  assert.equal(await binCount(), before, 'denied clone must not create any Bin');

  // Collection-less Bin cannot be cloned by a restricted key either.
  const looseRes = await request(`/bins/${binLoose.meta.id}/clone`, { method: 'POST', etag: binLoose.etag, authorization: `Bearer ${keyDenied.token}` });
  assert.equal(looseRes.status, 403);
  assert.equal(await binCount(), before, 'collection-less clone must not create any Bin');

  // The allowed target collection succeeds.
  const keyAllowed = await (await request('/keys', { method: 'POST', value: {
    name: 'clone-allowed', scopes: ['bin:read', 'bin:create'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [allowed.meta.id] },
  } })).json();
  const okRes = await request(`/bins/${binAllowed.meta.id}/clone`, { method: 'POST', etag: binAllowed.etag, authorization: `Bearer ${keyAllowed.token}` });
  assert.equal(okRes.status, 201);
  const cloned = await okRes.json();
  assert.equal(cloned.meta.collectionId, allowed.meta.id);
  assert.equal(await binCount(), before + 1);
});

test('audit: trash restore rebuilds the slug alias so /b/:slug keeps resolving', async () => {
  const bin = await (await request('/bins', { method: 'POST', value: { name: 'Slugged', slug: 'restore-slug-x', value: { keep: true } } })).json();
  assert.equal((await request('/b/restore-slug-x')).status, 200);
  assert.equal((await request(`/bins/${bin.meta.id}`, { method: 'DELETE' })).status, 200);
  const trash = await (await request('/trash/bins')).json();
  const record = trash.items.find(i => i.meta.id === bin.meta.id);
  const restored = await request(`/trash/bins/${bin.meta.id}/restore`, { method: 'POST', etag: record.etag });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.notEqual(restoredBody.meta.lifecycleId, bin.meta.lifecycleId);
  // The alias must point at the NEW lifecycle, otherwise slug resolution dies.
  const alias = await (await bucket.get(`aliases/bins/restore-slug-x.json`)).json();
  assert.equal(alias.lifecycleId, restoredBody.meta.lifecycleId);
  assert.equal(alias.binId, bin.meta.id);
  assert.equal((await request('/b/restore-slug-x')).status, 200);
});

test('audit: trash restore clears the published pointer and republishing starts fresh', async () => {
  const bin = await create({ pub: 'v1' });
  const path = `/bins/${bin.meta.id}`;
  assert.equal((await request(`${path}/publish`, { method: 'POST', etag: bin.etag })).status, 200);
  assert.equal((await request(`${path}/published`)).status, 200);
  assert.equal((await request(path, { method: 'DELETE' })).status, 200);
  const record = (await (await request('/trash/bins')).json()).items.find(i => i.meta.id === bin.meta.id);
  const restored = await (await request(`/trash/bins/${bin.meta.id}/restore`, { method: 'POST', etag: record.etag })).json();
  assert.equal(restored.meta.publishedVersion ?? null, null);
  assert.equal(restored.meta.publishedAt ?? null, null);
  assert.equal(restored.meta.visibility, 'private');
  assert.equal((await request(`${path}/published`)).status, 404);
});

test('audit: restoring into an occupied slug detaches the alias instead of overwriting the owner', async () => {
  const first = await (await request('/bins', { method: 'POST', value: { name: 'First Owner', slug: 'contested-slug', value: { who: 'first' } } })).json();
  assert.equal((await request(`/bins/${first.meta.id}`, { method: 'DELETE' })).status, 200);
  // While the first Bin is trashed its alias still pins the slug, so another
  // owner can only exist through out-of-band state; simulate it directly.
  const second = await (await request('/bins', { method: 'POST', value: { name: 'Second Owner', value: { who: 'second' } } })).json();
  await bucket.put('aliases/bins/contested-slug.json', JSON.stringify({ slug: 'contested-slug', binId: second.meta.id, lifecycleId: second.meta.lifecycleId, createdAt: new Date().toISOString() }));
  await bucket.put(`bins/${second.meta.id}/meta.json`, JSON.stringify({ ...second.meta, slug: 'contested-slug' }));

  const record = (await (await request('/trash/bins')).json()).items.find(i => i.meta.id === first.meta.id);
  const restored = await request(`/trash/bins/${first.meta.id}/restore`, { method: 'POST', etag: record.etag });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  // Primary data always wins; only the conflicting alias is given up.
  assert.equal(restoredBody.meta.slug ?? null, null);
  assert.deepEqual(restoredBody.warnings, ['slug_conflict_detached']);
  const slugBody = await (await request('/b/contested-slug')).json();
  assert.equal(slugBody.meta.id, second.meta.id);
  assert.equal((await request(`/bins/${first.meta.id}`)).status, 200);
});

test('audit: restricted key cannot widen its scope through the /b/:slug entry (F01)', async () => {
  const allowed = await (await request('/collections', { method: 'POST', value: { name: 'Slug Allowed' } })).json();
  const secret = await (await request('/bins', { method: 'POST', value: { name: 'Slug Secret', slug: 'restricted-slug-target', value: { private: 'data' } } })).json();
  const granted = await (await request('/bins', { method: 'POST', value: { name: 'Slug Granted', slug: 'restricted-slug-granted', collectionId: allowed.meta.id, value: { ok: true } } })).json();
  const byId = await (await request('/bins', { method: 'POST', value: { name: 'Granted By Id', value: { ok: 2 } } })).json();
  const publicBin = await (await request('/bins', { method: 'POST', value: { name: 'Public Slugged', slug: 'restricted-slug-public', visibility: 'public', value: { open: true } } })).json();

  const emptyKey = await (await request('/keys', { method: 'POST', value: {
    name: 'slug-empty', scopes: ['bin:read'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [] },
  } })).json();
  const auth = `Bearer ${emptyKey.token}`;

  // An empty-scope key is denied on the slug entry exactly like on the ID entry,
  // across current, published and deep-path reads.
  assert.equal((await request(`/bins/${secret.meta.id}`, { authorization: auth })).status, 403);
  for (const path of ['/b/restricted-slug-target', '/b/restricted-slug-target/published', '/b/restricted-slug-target/value/private']) {
    assert.equal((await request(path, { authorization: auth })).status, 403, path);
  }
  // Explicit restricted credentials keep their semantics on public Bins: no
  // silent fallback to anonymous public access.
  assert.equal((await request('/b/restricted-slug-public', { authenticated: false })).status, 200);
  assert.equal((await request('/b/restricted-slug-public', { authorization: auth })).status, 403);

  // Explicit bin grants and collection grants keep working through the slug entry.
  const binKey = await (await request('/keys', { method: 'POST', value: {
    name: 'slug-by-id', scopes: ['bin:read'],
    resourceAccess: { mode: 'restricted', binIds: [byId.meta.id], collectionIds: [] },
  } })).json();
  const collectionKey = await (await request('/keys', { method: 'POST', value: {
    name: 'slug-by-collection', scopes: ['bin:read'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [allowed.meta.id] },
  } })).json();
  assert.equal((await request(`/bins/${byId.meta.id}`, { authorization: `Bearer ${binKey.token}` })).status, 200);
  assert.equal((await request('/b/restricted-slug-granted', { authorization: `Bearer ${collectionKey.token}` })).status, 200);
  // A bin-granted key stays scoped: another Bin's slug is still denied.
  assert.equal((await request('/b/restricted-slug-target', { authorization: `Bearer ${binKey.token}` })).status, 403);
  assert.equal((await request('/b/restricted-slug-public', { authorization: `Bearer ${binKey.token}` })).status, 403);
});

test('audit: restricted key cannot list, restore or purge out-of-scope trash entries (F02)', async () => {
  const allowed = await (await request('/collections', { method: 'POST', value: { name: 'Trash Allowed' } })).json();
  const secret = await (await request('/bins', { method: 'POST', value: { name: 'Trash Secret', value: { private: 1 } } })).json();
  const granted = await (await request('/bins', { method: 'POST', value: { name: 'Trash Granted', collectionId: allowed.meta.id, value: { ok: 1 } } })).json();
  assert.equal((await request(`/bins/${secret.meta.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/bins/${granted.meta.id}`, { method: 'DELETE' })).status, 200);

  const emptyKey = await (await request('/keys', { method: 'POST', value: {
    name: 'trash-empty', scopes: ['bin:read', 'bin:update', 'history:read', 'bin:delete'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [] },
  } })).json();
  const auth = `Bearer ${emptyKey.token}`;

  // The listing leaks neither ids nor ETags of out-of-scope entries.
  const listed = await (await request('/trash/bins', { authorization: auth })).json();
  assert.equal(listed.total, 0);
  assert.deepEqual(listed.items, []);

  // Restore, single purge and batch purge are denied per item and leave data intact.
  assert.equal((await request(`/trash/bins/${secret.meta.id}/restore`, { method: 'POST', etag: '"never"', authorization: auth })).status, 403);
  assert.equal((await request(`/trash/bins/${secret.meta.id}`, { method: 'DELETE', etag: '"never"', authorization: auth })).status, 403);
  const batch = await (await request('/trash/bins/purge', { method: 'POST', value: { items: [{ id: secret.meta.id, etag: '"never"' }] }, authorization: auth })).json();
  assert.deepEqual(batch.results, [{ id: secret.meta.id, status: 403 }]);
  assert.ok(await bucket.get(`bins/${secret.meta.id}/versions/000001.json`), 'denied purge must not delete versions');
  // The denied restore must not have resurrected the Bin: trashed Bins stay
  // hidden from normal routes for every identity (404, not 403).
  assert.equal((await request(`/bins/${secret.meta.id}`, { authorization: auth })).status, 404);
  assert.ok((await (await request('/trash/bins')).json()).items.some(i => i.meta.id === secret.meta.id), 'session still sees the trashed Bin');

  // Unknown ids resolve to 404 for restricted keys: no purged-vs-absent probing oracle.
  assert.equal((await request(`/trash/bins/${crypto.randomUUID()}`, { method: 'DELETE', etag: '"x"', authorization: auth })).status, 404);

  // A collection grant restores its own trashed Bin and still cannot touch the other one.
  const collectionKey = await (await request('/keys', { method: 'POST', value: {
    name: 'trash-collection', scopes: ['bin:read', 'bin:update', 'history:read', 'bin:delete'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [allowed.meta.id] },
  } })).json();
  const colAuth = `Bearer ${collectionKey.token}`;
  const visible = await (await request('/trash/bins', { authorization: colAuth })).json();
  const entry = visible.items.find(i => i.meta.id === granted.meta.id);
  assert.ok(entry, 'collection-granted key must still see its own trashed Bin');
  assert.equal(visible.items.some(i => i.meta.id === secret.meta.id), false, 'other entries stay hidden');
  const restored = await request(`/trash/bins/${granted.meta.id}/restore`, { method: 'POST', etag: entry.etag, authorization: colAuth });
  assert.equal(restored.status, 200);
  assert.equal((await request(`/trash/bins/${secret.meta.id}`, { method: 'DELETE', etag: '"never"', authorization: colAuth })).status, 403);

  // Mixed batch: only the granted item is purged, the other reports 403.
  const restoredBody = await restored.json();
  assert.equal((await request(`/bins/${granted.meta.id}`, { method: 'DELETE', etag: restoredBody.etag })).status, 200);
  const trashNow = (await (await request('/trash/bins')).json()).items;
  const grantedEntry = trashNow.find(i => i.meta.id === granted.meta.id);
  const secretEntry = trashNow.find(i => i.meta.id === secret.meta.id);
  const mixed = await (await request('/trash/bins/purge', { method: 'POST', value: { items: [
    { id: granted.meta.id, etag: grantedEntry.etag },
    { id: secret.meta.id, etag: secretEntry.etag },
  ] }, authorization: colAuth })).json();
  const byIdResult = Object.fromEntries(mixed.results.map(r => [r.id, r.status]));
  assert.equal(byIdResult[granted.meta.id], 200, 'granted item purges');
  assert.equal(byIdResult[secret.meta.id], 403, 'out-of-scope item is denied');
  assert.ok(await bucket.get(`bins/${secret.meta.id}/versions/000001.json`), 'denied item keeps its versions');
});

test('audit: save-as-template and template instantiation pin the captured schema revision', async () => {
  const schema = await (await request('/schemas', { method: 'POST', value: {
    name: 'Pinning Schema', schema: { type: 'object', properties: { flag: { type: 'boolean' } }, required: ['flag'] },
  } })).json();
  assert.equal(schema.meta.currentRevision, 1);

  const bin = await (await request('/bins', { method: 'POST', value: {
    name: 'Pinned Bin', value: { flag: true }, schemaId: schema.meta.id,
  } })).json();
  assert.equal(bin.meta.schemaRevision, 1);

  // Upgrade the schema to revision 2; existing bindings must not float.
  const upgraded = await request(`/schemas/${schema.meta.id}`, { method: 'PUT', etag: schema.etag, value: {
    name: 'Pinning Schema', schema: { type: 'object', properties: { flag: { type: 'boolean' }, note: { type: 'string' } }, required: ['flag'] },
  } });
  assert.equal(upgraded.status, 200);

  const tplRes = await request(`/bins/${bin.meta.id}/save-as-template`, { method: 'POST', etag: bin.etag, value: { name: 'Pinned Template' } });
  assert.equal(tplRes.status, 201);
  const tpl = await tplRes.json();
  assert.equal(tpl.meta.schemaId, schema.meta.id);
  assert.equal(tpl.meta.schemaRevision, 1, 'template must capture the Bin pinned revision, not the latest');

  const fromTpl = await request(`/templates/${tpl.meta.id}/create-bin`, { method: 'POST', value: { name: 'From Pinned' } });
  assert.equal(fromTpl.status, 201);
  const fromTplBin = await fromTpl.json();
  assert.equal(fromTplBin.meta.schemaRevision, 1, 'instantiated Bin must bind the template captured revision');
  assert.equal((await request(`/bins/${fromTplBin.meta.id}`, { method: 'PUT', etag: fromTplBin.etag, value: { value: { flag: false } } })).status, 200);
});

test('audit: save-as-template is Session-only and a bin:read Bearer key cannot create templates', async () => {
  const bin = await create({ tpl: true });
  const key = await (await request('/keys', { method: 'POST', value: { name: 'tpl-key', scopes: ['bin:read'] } })).json();

  const bearerRes = await request(`/bins/${bin.meta.id}/save-as-template`, {
    method: 'POST', etag: bin.etag, value: { name: 'Via Bearer' }, authorization: `Bearer ${key.token}`,
  });
  assert.equal(bearerRes.status, 401);
  const list = await (await request('/templates')).json();
  assert.equal(list.items.some(t => t.name === 'Via Bearer'), false);

  const sessionRes = await request(`/bins/${bin.meta.id}/save-as-template`, {
    method: 'POST', etag: bin.etag, value: { name: 'Via Session' },
  });
  assert.equal(sessionRes.status, 201);
});

test('audit: content search covers falsy scalar roots and escapes JSON Pointer tokens', async () => {
  const falsy = await create(false);
  await request(`/bins/${falsy.meta.id}/meta`, { method: 'PATCH', etag: falsy.etag, value: { contentSearchMode: 'all' } });
  const zero = await create(0);
  await request(`/bins/${zero.meta.id}/meta`, { method: 'PATCH', etag: zero.etag, value: { contentSearchMode: 'all' } });
  const empty = await create('');
  await request(`/bins/${empty.meta.id}/meta`, { method: 'PATCH', etag: empty.etag, value: { contentSearchMode: 'all' } });
  const text = await create('needle-in-root');
  await request(`/bins/${text.meta.id}/meta`, { method: 'PATCH', etag: text.etag, value: { contentSearchMode: 'all' } });
  const escaped = await create({ 'a/b': { 'x~y': 'pointer-needle' } });
  await request(`/bins/${escaped.meta.id}/meta`, { method: 'PATCH', etag: escaped.etag, value: { contentSearchMode: 'all' } });

  for (const [id, q] of [[falsy.meta.id, 'false'], [zero.meta.id, '0'], [empty.meta.id, ''], [text.meta.id, 'needle-in-root']]) {
    if (!q) continue;
    const res = await request(`/search/content?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200);
    const hit = (await res.json()).items.find(i => i.binId === id);
    if (q === 'needle-in-root') {
      assert.ok(hit, 'root scalar string must be searchable');
      assert.equal(hit.path, '');
    } else {
      assert.ok(hit, `falsy root ${JSON.stringify(q)} must be searchable`);
      assert.equal(hit.matchType, 'value');
      assert.equal(hit.path, '');
    }
  }

  const pointerRes = await request('/search/content?q=pointer-needle');
  assert.equal(pointerRes.status, 200);
  const pointerHit = (await pointerRes.json()).items.find(i => i.binId === escaped.meta.id);
  assert.ok(pointerHit);
  assert.equal(pointerHit.path, '/a~1b/x~0y', 'JSON Pointer must escape "/" as ~1 and "~" as ~0');

  const keyHitRes = await request('/search/content?q=a%2Fb');
  const keyHit = (await keyHitRes.json()).items.find(i => i.binId === escaped.meta.id && i.matchType === 'key');
  assert.ok(keyHit);
  assert.equal(keyHit.path, '/a~1b');
});

test('audit: If-None-Match turns unchanged reads into empty 304 responses', async () => {
  const bin = await create({ stable: true });
  const path = `/bins/${bin.meta.id}`;
  const etag = bin.etag.replace(/"/g, '');

  // Exact, quoted, weak and list forms all match.
  for (const candidate of [etag, `"${etag}"`, `W/"${etag}"`, `"other", "${etag}"`]) {
    const res = await request(path, { headers: { 'If-None-Match': candidate } });
    assert.equal(res.status, 304, candidate);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('etag').replace(/"/g, ''), etag);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  // Mismatched and absent headers return full payloads.
  assert.equal((await request(path, { headers: { 'If-None-Match': '"stale"' } })).status, 200);
  assert.equal((await request(path)).status, 200);

  // Value, published and slug reads behave the same.
  assert.equal((await request(`${path}/value/stable`, { headers: { 'If-None-Match': `"${etag}"` } })).status, 304);
  const published = await (await request(`${path}/publish`, { method: 'POST', etag: bin.etag })).json();
  const publishedEtag = published.etag.replace(/"/g, '');
  assert.equal((await request(`${path}/published`, { headers: { 'If-None-Match': `"${publishedEtag}"` } })).status, 304);
  const slugged = await (await request('/bins', { method: 'POST', value: { name: '304 Slug', slug: 'not-modified-slug', value: 1 } })).json();
  const slugEtag = slugged.etag.replace(/"/g, '');
  assert.equal((await request('/b/not-modified-slug', { headers: { 'If-None-Match': `"${slugEtag}"` } })).status, 304);
  assert.equal((await request('/b/not-modified-slug', { headers: { 'If-None-Match': '"stale"' } })).status, 200);

  // Any change (metadata bump) invalidates the cached ETag.
  const updated = await (await request(`${path}/meta`, { method: 'PATCH', etag: publishedEtag, value: { name: 'renamed-304' } })).json();
  const updatedEtag = updated.etag.replace(/"/g, '');
  assert.equal((await request(path, { headers: { 'If-None-Match': `"${etag}"` } })).status, 200);
  assert.equal((await request(path, { headers: { 'If-None-Match': `"${updatedEtag}"` } })).status, 304);

  // Anonymous conditional access keeps authentication semantics.
  assert.equal((await request(path, { authenticated: false, headers: { 'If-None-Match': `"${updatedEtag}"` } })).status, 401);
  // The wildcard form matches any current representation.
  assert.equal((await request(path, { headers: { 'If-None-Match': '*' } })).status, 304);
  // Collections, schemas and templates support conditional reads too.
  const collection = await (await request('/collections', { method: 'POST', value: { name: '304 Collection' } })).json();
  assert.equal((await request('/collections/' + collection.meta.id, { headers: { 'If-None-Match': `"${collection.etag.replace(/"/g, '')}"` } })).status, 304);
  const schema = await (await request('/schemas', { method: 'POST', value: { name: '304 Schema', schema: { type: 'object' } } })).json();
  assert.equal((await request('/schemas/' + schema.meta.id, { headers: { 'If-None-Match': `"${schema.etag.replace(/"/g, '')}"` } })).status, 304);
});

test('audit: template updates validate the pinned schema revision, not the latest (F07)', async () => {
  const schema = await (await request('/schemas', { method: 'POST', value: { name: 'F07 Schema', schema: { type: 'string' } } })).json();
  const tpl = await (await request('/templates', { method: 'POST', value: { name: 'F07 Tpl', schemaId: schema.meta.id, value: 'a-string' } })).json();
  assert.equal(tpl.meta.schemaRevision, 1);

  // Evolve the schema: rev2 demands numbers while the template stays pinned to rev1.
  const evolved = await (await request(`/schemas/${schema.meta.id}`, { method: 'PUT', etag: schema.etag, value: { name: 'F07 Schema', schema: { type: 'number' } } })).json();
  assert.equal(evolved.meta.currentRevision, 2);

  // Metadata-only patches validate the pinned revision: an unrelated change
  // must not be rejected by the newer revision's rules.
  const renamed = await request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: tpl.etag, value: { description: 'unrelated' } });
  assert.equal(renamed.status, 200);
  const afterRename = await renamed.json();

  // A value update violating the pinned revision is rejected even though the
  // latest revision would accept it.
  const badValue = await request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: afterRename.etag, value: { value: 42 } });
  assert.equal(badValue.status, 422);
  assert.equal((await (await request(`/templates/${tpl.meta.id}`)).json()).value, 'a-string');

  // Deleting the schema must not silently skip validation: the pinned
  // revision lives in immutable history and still applies.
  assert.equal((await request(`/schemas/${schema.meta.id}`, { method: 'DELETE', etag: evolved.etag })).status, 200);
  const stillEnforced = await request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: afterRename.etag, value: { value: 42 } });
  assert.equal(stillEnforced.status, 422);
  const okMeta = await request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: afterRename.etag, value: { name: 'still fine' } });
  assert.equal(okMeta.status, 200);
});

test('audit: published deep paths return the addressed node, not the whole document (F15)', async () => {
  const bin = await (await request('/bins', { method: 'POST', value: { name: 'F15', slug: 'f15-published-path', value: { nested: { visible: 7 } } } })).json();
  assert.equal((await request(`/bins/${bin.meta.id}/publish`, { method: 'POST', etag: bin.etag })).status, 200);

  const deep = await (await request(`/bins/${bin.meta.id}/published/value/nested/visible`)).json();
  assert.equal(deep.value, 7);
  assert.deepEqual(deep.path, ['nested', 'visible']);
  const mid = await (await request(`/bins/${bin.meta.id}/published/value/nested`)).json();
  assert.deepEqual(mid.value, { visible: 7 });

  // Current-value deep paths and the slug entry keep working.
  assert.equal((await (await request(`/bins/${bin.meta.id}/value/nested/visible`)).json()).value, 7);
  assert.equal((await (await request(`/b/f15-published-path/published/value/nested/visible`)).json()).value, 7);
  assert.deepEqual((await (await request(`/b/f15-published-path/value/nested/visible`)).json()).value, 7);
});

test('audit: format exports are shell-safe and type-preserving (F09)', async () => {
  const bin = await create({ flag: 'true', version: '42', inject: "$(printf INJECTED)", quote: "it's", mixed: 'a b c' });
  const path = '/bins/' + bin.meta.id;

  // .env is a shell fragment: only the reserved-free subset stays bare, the
  // command-substitution canary is strictly single-quoted (never double).
  const envText = await (await request(path, { headers: { Accept: 'text/x-env' } })).text();
  // Reserved-free scalars stay bare (safe in both shell and dotenv consumers).
  assert.match(envText, /^FLAG=true$/m);
  assert.match(envText, /^VERSION=42$/m);
  assert.match(envText, /^INJECT='\$\(printf INJECTED\)'/m);
  assert.match(envText, new RegExp('^QUOTE=' + "'it'" + String.fromCharCode(92, 92) + "''s'$", 'm'));
  assert.match(envText, /^MIXED='a b c'/m);
  assert.doesNotMatch(envText, /"/);

  // YAML quotes strings that would otherwise parse as booleans or numbers.
  const yamlText = await (await request(path, { headers: { Accept: 'text/yaml' } })).text();
  assert.match(yamlText, /flag: "true"/);
  assert.match(yamlText, /version: "42"/);

  // TOML emits valid syntax for arrays of objects ([[table]]) instead of raw
  // JSON object syntax, and nested objects stay [table] sections.
  const tomlBin = await create({ server: { host: 'h', ports: [1, 2] }, items: [{ name: 'a' }, { name: 'b' }] });
  const tomlText = await (await request('/bins/' + tomlBin.meta.id, { headers: { Accept: 'application/toml' } })).text();
  assert.match(tomlText, /\[server\]/);
  assert.match(tomlText, /ports = \[1, 2\]/);
  assert.match(tomlText, /\[\[items\]\]/);
  assert.match(tomlText, /name = "a"/);
  assert.match(tomlText, /name = "b"/);
  assert.doesNotMatch(tomlText, /\[\{"name"/);

  // Sanitized env keys that collide get suffixes instead of overwriting.
  const collide = await create({ 'a-b': 1, 'a/b': 2 });
  const collideText = await (await request('/bins/' + collide.meta.id, { headers: { Accept: 'text/x-env' } })).text();
  assert.match(collideText, /^A_B=1$/m);
  assert.match(collideText, /^A_B_2=2$/m);

  // YAML block sequences render nested arrays of objects without duplication.
  const list = await create({ groups: [{ id: 1, tags: ['x', 'y'] }, { id: 2 }] });
  const listText = await (await request('/bins/' + list.meta.id, { headers: { Accept: 'text/yaml' } })).text();
  const idLines = listText.split('\n').filter(line => line.includes('id:'));
  assert.equal(idLines.length, 2, 'each item appears exactly once: ' + listText);
  assert.match(listText, /- id: 1/);
  assert.match(listText, /tags:/);
});

test('audit: template management rejects explicit Authorization like every other management route (F21)', async () => {
  const tpl = await (await request('/templates', { method: 'POST', value: { name: 'F21 模板', value: { a: 1 } } })).json();
  const invalid = 'Bearer jb_live_invalid_invalid_invalid';
  assert.equal((await request('/templates', { authorization: invalid })).status, 401);
  assert.equal((await request(`/templates/${tpl.meta.id}`, { authorization: invalid })).status, 401);
  assert.equal((await request(`/templates/${tpl.meta.id}`, { method: 'PATCH', etag: tpl.etag, authorization: invalid, value: { name: 'x' } })).status, 401);
  assert.equal((await request(`/templates/${tpl.meta.id}`, { method: 'DELETE', etag: tpl.etag, authorization: invalid })).status, 401);
  assert.equal((await request(`/templates/${tpl.meta.id}/create-bin`, { method: 'POST', etag: tpl.etag, authorization: invalid })).status, 401);
  // Even a VALID bearer cannot ride a session cookie into management.
  const real = await (await request('/keys', { method: 'POST', value: { name: 'f21-bearer', scopes: ['bin:read'] } })).json();
  assert.equal((await request('/templates', { authorization: `Bearer ${real.token}` })).status, 401);
});

test('fast 304 reads only canonical Bin metadata, not the immutable version body', async () => {
  const bin = await create({ stable: true, secret: 'do-not-transfer' });
  const published = await (await request('/bins/' + bin.meta.id)).json();
  const counts = { meta: 0, versions: 0 };
  const data = new Proxy(bucket, { get(target, property) {
    if (property === 'get') return async (key, ...args) => {
      if (key === 'bins/' + bin.meta.id + '/meta.json') counts.meta++;
      if (String(key).startsWith('bins/' + bin.meta.id + '/versions/')) counts.versions++;
      return target.get(key, ...args);
    };
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const cache = await mf.getKVNamespace('CACHE', 'jsonbin-tests');
  const env = { DATA: data, CACHE: cache, ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: sessionSecret };
  const worker = (await import('../dist/jsonbin/index.js')).default;
  const url = 'http://localhost/api/v1/bins/' + bin.meta.id;
  const response = await worker.fetch(new Request(url, { headers: { Cookie: cookie, 'If-None-Match': published.etag } }), env);
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
  assert.ok(counts.meta >= 1, 'always check canonical metadata for current authorization/expiry');
  assert.equal(counts.versions, 0, 'unchanged Bin must not fetch the large JSON body');
  const rejected = await worker.fetch(new Request(url, { headers: { 'If-None-Match': published.etag } }), env);
  assert.equal(rejected.status, 401, 'private Bin still requires a session even with a matching ETag');
});


test('key usage: 1000 authorized Bearer reads avoid R2 usage writes and keep authentication checks', async t => {
  const { createSystemHarness } = await import('./support/system-harness.mjs');
  const h = await createSystemHarness('usage-r2-write-' + crypto.randomUUID());
  t.after(() => h.close());
  const createdRes = await h.request('/keys', {
    method: 'POST', value: { name: 'isolated-usage-test', scopes: ['bin:read'], rateLimitPerMinute: null },
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json();
  const path = `keys/${created.key.id}/meta.json`;
  const initial = await (await h.env.DATA.get(path)).json();
  const metrics = { r2KeyGets: 0, r2KeyPuts: 0, kvPuts: 0 };
  const r2 = h.adapt({
    get: async (key, ...args) => {
      if (key === path) metrics.r2KeyGets++;
      return h.bucket.get(key, ...args);
    },
    put: async (key, ...args) => {
      if (key === path) metrics.r2KeyPuts++;
      return h.bucket.put(key, ...args);
    },
  });
  const cache = new Proxy(h.env.CACHE, { get(target, prop) {
    if (prop === 'put') return async (...args) => { metrics.kvPuts++; return target.put(...args); };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const env = { ...h.env, DATA: r2, CACHE: cache };
  for (let i = 0; i < 1000; i++) {
    const response = await h.request('/bins', { headers: { Authorization: `Bearer ${created.token}` } }, env);
    assert.equal(response.status, 200);
  }
  assert.equal(metrics.r2KeyGets >= 1000, true, 'each authorized request must check canonical R2 credentials');
  assert.equal(metrics.r2KeyPuts, 0, 'usage writes to R2 must not occur on the request path');
  assert.equal(metrics.kvPuts, 1000, 'reuse the existing Analytics write, not a second KV write');
  const final = await (await h.env.DATA.get(path)).json();
  assert.deepEqual(final, initial, 'request analytics cannot rewrite authority metadata');
  const adminRes = await h.request('/keys');
  const admin = (await adminRes.json()).items.find(key => key.id === created.key.id);
  assert.equal(admin.usageApproximate, true);
  assert.ok(admin.usageTotal >= 1 && admin.usageTotal <= 1000);
  assert.ok(admin.lastUsedAt);
  assert.equal(Object.hasOwn(admin, 'usageAppliedDays'), false);
  assert.equal((await h.request('/bins', {headers:{ Authorization:'Bearer invalid-token'}},env)).status, 401);
});
