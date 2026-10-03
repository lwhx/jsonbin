import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const examples = await import('../src/react-app/features/docs/examples.ts').catch(() => null);
const catalog = await import('../src/react-app/features/docs/catalog.ts').catch(() => null);
const context = { origin: 'https://example.test', binId: crypto.randomUUID(), etag: '"saved"' };
function operation(id) { return catalog.DOC_OPERATIONS.find(o => o.id === id); }
test('documentation preserves scopes request bodies and ETags', () => {
  assert.equal(typeof examples?.buildRequest, 'function');
  assert.equal(catalog.DOC_SCOPES.length, 9);
  assert.equal(new Set(catalog.DOC_OPERATIONS.map(o => o.id)).size, catalog.DOC_OPERATIONS.length);
  const put = examples.buildRequest(operation('bin-put'), context);
  assert.deepEqual(put.body, { value: { settings: { theme: 'light' }, enabled: false, note: null } });
  assert.equal(put.headers['If-Match'], context.etag);
  assert.equal(examples.buildRequest(operation('bin-patch'), context).headers['Content-Type'], 'application/merge-patch+json');
  assert.deepEqual(examples.buildRequest(operation('bin-patch'), context).body, { settings: { theme: 'dark' } });
  for (const body of [null, false, [], {}]) assert.deepEqual(examples.buildRequest({ ...operation('bin-patch'), body }, context).body, body);
  for (const id of ['keys-list', 'keys-create', 'keys-revoke', 'activity-list']) {
    const request = examples.buildRequest(operation(id), context);
    assert.equal(request.headers.Authorization, undefined); assert.equal(request.credentials, 'include');
  }
  assert.equal(examples.buildRequest(operation('bin-get'), { ...context, anonymous: true }).headers.Authorization, undefined);
  assert.ok(examples.buildRequest(operation('history-get'), { ...context, anonymous: true }).headers.Authorization);
  assert.deepEqual(operation('collection-bins').scopes, ['collection:read', 'bin:read']);
  assert.deepEqual(operation('history-restore').scopes, ['bin:update', 'history:read']);
  assert.equal(operation('schema-validate').successStatus, 200);
  assert.equal(operation('history-get').responseShape, '{id,version,createdAt,size,value,etag}');
  assert.equal(operation('history-list').responseShape, '{items,currentVersion,total}');
  assert.equal(operation('keys-revoke').responseShape, '{key}');
  for (const status of [400,401,403,404,409,412,422,423,428,500,502,503]) assert.ok(catalog.DOC_ERRORS.some(e => e.status === status));
});
test('JSON Pointer and URI escaping preserve individual property names', () => {
  assert.equal(typeof examples?.encodeValuePath, 'function');
  assert.equal(examples.encodeValuePath(['a/b', 'x~y', '中文 %']), '/a~1b/x~0y/' + encodeURIComponent('中文 %'));
  assert.equal(examples.encodeValuePath([]), '');
  const request = examples.buildRequest(operation('bin-path-get'), { ...context, pathSegments: ['a/b', 'x~y', '中文 %'] });
  assert.equal(new URL(request.url).pathname, `/api/v1/bins/${context.binId}/value/a~1b/x~0y/${encodeURIComponent('中文 %')}`);
});
test('rendered languages treat data as literals and preserve HTTP semantics', async () => {
  assert.equal(typeof examples?.renderExample, 'function');
  const dangerous = 'quote\'"\\\n`exit 9` $(exit 8) 中文';
  const request = { method: 'PUT', url: 'https://example.test/' + encodeURIComponent(dangerous),
    headers: { Authorization: 'Bearer ' + dangerous, 'Content-Type': 'application/json', 'If-Match': dangerous }, body: { value: [null, false, dangerous] } };
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  let captured; const code = examples.renderExample('javascript', request);
  await new AsyncFunction('fetch', 'console', code)(async (url, init) => { captured = { url, ...init }; return new Response('{}'); }, { log(){} });
  assert.equal(captured.url, request.url); assert.equal(captured.method, request.method);
  assert.deepEqual(captured.headers, request.headers); assert.deepEqual(JSON.parse(captured.body), request.body);
  await assert.rejects(new AsyncFunction('fetch', 'console', code)(async () => new Response('{}', { status: 412 }), { log(){} }));
  const args = JSON.parse(execFileSync('bash', ['-s'], { input: `curl() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@"; }\n` + examples.renderExample('curl', request), encoding: 'utf8' }));
  assert.ok(args.includes(request.url)); assert.ok(args.includes('If-Match: ' + dangerous));
  assert.ok(args.includes(JSON.stringify(request.body))); assert.ok(args.includes('PUT'));
  const stub = `import ast,json,sys,types\ncode=sys.stdin.read()\nast.parse(code)\nclass Response:\n def raise_for_status(self): pass\n def json(self): return {}\ndef call(method,url,**kw):\n print(json.dumps(dict(method=method,url=url,**kw),ensure_ascii=False))\n return Response()\nsys.modules['requests']=types.SimpleNamespace(request=call)\nexec(code)\n`;
  const lines = execFileSync('python3', ['-c', stub], { input: examples.renderExample('python', request), encoding: 'utf8' }).trim().split('\n');
  const parsed = JSON.parse(lines[0]); assert.equal(parsed.url, request.url); assert.equal(parsed.method, 'PUT');
  assert.deepEqual(parsed.headers, request.headers); assert.deepEqual(JSON.parse(parsed.data), request.body);
});
