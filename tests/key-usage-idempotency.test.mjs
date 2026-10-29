import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { readKeyUsageShadow, recordKeyUsageShadow } from '../src/worker/storage/key-usage-do-shadow.ts';

const KEY_ID = '12345678-1234-4234-8234-123456789012';
const OTHER_KEY_ID = 'abcdefab-1234-4234-8234-123456789012';
const now = () => new Date().toISOString();
const event = (overrides = {}) => ({
  timestamp: now(), method: 'GET', route: '/api/v1/bins', status: 200,
  durationMs: 1, authType: 'api_key', keyId: KEY_ID,
  qualifiedKeyUse: true, ...overrides,
});

test('P24: replayed UUID is counted exactly once even with 80 concurrent requests', async t => {
  const h = await createSystemHarness('usage-dedupe-' + crypto.randomUUID());
  t.after(() => h.close());
  const env = { ...h.env, KEY_USAGE_DO_SHADOW: '1' };
  const timestamp = now();
  const day = timestamp.slice(0, 10);
  const stableId = crypto.randomUUID();

  const results = await Promise.all(Array.from({ length: 80 }, () =>
    recordKeyUsageShadow(env, event({ timestamp }), stableId)));
  assert.ok(results.every(Boolean), 'replays must be accepted, not counted again');
  const first = await readKeyUsageShadow(env, KEY_ID, day);
  assert.equal(first.count, 1);
  assert.equal(first.lastUsedAt, timestamp);

  // Distinct event IDs at the very same timestamp represent distinct requests.
  const others = await Promise.all(Array.from({ length: 50 }, () =>
    recordKeyUsageShadow(env, event({ timestamp }), crypto.randomUUID())));
  assert.ok(others.every(Boolean));
  assert.equal((await readKeyUsageShadow(env, KEY_ID, day)).count, 51);
  assert.equal((await readKeyUsageShadow(env, OTHER_KEY_ID, day)).count, 0);
});

test('P24: internal SQLite RPC detects conflicting event IDs and stale/future replays', async t => {
  const h = await createSystemHarness('usage-conflicts-' + crypto.randomUUID());
  t.after(() => h.close());
  const ns = h.env.KEY_USAGE_COUNTER;
  const stub = ns.get(ns.idFromName('jsonbin:key-usage:v1:' + KEY_ID));
  const post = (payload) => stub.fetch('https://key-usage.internal/usage/increment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const timestamp = now(), day = timestamp.slice(0, 10), eventId = crypto.randomUUID();
  assert.deepEqual(await (await post({ timestamp, eventId })).json(), { ok: true, deduplicated: false });
  assert.deepEqual(await (await post({ timestamp, eventId })).json(), { ok: true, deduplicated: true });
  assert.equal((await readKeyUsageShadow({ ...h.env, KEY_USAGE_DO_SHADOW: '1' }, KEY_ID, day)).count, 1);

  const anotherTimestamp = new Date(Date.parse(timestamp) - 1000).toISOString();
  const conflict = await post({ timestamp: anotherTimestamp, eventId });
  assert.equal(conflict.status, 409, 'same UUID with altered payload cannot silently replace the original');
  assert.deepEqual(await conflict.json(), { error: 'usage_event_id_conflict' });

  for (const payload of [
    { timestamp }, { eventId }, { timestamp, eventId: 'not-a-uuid' },
    { timestamp, eventId, token: 'jb_live_PRIVATE' },
    { timestamp, eventId, count: 10_000 },
    { timestamp: 17123456, eventId },
    { timestamp: '2026-02-30T00:00:00.000Z', eventId: crypto.randomUUID() },
    { timestamp, eventId: crypto.randomUUID(), unexpected: 'x'.repeat(300) },
  ]) assert.equal((await post(payload)).status, 400);
  const tooOld = new Date(Date.now() - 36 * 86400000).toISOString();
  const inFuture = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await post({ timestamp: tooOld, eventId: crypto.randomUUID() })).status, 422);
  assert.equal((await post({ timestamp: inFuture, eventId: crypto.randomUUID() })).status, 422);
  assert.equal((await readKeyUsageShadow({ ...h.env, KEY_USAGE_DO_SHADOW: '1' }, KEY_ID, day)).count, 1);
});

test('P24: lost response after SQLite commit retries with same UUID, without double-counting', async t => {
  const h = await createSystemHarness('usage-lost-ack-' + crypto.randomUUID());
  t.after(() => h.close());
  const real = h.env.KEY_USAGE_COUNTER;
  let attempts = 0;
  const bodies = [];
  const binding = {
    idFromName: name => real.idFromName(name),
    get: id => {
      const stub = real.get(id);
      return {
        async fetch(url, init) {
          attempts++;
          bodies.push(init.body);
          const response = await stub.fetch(url, init);
          if (attempts === 1) {
            assert.equal(response.status, 200);
            throw Error('simulated lost ACK after durable commit');
          }
          return response;
        },
      };
    },
  };
  const timestamp = now();
  const env = { ...h.env, KEY_USAGE_COUNTER: binding, KEY_USAGE_DO_SHADOW: '1' };
  assert.equal(await recordKeyUsageShadow(env, event({ timestamp })), true);
  assert.equal(attempts, 2, 'one uncertain response must cause one bounded retry');
  assert.equal(bodies[0], bodies[1], 'retry must have exactly the same event ID AND timestamp');
  const payload = JSON.parse(bodies[0]);
  assert.match(payload.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(payload.timestamp, timestamp);
  assert.equal((await readKeyUsageShadow({ ...h.env, KEY_USAGE_DO_SHADOW: '1' }, KEY_ID, timestamp.slice(0, 10))).count, 1);
});

test('P24: retryable 5xx/429 have finite retries; non-retryable 4xx stops immediately', async () => {
  const seen = [];
  const binding = {
    idFromName: name => name,
    get: () => ({
      async fetch(_url, init) {
        seen.push(JSON.parse(init.body));
        if (seen.length === 1) return new Response(null, { status: 503 });
        if (seen.length === 2) return new Response(null, { status: 429 });
        return Response.json({ ok: true, deduplicated: false });
      },
    }),
  };
  const env = { KEY_USAGE_DO_SHADOW: '1', KEY_USAGE_COUNTER: binding };
  const timestamp = now();
  assert.equal(await recordKeyUsageShadow(env, event({ timestamp })), true);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(x => x.eventId === seen[0].eventId));
  assert.ok(seen.every(x => x.timestamp === timestamp));

  let attempts = 0;
  const reject = { idFromName: () => 'test', get: () => ({
    async fetch() { attempts++; return new Response(null, { status: 409 }); },
  }) };
  assert.equal(await recordKeyUsageShadow({ ...env, KEY_USAGE_COUNTER: reject }, event()), false);
  assert.equal(attempts, 1, 'conflicting UUID must never be retried');

  let outageAttempts = 0;
  const outage = { idFromName: () => 'test', get: () => ({
    async fetch() { outageAttempts++; throw Error('sensitive Authorization value must not be logged'); },
  }) };
  assert.equal(await recordKeyUsageShadow({ ...env, KEY_USAGE_COUNTER: outage }, event()), false);
  assert.equal(outageAttempts, 3, 'permanent outage must stop at the hard retry limit');
});

test('P24: caller-supplied X-Request-ID is ignored; server generates unique ID for each valid API call', async t => {
  const h = await createSystemHarness('usage-server-id-' + crypto.randomUUID());
  t.after(() => h.close());
  const created = await (await h.request('/keys', { method: 'POST', value: {
    name: 'request-id-protection', scopes: ['bin:read'], rateLimitPerMinute: null,
  } })).json();
  const shadowEnv = { ...h.env, KEY_USAGE_DO_SHADOW: '1' };
  const clientProvided = crypto.randomUUID();
  const request = () => h.worker.fetch(new Request('https://example.test/api/v1/bins', {
    headers: { Authorization: 'Bearer ' + created.token, 'X-Request-ID': clientProvided },
  }), shadowEnv);
  const responses = await Promise.all([request(), request()]);
  assert.ok(responses.every(r => r.status === 200));
  const generated = responses.map(r => r.headers.get('x-request-id'));
  assert.ok(generated.every(Boolean));
  assert.notEqual(generated[0], generated[1]);
  assert.ok(generated.every(x => x !== clientProvided));
  assert.equal((await readKeyUsageShadow(shadowEnv, created.key.id, new Date().toISOString().slice(0, 10))).count, 2);
});
