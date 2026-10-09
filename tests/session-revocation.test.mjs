import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSystemHarness } from './support/system-harness.mjs';

async function setup(t) {
  const h = await createSystemHarness('sessions-' + crypto.randomUUID());
  t.after(() => h.close());
  return h;
}
const path = '/api/v1/auth';
function request(h, target, { method = 'GET', cookie, body, env = h.env, headers = {} } = {}) {
  return h.worker.fetch(new Request('https://example.test' + path + target, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}
async function passwordLogin(h) {
  const res = await request(h, '/login', { method: 'POST', body: { username: h.env.ADMIN_USERNAME, password: h.env.ADMIN_PASSWORD } });
  assert.equal(res.status, 200, 'new password session must be issued');
  return res.headers.get('set-cookie').split(';')[0];
}
function payload(cookie) {
  return JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
}
function legacyCookie(h, exp = Math.floor(Date.now() / 1000) + 3600) {
  const claims = { id: 'local-admin', username: h.env.ADMIN_USERNAME, provider: 'password', exp };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', h.env.SESSION_SECRET).update(encoded).digest('base64url');
  return 'jsonbin_session=' + encoded + '.' + signature;
}
async function me(h, cookie, env) { return request(h, '/me', { cookie, env: env ?? h.env }); }

test('each signed 14-day session has a registered SID; logout revokes only the current device', async t => {
  const h = await setup(t);
  const a = await passwordLogin(h), b = await passwordLogin(h);
  const sidA = payload(a).sid, sidB = payload(b).sid;
  assert.match(sidA, /^[0-9a-f-]{36}$/i);
  assert.notEqual(sidA, sidB);
  assert.ok(Number.isSafeInteger(payload(a).gen));
  assert.equal((await me(h, a)).status, 200);
  assert.equal((await me(h, b)).status, 200);
  const logout = await request(h, '/logout', { method: 'POST', cookie: a });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
  assert.equal((await me(h, a)).status, 401, 'stolen cookie replay must be rejected immediately after logout');
  assert.equal((await me(h, b)).status, 200, 'other browser keeps its session');
});

test('admin can enumerate, target-revoke, and globally revoke other devices without Bearer access', async t => {
  const h = await setup(t);
  const a = await passwordLogin(h), b = await passwordLogin(h);
  const sidB = payload(b).sid;
  const list = await request(h, '/sessions', { cookie: a });
  assert.equal(list.status, 200);
  const sessions = (await list.json()).items;
  assert.ok(sessions.some(x => x.id === sidB));
  assert.ok(sessions.some(x => x.id === payload(a).sid && x.current === true));
  assert.equal((await request(h, '/sessions', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  assert.equal((await request(h, '/sessions/' + sidB, { cookie: a, method: 'DELETE', headers: { Origin: 'https://evil.test' } })).status, 403);
  const targeted = await request(h, '/sessions/' + sidB, { method: 'DELETE', cookie: a });
  assert.equal(targeted.status, 200);
  assert.equal((await me(h, b)).status, 401);
  assert.equal((await me(h, a)).status, 200);
  const c = await passwordLogin(h);
  const logoutAll = await request(h, '/logout-all', { method: 'POST', cookie: a });
  assert.equal(logoutAll.status, 200);
  assert.equal((await me(h, a)).status, 401);
  assert.equal((await me(h, c)).status, 401);
  assert.equal((await me(h, h.cookie)).status, 401);
  assert.equal((await passwordLogin(h)).startsWith('jsonbin_session='), true);
});

test('pre-upgrade 14-day HMAC cookie stays valid, but legacy logout and global revoke work', async t => {
  const h = await setup(t);
  const old = legacyCookie(h);
  assert.equal((await me(h, old)).status, 200, 'unexpired signed legacy session is not forcibly logged out');
  const logout = await request(h, '/logout', { method: 'POST', cookie: old });
  assert.equal(logout.status, 200);
  assert.equal((await me(h, old)).status, 401, 'legacy browser cookie replay after logout denied');
  const anotherLegacy = legacyCookie(h, Math.floor(Date.now() / 1000) + 7200);
  assert.equal((await me(h, anotherLegacy)).status, 200);
  const fresh = await passwordLogin(h);
  assert.equal((await request(h, '/logout-all', { method: 'POST', cookie: fresh })).status, 200);
  assert.equal((await me(h, anotherLegacy)).status, 401, 'global revocation disables legacy compatibility');
});

test('signed but unregistered session SID is invalid; signature tamper cannot bypass registry', async t => {
  const h = await setup(t);
  const valid = await passwordLogin(h);
  const p = payload(valid);
  const unregistered = { ...p, sid: crypto.randomUUID() };
  const encoded = Buffer.from(JSON.stringify(unregistered)).toString('base64url');
  const signature = createHmac('sha256', h.env.SESSION_SECRET).update(encoded).digest('base64url');
  assert.equal((await me(h, 'jsonbin_session=' + encoded + '.' + signature)).status, 401);
  assert.equal((await me(h, 'jsonbin_session=' + encoded + '.' + 'A'.repeat(43))).status, 401);
  assert.equal((await me(h, valid)).status, 200);
});

test('R2 state read/write outages return 503 without clearing existing Cookies or allowing protected access', async t => {
  const h = await setup(t);
  const cookie = await passwordLogin(h);
  const fault = { ...h.env, DATA: h.adapt({
    get: async () => { throw new Error('do-not-log-cookie'); },
    put: async () => { throw new Error('storage fault'); },
  }) };
  const check = await me(h, cookie, fault);
  assert.equal(check.status, 503, 'transient storage errors are not invalid sessions');
  assert.equal(check.headers.get('set-cookie'), null, 'error must not delete valid browser cookie');
  assert.equal((await h.request('/bins', { headers: { Cookie: cookie } }, fault)).status, 503);
  const logout = await request(h, '/logout', { method: 'POST', cookie, env: fault });
  assert.equal(logout.status, 503);
  assert.equal(logout.headers.get('set-cookie'), null);
  assert.equal((await me(h, cookie)).status, 200, 'failed revocation must not clear or invalidate old cookie');

  // Authenticated cookie is valid, but a new login cannot be committed.
  const issueFault = { ...h.env, DATA: h.adapt({ put: async () => { throw new Error('storage fault'); } }) };
  const freshLogin = await request(h, '/login', { method: 'POST', env: issueFault,
    body: { username: h.env.ADMIN_USERNAME, password: h.env.ADMIN_PASSWORD } });
  assert.equal(freshLogin.status, 503);
  assert.equal(freshLogin.headers.get('set-cookie'), null);
});

test('fixed 14-day Cookie survives simulated day 7/day 13 and expires at day 14; no sliding expiry', async t => {
  const h = await setup(t);
  const clock = Date.now, started = Date.UTC(2026, 9, 10, 12, 0, 0);
  try {
    Date.now = () => started;
    const res = await request(h, '/login', { method: 'POST',
      body: { username: h.env.ADMIN_USERNAME, password: h.env.ADMIN_PASSWORD } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=1209600/);
    assert.match(res.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(res.headers.get('set-cookie'), /SameSite=Lax/i);
    const cookie = res.headers.get('set-cookie').split(';')[0], firstExp = payload(cookie).exp;
    assert.equal(firstExp, Math.floor(started / 1000) + 1209600);
    for (const days of [7, 13]) {
      Date.now = () => started + days * 86400000;
      assert.equal((await me(h, cookie)).status, 200);
      assert.equal(payload(cookie).exp, firstExp, 'use of cookie must not extend expiry');
    }
    Date.now = () => started + 14 * 86400000;
    assert.equal((await me(h, cookie)).status, 401);
  } finally { Date.now = clock; }
});


test('legacy signed-session boundary accepts plus-one-second expiry during migration', async t => {
  const h = await setup(t);
  const original = Date.now;
  const timestamp = Date.UTC(2026, 9, 10, 12, 0, 0);
  Date.now = () => timestamp;
  try {
    const second = Math.floor(timestamp / 1000);
    const invalid = await me(h, legacyCookie(h, second));
    assert.equal(invalid.status, 401);
    const valid = await me(h, legacyCookie(h, second + 1));
    assert.equal(valid.status, 200, 'pre-upgrade HMAC session should survive within original expiration');
  } finally { Date.now = original; }
});


test('concurrent logins CAS-register independent devices; global revoke invalidates all of them', async t => {
  const h = await setup(t);
  const cookies = await Promise.all(Array.from({ length: 5 }, () => passwordLogin(h)));
  const ids = cookies.map(cookie => payload(cookie).sid);
  assert.equal(new Set(ids).size, 5, 'concurrent logins must not overwrite each other');
  for (const cookie of cookies) assert.equal((await me(h, cookie)).status, 200);
  assert.equal((await request(h, '/logout-all', { method: 'POST', cookie: cookies[0] })).status, 200);
  for (const cookie of cookies) assert.equal((await me(h, cookie)).status, 401);
  const fresh = await passwordLogin(h);
  assert.equal((await me(h, fresh)).status, 200, 'new generation can sign in after global revoke');
});
