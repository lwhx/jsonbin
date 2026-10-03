import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const api = await import('../src/react-app/features/bins/api.ts').catch(() => null);
const editor = await import('../src/react-app/features/bins/editor-state.ts').catch(() => null);
const navigation = await import('../src/react-app/features/bins/navigation.ts').catch(() => null);
const record = { meta: { id: 'example', currentVersion: 1 }, value: { a: 1 }, etag: '"v1"' };

test('client uses response ETag, includes If-Match and distinguishes API errors', async () => {
  assert.equal(typeof api?.getBin, 'function', 'Bin client API must exist');
  let mode = 'read';
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'read') { res.setHeader('ETag', '"header"'); res.end(JSON.stringify(record)); return; }
    if (mode === 'save') {
      assert.equal(req.method, 'PUT'); assert.equal(req.headers['if-match'], '"header"');
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { value: null });
      res.end(JSON.stringify({ ...record, value: null })); return;
    }
    if (mode === 'schema') { res.statusCode = 422; res.end(JSON.stringify({ error: 'schema_validation_failed', issues: [{ path: '#/count', keyword: 'minimum', message: '数值小于最小值' }] })); return; }
    res.statusCode = Number(mode); res.end(JSON.stringify({ error: 'failure' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/bins`;
  try {
    assert.equal((await api.getBin('example', base)).etag, '"header"');
    mode = 'save'; assert.equal((await api.saveBin('example', null, '"header"', base)).value, null);
    mode = 'schema';
    await assert.rejects(api.saveBin('example', {}, '"header"', base), error => error.status === 422 && error.message.includes('绑定的模型') && error.issues[0].path === '#/count');
    for (const status of [401, 404, 412, 423, 500]) {
      mode = String(status);
      await assert.rejects(api.getBin('example', base), error => error.status === status && error.message.length > 0);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(api.getBin('example', base), error => error.status === 0);
});

test('JSON validation supports scalar values and rejects invalid syntax', () => {
  assert.equal(typeof editor?.parseJson, 'function', 'Editor draft functions must exist');
  for (const value of [null, false, 0, '', [], { a: 1 }]) {
    const parsed = editor.parseJson(JSON.stringify(value));
    assert.equal(parsed.valid, true); assert.deepEqual(parsed.value, value);
  }
  assert.equal(editor.parseJson('{bad').valid, false);
});
test('background refresh never replaces a dirty draft', () => {
  assert.equal(typeof editor?.createDraft, 'function');
  const draft = { ...editor.createDraft(record), text: '{"local":true}' };
  assert.equal(editor.isDirty(draft), true);
  assert.deepEqual(editor.receiveRecord(draft, { ...record, etag: '"v2"', value: 'remote' }), draft);
});
test('save advances baseline while retaining edits made during the request', () => {
  assert.equal(typeof editor?.savedDraft, 'function');
  const draft = { ...editor.createDraft(record), text: '{"newer":true}' };
  const saved = { ...record, value: { a: 2 }, etag: '"v2"' };
  const next = editor.savedDraft(draft, saved, '{"a":2}');
  assert.equal(next.text, draft.text); assert.equal(next.record.etag, '"v2"'); assert.equal(editor.isDirty(next), true);
  const finished = editor.savedDraft({ ...draft, text: '{"a":2}' }, saved, '{"a":2}');
  assert.equal(editor.isDirty(finished), false);
});
test('detail hashes support refresh and reject malformed encodings', () => {
  assert.equal(typeof navigation?.binHash, 'function');
  assert.equal(navigation.binIdFromHash(navigation.binHash('example/id')), 'example/id');
  assert.equal(navigation.binIdFromHash('#/bins'), null);
  assert.equal(navigation.binIdFromHash('#/bins/%ZZ'), null);
});

const activityApi = await import('../src/react-app/features/activity/api.ts').catch(() => null);
test('activity client encodes filters and cursor and preserves cancellation and error status', async () => {
  assert.equal(typeof activityApi?.listActivity, 'function'); let status = 200;
  const server = createServer((req, res) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    assert.equal(params.get('cursor'), 'cursor+/='); assert.equal(params.get('resourceType'), 'key');
    assert.equal(params.get('action'), 'key.created'); assert.equal(params.get('limit'), '20');
    res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ items: [], nextCursor: null, retentionLimit: 2000 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/activity`;
  const query = { limit: 20, action: 'key.created', resourceType: 'key', cursor: 'cursor+/=' };
  try {
    assert.equal((await activityApi.listActivity(query, undefined, base)).nextCursor, null);
    for (status of [400, 401, 500]) await assert.rejects(activityApi.listActivity(query, undefined, base), e => e.status === status && /[\u4e00-\u9fff]/.test(e.message));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(activityApi.listActivity(query, controller.signal, base), e => e.name === 'AbortError');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
