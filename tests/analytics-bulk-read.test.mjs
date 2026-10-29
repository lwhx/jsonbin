import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryAnalytics, ANALYTICS_PREFIX } from '../src/worker/storage/analytics.ts';

function bucket(count, status, duration, keyId = 'test-key') {
  return {
    requests: count,
    totalDuration: count * duration,
    durationHistogram: { [duration]: count },
    statuses: { [status]: count },
    endpoints: {
      'GET /api/v1/bins/:id': {
        requests: count,
        totalDuration: count * duration,
        errors: status >= 400 ? count : 0,
        durationHistogram: { [duration]: count },
      },
    },
    keys: {
      [keyId]: {
        requests: count, count4xx: status >= 400 && status < 500 ? count : 0,
        count429: status === 429 ? count : 0,
      },
    },
    errors: {},
  };
}

test('30-day analytics uses exactly 36 KV bulk operations, bounded concurrency, and legacy shards', async () => {
  const current = new Date().toISOString().slice(0, 13);
  const preceding = new Date(Date.now() - 3600000).toISOString().slice(0, 13);
  const oldest = new Date(Date.now() - 719 * 3600000).toISOString().slice(0, 13);
  const records = new Map([
    [ANALYTICS_PREFIX + current, bucket(3, 200, 2)],
    [ANALYTICS_PREFIX + preceding + ':2', bucket(2, 429, 1000)],
    [ANALYTICS_PREFIX + oldest + ':3', bucket(1, 200, 100)],
  ]);

  let operations = 0, active = 0, maxActive = 0;
  const observed = new Set();
  const cache = {
    async get(keys, type) {
      assert.ok(Array.isArray(keys), 'no individual KV gets allowed on this path');
      assert.ok(keys.length > 0 && keys.length <= 100);
      assert.equal(type, 'json');
      operations++;
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      for (const key of keys) observed.add(key);
      return new Map(keys.map(key => [key, records.get(key) ?? null]));
    },
  };
  const result = await queryAnalytics({ CACHE: cache }, 720);
  assert.equal(operations, 36, '3,600 keys / 100 per bulk call');
  assert.ok(maxActive <= 6, 'at most six concurrent KV bulk gets');
  assert.equal(observed.size, 3600, 'include legacy plus four shards for all 720 hours');
  assert.equal(result.partial, false);
  assert.equal(result.overview.totalRequests, 6);
  assert.equal(result.overview.count429, 2);
  assert.equal(result.overview.successRate, 66.67);
  assert.equal(result.overview.p95DurationMs, 1000);
  assert.equal(result.endpoints.find(x => x.route === '/api/v1/bins/:id').p95DurationMs, 1000);
  assert.equal(result.keys.find(x => x.keyId === 'test-key').requests, 6);
});

test('1h, 24h, 7d queries stay within KV bulk key limits', async () => {
  for (const [hours, operations] of [[1, 1], [24, 2], [168, 9]]) {
    let calls = 0;
    const cache = {
      async get(keys, type) {
        calls++;
        assert.ok(keys.length <= 100);
        assert.equal(type, 'json');
        return new Map(keys.map(k => [k, null]));
      },
    };
    const result = await queryAnalytics({ CACHE: cache }, hours);
    assert.equal(calls, operations, hours + 'h query');
    assert.equal(result.overview.totalRequests, 0);
    assert.equal(result.partial, false);
  }
});

test('failed analytics bulk reads are visible as partial, not silently authoritative totals', async () => {
  const current = new Date().toISOString().slice(0, 13);
  let calls = 0;
  const cache = {
    async get(keys) {
      calls++;
      if (calls === 2) throw new Error('KV transient failure: do not expose exception');
      return new Map(keys.map(k => [k, k === ANALYTICS_PREFIX + current ? bucket(2, 200, 5) : null]));
    },
  };
  const result = await queryAnalytics({ CACHE: cache }, 24);
  assert.equal(calls, 2);
  assert.equal(result.partial, true);
  assert.equal(result.overview.totalRequests, 2);
  assert.deepEqual(result.statuses, [{ status: 200, count: 2 }]);
  assert.equal((await queryAnalytics({ CACHE: undefined }, 24)).partial, true);
});
