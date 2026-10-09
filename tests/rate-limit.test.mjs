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
  // The old 240 sequential HTTP calls could straddle a natural minute
  // boundary under CI contention, incorrectly treating a fresh window as
  // a bypass. Seed the exact *same* DO identity quickly and finish with
  // real API reads; leave at least 25s before the window rolls over.
  const msIntoWindow = Date.now() % 60000;
  if (msIntoWindow > 35000) await new Promise(r => setTimeout(r, 60000 - msIntoWindow + 50));
  const call = extraIp => h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': extraIp ?? ip },
  }), h.env);

  const digest = createHmac('sha256', h.env.SESSION_SECRET)
    .update(`jsonbin/public/ip/v1:${ip}`).digest('base64url');
  const stub = h.env.RATE_LIMITER.get(h.env.RATE_LIMITER.idFromName(`anon:${digest}`));
  const seed = () => stub.fetch('https://rate-limit.internal/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 240 }),
  });
  const reservations = await Promise.all(Array.from({ length: 239 }, seed));
  assert.ok(reservations.every(response => response.status === 200));
  assert.ok((await Promise.all(reservations.map(response => response.json())))
    .every(verdict => verdict.allowed), 'the first 239 reservations fit the active window');
  assert.equal((await call()).status, 200, 'the 240th request reaches the real HTTP route');
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await call('198.51.100.21')).status, 200);
  const spoofed = await h.worker.fetch(new Request(`https://example.test/api/v1/bins/${bin.meta.id}`, {
    headers: { 'CF-Connecting-IP': ip, 'X-Forwarded-For': '198.51.100.21' },
  }), h.env);
  assert.equal(spoofed.status, 429);

});

test('an explicit null key rate limit is honored as unlimited (F16)', async t => {
  const h = await harness(t);
  const key = await (await h.request('/keys', { method: 'POST', value: { name: 'unlimited', scopes: ['bin:read'], rateLimitPerMinute: null } })).json();
  assert.equal(key.key.rateLimitPerMinute, null);
  // Seed this minute's counter past the 120 default: an unlimited key sails
  // through, while a default-limited key would 429 on this very request.
  for (let i = 0; i < 121; i++) await h.worker.fetch(new Request('https://example.test/api/v1/bins', { headers: { Authorization: `Bearer ${key.token}` } }), h.env);
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

test('SEC-002 denies missing trusted IP and limiter outages, but keeps valid sessions', async t => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: { name: 'public security', visibility: 'public', value: { ok: true } } })).json();
  const path = `https://example.test/api/v1/bins/${bin.meta.id}`;
  const noIp = await h.worker.fetch(new Request(path), h.env);
  assert.equal(noIp.status, 503);
  assert.deepEqual(await noIp.json(), { error: 'anonymous_identity_unavailable' });
  const noLimiter = { ...h.env, RATE_LIMITER: undefined };
  assert.equal((await h.worker.fetch(new Request(path, { headers: { 'CF-Connecting-IP': '198.51.100.8' } }), noLimiter)).status, 503);
  assert.equal((await h.request(`/bins/${bin.meta.id}`, {}, noLimiter)).status, 200);
  const key = await (await h.request('/keys', { method: 'POST', value: { name: 'limited', scopes: ['bin:read'] } })).json();
  const rejected = await h.worker.fetch(new Request(path, { headers: { Authorization: `Bearer ${key.token}` } }), noLimiter);
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), { error: 'rate_limit_unavailable' });
});


test('SEC-002 SQLite Durable Object is exact across concurrent requests and dynamic limit changes', async t => {
  const h = await harness(t);
  const millis = Date.now() % 60000;
  if (millis > 58000) await new Promise(r => setTimeout(r, 60000 - millis + 100));
  const stub = h.env.RATE_LIMITER.get(h.env.RATE_LIMITER.idFromName('atomic-' + crypto.randomUUID()));
  const consume = async limit => {
    const response = await stub.fetch('https://rate-limit.internal/consume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const verdicts = await Promise.all(Array.from({ length: 32 }, () => consume(5)));
  assert.equal(verdicts.filter(result => result.allowed).length, 5, 'exactly five concurrent requests are accepted');
  assert.equal(verdicts.filter(result => !result.allowed).length, 27);
  for (let i = 0; i < 3; i++) assert.equal((await consume(8)).allowed, true, 'raising the limit allows only the additional capacity');
  assert.equal((await consume(8)).allowed, false);
  assert.equal((await consume(3)).allowed, false, 'lowering the limit cannot reset usage');
  assert.deepEqual((await stub.fetch('https://rate-limit.internal/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 0 }),
  })).status, 400);
});

test('SEC-002 limiter remains authoritative during KV outages', async t => {
  const h = await harness(t);
  const created = await (await h.request('/keys', { method: 'POST', value: {
    name: 'KV independent', scopes: ['bin:read'], rateLimitPerMinute: 2,
  } })).json();
  const withoutKv = { ...h.env, CACHE: undefined };
  const call = () => h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: `Bearer ${created.token}` },
  }), withoutKv);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const limited = await call();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('SEC-002 rate-limits private and missing anonymous Bin/Slug probes BEFORE R2', async t => {
  const h = await harness(t);
  const privateBin = await (await h.request('/bins', {
    method: 'POST', value: { name: 'probe-private', visibility: 'private', value: { secret: true } },
  })).json();
  const ip = '198.51.100.194';

  // Reserve 238 slots in this fixed window, then spend slots 239 and 240
  // through private-ID and missing-slug paths. Earlier versions looked up
  // both in R2 without charging the quota, allowing unbounded R2 probing.
  const msIntoMinute = Date.now() % 60000;
  if (msIntoMinute > 35000) await new Promise(resolve => setTimeout(resolve, 60000 - msIntoMinute + 50));
  const digest = createHmac('sha256', h.env.SESSION_SECRET)
    .update(`jsonbin/public/ip/v1:${ip}`).digest('base64url');
  const stub = h.env.RATE_LIMITER.get(h.env.RATE_LIMITER.idFromName(`anon:${digest}`));
  const reserve = () => stub.fetch('https://rate-limit.internal/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 240 }),
  });
  const reservations = await Promise.all(Array.from({ length: 238 }, reserve));
  assert.ok(reservations.every(r => r.status === 200));
  assert.ok((await Promise.all(reservations.map(r => r.json()))).every(v => v.allowed));
  const anonymous = (path, env = h.env, headers = {}) => h.worker.fetch(
    new Request('https://example.test/api/v1' + path, {
      headers: { 'CF-Connecting-IP': ip, ...headers },
    }), env,
  );
  assert.equal((await anonymous('/bins/' + privateBin.meta.id)).status, 401,
    'private Bin probes count toward the shared anonymous bucket');
  assert.equal((await anonymous('/b/no-such-slug-sec002')).status, 401,
    'missing slug probes also count toward the same anonymous bucket');

  // There is no R2 binding at all in this call. 429 must be returned before
  // getBinMetadata/getBinBySlug attempts to touch authoritative storage.
  const withoutR2 = { ...h.env, DATA: undefined };
  const blockedId = await anonymous('/bins/' + privateBin.meta.id, withoutR2);
  assert.equal(blockedId.status, 429);
  assert.ok(Number(blockedId.headers.get('retry-after')) >= 1);
  assert.equal((await anonymous('/b/no-such-slug-sec002', withoutR2)).status, 429);
  assert.equal((await anonymous('/bins/' + privateBin.meta.id, h.env, { Cookie: 'jsonbin_session=invalid' })).status, 429,
    'invalid Session cookies never exempt a client from the anonymous quota');

  // Independently authenticated callers never consume this anonymous quota.
  assert.equal((await h.request('/bins/' + privateBin.meta.id)).status, 200,
    'valid Session remains exempt even after anonymous 429');
  const key = await (await h.request('/keys', {
    method: 'POST', value: { name: 'scoped-proof', scopes: ['bin:read'] },
  })).json();
  assert.equal((await h.worker.fetch(new Request('https://example.test/api/v1/bins/' + privateBin.meta.id, {
    headers: { 'CF-Connecting-IP': ip, Authorization: 'Bearer ' + key.token },
  }), h.env)).status, 200, 'Bearer uses its separate per-Key rate limit');
});

// An identity's table and internal metadata must not live forever after its
// single sixty-second rate window. The alarm later invokes deleteAll().
test('SEC-002 schedules idle SQLite cleanup without resetting live quotas', async t => {
  const h = await harness(t);
  const identity = 'ttl-' + crypto.randomUUID();
  const stub = h.env.RATE_LIMITER.get(h.env.RATE_LIMITER.idFromName(identity));
  const consume = () => stub.fetch('https://rate-limit.internal/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1 }),
  });
  const accepted = await (await consume()).json();
  assert.equal(accepted.allowed, true);
  const storage = await h.getLimiterStorage(identity);
  const alarm = await storage.getAlarm();
  const remaining = alarm - Date.now();
  assert.ok(remaining > 30_000 && remaining <= 120_000,
    'one bounded idle cleanup alarm is scheduled for the identity');
  const denied = await (await consume()).json();
  assert.equal(denied.allowed, false);
  assert.equal(await storage.getAlarm(), alarm,
    'a second request must not rewrite the cleanup alarm or reset the quota');
});
