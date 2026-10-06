import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

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
    value: { name: 'Remote MCP Key', scopes: ['bin:read', 'bin:update', 'history:read', 'collection:read'] },
  })).json();
  const token = keyRes.token;

  // 3. Unauthenticated requests must be rejected with 401
  const unauthPost = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  }), h.env);
  assert.equal(unauthPost.status, 401);

  const unauthSse = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse'), h.env);
  assert.equal(unauthSse.status, 401);

  // 4. Streamable HTTP: initialize
  const initRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'init-1', method: 'initialize' }),
  }), h.env);
  assert.equal(initRes.status, 200);
  const initData = await initRes.json();
  assert.equal(initData.result.serverInfo.name, 'jsonbin-remote-mcp');

  // 5. Streamable HTTP: tools/list
  const toolsRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'list-1', method: 'tools/list' }),
  }), h.env);
  assert.equal(toolsRes.status, 200);
  const toolsData = await toolsRes.json();
  assert.equal(toolsData.result.tools.length >= 13, true);
  assert.equal(toolsData.result.tools.some(t => t.name === 'json_patch_bin'), true);
  assert.equal(toolsData.result.tools.some(t => t.name === 'list_bin_versions'), true);

  // 6. Streamable HTTP: tools/call (get_bin via slug)
  const callGetRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'call-1',
      method: 'tools/call',
      params: { name: 'get_bin', arguments: { idOrSlug: 'remote-mcp-cfg' } },
    }),
  }), h.env);
  assert.equal(callGetRes.status, 200);
  const getOutput = JSON.parse((await callGetRes.json()).result.content[0].text);
  assert.equal(getOutput.value.workers, 4);
  const etag = getOutput.etag;
  assert.ok(etag);

  // 7. Streamable HTTP: tools/call (json_patch_bin)
  const callPatchRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'call-2',
      method: 'tools/call',
      params: {
        name: 'json_patch_bin',
        arguments: {
          id: createBin.meta.id,
          etag,
          operations: [{ op: 'replace', path: '/workers', value: 8 }],
        },
      },
    }),
  }), h.env);
  assert.equal(callPatchRes.status, 200);
  const patchOutput = JSON.parse((await callPatchRes.json()).result.content[0].text);
  assert.equal(patchOutput.value.workers, 8);

  // 8. Standard MCP SSE: GET /api/v1/mcp/sse
  const sseRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/sse', {
    headers: { 'Authorization': `Bearer ${token}` },
  }), h.env);
  assert.equal(sseRes.status, 200);
  assert.equal(sseRes.headers.get('Content-Type')?.includes('text/event-stream'), true);

  const reader = sseRes.body.getReader();
  const chunk = await reader.read();
  const chunkText = new TextDecoder().decode(chunk.value);
  assert.equal(chunkText.includes('event: endpoint'), true);
  assert.equal(chunkText.includes('/api/v1/mcp/message?sessionId='), true);
  await reader.cancel();

  // 9. MCP SSE Postback: POST /api/v1/mcp/message
  const msgRes = await h.worker.fetch(new Request('https://example.test/api/v1/mcp/message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
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
});
