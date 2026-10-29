import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { readKeyUsageShadow, recordKeyUsageShadow } from '../src/worker/storage/key-usage-do-shadow.ts';

const KEY_A = '12345678-1234-4234-8234-123456789012';
const KEY_B = 'abcdefab-1234-4234-8234-123456789012';
const STAMP = '2026-10-08T23:59:50.000Z';
const event = (overrides = {}) => ({
  timestamp: STAMP, method: 'GET', route: '/api/v1/bins',
  status: 200, durationMs: 7, authType: 'api_key',
  keyId: KEY_A, qualifiedKeyUse: true, ...overrides,
});

test('P22 shadow is disabled by default; unauthorized/anonymous/invalid Key events never cause DO RPC', async () => {
  const calls = [];
  const binding = {
    idFromName(name) { calls.push(['identity', name]); return name; },
    get(identity) {
      return {
        async fetch(url, init) {
          calls.push(['request', url, init]);
          return Response.json({ ok: true });
        },
      };
    },
  };
  const base = { KEY_USAGE_COUNTER: binding };
  assert.equal(await recordKeyUsageShadow(base, event()), false);
  assert.equal(await recordKeyUsageShadow({ KEY_USAGE_DO_SHADOW: '1' }, event()), false);
  const env = { ...base, KEY_USAGE_DO_SHADOW: '1' };
  for (const changes of [
    { authType: 'anonymous' }, { authType: 'session' },
    { qualifiedKeyUse: false }, { keyId: 'invalid-key-id' },
    { keyId: null }, { status: 401 }, { status: 403 }, { status: 429 },
    { timestamp: 'bad-day' }, { status: 999 },
  ]) assert.equal(await recordKeyUsageShadow(env, event(changes)), false, JSON.stringify(changes));
  assert.equal(calls.length, 0);

  assert.equal(await recordKeyUsageShadow(env, event()), true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['identity', 'jsonbin:key-usage:v1:' + KEY_A]);
  const [type, url, init] = calls[1];
  assert.equal(type, 'request');
  assert.equal(new URL(url).pathname, '/usage/increment');
  assert.equal(init.method, 'POST');
  const payload = JSON.parse(init.body);
  assert.equal(payload.timestamp, STAMP);
  assert.match(payload.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  for (const sensitive of [KEY_A, 'Bearer', 'Cookie', 'token', 'requestBody']) {
    assert.equal(init.body.includes(sensitive), false, 'shadow RPC body must carry timestamps only');
  }
  assert.equal(await readKeyUsageShadow({ KEY_USAGE_COUNTER: binding }, KEY_A, '2026-10-08'), null);
});

test('P22 SQLite DO serializes concurrent per-Key increments with UTC day separation and input bounds', async t => {
  const h = await createSystemHarness('usage-shadow-atomic-' + crypto.randomUUID());
  t.after(() => h.close());
  const namespace = h.env.KEY_USAGE_COUNTER;
  const stub = namespace.get(namespace.idFromName('jsonbin:key-usage:v1:' + KEY_A));
  const other = namespace.get(namespace.idFromName('jsonbin:key-usage:v1:' + KEY_B));
  const post = (target, body) => target.fetch('https://key-usage.internal/usage/increment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body && 'timestamp' in body && !('eventId' in body)
      ? { ...body, eventId: crypto.randomUUID() } : body),
  });
  const count = async (target, day) => (await target.fetch('https://key-usage.internal/usage/day/' + day)).json();

  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const nextDay = new Date(Date.parse(day + 'T00:00:00.000Z') + 86400000).toISOString().slice(0, 10);
  const late = day + 'T23:59:50.000Z';
  const next = nextDay + 'T00:00:01.000Z';
  const times = Array.from({ length: 48 }, (_, i) => new Date(Date.parse(day + 'T23:58:00.000Z') + i * 1000).toISOString());
  const responses = await Promise.all(times.map(timestamp => post(stub, { timestamp })));
  assert.ok(responses.every(r => r.status === 200), 'all concurrent SQLite UPSERTs must commit');
  assert.deepEqual(await count(stub, day), {
    day, count: 48, lastUsedAt: times.at(-1),
  });
  assert.deepEqual(await count(other, day), {
    day, count: 0, lastUsedAt: null,
  }, 'usage counters must be isolated per Key');

  assert.equal((await post(stub, { timestamp: next })).status, 200);
  assert.deepEqual(await count(stub, nextDay), {
    day: nextDay, count: 1, lastUsedAt: next,
  });
  assert.equal((await post(stub, { timestamp: late })).status, 200);
  assert.equal((await count(stub, day)).count, 49);
  assert.equal((await count(stub, day)).lastUsedAt, late);

  for (const bad of [
    {}, { timestamp: '2026-10-08' }, { timestamp: 1234 },
    { timestamp: late, keyId: KEY_A }, { timestamp: late, count: 1000 },
    { timestamp: '2026-99-08T23:59:50.000Z' },
  ]) assert.equal((await post(stub, bad)).status, 400, 'invalid body must not mutate usage');
  assert.equal((await count(stub, day)).count, 49);
  assert.equal((await stub.fetch('https://key-usage.internal/usage/day/2026-02-30')).status, 400);
  assert.equal((await stub.fetch('https://key-usage.internal/usage/increment')).status, 405);
  assert.equal((await stub.fetch('https://key-usage.internal/usage/other', { method: 'POST' })).status, 405);
});

test('P22 actual API requests shadow only qualified Key use, not rejected 403 or 429; KV remains authoritative', async t => {
  const h = await createSystemHarness('usage-shadow-api-' + crypto.randomUUID());
  t.after(() => h.close());
  const unlimited = await (await h.request('/keys', { method: 'POST', value: {
    name: 'shadow-unlimited', scopes: ['bin:read'], rateLimitPerMinute: null,
  } })).json();
  const limited = await (await h.request('/keys', { method: 'POST', value: {
    name: 'shadow-limited', scopes: ['bin:read'], rateLimitPerMinute: 1,
  } })).json();
  const env = { ...h.env, KEY_USAGE_DO_SHADOW: '1' };
  const call = (token, path = '/bins', method = 'GET') =>
    h.worker.fetch(new Request('https://example.test/api/v1' + path, {
      method, headers: { Authorization: 'Bearer ' + token },
    }), env);
  const responses = await Promise.all(Array.from({ length: 10 }, () => call(unlimited.token)));
  assert.ok(responses.every(r => r.status === 200), 'all 10 authenticated reads should succeed');
  assert.equal((await call(unlimited.token, '/bins', 'POST')).status, 403, 'insufficient scope not billable');
  assert.equal((await call(limited.token)).status, 200);
  assert.equal((await call(limited.token)).status, 429, 'rate-limit rejection not billable');

  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await readKeyUsageShadow(env, unlimited.key.id, day)).count, 10);
  assert.equal((await readKeyUsageShadow(env, limited.key.id, day)).count, 1);
  const whenDisabled = { ...h.env, KEY_USAGE_DO_SHADOW: undefined };
  assert.equal(await readKeyUsageShadow(whenDisabled, unlimited.key.id, day), null);
  assert.equal(await readKeyUsageShadow(env, KEY_A, '2026-02-30'), null);

  // The old KV path remains live and its count may differ under concurrent RMW;
  // do not treat it as an exact reference or settle R2 from this new DO yet.
  const keys = (await h.env.CACHE.list({ prefix: 'analytics:agg:' })).keys;
  assert.ok(keys.length > 0);
  assert.equal((await (await h.request('/keys')).json()).items.length, 2);
});

test('P22 shadow DO failures never block valid Key reads or bypass the old KV writer', async t => {
  const h = await createSystemHarness('usage-shadow-failure-' + crypto.randomUUID());
  t.after(() => h.close());
  const created = await (await h.request('/keys', { method: 'POST', value: { name: 'do-down', scopes: ['bin:read'] } })).json();
  const unavailable = {
    ...h.env, KEY_USAGE_DO_SHADOW: '1',
    KEY_USAGE_COUNTER: { idFromName() { throw Error('shadow unavailable'); } },
  };
  const res = await h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: 'Bearer ' + created.token },
  }), unavailable);
  assert.equal(res.status, 200);
  const keys = (await h.env.CACHE.list({ prefix: 'analytics:agg:' })).keys;
  assert.ok(keys.length > 0, 'legacy KV metrics must continue even when shadow DO crashes');
  const raw = (await Promise.all(keys.map(async k => await h.env.CACHE.get(k.name)))).join('\n');
  assert.equal(raw.includes(created.key.id), true, 'legacy authorized request remains in KV');
});
