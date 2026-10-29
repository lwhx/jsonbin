import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSystemHarness } from './support/system-harness.mjs';
import { readKeyUsageShadow } from '../src/worker/storage/key-usage-do-shadow.ts';
import stagingWorker from '../src/worker/usage-staging-entry.ts';
import {
  parseQueuedKeyUsageEvent, archiveKeyForEvent, enqueueKeyUsageShadow,
  consumeKeyUsageEvents, archiveKeyUsageDeadLetters,
} from '../src/worker/storage/key-usage-queue.ts';

const keyId = '12345678-1234-4234-8234-123456789012';
const request = () => ({ timestamp: new Date().toISOString(), method: 'GET',
  route: '/api/v1/bins', status: 200, durationMs: 1,
  authType: 'api_key', keyId, qualifiedKeyUse: true });
const event = () => ({ version: 1, keyId, eventId: crypto.randomUUID(),
  timestamp: new Date().toISOString() });

test('P24b queue is default-off; acknowledged send keeps minimal body', async () => {
  const writes = [];
  const env = { KEY_USAGE_EVENTS_QUEUE: { async send(body) { writes.push(body); } } };
  const id = crypto.randomUUID();
  assert.equal(await enqueueKeyUsageShadow(env, request(), id), false);
  assert.equal(writes.length, 0);
  assert.equal(await enqueueKeyUsageShadow({ ...env, KEY_USAGE_QUEUE_SHADOW: '1' }, request(), id), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].eventId, id);
  assert.deepEqual(Object.keys(writes[0]).sort(), ['eventId','keyId','timestamp','version']);
  assert.equal(parseQueuedKeyUsageEvent({ ...event(), token: 'sensitive' }), null);
  assert.equal(parseQueuedKeyUsageEvent(event()).version, 1);
});

test('P24b invalid/failed Queue sends never propagate into API', async () => {
  const bad = { KEY_USAGE_QUEUE_SHADOW: '1', KEY_USAGE_EVENTS_QUEUE: {
    async send() { throw Error('secret data should not escape'); },
  } };
  assert.equal(await enqueueKeyUsageShadow(bad, request(), crypto.randomUUID()), false);
  assert.equal(await enqueueKeyUsageShadow(bad, { ...request(), status: 429 }, crypto.randomUUID()), false);
});

test('P24b per-message retry does not ACK invalid or undelivered messages', async () => {
  let retried = 0, acked = 0;
  const message = { body: { ...event(), token: 'extra' },
    ack() { acked++; }, retry() { retried++; } };
  await consumeKeyUsageEvents({ queue: 'jsonbin-key-usage-events-preview', messages: [message] }, {});
  assert.equal(retried, 1);
  assert.equal(acked, 0);
});

test('P24b DLQ archives only validated private events; retries storage faults', async () => {
  const e = event(), objects = [];
  let acked = 0, retried = 0;
  const msg = { body: e, ack() { acked++; }, retry() { retried++; } };
  const batch = { queue: 'jsonbin-key-usage-dlq-preview', messages: [msg] };
  await archiveKeyUsageDeadLetters(batch, { KEY_USAGE_DLQ_ARCHIVE: {
    async put(key, body) { objects.push([key, JSON.parse(body)]); },
  } });
  assert.equal(acked, 1);
  assert.equal(retried, 0);
  assert.equal(objects[0][0], archiveKeyForEvent(e));
  assert.deepEqual(objects[0][1], e);
  await archiveKeyUsageDeadLetters(batch, {});
  assert.equal(retried, 1);
});

test('P24b staging configuration isolates all resources and is explicitly disabled', () => {
  const stage = JSON.parse(readFileSync('wrangler.usage-staging.jsonc', 'utf8'));
  const prod = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  assert.notEqual(stage.name, prod.name);
  assert.equal(stage.vars.KEY_USAGE_QUEUE_SHADOW, '0');
  assert.equal(stage.vars.KEY_USAGE_CONSUMER_ENABLED, '0');
  assert.equal(stage.vars.KEY_USAGE_DO_SHADOW, '0');
  assert.equal(prod.queues, undefined, 'no Cloudflare Queue may be configured on production');
  assert.equal(stage.main, 'src/worker/usage-staging-entry.ts');
  assert.equal(stage.vars.KEY_USAGE_STAGING_MODE, '0');
  assert.equal(stage.kv_namespaces, undefined);
  assert.equal(stage.assets, undefined);
  assert.equal(stage.triggers, undefined);
  assert.deepEqual(stage.r2_buckets.map(x => x.binding), ['KEY_USAGE_DLQ_ARCHIVE']);
  assert.ok(stage.r2_buckets[0].bucket_name.includes('staging'));
  assert.deepEqual(stage.durable_objects.bindings.map(x => x.name), ['KEY_USAGE_COUNTER']);
  assert.ok(!('STAGING_PROBE_TOKEN' in stage.vars));
  const [main, dlq] = stage.queues.consumers;
  assert.equal(main.dead_letter_queue, dlq.queue);
  assert.notEqual(dlq.dead_letter_queue, main.queue);
  assert.ok(dlq.dead_letter_queue.includes('quarantine-staging'));
  assert.equal(stage.queues.producers[0].queue, main.queue);
});

test('P24b Queue consumer ACKs successful and duplicate deliveries exactly once', async t => {
  const h = await createSystemHarness('usage-queue-real-' + crypto.randomUUID());
  t.after(() => h.close());
  const e = event();
  let acked = 0, retried = 0;
  const message = { id: crypto.randomUUID(), body: e,
    ack() { acked++; }, retry() { retried++; } };
  const batch = { queue: 'jsonbin-key-usage-events-staging', messages: [message] };
  await assert.rejects(
    h.worker.queue(batch, { ...h.env, KEY_USAGE_CONSUMER_ENABLED: '0' }),
    /usage_queue_consumer_disabled/,
  );
  assert.equal(acked, 0);
  await h.worker.queue(batch, { ...h.env, KEY_USAGE_CONSUMER_ENABLED: '1' });
  await h.worker.queue(batch, { ...h.env, KEY_USAGE_CONSUMER_ENABLED: '1' });
  assert.equal(acked, 2);
  assert.equal(retried, 0);
  const count = await readKeyUsageShadow(
    { ...h.env, KEY_USAGE_DO_SHADOW: '1' }, keyId, e.timestamp.slice(0, 10));
  assert.equal(count.count, 1, 'SQLite event UUID must deduplicate Queue redeliveries');
});

test('P24b permanent counter fault retries individual messages without ACK', async () => {
  const e = event();
  let acks = 0, retries = 0;
  const message = { id: crypto.randomUUID(), body: e,
    ack() { acks++; }, retry({ delaySeconds }) { retries++; assert.equal(delaySeconds, 30); } };
  await consumeKeyUsageEvents({ queue: 'jsonbin-key-usage-events-staging', messages: [message] }, {
    KEY_USAGE_COUNTER: { idFromName: () => 'fake', get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) },
  });
  assert.equal(acks, 0);
  assert.equal(retries, 1);
});

test('P24b malformed DLQ payload is quarantined without recording raw content', async () => {
  const writes = [];
  let acks = 0, retries = 0;
  const body = { version: 1, token: 'jb_live_PRIVATE', attackerSupplied: 'secret content' };
  const msg = { id: crypto.randomUUID(), body, ack() { acks++; }, retry() { retries++; } };
  const env = { KEY_USAGE_DLQ_ARCHIVE: { async put(key, data) { writes.push([key, data]); } } };
  const batch = { queue: 'jsonbin-key-usage-dlq-staging', messages: [msg] };
  await archiveKeyUsageDeadLetters(batch, env);
  assert.equal(acks, 1);
  assert.equal(retries, 0);
  assert.equal(writes.length, 1);
  const pathParts = writes[0][0].split('/');
  assert.deepEqual(pathParts.slice(0, 3), ['internal', 'key-usage-quarantine', 'v1']);
  assert.equal(pathParts.length, 5);
  assert.equal(pathParts[3].length, 10);
  assert.match(pathParts[4].split('.')[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(writes[0][1]), {
    version: 1, category: 'invalid_usage_event', sourceQueue: batch.queue,
  });
  assert.ok(!writes[0][1].includes('PRIVATE'));
  assert.ok(!writes[0][1].includes('secret content'));
  await archiveKeyUsageDeadLetters(batch, env);
  assert.equal(writes[0][0], writes[1][0], 'same Queue ID must have deterministic quarantine path');
});

test('P24b private R2 archive failures are retried without acknowledging messages', async () => {
  const e = event();
  let acks = 0, retries = 0;
  const msg = { id: crypto.randomUUID(), body: e, ack() { acks++; },
    retry({ delaySeconds }) { retries++; assert.equal(delaySeconds, 60); } };
  const batch = { queue: 'jsonbin-key-usage-dlq-staging', messages: [msg] };
  await archiveKeyUsageDeadLetters(batch, { KEY_USAGE_DLQ_ARCHIVE: {
    async put() { throw new Error('sensitive storage error not allowed in logs'); },
  } });
  assert.equal(acks, 0);
  assert.equal(retries, 1);
});

test('P24b manually replayed archived event uses its original UUID and never recounts', async t => {
  const h = await createSystemHarness('usage-queue-replay-' + crypto.randomUUID());
  t.after(() => h.close());
  const { replayArchivedKeyUsageEvent } = await import('../src/worker/storage/key-usage-queue.ts');
  const e = event();
  const key = archiveKeyForEvent(e);
  const env = { ...h.env, KEY_USAGE_DLQ_ARCHIVE: {
    async get(path) { return path === key ? { text: async () => JSON.stringify(e) } : null; },
  } };
  assert.equal(await replayArchivedKeyUsageEvent(env, key), true);
  assert.equal(await replayArchivedKeyUsageEvent(env, key), true);
  assert.equal(await replayArchivedKeyUsageEvent(env, key.replace(e.keyId, 'abcdefab-1234-4234-8234-123456789012')), false);
  assert.equal((await readKeyUsageShadow(
    { ...h.env, KEY_USAGE_DO_SHADOW: '1' }, keyId, e.timestamp.slice(0, 10))).count, 1);
});


test('P24b standalone staging routes require a strong token and expose no business APIs', async () => {
  const token = 'a'.repeat(64);
  const env = { KEY_USAGE_STAGING_MODE: '1', STAGING_PROBE_TOKEN: token,
    KEY_USAGE_QUEUE_SHADOW: '1', KEY_USAGE_CONSUMER_ENABLED: '1',
    KEY_USAGE_EVENTS_QUEUE: { async send() {} }, KEY_USAGE_COUNTER: {} };
  const get = (path, headers = {}) =>
    stagingWorker.fetch(new Request('https://staging.example.test' + path, { headers }), env);
  const absent = await get('/__staging/usage/status');
  assert.equal(absent.status, 401);
  assert.equal(absent.headers.get('Cache-Control'), 'no-store');
  assert.equal((await get('/api/v1/system/health', { Authorization: 'Bearer ' + token })).status, 404);
  assert.equal((await stagingWorker.fetch(
    new Request('https://staging.example.test/__staging/usage/status', {
      headers: { Authorization: 'Bearer ' + token },
    }), { ...env, KEY_USAGE_STAGING_MODE: '0' })).status, 404);
  const status = await get('/__staging/usage/status', { Authorization: 'Bearer ' + token });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).producerEnabled, true);
  const bad = await get('/__staging/usage/status?unexpected=1', { Authorization: 'Bearer ' + token });
  assert.equal(bad.status, 400);
});

test('P24b staging HTTP emits only valid synthetic events and exposes SQLite count', async t => {
  const h = await createSystemHarness('usage-staging-entry-' + crypto.randomUUID());
  t.after(() => h.close());
  const writes = [];
  const token = '0'.repeat(64);
  const env = { ...h.env, KEY_USAGE_STAGING_MODE: '1', STAGING_PROBE_TOKEN: token,
    KEY_USAGE_QUEUE_SHADOW: '1', KEY_USAGE_CONSUMER_ENABLED: '1',
    KEY_USAGE_EVENTS_QUEUE: { async send(body) { writes.push(body); } } };
  const headers = { Authorization: 'Bearer ' + token };
  const e = event();
  const day = e.timestamp.slice(0, 10);
  const path = '/__staging/usage/day?keyId=' + encodeURIComponent(e.keyId) + '&day=' + day;
  const get = p => stagingWorker.fetch(new Request('https://staging.example.test' + p, { headers }), env);
  const emit = body => stagingWorker.fetch(new Request('https://staging.example.test/__staging/usage/emit', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const baseline = await get(path);
  assert.equal(baseline.status, 200);
  assert.equal((await baseline.json()).count, 0);
  assert.equal((await emit(e)).status, 202);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], e);
  assert.equal((await emit({ ...e, token: 'jb_live_SECRET' })).status, 400);
  assert.equal(writes.length, 1, 'injected payload must never enqueue');
  assert.equal((await emit({ ...e, timestamp: new Date(Date.now() - 36 * 86400000).toISOString() })).status, 422);

  let acked = 0;
  const msg = { id: crypto.randomUUID(), body: writes[0], ack() { acked++; }, retry() {} };
  const batch = { queue: 'jsonbin-key-usage-events-staging', messages: [msg] };
  await stagingWorker.queue(batch, env);
  await stagingWorker.queue(batch, env);
  assert.equal(acked, 2);
  const result = await get(path);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).count, 1);
  await assert.rejects(stagingWorker.queue(batch, {
    ...env, KEY_USAGE_CONSUMER_ENABLED: '0',
  }), /usage_staging_consumer_disabled/);
  await assert.rejects(stagingWorker.queue({
    queue: 'jsonbin-key-usage-events-prod', messages: [msg],
  }, env), /unsupported_usage_staging_queue/);
});
