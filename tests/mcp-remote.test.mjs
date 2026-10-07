import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import pkg from '../package.json' with { type: 'json' };

test('Remote MCP: Streamable HTTP transport, strict envelopes and budgets on Cloudflare Worker', async (t) => {
  const h = await createSystemHarness('remote-mcp-' + crypto.randomUUID());
  t.after(() => h.close());

  // 1. Create a test bin
  const createBin = await (await h.request('/bins', {
    method: 'POST',
    value: { name: 'Remote MCP Config', slug: 'remote-mcp-cfg', value: { mode: 'active', workers: 4 } },
  })).json();

  // 2. Create an API Key for MCP
  const keyRes = await (await h.request('/keys', {
    method: 'POST',
    value: { name: 'Remote MCP Key', scopes: ['bin:read', 'bin:create', 'bin:update', 'history:read', 'collection:read'] },
  })).json();
  const token = keyRes.token;

  const post = (body, headers = {}) => h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), h.env);

  // 3. Unauthenticated and invalid-token requests must be rejected with 401
  const unauthPost = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(unauthPost.status, 401);

  // Removed legacy endpoints answer with 410 regardless of credentials (F12)
  const unauthSse = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse'), h.env);
  assert.equal(unauthSse.status, 410);
  assert.equal((await unauthSse.json()).error, 'legacy_sse_removed');

  const badToken = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { Authorization: 'Bearer jb_live_invalid_invalid_invalid' });
  assert.equal(badToken.status, 401);
  assert.equal((await badToken.json()).error.code, -32000);

  const authedSse = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse', { headers: { Authorization: `Bearer ${token}` } }), h.env);
  assert.equal(authedSse.status, 410);
  const authedMessage = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/message', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }), h.env);
  assert.equal(authedMessage.status, 410);

  const auth = { Authorization: `Bearer ${token}` };

  // 4. Streamable HTTP: initialize echoes a supported protocol version and the package version
  const initRes = await post({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: '2025-03-26' } }, auth);
  assert.equal(initRes.status, 200);
  const initData = await initRes.json();
  assert.equal(initData.result.protocolVersion, '2025-03-26');
  assert.equal(initData.result.serverInfo.name, 'jsonbin-remote-mcp');
  assert.equal(initData.result.serverInfo.version, pkg.version);

  // Unsupported requested versions fall back to the baseline revision
  const initFallback = await post({ jsonrpc: '2.0', id: 'init-2', method: 'initialize', params: { protocolVersion: '1999-01-01' } }, auth);
  assert.equal((await initFallback.json()).result.protocolVersion, '2025-06-18');

  // 5. Streamable HTTP: tools/list
  const toolsRes = await post({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list' }, auth);
  assert.equal(toolsRes.status, 200);
  const toolsData = await toolsRes.json();
  assert.equal(toolsData.result.tools.length >= 14, true);
  assert.equal(toolsData.result.tools.some(t => t.name === 'json_patch_bin'), true);
  assert.equal(toolsData.result.tools.some(t => t.name === 'create_bin'), true);
  assert.equal(toolsData.result.tools.some(t => t.name === 'list_bin_versions'), true);

  // 6. Notifications (no id) never receive a response: 204 with no body
  const notification = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  assert.equal(notification.status, 204);
  assert.equal(await notification.text(), '');

  // Unknown methods with an id receive a JSON-RPC error
  const unknown = await post({ jsonrpc: '2.0', id: 'x', method: 'resources/list' }, auth);
  assert.equal(unknown.status, 200);
  assert.equal((await unknown.json()).error.code, -32601);

  // ping is supported
  const ping = await post({ jsonrpc: '2.0', id: 'p', method: 'ping' }, auth);
  assert.deepEqual((await ping.json()).result, {});

  // A notification-only batch also yields 204
  const batch = await post([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
  ], auth);
  assert.equal(batch.status, 204);

  // Stateless streamable server: no server-initiated stream, no session DELETE
  const getRoot = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', { headers: auth }), h.env);
  assert.equal(getRoot.status, 405);
  const deleteRoot = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', { method: 'DELETE', headers: auth }), h.env);
  assert.equal(deleteRoot.status, 405);

  // 7. tools/call: create_bin
  const callCreate = await post({
    jsonrpc: '2.0', id: 'create-1', method: 'tools/call',
    params: { name: 'create_bin', arguments: { name: 'Remote MCP Created', value: { seeded: true }, tags: ['mcp'] } },
  }, auth);
  assert.equal(callCreate.status, 200);
  const createdOutput = JSON.parse((await callCreate.json()).result.content[0].text);
  assert.equal(createdOutput.value.seeded, true);
  assert.equal(createdOutput.meta.currentVersion, 1);

  // 8. tools/call: get_bin via slug, then json_patch_bin
  const callGetRes = await post({
    jsonrpc: '2.0', id: 'call-1', method: 'tools/call',
    params: { name: 'get_bin', arguments: { idOrSlug: 'remote-mcp-cfg' } },
  }, auth);
  assert.equal(callGetRes.status, 200);
  const getOutput = JSON.parse((await callGetRes.json()).result.content[0].text);
  assert.equal(getOutput.value.workers, 4);
  const etag = getOutput.etag;
  assert.ok(etag);

  const callPatchRes = await post({
    jsonrpc: '2.0', id: 'call-2', method: 'tools/call',
    params: {
      name: 'json_patch_bin',
      arguments: {
        id: createBin.meta.id,
        etag,
        operations: [{ op: 'replace', path: '/workers', value: 8 }],
      },
    },
  }, auth);
  assert.equal(callPatchRes.status, 200);
  const patchOutput = JSON.parse((await callPatchRes.json()).result.content[0].text);
  assert.equal(patchOutput.value.workers, 8);

  // 9. Stale ETag maps to the stable etag_conflict error code
  const staleRes = await post({
    jsonrpc: '2.0', id: 'call-3', method: 'tools/call',
    params: {
      name: 'update_bin',
      arguments: { id: createBin.meta.id, etag, value: { mode: 'idle' } },
    },
  }, auth);
  assert.equal(staleRes.status, 200);
  const staleBody = await staleRes.json();
  assert.equal(staleBody.result.isError, true);
  const stalePayload = JSON.parse(staleBody.result.content[0].text);
  assert.equal(stalePayload.error, 'etag_conflict');
  assert.equal(stalePayload.statusCode, 412);

  // 10. Strict envelope validation: malformed requests are never executed (F20)
  const badVersion = await post({ jsonrpc: 'not-2.0', id: 7, method: 'ping' }, auth);
  assert.equal(badVersion.status, 200);
  assert.equal((await badVersion.json()).error.code, -32600);

  const badId = await post({ jsonrpc: '2.0', id: { bad: 1 }, method: 'ping' }, auth);
  assert.equal((await badId.json()).error.code, -32600);

  const badParams = await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 42 } }, auth);
  assert.equal((await badParams.json()).error.code, -32600);

  // A malformed notification (wrong jsonrpc, no id) is invalid, not silent.
  const malformedNotification = await post({ jsonrpc: '1.0', method: 'notifications/initialized' }, auth);
  assert.equal(malformedNotification.status, 200);
  assert.equal((await malformedNotification.json()).error.code, -32600);

  // 11. Batch budgets: empty and oversized batches reject instead of amplifying
  const emptyBatch = await post([], auth);
  assert.equal((await emptyBatch.json()).error.code, -32600);
  const oversized = await post(Array.from({ length: 101 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })), auth);
  const oversizedBody = await oversized.json();
  assert.equal(oversizedBody.error.code, -32600);
  assert.equal(oversizedBody.error.message.includes('batch exceeds'), true);
  const mixedBatch = await post([
    { jsonrpc: '2.0', id: 'b1', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.9', id: 'b2', method: 'ping' },
  ], auth);
  const mixedBody = await mixedBatch.json();
  assert.equal(Array.isArray(mixedBody), true);
  assert.equal(mixedBody.length, 2);
  assert.equal(mixedBody[1].error.code, -32600);

  // 12. create_bin accepts collectionId for collection-scoped keys (F20)
  const collection = await (await h.request('/collections', { method: 'POST', value: { name: 'MCP Collection' } })).json();
  const scopedKey = await (await h.request('/keys', { method: 'POST', value: {
    name: 'MCP scoped', scopes: ['bin:read', 'bin:create', 'collection:read'],
    resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [collection.meta.id] },
  } })).json();
  const scopedAuth = { Authorization: `Bearer ${scopedKey.token}` };
  const inCollection = await post({
    jsonrpc: '2.0', id: 'scoped-1', method: 'tools/call',
    params: { name: 'create_bin', arguments: { name: 'Scoped MCP Bin', value: { ok: 1 }, collectionId: collection.meta.id } },
  }, scopedAuth);
  const scopedOutput = JSON.parse((await inCollection.json()).result.content[0].text);
  assert.equal(scopedOutput.meta.collectionId, collection.meta.id);
  // ...and an ungrouped create stays forbidden for that key.
  const ungrouped = await post({
    jsonrpc: '2.0', id: 'scoped-2', method: 'tools/call',
    params: { name: 'create_bin', arguments: { name: 'No Collection', value: {} } },
  }, scopedAuth);
  const ungroupedOutput = JSON.parse((await ungrouped.json()).result.content[0].text);
  assert.equal(ungroupedOutput.error, 'resource_forbidden');
});
