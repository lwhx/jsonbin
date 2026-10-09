import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
let mf, bucket, app, env, cookie;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{ name: 'activity-tests', modules: true,
    scriptPath: 'dist/jsonbin/index.js', compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], durableObjects: { RATE_LIMITER: { className: 'ApiRateLimiter', useSQLite: true } } }] }));
  bucket = await mf.getR2Bucket('DATA', 'activity-tests'); app = (await import('../dist/jsonbin/index.js')).default;
  env = { DATA: bucket, RATE_LIMITER: await mf.getDurableObjectNamespace('RATE_LIMITER', 'activity-tests'), ADMIN_USERNAME: 'test', ADMIN_PASSWORD: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex') };
  const login = await app.fetch(new Request('https://example.test/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password: env.ADMIN_PASSWORD }) }), env);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => { await mf?.dispose(); });
function request(path, options = {}, bindings = env) {
  return app.fetch(new Request('https://example.test/api/v1' + path, { method: options.method ?? 'GET',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...options.headers },
    ...(options.value === undefined ? {} : { body: JSON.stringify(options.value) }) }), bindings);
}
function adaptedBucket(overrides) { return new Proxy(bucket, { get(target, key) {
  if (key in overrides) return overrides[key]; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
} }); }
async function activities(query = '') { const entries = []; let cursor;
  do { const page = await (await request('/activity?limit=100' + query + (cursor ? '&cursor=' + cursor : ''))).json(); entries.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return entries;
}
test('failed activity writes preserve committed business success and never log exception secrets', async t => {
  const secret = randomBytes(32).toString('hex'), diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args));
  for (const failure of ['throw', 'collision']) {
    let attempts = 0;
    const bindings = { ...env, DATA: adaptedBucket({ put: async (key, ...args) => {
      if (key.startsWith('activity/')) { attempts++; if (failure === 'throw') throw new Error(secret); return null; }
      return bucket.put(key, ...args);
    } }) };
    const response = await request('/bins', { method: 'POST', value: { name: 'business', value: false } }, bindings);
    assert.equal(response.status, 201); const created = await response.json();
    assert.equal(created.meta.currentVersion, 1); assert.equal((await (await request('/bins/' + created.meta.id)).json()).value, false);
    assert.equal(attempts, failure === 'throw' ? 1 : 3);
  }
  assert.equal(diagnostics.length, 2); assert.ok(diagnostics.every(args => args[0] === 'activity_write_failed'));
  assert.ok(!JSON.stringify(diagnostics).includes(secret));
});
test('same-millisecond writes have unique immutable activity IDs and ignore client request IDs', async t => {
  const now = Date.now(); t.mock.method(Date, 'now', () => now);
  const marker = randomBytes(24).toString('hex');
  const responses = await Promise.all(Array.from({ length: 8 }, () => request('/bins', { method: 'POST', headers: { 'X-Request-ID': marker }, value: { name: marker, value: marker } })));
  assert.ok(responses.every(r => r.status === 201)); const ids = await Promise.all(responses.map(async r => (await r.json()).meta.id));
  const entries = (await activities()).filter(e => ids.includes(e.resourceId));
  assert.equal(entries.length, 8); assert.equal(new Set(entries.map(e => e.id)).size, 8);
  assert.ok(entries.every(e => e.timestamp === new Date(now).toISOString() && e.requestId !== marker));
  assert.ok(!JSON.stringify(entries).includes(marker));
});

test('OAuth success and failures persist only verified identity and fixed summaries', async t => {
  const marker = randomBytes(32).toString('hex'), state = randomBytes(16).toString('hex'); let mode = 'success';
  t.mock.method(globalThis, 'fetch', async url => {
    const tokenEndpoint = String(url).includes('access_token');
    if (mode === (tokenEndpoint ? 'exchange-network' : 'lookup-network')) throw new Error(marker);
    if (mode === (tokenEndpoint ? 'exchange-json' : 'lookup-json')) return new Response('invalid ' + marker);
    if (tokenEndpoint) return new Response(JSON.stringify(mode === 'missing' ? {} : { access_token: marker }), { status: mode === 'exchange' ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ id: mode === 'denied' ? 999 : 123, login: marker }), { status: mode === 'lookup' ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const bindings = { ...env, GITHUB_CLIENT_ID: marker, GITHUB_CLIENT_SECRET: marker, GITHUB_ALLOWED_USER_ID: '123' };
  const before = (await activities()).length;
  assert.equal((await request('/auth/github/callback?code=' + marker + '&state=wrong', { headers: { Cookie: `jsonbin_oauth_state=${state}` } }, bindings)).status, 400);
  for (const [failure, status] of [['exchange-network', 502], ['exchange-json', 502], ['lookup-network', 502], ['lookup-json', 502], ['exchange', 502], ['missing', 401], ['lookup', 502], ['denied', 403], ['success', 302]]) {
    mode = failure;
    assert.equal((await request('/auth/github/callback?code=' + marker + '&state=' + state, { headers: { Cookie: `jsonbin_oauth_state=${state}` } }, bindings)).status, status);
  }
  const entries = await activities(); assert.equal(entries.length - before, 10);
  assert.ok(entries.some(e => e.action === 'auth.login_succeeded' && e.actor.id === '123' && e.provider === 'github'));
  assert.equal(entries.filter(e => e.action === 'auth.login_failed' && e.actor.type === 'anonymous').length, 9);
  assert.ok(!JSON.stringify(entries).includes(marker)); assert.ok(!JSON.stringify(entries).includes(state));
});

test('Cron retries retention failures and still cleans activities when Bin maintenance fails', async t => {
  const marker = randomBytes(24).toString('hex'), now = Date.now(); t.mock.method(console, 'error', () => {});
  const keys = await Promise.all(Array.from({ length: 2010 }, async (_, i) => {
    const id = crypto.randomUUID(), timestamp = now - 10000 - i;
    const key = `activity/${String(8640000000000000 - timestamp).padStart(16, '0')}-${id}.json`;
    await bucket.put(key, JSON.stringify({ id, action: 'bin.created', resourceType: 'bin', resourceId: crypto.randomUUID(),
      actor: { type: 'session', id: 'local-admin' }, provider: 'password', timestamp: new Date(timestamp).toISOString(),
      summary: '创建数据仓', requestId: crypto.randomUUID() }), { customMetadata: { action: 'bin.created', resourceType: 'bin' } });
    return key;
  }));
  const failureEnv = { ...env, DATA: adaptedBucket({ delete: async keys => {
    if (Array.isArray(keys) && keys.some(key => key.startsWith('activity/'))) throw new Error(marker);
    return bucket.delete(keys);
  } }) };
  await assert.rejects(app.scheduled({}, failureEnv), /scheduled_maintenance_failed/);
  assert.ok(await bucket.get(keys.at(-1)));
  let inserted;
  const raceEnv = { ...env, DATA: adaptedBucket({ delete: async keys => {
    if (!inserted && Array.isArray(keys) && keys.some(key => key.startsWith('activity/'))) {
      inserted = await (await request('/bins', { method: 'POST', value: { name: 'newest', value: null } })).json();
    }
    return bucket.delete(keys);
  } }) };
  await app.scheduled({}, raceEnv); assert.ok(inserted);
  const independent = { ...env, DATA: adaptedBucket({ list: async options => {
    if (options.prefix === 'bins/') throw new Error(marker); return bucket.list(options);
  } }) };
  await assert.rejects(app.scheduled({}, independent), /scheduled_maintenance_failed/);
  const objects = []; let cursor;
  do { const page = await bucket.list({ prefix: 'activity/', cursor }); objects.push(...page.objects); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  assert.equal(objects.length, 2000);
  const entries = (await (await request('/activity')).json()).items;
  assert.ok(entries.some(e => e.resourceId === inserted.meta.id)); assert.equal(await bucket.get(keys.at(-1)), null);
});
test('Cron emits purged only for its own actual final CAS and never for tombstone retries', async () => {
  const created = await (await request('/bins', { method: 'POST', value: { name: 'cron purge', value: false } })).json();
  await request('/bins/' + created.meta.id, { method: 'DELETE' });
  const path = `bins/${created.meta.id}/meta.json`, meta = await (await bucket.get(path)).json();
  await bucket.put(path, JSON.stringify({ ...meta, purgeState: 'purging', purgeEtag: 'old' }));
  await app.scheduled({}, env); await app.scheduled({}, env);
  assert.equal((await activities('&action=bin.purged')).filter(e => e.resourceId === created.meta.id && e.action === 'bin.purged' && e.actor.type === 'system').length, 1);
  const second = await (await request('/bins', { method: 'POST', value: { name: 'other CAS', value: null } })).json();
  await request('/bins/' + second.meta.id, { method: 'DELETE' });
  const secondPath = `bins/${second.meta.id}/meta.json`, secondMeta = await (await bucket.get(secondPath)).json();
  await bucket.put(secondPath, JSON.stringify({ ...secondMeta, purgeState: 'purging', purgeEtag: 'old' }));
  const raced = { ...env, DATA: adaptedBucket({ put: async (key, value, options) => {
    if (key === secondPath && JSON.parse(value).purgeState === 'purged') { await bucket.put(key, value); return null; }
    return bucket.put(key, value, options);
  } }) };
  await app.scheduled({}, raced);
  assert.equal((await activities('&action=bin.purged')).filter(e => e.resourceId === second.meta.id && e.action === 'bin.purged' && e.actor.type === 'system').length, 0);
});

test('malformed-key scan budgets advance both initial and existing cursors', async () => {
  const entry = { id: crypto.randomUUID(), action: 'auth.login_failed', resourceType: 'auth', resourceId: null,
    actor: { type: 'anonymous', id: null }, provider: 'anonymous', timestamp: new Date().toISOString(),
    summary: '登录失败', requestId: crypto.randomUUID() };
  const key = `activity/${String(8640000000000000 - Date.parse(entry.timestamp)).padStart(16, '0')}-${entry.id}.json`;
  const invalid = Array.from({ length: 1000 }, (_, i) => ({ key: 'activity/0000000000000000~' + String(i).padStart(4, '0') }));
  for (const withAnchor of [false, true]) {
    const anchor = `activity/0000000000000000-${crypto.randomUUID()}.json`;
    const objects = [...(withAnchor ? [{ key: anchor }] : []), ...invalid, { key, customMetadata: { action: entry.action, resourceType: entry.resourceType } }];
    let lists = 0, gets = 0;
    const bindings = { ...env, DATA: adaptedBucket({ list: async options => {
      lists++; assert.equal(options.prefix, 'activity/');
      const start = options.cursor ? Number(options.cursor) : options.startAfter ? objects.findIndex(o => o.key === options.startAfter) + 1 : 0;
      const end = Math.min(start + options.limit, objects.length);
      return { objects: objects.slice(start, end), truncated: end < objects.length, cursor: String(end) };
    }, get: async path => {
      gets++; assert.ok(path === anchor || path === key);
      return path === key ? { json: async () => entry } : null;
    } }) };
    let cursor = withAnchor ? Buffer.from(JSON.stringify({ v: 1, after: anchor, action: null, resourceType: null })).toString('base64url') : undefined;
    const first = await (await request('/activity' + (cursor ? '?cursor=' + cursor : ''), {}, bindings)).json();
    assert.deepEqual(first.items, []); assert.ok(first.nextCursor); assert.notEqual(first.nextCursor, cursor); assert.equal(lists, 5); assert.equal(gets, 0);
    const second = await (await request('/activity?cursor=' + first.nextCursor, {}, bindings)).json();
    assert.deepEqual(second.items, [entry]); assert.equal(second.nextCursor, null);
  }
});
