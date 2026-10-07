import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { tools, dispatchMessage, normalizeErrorPayload } from '../mcp/server.js';
import { JsonBinError, EtagConflictError, AuthenticationError } from '../sdk/typescript/dist/index.js';
import pkg from '../package.json' with { type: 'json' };

test('MCP Server: create/list/get/patch/publish tools and permission boundary', async (t) => {
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
    value: { name: 'MCP Key', scopes: ['bin:read', 'bin:create', 'bin:update', 'history:read', 'collection:read'] },
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
    // 1. Tool: create_bin
    const created = await tools.create_bin.handler({
      name: 'MCP Created Config',
      value: { seeded: true },
      tags: ['mcp'],
    });
    assert.equal(created.value.seeded, true);
    assert.equal(created.meta.currentVersion, 1);

    // 2. Tool: list_bins
    const listResult = await tools.list_bins.handler({});
    assert.equal(listResult.total >= 2, true);
    assert.equal(listResult.bins.some(b => b.name === 'MCP App Config'), true);
    assert.equal(listResult.bins.some(b => b.name === 'MCP Created Config'), true);

    // 3. Tool: get_bin (via slug)
    const getResult = await tools.get_bin.handler({ idOrSlug: 'mcp-app-config' });
    assert.equal(getResult.meta.id, bin.meta.id);
    assert.equal(getResult.value.port, 3000);

    // 4. Tool: json_patch_bin
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

    // 5. Tool: publish_bin
    const pubResult = await tools.publish_bin.handler({
      id: bin.meta.id,
      etag: patchResult.etag,
    });
    assert.equal(pubResult.meta.publishedVersion, 2);

    // 6. Tool: get_published_bin
    const pubGet = await tools.get_published_bin.handler({ idOrSlug: 'mcp-app-config' });
    assert.equal(pubGet.value.port, 9000);

    // 7. Tool: list_bin_versions & get_bin_version
    const versionsResult = await tools.list_bin_versions.handler({ id: bin.meta.id });
    assert.equal(versionsResult.total >= 2, true);
    const v1Result = await tools.get_bin_version.handler({ id: bin.meta.id, version: 1 });
    assert.equal(v1Result.value.port, 3000);

    // 8. Tool: search_bins (verify type=bin default parameter)
    const searchBinsResult = await tools.search_bins.handler({ query: 'MCP' });
    assert.equal(searchBinsResult.items.some(item => item.id === bin.meta.id), true);

    // 9. Tool: search_json (verify API Key can call content search)
    // Enable content search on the test bin
    const metaUpdateRes = await h.request(`/bins/${bin.meta.id}/meta`, {
      method: 'PATCH',
      headers: { 'If-Match': pubResult.etag },
      value: { contentSearchMode: 'all' },
    });
    assert.equal(metaUpdateRes.status, 200);
    const searchJsonResult = await tools.search_json.handler({ query: '9000' });
    assert.equal(searchJsonResult.items.some(item => item.binId === bin.meta.id), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('MCP Server: JSON-RPC dispatch semantics (notifications, ping, unknown methods, version negotiation)', async () => {
  // Notifications (no id) never receive a response
  assert.equal(await dispatchMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await dispatchMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  // A null message is a malformed envelope, not a notification: it gets an
  // explicit Invalid Request instead of silent silence the client cannot see.
  assert.equal((await dispatchMessage(null)).error.code, -32600);
  assert.equal((await dispatchMessage({ jsonrpc: '1.0', id: 9, method: 'ping' })).error.code, -32600);
  assert.equal((await dispatchMessage({ jsonrpc: '2.0', id: { bad: 1 }, method: 'ping' })).error.code, -32600);
  // Only structurally VALID messages without an id count as notifications.
  assert.equal(await dispatchMessage({ jsonrpc: '1.0', method: 'notifications/initialized' }).then(r => r.error.code), -32600);

  // initialize echoes a supported protocol version and reports the package version
  const init = await dispatchMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'jsonbin-mcp');
  assert.equal(init.result.serverInfo.version, pkg.version);

  const initFallback = await dispatchMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(initFallback.result.protocolVersion, '2025-06-18');

  // ping is supported; unknown methods and non-requests get JSON-RPC errors
  const ping = await dispatchMessage({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(ping.result, {});

  const unknown = await dispatchMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(unknown.error.code, -32601);

  const invalid = await dispatchMessage({ jsonrpc: '2.0', id: 5 });
  assert.equal(invalid.error.code, -32600);

  // tools/list includes every handler, including create_bin
  const list = await dispatchMessage({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  const names = list.result.tools.map(tool => tool.name);
  assert.equal(names.includes('create_bin'), true);
  assert.equal(names.length, Object.keys(tools).length);

  // tools/call with an unknown tool is an isError result, not a transport error
  const unknownTool = await dispatchMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.result.isError, true);
  assert.equal(JSON.parse(unknownTool.result.content[0].text).error, 'unknown_tool');
});

test('MCP Server: error payloads use the stable error vocabulary', async () => {
  // API codes pass through when they are already stable
  const etag = normalizeErrorPayload(new EtagConflictError('etag_conflict', { error: 'etag_conflict' }));
  assert.equal(etag.error, 'etag_conflict');
  assert.equal(etag.statusCode, 412);

  // Non-SDK failures degrade to a generic operation_failed without a stack trace
  const generic = normalizeErrorPayload(new Error('boom'));
  assert.equal(generic.error, 'operation_failed');
  assert.equal(generic.message, 'boom');

  // Auth codes are normalized to the documented vocabulary
  const auth = normalizeErrorPayload(new AuthenticationError('unauthorized', { error: 'unauthorized' }));
  assert.equal(auth.error, 'authentication_failed');
  assert.equal(auth.statusCode, 401);

  const scope = normalizeErrorPayload(new AuthenticationError('insufficient_scope', { error: 'insufficient_scope', requiredScopes: ['bin:read'] }));
  assert.equal(scope.error, 'permission_denied');
  assert.deepEqual(scope.requiredScopes, ['bin:read']);

  // Bodies without a code fall back to the HTTP status mapping
  const rate = normalizeErrorPayload(new JsonBinError('HTTP 429', 429, null));
  assert.equal(rate.error, 'rate_limited');

  // Validation issues are preserved
  const validation = normalizeErrorPayload(new JsonBinError('validation_failed', 422, {
    error: 'validation_failed',
    issues: [{ path: ['name'], message: 'required' }],
  }));
  assert.equal(validation.error, 'validation_failed');
  assert.equal(validation.issues.length, 1);
});
