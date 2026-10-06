import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import pkg from '../package.json' with { type: 'json' };

test('Remote MCP: Streamable HTTP and SSE endpoints on Cloudflare Worker', async (t) => {
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

  const unauthSse = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse'), h.env);
  assert.equal(unauthSse.status, 401);

  const badToken = await post({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { Authorization: 'Bearer jb_live_invalid_invalid_invalid' });
  assert.equal(badToken.status, 401);
  assert.equal((await badToken.json()).error.code, -32000);

  const badTokenSse = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse', {
    headers: { Authorization: 'Bearer jb_live_invalid_invalid_invalid' },
  }), h.env);
  assert.equal(badTokenSse.status, 401);

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
  assert.equal((await initFallback.json()).result.protocolVersion, '2024-11-05');

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

  // 10. Standard MCP SSE: GET /api/v1/mcp/sse issues a signed session
  const sseRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse', {
    headers: { Authorization: `Bearer ${token}` },
  }), h.env);
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get('Content-Type')?.includes('text/event-stream'), true);

  const reader = sseRes.body.getReader();
  const chunk = await reader.read();
  const chunkText = new TextDecoder().decode(chunk.value);
  assert.equal(chunkText.includes('event: endpoint'), true);
  const sessionId = /sessionId=([0-9a-f]{32}\.\d+\.[A-Za-z0-9_-]{43})/.exec(chunkText)?.[1];
  assert.ok(sessionId);
  await reader.cancel();

  // 11. SSE Postback: session-less or forged session ids are rejected
  const noSession = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  }), h.env);
  assert.equal(noSession.status, 404);

  const forgedSession = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/message?sessionId=' + crypto.randomUUID().replace(/-/g, '') + '.9999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  }), h.env);
  assert.equal(forgedSession.status, 404);

  // 12. SSE Postback: a valid signed session works
  const msgRes = await h.worker.fetch(new Request(`https://example.test/api/v1/mcp/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'msg-1',
      method: 'tools/call',
      params: { name: 'get_bin', arguments: { idOrSlug: createBin.meta.id } },
    }),
  }), h.env);
  assert.equal(msgRes.status, 200);
  const msgOutput = JSON.parse((await msgRes.json()).result.content[0].text);
  assert.equal(msgOutput.value.workers, 8);

  // 13. Notifications over the SSE postback endpoint also stay silent (204)
  const msgNotification = await h.worker.fetch(new Request(`https://example.test/api/v1/mcp/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }), h.env);
  assert.equal(msgNotification.status, 204);
});
