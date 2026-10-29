import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../dist/jsonbin/index.js';
import { renderOpenApiTxt } from '../src/shared/openapi-txt.ts';
import { normalizeRoute } from '../src/worker/storage/analytics.ts';

const ORIGIN = 'https://jsonbin-ai-docs.example.test';
const METHODS = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace']);

async function get(path, origin = ORIGIN) {
  return app.fetch(new Request(origin + path), {});
}
async function readSpec() {
  const response = await get('/api/v1/openapi.json');
  assert.equal(response.status, 200);
  return response.json();
}

test('AI API TXT is a public UTF-8 attachment with no runtime bindings or user credentials', async () => {
  assert.equal(normalizeRoute('/api/v1/openapi.txt'), '/api/v1/openapi.txt');
  const response = await get('/api/v1/openapi.txt');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^text\/plain;\s*charset=utf-8/i);
  assert.equal(response.headers.get('Content-Disposition'), 'attachment; filename="jsonbin-api-guide.txt"');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');

  const body = await response.text();
  assert.ok(body.startsWith('JSONBin - AI 可读 API 使用指南（TXT）'));
  assert.ok(body.endsWith('\n'));
  assert.ok(body.includes('API 根路径：' + ORIGIN + '/api/v1'));
  assert.ok(body.includes('机器可读规范：' + ORIGIN + '/api/v1/openapi.json'));
  assert.ok(body.includes('/api/v1/mcp'));
  assert.ok(body.includes('JSON Patch'));
  assert.ok(body.includes('Merge Patch'));
  assert.ok(body.includes('If-Match'));
  assert.ok(body.includes('Retry-After'));
  assert.ok(body.includes('Bearer API Key'));
  assert.ok(body.includes('管理员 Session Cookie'));
  assert.ok(body.includes('不包含真实 API Token'));
  assert.ok(body.includes('GET /api/v1/system/health'));
  assert.ok(body.includes('POST /api/v1/bins'));
  assert.ok(body.includes('请求体：'));
  assert.ok(body.includes('返回状态：'));
  assert.doesNotMatch(body, /jb_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}/);
  assert.equal(body.includes('token=MY_PRIVATE_TOKEN'), false);
});

test('AI TXT export covers every published OpenAPI operation and preserves method permissions', async () => {
  const spec = await readSpec();
  const response = await get('/api/v1/openapi.txt');
  const body = await response.text();
  let operationCount = 0;
  for (const [path, definitions] of Object.entries(spec.paths)) {
    for (const [method] of Object.entries(definitions)) {
      if (!METHODS.has(method)) continue;
      operationCount++;
      const fullPath = '/api/v1' + (path === '/' ? '' : path);
      assert.ok(body.includes(method.toUpperCase() + ' ' + fullPath),
        'missing operation in AI text: ' + method + ' ' + fullPath);
    }
  }
  assert.ok(operationCount >= 60);
  assert.ok(body.includes('已登记接口操作数量：' + operationCount));
  assert.equal(spec.paths['/openapi.txt'].get.security.length, 0);
  assert.ok(body.includes('GET /api/v1/openapi.txt'));
  assert.ok(body.includes('仅管理员 Session Cookie；不接受 Bearer API Key'));
  assert.ok(body.includes('公开接口（数据仓是否允许匿名读取仍取决于可见性）'));
  assert.ok(body.includes('  - If-Match [header] (必填; string)'));
});

test('AI TXT export is deterministic and does not echo request querystrings or untrusted origins', async () => {
  const spec = await readSpec();
  const good = renderOpenApiTxt(spec, ORIGIN);
  assert.equal(good, renderOpenApiTxt(spec, ORIGIN + '/unrelated/path?secret=NEVER_EXPORT'));
  assert.equal(good, await (await get('/api/v1/openapi.txt')).text());
  const untrusted = renderOpenApiTxt(spec, 'https://secret:password@attacker.example');
  assert.ok(untrusted.includes('https://YOUR_JSONBIN_HOST/api/v1'));
  assert.doesNotMatch(untrusted, /attacker\.example|secret:password@/);
  const badProtocol = renderOpenApiTxt(spec, 'javascript:alert(1)');
  assert.ok(badProtocol.includes('https://YOUR_JSONBIN_HOST/api/v1'));
});

test('AI TXT includes schema and a matching content type for multi-format request bodies', () => {
  const spec = {
    info: { title: 'Example', version: '1.0' },
    security: [{ CookieAuth: [] }, { BearerAuth: [] }],
    paths: {
      '/bin/{id}': {
        patch: {
          summary: 'Patch',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } },
          ],
          requestBody: { required: true, content: {
            'application/merge-patch+json': { schema: { type: 'object', properties: { flag: { type: 'boolean' } } } },
            'application/json-patch+json': { schema: { type: 'array' } },
          } },
          responses: { '200': { description: 'ok' }, '412': { description: 'stale' } },
        },
      },
    },
  };
  const text = renderOpenApiTxt(spec, ORIGIN);
  assert.ok(text.includes('Content-Type: application/merge-patch+json'));
  assert.ok(text.includes('Content-Type: application/json-patch+json'));
  assert.ok(text.includes('-H "If-Match: <CURRENT_ETAG>"'));
  assert.ok(text.includes('-H \'Content-Type: application/merge-patch+json\''));
  assert.ok(text.includes('  - 412：stale'));
  assert.ok(text.includes('flag'));
});
