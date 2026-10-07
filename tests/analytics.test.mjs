import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

test('API Analytics: records metrics, normalizes routes, aggregates status codes and prohibits sensitive data', async (t) => {
  const h = await createSystemHarness('analytics-test-' + crypto.randomUUID());
  t.after(() => h.close());

  // 1. Generate requests with various status codes and normalized routes
  // Valid bin read
  const bin = await (await h.request('/bins', { method: 'POST', value: { name: 'Analytics Bin', value: { a: 1 } } })).json();
  await h.request(`/bins/${bin.meta.id}`);
  await h.request(`/bins/${bin.meta.id}`);

  // 404 not found
  await h.request('/bins/00000000-0000-0000-0000-000000000000');

  // 401 unauthenticated request
  await h.worker.fetch(new Request('https://example.test/api/v1/keys'), h.env);

  // 2. Query Analytics Overview (Session-authenticated)
  const analyticsRes = await h.request('/analytics/overview?range=24h');
  assert.equal(analyticsRes.status, 200);
  const data = await analyticsRes.json();

  assert.equal(data.overview.totalRequests >= 4, true);
  assert.equal(typeof data.overview.avgDurationMs, 'number');
  assert.equal(typeof data.overview.p95DurationMs, 'number');

  // Check endpoint route normalization (/bins/:id instead of raw UUID)
  const hasNormalizedBinRoute = data.endpoints.some(ep => ep.route === '/api/v1/bins/:id');
  assert.equal(hasNormalizedBinRoute, true);

  // Check status breakdown
  assert.equal(data.statuses.some(s => s.status === 200), true);
  assert.equal(data.statuses.some(s => s.status === 404), true);

  // 3. Prohibit sensitive data: Ensure no Tokens or JSON bodies leaked into KV
  const kvKeys = await h.env.CACHE.list({ prefix: 'analytics:agg:' });
  for (const k of kvKeys.keys) {
    const raw = await h.env.CACHE.get(k.name);
    assert.equal(raw.includes('Analytics Bin'), false);
    assert.equal(raw.includes('jb_live_'), false);
    assert.equal(raw.includes('Bearer'), false);
    assert.equal(raw.includes('Cookie'), false);
  }

  // 4. Session-only: Bearer token cannot access analytics
  const keyRes = await h.request('/keys', { method: 'POST', value: { name: 'Key', scopes: ['bin:read'] } });
  const { token } = await keyRes.json();
  const bearerRes = await h.worker.fetch(new Request('https://example.test/api/v1/analytics/overview', {
    headers: { Authorization: `Bearer ${token}` },
  }), h.env);
  assert.equal(bearerRes.status, 401);
});

test('routes are recorded as bounded templates and never leak path content (F08)', async t => {
  const h = await createSystemHarness('analytics-f08-' + crypto.randomUUID());
  t.after(() => h.close());
  const bin = await (await h.request('/bins', { method: 'POST', value: { name: 'F08 Analytics Bin', value: { secretPath: { deeper: true } } } })).json();
  // A deep JSON path carrying a canary token, plus a totally unknown route.
  await h.request(`/bins/${bin.meta.id}/value/secretPath/SECRET_PATH_CANARY`);
  await h.request('/definitely-not-a-route/xyz');
  const kvKeys = await h.env.CACHE.list({ prefix: 'analytics:agg:' });
  const raws = [];
  for (const k of kvKeys.keys) raws.push(await h.env.CACHE.get(k.name));
  const all = raws.join('\n');
  assert.equal(all.includes('SECRET_PATH_CANARY'), false, 'deep JSON paths must collapse to /bins/:id/value/*');
  assert.equal(all.includes('definitely-not-a-route'), false, 'unknown routes must collapse to /api/v1/unmatched');
  assert.equal(all.includes('GET /api/v1/bins/:id/value/*'), true);
  assert.equal(all.includes('GET /api/v1/unmatched'), true);
});
