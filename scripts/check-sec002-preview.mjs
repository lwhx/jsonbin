#!/usr/bin/env node
/**
 * SEC-002 read-only runtime smoke test for the isolated Cloudflare Worker Preview.
 * No sessions, API keys, secrets, POSTs, writes, or production API targets.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const SEC002_PREVIEW_ORIGIN = 'https://security-sec-002-api-key-public-rate-limits-jsonbin.whuil1213.workers.dev';

export function previewOrigin(input) {
  const url = new URL(input);
  // Deliberately not a general-purpose API tester: the read-only probe may
  // only target this one isolated SEC-002 branch preview.
  if (url.origin !== SEC002_PREVIEW_ORIGIN || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('origin_must_be_sec002_preview');
  }
  return url.origin;
}

export async function runPreviewSmoke({
  origin = SEC002_PREVIEW_ORIGIN,
  fetchImpl = fetch,
  expectedVersion = '3.2.0',
} = {}) {
  const base = previewOrigin(origin);
  const checks = [];
  const warnings = [];
  const add = (name, passed, detail = '') => {
    checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  };
  const fetchResponse = async (path, method = 'GET', headers = {}) => {
    const response = await fetchImpl(base + path, {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    return response;
  };
  const assertResponse = async (name, path, status, method = 'GET', headers = {}) => {
    try {
      const response = await fetchResponse(path, method, headers);
      add(name, response.status === status, 'HTTP ' + response.status + ' (expected ' + status + ')');
      return response;
    } catch {
      add(name, false, 'request_failed');
      return null;
    }
  };

  const healthResponse = await assertResponse('health HTTP', '/api/v1/system/health', 200);
  if (healthResponse?.ok) {
    let health;
    try { health = await healthResponse.json(); }
    catch { health = null; }
    add('Worker identity and version', health?.ok === true && health?.service === 'jsonbin' &&
        health?.version === expectedVersion);
    add('Preview isolated R2 bound', health?.storage?.r2 === true);
    add('No production KV on Preview', health?.storage?.kv === false,
        'Preview intentionally has no KV binding');
    add('No-store response', healthResponse.headers.get('cache-control') === 'no-store');
    add('Security response headers', healthResponse.headers.get('x-content-type-options') === 'nosniff' &&
        healthResponse.headers.get('x-frame-options') === 'DENY' &&
        (healthResponse.headers.get('content-security-policy') || '').includes("default-src 'none'"));
    add('Correlation ID', /^[a-f0-9-]{36}$/i.test(healthResponse.headers.get('x-request-id') || ''));
  } else {
    add('Health payload inspection', false, 'health_endpoint_unavailable');
  }

  await assertResponse('Private Bin listing denied', '/api/v1/bins', 401);
  await assertResponse('Invalid Bearer never becomes anonymous', '/api/v1/bins', 401, 'GET', {
    Authorization: 'Bearer invalid-sec002-smoke-token',
  });
  await assertResponse('No anonymous administrator Session', '/api/v1/auth/me', 401);
  await assertResponse('Private management info denied', '/api/v1/system/info', 401);
  await assertResponse('Public OpenAPI reachable', '/api/v1/openapi.json', 200);

  const corsHeaders = {
    Origin: base,
    'Access-Control-Request-Method': 'PATCH',
    'Access-Control-Request-Headers': 'Content-Type,Authorization,If-Match',
  };
  const sameOrigin = await assertResponse('Preflight accepted', '/api/v1/bins', 204, 'OPTIONS', corsHeaders);
  if (sameOrigin) {
    add('Only application Origin receives CORS credentials', 
      sameOrigin.headers.get('access-control-allow-origin') === base &&
      sameOrigin.headers.get('access-control-allow-credentials') === 'true');
  }
  const foreignOrigin = await assertResponse('Foreign preflight processed', '/api/v1/bins', 204, 'OPTIONS', {
    ...corsHeaders, Origin: 'https://foreign-sec002-probe.invalid',
  });
  if (foreignOrigin) {
    add('Foreign Origin not allowed', !foreignOrigin.headers.get('access-control-allow-origin'));
  }

  const auth = await assertResponse('Authentication config reachable', '/api/v1/auth/config', 200);
  if (auth?.ok) {
    let config;
    try { config = await auth.json(); } catch { config = null; }
    add('Authentication config shape', typeof config?.passwordEnabled === 'boolean' &&
        typeof config?.githubEnabled === 'boolean');
    if (config?.passwordEnabled === false) {
      warnings.push('Preview-only ADMIN_PASSWORD and SESSION_SECRET are not both configured; authenticated Key and 429 tests cannot yet be run.');
    }
  }
  return {
    ok: checks.every(x => x.passed),
    origin: base,
    checks,
    warnings,
    // Authenticated rate-limit smoke tests require *separate* Preview-only
    // credentials; this read-only probe deliberately does not generate them.
    coverage: 'read-only-public-and-anonymous',
  };
}

async function main() {
  const expectedVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const report = await runPreviewSmoke({ origin: process.argv[2] || SEC002_PREVIEW_ORIGIN, expectedVersion });
  for (const check of report.checks) {
    console.log((check.passed ? 'PASS' : 'FAIL') + ' ' + check.name + (check.detail ? ': ' + check.detail : ''));
  }
  for (const warning of report.warnings) console.log('WARN ' + warning);
  console.log('SEC-002 preview read-only smoke: ' + (report.ok ? 'PASS' : 'FAIL'));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('SEC-002 preview smoke failed: ' + String(error?.message || error).slice(0,200));
    process.exitCode = 1;
  });
}
