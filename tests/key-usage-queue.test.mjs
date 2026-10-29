import { test } from 'node:test';
import assert from 'node:assert/strict';
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
