import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  const before429 = await usage();
  assert.ok(before429 >= 1 && before429 <= 3, 'qualified requests produce a best-effort approximate count');

  const limited = await call();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'rate_limit_exceeded' });
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After in window range: ${retryAfter}`);
  assert.equal(await usage(), before429, 'the rejected request must not be counted');

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
  const anonScope = address => 'a:' + createHmac('sha256', h.env.SESSION_SECRET)
    .update('public-rate/v1' + String.fromCharCode(0) + address).digest('base64url');
  // Never seed against a window that is about to roll over.
  const msIntoWindow = Date.now() % 60000;
  if (msIntoWindow > 58000) await new Promise(r => setTimeout(r, 60000 - msIntoWindow + 50));
  const window = Math.floor(Date.now() / 60000);
  const call = extraIp => h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': extraIp ?? ip },
  }), h.env);

  // Seed the IP's current window at the limit instead of spending 240
  // wall-clock requests: the verdict is deterministic even under CI load.
  await h.env.CACHE.put(`rl:${anonScope(ip)}:${window}`, '240');
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  // A different IP is a different bucket.
  assert.equal((await call('198.51.100.21')).status, 200);

  // Only the ACTIVE window counts: a saturated previous window never limits.
  await h.env.CACHE.delete(`rl:${anonScope(ip)}:${window}`);
  await h.env.CACHE.put(`rl:${anonScope(ip)}:${window - 1}`, '240');
  assert.equal((await call()).status, 200);

  // Counters are disposable KV state: deleting the active window restores access.
  await h.env.CACHE.put(`rl:${anonScope(ip)}:${window}`, '240');
  assert.equal((await call()).status, 429);
  await h.env.CACHE.delete(`rl:${anonScope(ip)}:${window}`);
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

test('password login locks each IP on failure 3, bans on failure 6, and never blocks GitHub OAuth', async t => {
  const h = await harness(t);
  const ip = '203.0.113.5', otherIp = '198.51.100.9';
  const attempt = (address, username = h.env.ADMIN_USERNAME, password = 'wrong-password') =>
    h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': address },
      body: JSON.stringify({ username, password }),
    }), h.env);
  const inspect = async () => {
    const objects = (await h.bucket.list({ prefix: 'auth/login-guard/' })).objects;
    assert.equal(objects.length, 1, 'only the offending IP has an authoritative R2 state');
    assert.ok(!objects[0].key.includes(ip), 'stored object key must not expose the raw IP');
    return { key: objects[0].key, record: await (await h.bucket.get(objects[0].key)).json() };
  };

  // Wrong username and wrong password are indistinguishable to callers.
  for (const [username, password] of [['somebody-else', h.env.ADMIN_PASSWORD], [h.env.ADMIN_USERNAME, 'bad-password']]) {
    const response = await attempt(ip, username, password);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_credentials' });
  }
  let response = await attempt(ip);
  assert.equal(response.status, 429, 'the third wrong verification starts the one-minute lock immediately');
  assert.deepEqual(await response.json(), { error: 'login_cooldown' });
  assert.ok(Number(response.headers.get('retry-after')) >= 1 && Number(response.headers.get('retry-after')) <= 60);

  response = await attempt(ip, h.env.ADMIN_USERNAME, h.env.ADMIN_PASSWORD);
  assert.equal(response.status, 429, 'even correct credentials cannot bypass the cooldown');
  assert.deepEqual(await response.json(), { error: 'login_cooldown' });
  assert.equal((await attempt(otherIp, h.env.ADMIN_USERNAME, h.env.ADMIN_PASSWORD)).status, 200);

  const github = { ...h.env, GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret', GITHUB_ALLOWED_USER_ID: '123' };
  const oauthStart = () => h.worker.fetch(new Request('https://example.test/api/v1/auth/github', { headers: { 'CF-Connecting-IP': ip } }), github);
  assert.equal((await oauthStart()).status, 302, 'GitHub OAuth must be independent of password throttling');

  // Simulate passage of one minute by expiring only the R2 cooldown field.
  let stored = await inspect();
  assert.equal(stored.record.failures, 3);
  await h.bucket.put(stored.key, JSON.stringify({ ...stored.record, cooldownUntil: Date.now() - 1 }));
  for (const wrong of ['fourth-wrong', 'fifth-wrong']) {
    response = await attempt(ip, h.env.ADMIN_USERNAME, wrong);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_credentials' });
  }
  response = await attempt(ip);
  assert.equal(response.status, 429, 'the sixth failure bans password login on that IP');
  assert.deepEqual(await response.json(), { error: 'login_ip_banned' });
  assert.ok(Number(response.headers.get('retry-after')) >= 86390);
  assert.ok(Number(response.headers.get('retry-after')) <= 86400);
  assert.equal((await attempt(ip, h.env.ADMIN_USERNAME, h.env.ADMIN_PASSWORD)).status, 429);
  assert.equal((await oauthStart()).status, 302, 'OAuth remains available even after the six-failure ban');
  assert.equal((await h.request('/bins')).status, 200, 'existing sessions remain valid');

  // A stale ban and 24-hour failure window must expire automatically.
  stored = await inspect();
  assert.equal(stored.record.failures, 6);
  await h.bucket.put(stored.key, JSON.stringify({
    ...stored.record, bannedUntil: Date.now() - 1,
    windowStartedAt: Date.now() - 86400001, expiresAt: Date.now() - 1,
  }));
  assert.equal((await attempt(ip, h.env.ADMIN_USERNAME, h.env.ADMIN_PASSWORD)).status, 200);
});

test('successful password login resets the IP failure streak; malformed bodies do not consume attempts', async t => {
  const h = await harness(t);
  const ip = '2001:db8::5';
  const login = (username, password) => h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ username, password }),
  }), h.env);

  const malformed = await h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: '{',
  }), h.env);
  assert.equal(malformed.status, 400);

  assert.equal((await login('invalid-account', h.env.ADMIN_PASSWORD)).status, 401);
  assert.equal((await login(h.env.ADMIN_USERNAME, 'invalid-password')).status, 401);
  assert.equal((await login(h.env.ADMIN_USERNAME, h.env.ADMIN_PASSWORD)).status, 200, 'valid login clears the first two failures');

  assert.equal((await login(h.env.ADMIN_USERNAME, 'again-1')).status, 401);
  assert.equal((await login(h.env.ADMIN_USERNAME, 'again-2')).status, 401);
  const third = await login(h.env.ADMIN_USERNAME, 'again-3');
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: 'login_cooldown' });
});

test('unavailable R2 login guard fails closed for passwords without affecting GitHub OAuth', async t => {
  const h = await harness(t);
  const github = { ...h.env, DATA: h.adapt({ get: async () => { throw new Error('STORAGE_CANARY'); } }),
    GITHUB_CLIENT_ID: 'client-id', GITHUB_CLIENT_SECRET: 'client-secret', GITHUB_ALLOWED_USER_ID: '123' };
  const headers = { 'CF-Connecting-IP': '203.0.113.77' };
  const response = await h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: h.env.ADMIN_USERNAME, password: h.env.ADMIN_PASSWORD }),
  }), github);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'login_guard_unavailable' });
  assert.equal((await h.worker.fetch(new Request('https://example.test/api/v1/auth/github', { headers }), github)).status, 302);
});


test('daily scheduled housekeeping prunes only expired password-IP security records', async t => {
  const h = await harness(t);
  const now = Date.now();
  const expiry = new Date(now + 3 * 86400000);
  expiry.setUTCHours(3, 0, 0, 0);
  const sweepAt = expiry.getTime() > now + 2 * 86400000 ? expiry.getTime() : expiry.getTime() + 86400000;
  const staleKey = 'auth/login-guard/test-stale.json';
  const activeKey = 'auth/login-guard/test-active.json';
  const state = { failures: 3, windowStartedAt: now - 86400000, cooldownUntil: null, bannedUntil: null, expiresAt: now - 1000 };
  await h.bucket.put(staleKey, JSON.stringify(state));
  await h.bucket.put(activeKey, JSON.stringify({ ...state, expiresAt: sweepAt + 1000 }));

  await h.worker.scheduled({ scheduledTime: sweepAt }, h.env);
  assert.equal(await h.bucket.get(staleKey), null, 'expired IP state should not accumulate forever in R2');
  assert.ok(await h.bucket.get(activeKey), 'non-expired IP state must survive housekeeping');
});


test('concurrent invalid logins use R2 CAS to enforce exactly three then six failures', async t => {
  const h = await harness(t);
  const ip = '203.0.113.44';
  const attempt = () => h.worker.fetch(new Request('https://example.test/api/v1/auth/login', {
    method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: h.env.ADMIN_USERNAME, password: 'wrong-password' }),
  }), h.env);
  const first = await Promise.all([attempt(), attempt(), attempt()]);
  assert.deepEqual(first.map(r => r.status).sort(), [401, 401, 429]);
  const [entry] = (await h.bucket.list({ prefix: 'auth/login-guard/' })).objects;
  assert.ok(entry);
  let stored = await (await h.bucket.get(entry.key)).json();
  assert.equal(stored.failures, 3, 'concurrent credentials cannot overwrite prior failures');
  await h.bucket.put(entry.key, JSON.stringify({ ...stored, cooldownUntil: Date.now() - 1 }));
  const next = await Promise.all([attempt(), attempt(), attempt()]);
  assert.deepEqual(next.map(r => r.status).sort(), [401, 401, 429]);
  stored = await (await h.bucket.get(entry.key)).json();
  assert.equal(stored.failures, 6);
  assert.ok(stored.bannedUntil > Date.now());
});


test('SEC002: missing limiter and KV binding fails closed for default Bearer and anonymous reads', async t => {
  const h = await harness(t);
  const created = await (await h.request('/keys', { method: 'POST', value: { name: 'native-limit-required', scopes: ['bin:read'] } })).json();
  const pub = await (await h.request('/bins', { method: 'POST', value: { name: 'public-limit-required', visibility: 'public', value: 1 } })).json();
  const noLimiter = { ...h.env, CACHE: undefined, JSONBIN_KEY_RATE: undefined, JSONBIN_ANON_RATE: undefined };
  const bearer = await h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: 'Bearer ' + created.token } }), noLimiter);
  assert.equal(bearer.status, 503);
  assert.deepEqual(await bearer.json(), { error: 'rate_limit_unavailable' });
  const anonymous = await h.worker.fetch(new Request('https://example.test/api/v1/bins/' + pub.meta.id, {
    headers: { 'CF-Connecting-IP': '203.0.113.31' },
  }), noLimiter);
  assert.equal(anonymous.status, 503);
  assert.deepEqual(await anonymous.json(), { error: 'rate_limit_unavailable' });
});

test('SEC002: KV read and write failures do not grant unlimited anonymous or Bearer access', async t => {
  const h = await harness(t);
  const created = await (await h.request('/keys', { method: 'POST', value: { name: 'kv-outage', scopes: ['bin:read'] } })).json();
  const pub = await (await h.request('/bins', { method: 'POST', value: { name: 'public-kv-outage', visibility: 'public', value: 1 } })).json();
  for (const failurePoint of ['get', 'put']) {
    const cache = {
      get: async () => { if (failurePoint === 'get') throw Error('KV_UNAVAILABLE'); return null; },
      put: async () => { if (failurePoint === 'put') throw Error('KV_WRITE_THROTTLED'); },
    };
    const env = { ...h.env, CACHE: cache, JSONBIN_KEY_RATE: undefined, JSONBIN_ANON_RATE: undefined };
    const bearer = await h.worker.fetch(new Request('https://example.test/api/v1/bins', {
      headers: { Authorization: 'Bearer ' + created.token },
    }), env);
    assert.equal(bearer.status, 503, failurePoint + ': failed KV cannot authenticate through limiter');
    assert.deepEqual(await bearer.json(), { error: 'rate_limit_unavailable' });
    const anonymous = await h.worker.fetch(new Request('https://example.test/api/v1/bins/' + pub.meta.id, {
      headers: { 'CF-Connecting-IP': '198.51.100.34' },
    }), env);
    assert.equal(anonymous.status, 503, failurePoint + ': failed KV cannot grant public quota');
  }
});

test('SEC002: native per-key and anonymous binding limits take precedence over KV and return 429', async t => {
  const h = await harness(t);
  const created = await (await h.request('/keys', { method: 'POST', value: { name: 'native-default', scopes: ['bin:read'] } })).json();
  const pub = await (await h.request('/bins', { method: 'POST', value: { name: 'native-public', visibility: 'public', value: 1 } })).json();
  const hitKeys = [], hitIps = [];
  const denied = seen => ({ limit: async ({ key }) => { seen.push(key); return { success: false }; } });
  const cache = { get: async () => { throw Error('KV MUST NOT BE USED WITH NATIVE LIMITER'); }, put: async () => { throw Error('KV MUST NOT BE USED WITH NATIVE LIMITER'); } };
  const env = { ...h.env, CACHE: cache, JSONBIN_KEY_RATE: denied(hitKeys), JSONBIN_ANON_RATE: denied(hitIps) };
  const keyResp = await h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: 'Bearer ' + created.token } }), env);
  assert.equal(keyResp.status, 429);
  assert.deepEqual(await keyResp.json(), { error: 'rate_limit_exceeded' });
  assert.ok(Number(keyResp.headers.get('retry-after')) >= 1 && Number(keyResp.headers.get('retry-after')) <= 60);
  assert.equal(hitKeys.length, 1);
  assert.ok(hitKeys[0].includes(created.key.id));
  assert.ok(!hitKeys[0].includes(created.token));
  const pubResp = await h.worker.fetch(new Request('https://example.test/api/v1/bins/' + pub.meta.id, {
    headers: { 'CF-Connecting-IP': '203.0.113.81' },
  }), env);
  assert.equal(pubResp.status, 429);
  assert.equal(hitIps.length, 1);
  assert.ok(!hitIps[0].includes('203.0.113.81'), 'new limiter must not expose raw client IP');
});

test('SEC002: native binding and custom quota storage outages fail closed; explicit null is unlimited', async t => {
  const h = await harness(t);
  const def = await (await h.request('/keys', { method: 'POST', value: { name: 'native-outage', scopes: ['bin:read'] } })).json();
  const custom = await (await h.request('/keys', { method: 'POST', value: { name: 'custom-outage', scopes: ['bin:read'], rateLimitPerMinute: 3 } })).json();
  const unlimited = await (await h.request('/keys', { method: 'POST', value: { name: 'unlimited-outage', scopes: ['bin:read'], rateLimitPerMinute: null } })).json();
  const nativeFail = { ...h.env, JSONBIN_KEY_RATE: { limit: async () => { throw Error('native-limit-failed'); } } };
  const doRequest = (token, env) => h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: 'Bearer ' + token } }), env);
  const first = await doRequest(def.token, nativeFail);
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { error: 'rate_limit_unavailable' });
  const noR2 = { ...h.env, DATA: h.adapt({ get: async key => {
    if (key.startsWith('auth/key-rate/')) throw Error('CUSTOM_QUOTA_UNAVAILABLE');
    return h.bucket.get(key);
  } }) };
  const second = await doRequest(custom.token, noR2);
  assert.equal(second.status, 503);
  assert.deepEqual(await second.json(), { error: 'rate_limit_unavailable' });
  const unrestricted = await doRequest(unlimited.token, { ...h.env, CACHE: undefined, JSONBIN_KEY_RATE: nativeFail.JSONBIN_KEY_RATE });
  assert.equal(unrestricted.status, 200, 'null bypasses quota system without bypassing key authentication');
});

test('SEC002: concurrent dynamic per-key requests never exceed exact R2 limit=3, per-key reset isolates quotas', async t => {
  const h = await harness(t);
  const custom = await (await h.request('/keys', { method: 'POST', value: { name: 'exact-custom', scopes: ['bin:read'], rateLimitPerMinute: 3 } })).json();
  const endpoint = () => h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: 'Bearer ' + custom.token },
  }), h.env);
  const results = await Promise.all(Array.from({ length: 5 }, endpoint));
  assert.deepEqual(results.map(x => x.status).sort((a,b) => a-b), [200,200,200,429,429]);
  const record = await h.bucket.get('auth/key-rate/' + custom.key.id + '.json');
  assert.ok(record, 'exact custom quota stored as one R2 CAS object');
  assert.equal((await record.json()).count, 3);
  const limited = await endpoint();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1 && Number(limited.headers.get('retry-after')) <= 60);
  const other = await (await h.request('/keys', { method: 'POST', value: { name: 'other-custom', scopes: ['bin:read'], rateLimitPerMinute: 3 } })).json();
  assert.equal((await h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: 'Bearer ' + other.token },
  }), h.env)).status, 200);
});


test('SEC002: stale in-flight request never rewinds a newer UTC quota window', async t => {
  const h = await harness(t);
  const custom = await (await h.request('/keys', { method: 'POST', value: {
    name: 'monotonic-window', scopes: ['bin:read'], rateLimitPerMinute: 3,
  } })).json();
  const path = 'auth/key-rate/' + custom.key.id + '.json';
  const advancedWindow = Math.floor(Date.now() / 60000) + 1;
  // A later-minute request won CAS already; an earlier-minute request
  // may arrive after it due to network/R2 scheduling. It must not
  // resurrect the old window or reset the newer counter to zero.
  await h.bucket.put(path, JSON.stringify({ window: advancedWindow, count: 3 }));
  const response = await h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: 'Bearer ' + custom.token },
  }), h.env);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'rate_limit_exceeded' });
  const persisted = await (await h.bucket.get(path)).json();
  assert.equal(persisted.window, advancedWindow);
  assert.equal(persisted.count, 3);
});
