import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAnalytics, shouldRecordKvAnalytics } from '../src/worker/storage/analytics.ts';
import { createSystemHarness } from './support/system-harness.mjs';

class CountingKV {
  constructor() { this.data = new Map(); this.reads = 0; this.writes = 0; }
  async get(key, format) {
    this.reads++;
    const value = this.data.get(key) ?? null;
    return value && format === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.writes++; this.data.set(key, value); }
}

const sample = (overrides = {}) => ({
  timestamp: '2026-10-29T06:00:00.000Z',
  method: 'GET',
  route: '/api/v1/system/health',
  status: 200,
  durationMs: 2,
  authType: 'anonymous',
  keyId: null,
  qualifiedKeyUse: false,
  ...overrides,
});

test('KV probe filter matches only anonymous GET 200 on exact normalized templates', () => {
  for (const route of ['/api/v1/system/health', '/api/v1/auth/config']) {
    assert.equal(shouldRecordKvAnalytics(sample({ route })), false);
    const protectedVariants = [
      { method: 'HEAD' }, { method: 'POST' },
      { status: 201 }, { status: 401 }, { status: 429 }, { status: 500 },
      { authType: 'session' }, { authType: 'api_key' },
      { keyId: 'key-id' }, { qualifiedKeyUse: true },
      { route: route + '/injected' },
    ];
    for (const variant of protectedVariants) {
      assert.equal(shouldRecordKvAnalytics(sample({ route, ...variant })), true,
        'real traffic, failures and any credential context must never be skipped: ' + JSON.stringify(variant));
    }
  }
  assert.equal(shouldRecordKvAnalytics(sample({ route: '/api/v1/auth/me' })), true);
  assert.equal(shouldRecordKvAnalytics(sample({ route: '/api/v1/bins/:id' })), true);
});

test('normal probe responses cause zero KV reads/writes; Key usage and failures retain original counters', async () => {
  const kv = new CountingKV(), env = { CACHE: kv };
  for (let n = 0; n < 20; n++) {
    await recordAnalytics(env, sample({ route: n % 2 ? '/api/v1/system/health' : '/api/v1/auth/config' }));
  }
  assert.equal(kv.reads, 0);
  assert.equal(kv.writes, 0);

  await recordAnalytics(env, sample({ status: 500 }));
  await recordAnalytics(env, sample({ status: 401 }));
  await recordAnalytics(env, sample({ authType: 'api_key', keyId: 'key-id', qualifiedKeyUse: true }));
  assert.equal(kv.reads, 3);
  assert.equal(kv.writes, 3);
  const buckets = [...kv.data.values()].map(JSON.parse);
  const total = field => buckets.reduce((n, b) => n + (b[field] ?? 0), 0);
  assert.equal(total('requests'), 3);
  const keyEntries = buckets.map(b => b.keys?.['key-id']).filter(Boolean);
  assert.equal(keyEntries.reduce((n, k) => n + (k.authorizedUses ?? 0), 0), 1,
    'authorized API Key uses must remain recorded for UTC daily settlement');
  assert.equal(keyEntries[0].lastAuthorizedAt, '2026-10-29T06:00:00.000Z');
  assert.equal(buckets.reduce((n, b) => n + (b.statuses?.['500'] ?? 0), 0), 1);
  assert.equal(buckets.reduce((n, b) => n + (b.statuses?.['401'] ?? 0), 0), 1);
});

test('real public probe endpoints skip KV while opt-in Analytics Engine still receives raw events', async t => {
  const h = await createSystemHarness('analytics-probe-' + crypto.randomUUID());
  t.after(() => h.close());
  const snapshot = async () => {
    const { keys } = await h.env.CACHE.list({ prefix: 'analytics:agg:' });
    return (await Promise.all(keys.map(async k => [k.name, await h.env.CACHE.get(k.name)])))
      .sort(([a], [b]) => a.localeCompare(b));
  };
  const baseline = await snapshot();
  const shadowEvents = [];
  const shadowEnv = {
    ...h.env,
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_EVENTS: { writeDataPoint(event) { shadowEvents.push(event); } },
  };
  assert.equal((await h.request('/system/health', {}, shadowEnv)).status, 200);
  assert.equal((await h.request('/auth/config', {}, shadowEnv)).status, 200);
  assert.deepEqual(await snapshot(), baseline, 'ordinary health/config probes must not mutate the KV analytics store');
  assert.deepEqual(shadowEvents.map(event => event.blobs[1]),
    ['/api/v1/system/health', '/api/v1/auth/config'],
    'opt-in shadow telemetry must still capture these probes');

  const bearerRequest = await h.worker.fetch(new Request('https://example.test/api/v1/auth/config', {
    headers: { Authorization: 'Bearer invalid' },
  }), h.env);
  assert.equal(bearerRequest.status, 200);
  assert.notDeepEqual(await snapshot(), baseline,
    'a credential-bearing request must never take the anonymous probe bypass');
});
