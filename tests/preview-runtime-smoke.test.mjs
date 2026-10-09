import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreviewSmoke, previewOrigin, SEC002_PREVIEW_ORIGIN } from '../scripts/check-sec002-preview.mjs';

const requestId = 'f550edb6-75ee-4cbb-98d7-2fb6ed87d450';
function mockService({ kv = false, passwordEnabled = false, denyCORS = false, limiterBound = true } = {}) {
  const requests = [];
  const transport = async (url, init) => {
    const u = new URL(url);
    requests.push({ path: u.pathname, method: init.method, headers: init.headers });
    assert.equal(u.origin, SEC002_PREVIEW_ORIGIN);
    assert.ok(['GET', 'OPTIONS'].includes(init.method), 'never write to Preview');
    assert.equal(init.redirect, 'error', 'do not follow redirects');
    const headers = {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'",
      'x-request-id': requestId,
      'content-type': 'application/json',
    };
    if (init.method === 'OPTIONS') {
      if (!denyCORS && init.headers.Origin === SEC002_PREVIEW_ORIGIN) {
        headers['access-control-allow-origin'] = SEC002_PREVIEW_ORIGIN;
        headers['access-control-allow-credentials'] = 'true';
      }
      return new Response(null, { status: 204, headers });
    }
    if (u.pathname === '/api/v1/system/health') {
      return Response.json({ ok: true, service: 'jsonbin', version: '3.2.0',
        storage: { r2: true, kv }, rateLimiterConfigured: limiterBound }, { headers });
    }
    if (u.pathname === '/api/v1/auth/config') {
      return Response.json({ passwordEnabled, githubEnabled: false }, { headers });
    }
    if (u.pathname === '/api/v1/openapi.json') {
      return Response.json({ openapi: '3.1.0' }, { headers });
    }
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  };
  return { requests, transport };
}

test('SEC-002 preview probe allows only the approved test hostname', () => {
  assert.equal(previewOrigin(SEC002_PREVIEW_ORIGIN), SEC002_PREVIEW_ORIGIN);
  for (const target of ['https://example.com', 'https://js.gnn.im',
    'https://jsonbin.whuil1213.workers.dev', SEC002_PREVIEW_ORIGIN + '/api/v1/bins',
    SEC002_PREVIEW_ORIGIN + '/?other=1']) {
    assert.throws(() => previewOrigin(target), /origin_must_be_sec002_preview/);
  }
});

test('SEC-002 preview smoke is non-mutating and checks isolated bindings, auth and CORS', async () => {
  const { transport, requests } = mockService();
  const report = await runPreviewSmoke({ fetchImpl: transport });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.coverage, 'read-only-public-and-anonymous');
  assert.equal(report.checks.filter(x => !x.passed).length, 0);
  assert.equal(report.warnings.length, 1);
  assert.ok(requests.every(x => x.method === 'GET' || x.method === 'OPTIONS'));
  assert.ok(requests.some(x => x.headers.Authorization === 'Bearer invalid-sec002-smoke-token'));
});

test('SEC-002 preview smoke fails on an absent limiter, unsafe inherited production KV or bad CORS', async () => {
  const missingLimiter = await runPreviewSmoke({ fetchImpl: mockService({ limiterBound: false }).transport });
  assert.equal(missingLimiter.ok, false);
  assert.ok(missingLimiter.checks.some(x => x.name === 'Preview limiter binding present' && !x.passed));
  const kv = await runPreviewSmoke({ fetchImpl: mockService({ kv: true }).transport });
  assert.equal(kv.ok, false);
  assert.ok(kv.checks.some(x => x.name === 'No production KV on Preview' && !x.passed));
  const cors = await runPreviewSmoke({ fetchImpl: mockService({ denyCORS: true }).transport });
  assert.equal(cors.ok, false);
  assert.ok(cors.checks.some(x => x.name === 'Only application Origin receives CORS credentials' && !x.passed));
});

test('SEC-002 preview smoke confirms password readiness without displaying credentials', async () => {
  const r = await runPreviewSmoke({ fetchImpl: mockService({ passwordEnabled: true }).transport });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 0);
});
