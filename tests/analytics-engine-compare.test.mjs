import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import {
  compareShadowAnalytics,
  shadowComparisonEnabled,
  shadowComparisonRange,
} from '../src/worker/storage/analytics-engine-compare.ts';

function previewSQL() {
  const seen = [];
  const binding = {
    async query(input) {
      seen.push(input);
      if (input.query.includes('AS totalRequests')) {
        return { data: [{ totalRequests: '10', totalDurationMs: '190', p95DurationMs: '75' }], rows: 1 };
      }
      if (input.query.includes('blob3 AS status')) {
        return { data: [{ status: '200', requests: '8' }, { status: '429', requests: '2' }], rows: 2 };
      }
      if (input.query.includes('blob1 AS method')) {
        return {
          data: [
            { method: 'GET', route: '/api/v1/bins/:id', requests: '8', totalDurationMs: '152', errors: '0', p95DurationMs: '50' },
            { method: 'GET', route: '/api/v1/unmatched', requests: '2', totalDurationMs: '38', errors: '2', p95DurationMs: '75' },
          ], rows: 2,
        };
      }
      throw Error('unexpected_query');
    },
  };
  return { binding, seen };
}

test('shadow comparison remains off without explicit flags, SQL binding and trusted dataset', () => {
  const sql = { query: async () => ({ data: [], rows: 0 }) };
  assert.equal(shadowComparisonEnabled({ ANALYTICS_SQL: sql, ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview' }), false);
  assert.equal(shadowComparisonEnabled({ ANALYTICS_SQL: sql, ANALYTICS_SHADOW_COMPARE: '1', ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview' }), false);
  assert.equal(shadowComparisonEnabled({
    ANALYTICS_SQL: sql, ANALYTICS_SHADOW_COMPARE: '1', ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview"; DROP TABLE foo',
  }), false);
  assert.equal(shadowComparisonRange('1h'), 1);
  assert.equal(shadowComparisonRange('24h'), 24);
  assert.equal(shadowComparisonRange('7d'), 168);
  assert.equal(shadowComparisonRange('30d'), 720);
  assert.equal(shadowComparisonRange('100000h'), null);
});

test('management-only diagnostics use weighted SQL and preserve the existing KV overview', async t => {
  const h = await createSystemHarness('analytics-shadow-compare-' + crypto.randomUUID());
  t.after(() => h.close());
  const created = await h.request('/bins', { method: 'POST', value: { name: 'safe analytics', value: { secret: 'HIDDEN_CANARY' } } });
  assert.equal(created.status, 201);
  const id = (await created.json()).meta.id;
  await h.request('/bins/' + id);
  const { binding, seen } = previewSQL();
  const env = {
    ...h.env,
    ANALYTICS_SQL: binding,
    ANALYTICS_SHADOW_COMPARE: '1',
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview',
    ANALYTICS_SHADOW_STARTED_AT: '2026-01-01T00:00:00.000Z',
    ANALYTICS_KV_PROBE_FILTER_STARTED_AT: '2026-01-01T00:00:00.000Z',
  };
  assert.equal((await h.request('/analytics/shadow-compare?range=1h')).status, 404, 'disabled by default');
  assert.equal(seen.length, 0);
  assert.equal((await h.request('/analytics/shadow-compare?range=2000h', {}, env)).status, 400);
  const response = await h.request('/analytics/shadow-compare?range=1h', {}, env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.range, '1h');
  assert.ok(data.legacy.overview.totalRequests >= 2, 'legacy KV remains authoritative');
  assert.equal(data.shadow.available, true);
  assert.equal(data.shadow.overview.totalRequests, 10);
  assert.equal(data.shadow.overview.avgDurationMs, 19);
  assert.equal(data.shadow.overview.p95DurationMs, 75);
  assert.equal(data.shadow.overview.count429, 2);
  assert.equal(data.shadow.overview.count4xx, 2);
  assert.equal(data.shadow.overview.successRate, 80);
  assert.equal(data.shadow.endpoints[0].route, '/api/v1/bins/:id');
  assert.equal(data.coverage, 'full_window');
  assert.equal(data.comparable, true);
  assert.ok(data.deltas && Number.isInteger(data.deltas.requestDifference));
  assert.equal(seen.length, 3, 'one overview, one status and one endpoint query');
  for (const { query, params } of seen) {
    assert.match(query, /^SELECT\s/i);
    assert.match(query, /events\.analyticsEngine\."jsonbin-api-shadow-preview"/);
    assert.match(query, /timestamp >= \$start AND timestamp < \$end/);
    assert.match(query, /index1 = 'jsonbin'/);
    assert.match(query, /AND NOT \(blob1 = 'GET' AND blob3 = '200' AND blob4 = 'anonymous'/);
    assert.match(query, /blob6 = '0' AND blob2 IN \('\/api\/v1\/system\/health', '\/api\/v1\/auth\/config'\)/);
    assert.doesNotMatch(query, /blob3 != '200'/);
    // New Analytics SQL API auto-applies sample weights to COUNT and SUM.
    // Multiplying by _sample_interval again would inflate production counts.
    assert.doesNotMatch(query, /_sample_interval/i);
    assert.doesNotMatch(query, /sumIf\(/i);
    if (query.includes('AS totalRequests')) {
      assert.match(query, /COUNT\(\*\) AS totalRequests/);
      assert.match(query, /SUM\(double2\) AS totalDurationMs/);
    }
    if (query.includes('AS p95DurationMs')) {
      assert.match(query, /quantileWeighted\(0\.95, double2, sampleInterval\)/);
    }
    if (query.includes('AS errors')) {
      assert.match(query, /countIf\(toUInt32\(blob3\) >= 400\) AS errors/);
    }
    assert.ok(Date.parse(params.start) <= Date.now());
    assert.ok(Date.parse(params.end) > Date.parse(params.start));
    assert.doesNotMatch(query, /HIDDEN_CANARY|Bearer|Authorization|Cookie|DROP TABLE/);
  }
  const regular = await h.request('/analytics/overview?range=1h', {}, env);
  assert.equal(regular.status, 200);
  assert.ok((await regular.json()).overview.totalRequests >= 2);
  assert.equal(seen.length, 3, 'regular Dashboard never queries Analytics SQL');
  const bearer = await h.worker.fetch(new Request('https://example.test/api/v1/analytics/shadow-compare', {
    headers: { Authorization: 'Bearer invalid-token' },
  }), env);
  assert.equal(bearer.status, 401, 'Bearer credentials cannot access management diagnostic');
  assert.equal(seen.length, 3, 'unauthorized requests do not execute SQL');
});

test('partial historical coverage and missing markers cannot falsely assert comparability', async () => {
  const { binding } = previewSQL();
  const base = {
    ANALYTICS_SQL: binding,
    ANALYTICS_SHADOW_COMPARE: '1',
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview',
  };
  const missing = await compareShadowAnalytics(base, '1h');
  assert.equal(missing.coverage, 'unknown');
  assert.equal(missing.comparable, false);
  assert.equal(missing.deltas, null);
  const missingPolicy = await compareShadowAnalytics({
    ...base, ANALYTICS_SHADOW_STARTED_AT: '2026-01-01T00:00:00.000Z',
  }, '1h');
  assert.equal(missingPolicy.coverage, 'unknown',
    'without a trusted KV rollout timestamp historical buckets can be mixed');
  assert.equal(missingPolicy.comparable, false);
  const later = await compareShadowAnalytics({
    ...base,
    ANALYTICS_SHADOW_STARTED_AT: new Date().toISOString(),
    ANALYTICS_KV_PROBE_FILTER_STARTED_AT: '2026-01-01T00:00:00.000Z',
  }, '1h');
  assert.equal(later.coverage, 'partial_window');
  assert.equal(later.comparable, false);
  assert.equal(later.deltas, null);
  const recentPolicy = await compareShadowAnalytics({
    ...base,
    ANALYTICS_SHADOW_STARTED_AT: '2026-01-01T00:00:00.000Z',
    ANALYTICS_KV_PROBE_FILTER_STARTED_AT: new Date().toISOString(),
  }, '1h');
  assert.equal(recentPolicy.coverage, 'partial_window',
    'do not compare the first hour containing a KV analytics policy change');
  assert.equal(recentPolicy.comparable, false);
  assert.equal(recentPolicy.deltas, null);
});

test('SQL binding errors fall back to the legacy KV response without leaking failures', async () => {
  const env = {
    ANALYTICS_SQL: { query: async () => { throw Error('Authorization: Bearer TOP_SECRET'); } },
    ANALYTICS_SHADOW_COMPARE: '1',
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview',
  };
  const data = await compareShadowAnalytics(env, '1h');
  assert.equal(data.shadow.available, false);
  assert.equal(data.shadow.reason, 'sql_unavailable');
  assert.equal(data.legacy.partial, true);
  assert.equal(data.comparable, false);
  assert.doesNotMatch(JSON.stringify(data), /TOP_SECRET|Authorization/);
});

test('unexpected SQL endpoint dimensions are discarded before returning results', async () => {
  const env = {
    ANALYTICS_SQL: {
      query: async ({ query }) => {
        if (query.includes('AS totalRequests')) return { data: [{ totalRequests: 1, totalDurationMs: 5, p95DurationMs: 5 }] };
        if (query.includes('blob3 AS status')) return { data: [{ status: '200', requests: 1 }] };
        return { data: [{ method: 'GET', route: '/api/v1/b/sensitive-user-slug', requests: 1, totalDurationMs: 5, errors: 0, p95DurationMs: 5 }] };
      },
    },
    ANALYTICS_SHADOW_COMPARE: '1',
    ANALYTICS_EVENTS_SHADOW: '1',
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-preview',
  };
  const data = await compareShadowAnalytics(env, '1h');
  assert.equal(data.shadow.available, true);
  assert.deepEqual(data.shadow.endpoints, []);
  assert.equal(JSON.stringify(data).includes('sensitive-user-slug'), false);
});
