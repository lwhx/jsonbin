import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { minimalBackup } from './support/backup-fixtures.mjs';
let h;
before(async () => { h = await createSystemHarness('search-tests'); });
after(async () => { await h?.close(); });
async function create(path, value, env = h.env) {
  const response = await h.request(path, { method: 'POST', value }, env);
  assert.equal(response.status, 201); return response.json();
}
async function search(q, type = 'all', env = h.env) {
  const response = await h.request('/search?' + new URLSearchParams({ q, type }), {}, env);
  assert.equal(response.status, 200); return response.json();
}
function kv(overrides) {
  return new Proxy(h.env.CACHE, { get(target, key) { if (key in overrides) return overrides[key]; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; } });
}
test('global search finds names descriptions IDs and collection membership, normalizes text and never searches business JSON', async () => {
  const collection = await create('/collections', { name: '索引集合甲', description: '描述集合甲' });
  const bin = await create('/bins', { name: 'ＡＢＣ索引甲', description: '描述数据仓甲', collectionId: collection.meta.id, value: { secret: '正文秘密甲' } });
  const schema = await create('/schemas', { name: '模型索引甲', description: '描述模型甲', schema: { type: 'object' } });
  for (const q of ['abc', '描述数据仓甲', bin.meta.id, '索引集合甲', collection.meta.id]) assert.ok((await search(q, 'bin')).items.some(item => item.id === bin.meta.id), q);
  const all = await search('索引'); assert.ok(all.items.some(item => item.id === collection.meta.id)); assert.ok(all.items.some(item => item.id === schema.meta.id));
  assert.equal((await search('正文秘密甲')).items.length, 0);
  const item = (await search(bin.meta.id)).items[0]; assert.equal(item.collectionName, collection.meta.name); assert.ok(!Object.hasOwn(item, 'value')); assert.ok(!Object.hasOwn(item, 'visibility'));
});
test('verified KV snapshot reads only matching canonical metadata and skips JSON version bodies', async () => {
  const bin = await create('/bins', { name: '读取计数乙', value: null }); await search('读取计数乙');
  const reads = []; const env = { ...h.env, DATA: h.adapt({ get: async (key, ...args) => { if (key !== 'system/auth/sessions.json') reads.push(key); return h.bucket.get(key, ...args); } }) };
  const result = await search('读取计数乙', 'bin', env); assert.equal(result.source, 'kv'); assert.equal(result.items[0].id, bin.meta.id);
  assert.deepEqual(reads.sort(), [`bins/${bin.meta.id}/meta.json`, 'indexes/search/meta.json'].sort());
});
test('missing unavailable and corrupt KV all return complete R2 results without failing business writes', async () => {
  const bin = await create('/bins', { name: '缓存回退丙', value: false }); await search('缓存回退丙');
  for (const CACHE of [undefined, kv({ get: async () => null, put: async () => { throw Error('private-kv'); } }),
    kv({ get: async () => { throw Error('private-kv'); }, put: async () => { throw Error('private-kv'); } }),
    kv({ get: async () => '{"format":1,"rows":[]}', put: async () => { throw Error('private-kv'); } })]) {
    const result = await search('缓存回退丙', 'bin', { ...h.env, CACHE }); assert.equal(result.source, 'r2'); assert.equal(result.items[0].id, bin.meta.id);
  }
  const bad = { ...h.env, CACHE: kv({ put: async () => { throw Error('private-kv'); }, delete: async () => { throw Error('private-kv'); } }) };
  const created = await create('/bins', { name: '缓存写失败丙', value: null }, bad); assert.equal((await search(created.meta.id, 'bin', bad)).items.length, 1);
});
test('R2 ETag inventory invalidates stale snapshots even when a metadata update bypasses synchronization', async () => {
  const bin = await create('/bins', { name: '旧名称丁', value: null }); await search('旧名称丁');
  await h.bucket.put(`bins/${bin.meta.id}/meta.json`, JSON.stringify({ ...bin.meta, name: '新名称丁', description: '漏同步描述丁' }));
  assert.equal((await search('新名称丁')).items[0].id, bin.meta.id); assert.equal((await search('旧名称丁')).items.length, 0);
  const imported = minimalBackup(); imported.bins[0].meta.id = crypto.randomUUID(); imported.bins[0].meta.name = '备份导入丁';
  const restored = await h.request('/system/restore', { method: 'POST', value: { resource: { kind: 'bin', data: imported.bins[0] }, dependencies: [] } }); assert.equal(restored.status, 200);
  assert.equal((await restored.json()).status, 'created'); assert.ok(await h.env.CACHE.get('idx:bin:' + imported.bins[0].meta.id)); assert.equal((await search('备份导入丁')).items.length, 1);
});
test('CRUD collection detach trash restoration and permanent purge maintain disposable resource indexes', async () => {
  const c = await create('/collections', { name: '清理集合戊' }), b = await create('/bins', { name: '清理数据戊', collectionId: c.meta.id, value: null });
  assert.equal(await h.env.CACHE.get('idx:slug:' + c.meta.slug), c.meta.id);
  const edited = await h.request('/bins/' + b.meta.id + '/meta', { method: 'PATCH', headers: { 'If-Match': b.etag }, value: { name: '更新数据戊' } }); assert.equal(edited.status, 200);
  assert.equal(JSON.parse(await h.env.CACHE.get('idx:bin:' + b.meta.id)).name, '更新数据戊');
  assert.equal((await h.request('/collections/' + c.meta.id, { method: 'DELETE', headers: { 'If-Match': c.etag } })).status, 200);
  assert.equal(await h.env.CACHE.get('idx:collection:' + c.meta.id), null); assert.equal(await h.env.CACHE.get('idx:slug:' + c.meta.slug), null); assert.equal(JSON.parse(await h.env.CACHE.get('idx:bin:' + b.meta.id)).collectionId, null);
  let current = await (await h.request('/bins/' + b.meta.id)).json(); await h.request('/bins/' + b.meta.id, { method: 'DELETE', headers: { 'If-Match': current.etag } });
  assert.equal(await h.env.CACHE.get('idx:bin:' + b.meta.id), null); assert.equal((await search('更新数据戊')).items.length, 0);
  let trash = (await (await h.request('/trash/bins')).json()).items.find(item => item.meta.id === b.meta.id);
  const restored = await h.request('/trash/bins/' + b.meta.id + '/restore', { method: 'POST', headers: { 'If-Match': trash.etag } }); assert.equal(restored.status, 200); current = await restored.json();
  assert.ok(await h.env.CACHE.get('idx:bin:' + b.meta.id)); await h.request('/bins/' + b.meta.id, { method: 'DELETE', headers: { 'If-Match': current.etag } });
  trash = (await (await h.request('/trash/bins')).json()).items.find(item => item.meta.id === b.meta.id);
  assert.equal((await h.request('/trash/bins/' + b.meta.id, { method: 'DELETE', headers: { 'If-Match': trash.etag } })).status, 200); assert.equal(await h.env.CACHE.get('idx:bin:' + b.meta.id), null);
  const s = await create('/schemas', { name: '归档模型戊', schema: true }); assert.ok(await h.env.CACHE.get('idx:schema:' + s.meta.id));
  await h.request('/schemas/' + s.meta.id, { method: 'DELETE', headers: { 'If-Match': s.etag } }); assert.equal(await h.env.CACHE.get('idx:schema:' + s.meta.id), null); assert.equal((await search('归档模型戊')).items.length, 0);
});
test('wall-clock TTL expiration is enforced on an unchanged KV snapshot and Cron removes the row', async () => {
  const bin = await create('/bins', { name: '到期数据己', value: null, expiresAt: new Date(Date.now() + 60000).toISOString() }); await search('到期数据己');
  const original = Date.now; Date.now = () => original() + 120000;
  try { const result = await search('到期数据己'); assert.equal(result.source, 'kv'); assert.equal(result.items.length, 0); await h.worker.scheduled({}, h.env); }
  finally { Date.now = original; }
  assert.equal(await h.env.CACHE.get('idx:bin:' + bin.meta.id), null);
});
test('pending purging purged and archived resources remain hidden; candidate revalidation prevents a concurrent delete leak', async () => {
  const bin = await create('/bins', { name: '隐藏数据庚', value: null }); await search('隐藏数据庚');
  let changed = false; const env = { ...h.env, DATA: h.adapt({ get: async (key, ...args) => {
    if (key === `bins/${bin.meta.id}/meta.json` && !changed) { changed = true; await h.bucket.put(key, JSON.stringify({ ...bin.meta, deletedAt: new Date().toISOString() })); }
    return h.bucket.get(key, ...args);
  } }) };
  assert.equal((await search('隐藏数据庚', 'all', env)).items.length, 0);
  for (const state of ['pending', 'purging', 'purged']) {
    const id = crypto.randomUUID(), meta = state === 'pending' ? { id, importState: 'pending', kind: 'bin', fingerprint: 'x', startedAt: new Date().toISOString() }
      : state === 'purged' ? { id, purgeState: 'purged', deletedAt: new Date().toISOString() } : { ...bin.meta, id, name: '隐藏状态庚', deletedAt: new Date().toISOString(), purgeState: 'purging' };
    await h.bucket.put(`bins/${id}/meta.json`, JSON.stringify(meta));
    assert.equal((await search(id)).items.length, 0);
  }
});
test('pagination is bound to query filter limit and R2 inventory and does not repeat resources', async () => {
  for (let i = 0; i < 3; i++) await create('/bins', { name: '分页数据辛' + i, value: null });
  const path = '/search?q=分页数据辛&type=bin&limit=1'; const first = await (await h.request(path)).json(); assert.ok(first.nextCursor);
  const second = await (await h.request(path + '&cursor=' + encodeURIComponent(first.nextCursor))).json(); assert.ok(second.nextCursor); assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal((await h.request(path.replace('limit=1', 'limit=2') + '&cursor=' + encodeURIComponent(first.nextCursor))).status, 400);
  await create('/bins', { name: '分页数据辛新', value: null }); assert.equal((await h.request(path + '&cursor=' + encodeURIComponent(first.nextCursor))).status, 409);
});
test('search validates queries and does not permit anonymous public discovery or explicit Bearer Cookie fallback', async () => {
  for (const query of ['', '?q=', '?q=x&type=no', '?q=x&limit=0', '?q=x&limit=51', '?q=x&limit=1e1', '?q=x&q=y', '?q=x&unknown=1', '?q=' + 'x'.repeat(161), '?q=x&cursor=bad']) assert.equal((await h.request('/search' + query)).status, 400, query);
  await create('/bins', { name: '公开搜索壬', visibility: 'public', value: null });
  for (const headers of [{ Cookie: '' }, { Authorization: '' }, { Authorization: 'Bearer invalid' }]) assert.equal((await h.request('/search?q=公开搜索壬', { headers })).status, 401);
  for (const scopes of [['bin:read', 'collection:read'], ['bin:read', 'collection:read', 'schema:read']]) {
    const key = await create('/keys', { name: '搜索权限', scopes }); const headers = { Authorization: 'Bearer ' + key.token };
    assert.equal((await h.request('/search?q=公开搜索壬&type=bin', { headers })).status, 200);
    assert.equal((await h.request('/search?q=公开搜索壬', { headers })).status, scopes.length === 3 ? 200 : 403);
    for (const [path, method] of [['/search/index', 'GET'], ['/search/rebuild', 'POST']]) assert.equal((await h.request(path, { method, headers })).status, 401);
  }
  assert.equal((await h.request('/search/rebuild', { method: 'POST', headers: { Origin: 'https://evil.test' } })).status, 403);
});
test('pagination continues by resource key when TTL expires and the KV snapshot disappears between pages', async () => {
  const bins = [];
  for (let i = 0; i < 3; i++) bins.push(await create('/bins', { name: '期限分页子' + i, value: null }));
  bins.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  await h.bucket.put(`bins/${bins[0].meta.id}/meta.json`, JSON.stringify({ ...bins[0].meta, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  const path = '/search?q=期限分页子&type=bin&limit=1'; const first = await (await h.request(path)).json(); assert.equal(first.items[0].id, bins[0].meta.id); assert.ok(first.nextCursor);
  const original = Date.now; Date.now = () => original() + 120000;
  try {
    const second = await (await h.request(path + '&cursor=' + encodeURIComponent(first.nextCursor), {}, { ...h.env, CACHE: undefined })).json();
    assert.equal(second.items[0].id, bins[1].meta.id); assert.ok(second.nextCursor);
    const third = await (await h.request(path + '&cursor=' + encodeURIComponent(second.nextCursor), {}, { ...h.env, CACHE: undefined })).json();
    assert.equal(third.items[0].id, bins[2].meta.id); assert.equal(third.nextCursor, null);
  } finally { Date.now = original; }
});
test('rebuild repairs missing indexes removes abandoned rows and reports concurrent changes without corrupting business metadata', async () => {
  const bin = await create('/bins', { name: '重建数据癸', value: null }); await h.env.CACHE.delete('idx:bin:' + bin.meta.id); await h.env.CACHE.put('idx:bin:abandoned', '{}');
  let response = await h.request('/search/rebuild', { method: 'POST' }); assert.equal(response.status, 200); assert.equal((await response.json()).current, true);
  assert.ok(await h.env.CACHE.get('idx:bin:' + bin.meta.id)); assert.equal(await h.env.CACHE.get('idx:bin:abandoned'), null); assert.equal((await (await h.request('/search/index')).json()).current, true);
  await h.bucket.put('indexes/search/meta.json', 'null');
  assert.equal((await search('重建数据癸')).items.length, 1); // Repair a malformed derived manifest using its existing ETag.
  assert.equal((await (await h.request('/search/index')).json()).current, true);
  let changed = false; const env = { ...h.env, DATA: h.adapt({ get: async (key, ...args) => {
    if (key === `bins/${bin.meta.id}/meta.json` && !changed) { changed = true; await h.bucket.put(key, JSON.stringify({ ...bin.meta, name: '重建并发癸' })); } return h.bucket.get(key, ...args);
  } }) };
  response = await h.request('/search/rebuild', { method: 'POST' }, env); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'search_changed'); assert.equal((await search('重建并发癸')).items.length, 1);
  assert.equal((await h.request('/search/rebuild', { method: 'POST' }, { ...h.env, CACHE: undefined })).status, 503);
  const unavailable = await h.request('/search/rebuild', { method: 'POST' }, { ...h.env, CACHE: kv({ put: async () => { throw Error('private-kv'); } }) });
  assert.equal(unavailable.status, 503); assert.equal((await unavailable.json()).error, 'search_index_unavailable');
});
test('search limits fail explicitly rather than presenting a silently partial result', async () => {
  const env = { ...h.env, DATA: h.adapt({ list: async () => ({ objects: Array.from({ length: 201 }, (_, i) => ({ key: `bins/id-${i}/meta.json`, etag: 'x' })), truncated: false }) }) };
  const response = await h.request('/search?q=x', {}, env); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'search_limit_exceeded' });
});
test('worst-case rebuild remains below 1000 internal-service calls and abandoned-index cleanup can resume', async () => {
  let calls = 0, removed = 0; const ids = Array.from({ length: 200 }, () => crypto.randomUUID());
  const DATA = h.adapt({
    list: async ({ prefix }) => { calls++; return { objects: prefix === 'collections/' ? ids.map(id => ({ key: `collections/${id}/meta.json`, etag: 'meta' })) : [], truncated: false }; },
    get: async key => { if (key === 'system/auth/sessions.json') return h.bucket.get(key); calls++; if (key === 'indexes/search/meta.json') return null; const id = key.split('/')[1]; return { httpEtag: '"meta"', uploaded: new Date(), json: async () => ({ id, name: '集合', description: '', status: 'active', slug: 'collection-' + id, updatedAt: new Date().toISOString() }) }; },
    put: async () => { calls++; return { httpEtag: '"published"' }; },
  });
  const CACHE = kv({ put: async () => { calls++; }, delete: async () => { calls++; removed++; }, list: async () => { calls++; return { keys: Array.from({ length: 200 }, (_, i) => ({ name: 'idx:bin:abandoned-' + i })), list_complete: true }; } });
  const response = await h.request('/search/rebuild', { method: 'POST' }, { ...h.env, DATA, CACHE }); assert.equal(response.status, 200); assert.equal(removed, 200); assert.ok(calls < 1000, 'internal service calls: ' + calls);
  removed = 0; const crowded = kv({ put: async () => {}, delete: async () => { removed++; }, list: async () => ({ keys: Array.from({ length: 201 }, (_, i) => ({ name: 'idx:bin:abandoned-' + i })), list_complete: true }) });
  const partial = await h.request('/search/rebuild', { method: 'POST' }, { ...h.env, DATA, CACHE: crowded }); assert.equal(partial.status, 503); assert.equal((await partial.json()).error, 'search_cleanup_limit_exceeded'); assert.equal(removed, 200);
});

test('restricted keys search only their authorized scope while scanning and paging (F19)', async () => {
  const granted = await create('/collections', { name: 'F19 授权集合' });
  const other = await create('/collections', { name: 'F19 其他集合' });
  const inScopeIds = [];
  // Matching bins: two in the granted collection, one out of scope.
  for (const name of ['f19scope 甲', 'f19scope 乙']) {
    const bin = await create('/bins', { name, collectionId: granted.meta.id, value: {} });
    inScopeIds.push(bin.meta.id);
  }
  await create('/bins', { name: 'f19scope 丙', collectionId: other.meta.id, value: {} });
  const key = await (await h.request('/keys', { method: 'POST', value: {
    name: 'f19-search', scopes: ['bin:read', 'collection:read', 'schema:read'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [granted.meta.id] },
  } })).json();
  const auth = { Authorization: `Bearer ${key.token}` };

  // Metadata search pages only authorized candidates: a full page holds two
  // in-scope bins (the out-of-scope one never consumed a slot), and a cursor
  // only ever references an in-scope position.
  const page = await (await h.request('/search?type=bin&limit=2&q=f19scope', { headers: auth })).json();
  assert.equal(page.items.length, 2, 'the page must be full of authorized matches');
  assert.deepEqual(page.items.map(item => item.id).sort(), [...inScopeIds].sort());
  if (page.nextCursor) {
    const position = JSON.parse(atob(page.nextCursor)).after;
    if (position.startsWith('bin:')) assert.equal(inScopeIds.includes(position.slice(4)), true, `cursor leaked out-of-scope position ${position}`);
  }

  // A scope whose matching candidates are all out of scope ends with no
  // cursor at all instead of paging through invisible resources.
  const alien = await (await h.request('/keys', { method: 'POST', value: {
    name: 'f19-alien', scopes: ['bin:read', 'collection:read', 'schema:read'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [] },
  } })).json();
  const empty = await (await h.request('/search?type=bin&limit=1&q=f19scope', { headers: { Authorization: `Bearer ${alien.token}` } })).json();
  assert.deepEqual(empty.items, []);
  assert.equal(empty.nextCursor, null, 'an exhausted authorized scope must not emit a cursor');

  // Content search: collection grants pass (the old id-only filter denied
  // them) and out-of-scope searchable bins never leak matches.
  const searchable = await create('/bins', { name: 'f19content-in', collectionId: granted.meta.id, value: { needle: 'F19NEEDLE' } });
  inScopeIds.push(searchable.meta.id);
  const leaky = await create('/bins', { name: 'f19content-out', collectionId: other.meta.id, value: { needle: 'F19NEEDLE' } });
  for (const bin of [searchable, leaky]) {
    const current = await (await h.request(`/bins/${bin.meta.id}`)).json();
    await h.request(`/bins/${bin.meta.id}/meta`, { method: 'PATCH', headers: { 'If-Match': current.etag }, value: { contentSearchMode: 'all' } });
  }
  const content = await (await h.request('/search/content?q=F19NEEDLE', { headers: auth })).json();
  assert.equal(content.items.some(item => item.binId === searchable.meta.id), true, 'a collection grant must see its own searchable bin');
  assert.equal(content.items.some(item => item.binId === leaky.meta.id), false, 'out-of-scope bins must not leak content matches');
});
