import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shadowAnalyticsEvent } from '../src/worker/storage/analytics-engine-shadow.ts';

const point = {
  timestamp: '2026-10-29T03:00:00.000Z',
  method: 'GET',
  route: '/api/v1/bins/:id',
  status: 200,
  durationMs: 18,
  authType: 'api_key',
  keyId: 'private-key-id',
  qualifiedKeyUse: true,
};

test('shadow telemetry is disabled by default and never requires binding', () => {
  let count = 0;
  const env = { ANALYTICS_EVENTS: { writeDataPoint() { count++; } } };
  assert.equal(shadowAnalyticsEvent(env, point), false);
  assert.equal(shadowAnalyticsEvent({ ANALYTICS_EVENTS_SHADOW: '1' }, point), false);
  assert.equal(count, 0);
});

test('shadow writes contain only bounded normalized fields, never Key IDs or raw data', () => {
  let sent;
  const env = {
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_EVENTS: { writeDataPoint(event) { sent = event; } },
  };
  assert.equal(shadowAnalyticsEvent(env, { ...point, error: 'rate_limit_exceeded' }), true);
  assert.deepEqual(sent.blobs, ['GET', '/api/v1/bins/:id', '200', 'api_key', 'rate_limit_exceeded', '1']);
  assert.deepEqual(sent.doubles, [1, 18, Date.parse(point.timestamp)]);
  assert.deepEqual(sent.indexes, ['jsonbin']);
  const serialized = JSON.stringify(sent);
  for (const secret of ['private-key-id', 'Authorization', 'Bearer', 'Cookie', 'example-slug']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('untrusted paths and error labels cannot enter the dataset', () => {
  const events = [];
  const env = { ANALYTICS_EVENTS_SHADOW: '1', ANALYTICS_EVENTS: { writeDataPoint(event) { events.push(event); } } };
  assert.equal(shadowAnalyticsEvent(env, { ...point, route: '/api/v1/b/secret-slug?token=123' }), false);
  assert.equal(shadowAnalyticsEvent(env, { ...point, route: '/api/v1/bins/:id', error: 'Bearer secret' }), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].blobs[4], '');
  assert.equal(shadowAnalyticsEvent(env, { ...point, status: 999 }), false);
});

test('Analytics Engine outages never throw or affect KV fallback', () => {
  assert.doesNotThrow(() => {
    const success = shadowAnalyticsEvent({
      ANALYTICS_EVENTS_SHADOW: '1',
      ANALYTICS_EVENTS: { writeDataPoint() { throw Error('dataset_unavailable'); } },
    }, point);
    assert.equal(success, false);
  });
});
