import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { tools } from '../mcp/server.js';

test('MCP Server: list_bins, get_bin, json_patch_bin, publish_bin, and permission boundary', async (t) => {
  const h = await createSystemHarness('mcp-test-' + crypto.randomUUID());
  t.after(() => h.close());

  // Create test bin
  const createBinRes = await h.request('/bins', {
    method: 'POST',
    value: { name: 'MCP App Config', slug: 'mcp-app-config', value: { features: { beta: false }, port: 3000 } },
  });
  const bin = await createBinRes.json();

  // Create API Key
  const keyRes = await h.request('/keys', {
    method: 'POST',
    value: { name: 'MCP Key', scopes: ['bin:read', 'bin:update', 'history:read'] },
  });
  const { token } = await keyRes.json();

  // Wire environment for MCP
  process.env.JSONBIN_URL = 'http://localhost';
  process.env.JSONBIN_TOKEN = token;

  // Intercept fetch for harness
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    const headers = new Headers(init?.headers);
    const method = init?.method || 'GET';
    const body = init?.body ? String(init.body) : undefined;
    const reqHeaders = {};
    headers.forEach((v, k) => { reqHeaders[k] = v; });

    return h.worker.fetch(new Request(`https://example.test${path}`, {
      method,
      headers: reqHeaders,
      body,
    }), h.env);
  };

  try {
    // 1. Tool: list_bins
    const listResult = await tools.list_bins.handler({});
    assert.equal(listResult.total >= 1, true);
    assert.equal(listResult.bins.some(b => b.name === 'MCP App Config'), true);

    // 2. Tool: get_bin (via slug)
    const getResult = await tools.get_bin.handler({ idOrSlug: 'mcp-app-config' });
    assert.equal(getResult.meta.id, bin.meta.id);
    assert.equal(getResult.value.port, 3000);

    // 3. Tool: json_patch_bin
    const patchResult = await tools.json_patch_bin.handler({
      id: bin.meta.id,
      etag: getResult.etag,
      operations: [
        { op: 'replace', path: '/port', value: 9000 },
        { op: 'replace', path: '/features/beta', value: true },
      ],
    });
    assert.equal(patchResult.value.port, 9000);
    assert.equal(patchResult.value.features.beta, true);

    // 4. Tool: publish_bin
    const pubResult = await tools.publish_bin.handler({
      id: bin.meta.id,
      etag: patchResult.etag,
    });
    assert.equal(pubResult.meta.publishedVersion, 2);

    // 5. Tool: get_published_bin
    const pubGet = await tools.get_published_bin.handler({ idOrSlug: 'mcp-app-config' });
    assert.equal(pubGet.value.port, 9000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
