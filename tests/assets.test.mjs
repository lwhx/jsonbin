import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetsHarness } from './support/assets-harness.mjs';
import { spawn } from 'node:child_process';

test('production assets and SPA fallback apply CSP while API responses retain JSON security headers', async () => {
  const h = await createAssetsHarness();
  try {
    for (const path of ['/', '/dashboard']) {
      const response = await h.request(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
      const csp = response.headers.get('content-security-policy');
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-eval/);
      assert.match(csp, /worker-src 'self' blob:/);
      assert.match(csp, /frame-ancestors 'none'/);
    }
    const response = await h.request('/api/v1/system/health');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service, 'jsonbin');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/check-production.mjs', h.origin], { env: { ...process.env, JSONBIN_BROWSER_ORIGIN: h.origin } });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('error', reject);
      child.on('exit', code => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.equal((result.output.match(/^PASS /gm) ?? []).length, 8, 'production release probe checks limiter binding and an administrator auth provider');
  } finally { await h.close(); }
});
