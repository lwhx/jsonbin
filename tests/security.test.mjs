import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSystemHarness } from './support/system-harness.mjs';

let h;
before(async () => { h = await createSystemHarness('security'); });
after(async () => { await h?.close(); });
const login = (options = {}, env = h.env) => h.request('/auth/login', { method: 'POST', value: { username: h.env.ADMIN_USERNAME, password: h.env.ADMIN_PASSWORD }, ...options }, env);
function signedCookie(payload, secret = h.env.SESSION_SECRET) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `jsonbin_session=${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}
const validPayload = () => ({ id: 'local-admin', username: 'test', provider: 'password', exp: Math.floor(Date.now() / 1000) + 3600 });

test('malformed, noncanonical and tampered session cookies return 401 rather than 500', async () => {
  const token = h.cookie.split('=')[1];
  const [payload, signature] = token.split('.');
  // Base64 aliases differing only in unused padding bits must not be accepted.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) ^ 1];
  for (const value of ['missing-dot', '.x', `${payload}.%`, `${token}.suffix`, `${payload}.${alias}`, `${payload}.${'A'.repeat(43)}`, 'x'.repeat(4097), '%E0%A4%A']) {
    const response = await h.request('/auth/me', { headers: { Cookie: `jsonbin_session=${value}` } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { authenticated: false });
  }
  assert.equal((await h.request('/auth/me')).status, 200);
});

test('signed sessions validate identity, provider and finite integer expiry', async () => {
  for (const changes of [{ id: '' }, { id: 1 }, { username: null }, { username: 'x'.repeat(129) }, { provider: 'admin' }, { exp: '9999999999' }, { exp: 9999999999.5 }]) {
    const response = await h.request('/auth/me', { headers: { Cookie: signedCookie({ ...validPayload(), ...changes }) } });
    assert.equal(response.status, 401);
  }
  assert.equal((await h.request('/auth/me', { headers: { Cookie: signedCookie(null) } })).status, 401);
});

test('sessions expire at the boundary and rotation invalidates previously issued sessions', async () => {
  const now = Date.now;
  Date.now = () => 2_000_000_000_000;
  try {
    for (const [exp, status] of [[2_000_000_000, 401], [1_999_999_999, 401], [2_000_000_001, 200]]) {
      assert.equal((await h.request('/auth/me', { headers: { Cookie: signedCookie({ ...validPayload(), exp }) } })).status, status);
    }
  } finally { Date.now = now; }
  assert.equal((await h.request('/auth/me', {}, { ...h.env, SESSION_SECRET: 'r'.repeat(32) })).status, 401);
});

test('HTTPS session cookies are HttpOnly, Secure, SameSite Lax and logout expires the cookie', async () => {
  const response = await login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=1209600']) assert.ok(cookie.includes(attribute));
  const logout = await h.request('/auth/logout', { method: 'POST', headers: { Origin: 'https://example.test' } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('unconfigured session signing disables login cleanly without a server error', async () => {
  for (const secret of [undefined, 'short']) {
    const env = { ...h.env, SESSION_SECRET: secret };
    assert.deepEqual(await (await h.request('/auth/config', {}, env)).json(), { passwordEnabled: false, githubEnabled: false });
    const response = await login({}, env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'session_not_configured');
    assert.equal((await h.request('/auth/me', {}, env)).status, 401);
  }
});

test('login, logout and cookie-authenticated writes reject foreign and opaque origins', async () => {
  for (const origin of ['https://attacker.test', 'null', 'https://example.test.attacker.test']) {
    const response = await login({ headers: { Origin: origin } });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    const logout = await h.request('/auth/logout', { method: 'POST', headers: { Origin: origin } });
    assert.equal(logout.status, 403);
    assert.equal(logout.headers.get('set-cookie'), null);
    assert.equal((await h.request('/bins', { method: 'POST', headers: { Origin: origin }, value: { value: null } })).status, 403);
  }
  assert.equal((await login({ headers: { Origin: 'https://example.test' } })).status, 200);
  assert.equal((await login()).status, 200); // curl and other non-browser clients
});

test('CORS defaults to the request origin and exposes concurrency headers only to that origin', async () => {
  for (const [origin, allowed] of [['https://example.test', true], ['https://attacker.test', false], ['null', false]]) {
    for (const method of ['GET', 'OPTIONS']) {
      const response = await h.request('/bins', { method, headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type,If-Match' } });
      assert.equal(response.headers.get('access-control-allow-origin'), allowed ? origin : null);
      assert.match(response.headers.get('vary'), /Origin/i);
      if (allowed) {
        assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
        if (method === 'GET') assert.match(response.headers.get('access-control-expose-headers'), /ETag/);
        else assert.match(response.headers.get('access-control-allow-headers'), /If-Match/);
      }
    }
  }
});

test('explicit APP_ORIGIN is shared by CORS and login, and invalid configuration fails closed', async () => {
  const env = { ...h.env, APP_ORIGIN: 'https://dashboard.test' };
  for (const [origin, status] of [['https://dashboard.test', 200], ['https://example.test', 403]]) {
    const response = await login({ headers: { Origin: origin } }, env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('access-control-allow-origin'), status === 200 ? origin : null);
  }
  for (const invalid of ['*', 'null', 'https://dashboard.test/path', 'https://user:password@dashboard.test']) {
    const bindings = { ...h.env, APP_ORIGIN: invalid };
    const response = await login({ headers: { Origin: 'https://example.test' } }, bindings);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
});

test('login counts actual body bytes, including streams with misleading Content-Length', async () => {
  const oversized = JSON.stringify({ username: 'test', password: h.env.ADMIN_PASSWORD, extra: 'x'.repeat(4096) });
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const response = await login({ value: undefined, body: oversized, headers });
    assert.equal(response.status, 413);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const bytes = new TextEncoder().encode(oversized);
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 100)); controller.enqueue(bytes.slice(100)); controller.close(); } });
  const response = await h.worker.fetch(new Request('https://example.test/api/v1/auth/login', { method: 'POST', body, duplex: 'half' }), h.env);
  assert.equal(response.status, 413);
  assert.equal((await login({ value: undefined, body: '{' })).status, 400);
});

test('all API success, auth failures, preflight and not-found responses are no-store and hardened', async () => {
  for (const [path, options] of [['/system/health', {}], ['/auth/config', {}], ['/auth/me', { headers: { Cookie: '' } }], ['/bins', { method: 'OPTIONS', headers: { Origin: 'https://example.test' } }], ['/missing', {}]]) {
    const response = await h.request(path, options);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(response.headers.get('x-request-id'), /^[\da-f-]{36}$/);
  }
});

test('unexpected storage errors log only method and correlation id, without paths or exception data', async () => {
  const logs = [], previous = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const response = await h.request('/bins/11111111-1111-4111-8111-111111111111/value/CANARY_PATH?private-query=CANARY_QUERY', { headers: { 'X-Canary': 'CANARY_HEADER' } }, {
      ...h.env, DATA: h.adapt({ get() { throw new Error('CANARY_PASSWORD CANARY_VALUE CANARY_PATH'); } }),
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_server_error' });
    const failure = logs.find(([name]) => name === 'request_failed');
    assert.ok(failure);
    assert.deepEqual(Object.keys(failure[1]).sort(), ['method', 'requestId']);
    assert.equal(failure[1].requestId, response.headers.get('x-request-id'));
    assert.doesNotMatch(JSON.stringify(logs), /CANARY/);
    assert.ok(!JSON.stringify(logs).includes(h.cookie));
  } finally { console.error = previous; }
});

test('GitHub OAuth validates state and upstream identity before issuing a session', async () => {
  const env = { ...h.env, GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret', GITHUB_ALLOWED_USER_ID: '123' };
  const start = await h.request('/auth/github', {}, env);
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  assert.match(start.headers.get('set-cookie'), /Max-Age=600/);
  const previous = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('CANARY_UPSTREAM'); };
    const invalid = await h.request('/auth/github/callback?code=test&state=wrong', { headers: { Cookie: stateCookie } }, env);
    assert.equal(invalid.status, 400);
    assert.equal(calls, 0);
    const callback = () => h.request(`/auth/github/callback?code=test&state=${state}`, { headers: { Cookie: stateCookie } }, env);
    assert.equal((await callback()).status, 502);
    for (const user of [{ id: 123 }, { id: 123, login: '' }, { id: '123', login: 'test' }, { id: 124, login: 'test' }, { id: 123, login: 'test' }]) {
      globalThis.fetch = async (url) => Response.json(url.includes('access_token') ? { access_token: 'test-access-token' } : user);
      const response = await callback();
      assert.equal(response.status, user.id === 124 ? 403 : user.login === 'test' && user.id === 123 ? 302 : 502);
      assert.equal(response.headers.get('set-cookie')?.includes('jsonbin_session='), response.status === 302);
    }
  } finally { globalThis.fetch = previous; }
});
