import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

/**
 * P22 — RFC 6902 JSON Patch conformance and security suite.
 * Covers the operation matrix, JSON Pointer escaping, atomicity,
 * precondition/lock/schema enforcement and prototype-pollution safety.
 */

async function harness(t) {
  const h = await createSystemHarness('jsonpatch-' + crypto.randomUUID());
  t.after(() => h.close());
  return h;
}

const PATCH = 'application/json-patch+json';

function ifMatch(etag) {
  return etag === undefined ? {} : { 'If-Match': etag };
}

async function patch(h, id, ops, etag, contentType = PATCH) {
  return h.request(`/bins/${id}`, {
    method: 'PATCH',
    value: ops,
    headers: { 'Content-Type': contentType, ...ifMatch(etag) },
  });
}

test('JSON Patch: add / remove / replace / move / copy / test on objects and arrays', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'patch-matrix', value: { items: ['a', 'b'], obj: { x: 1 }, keep: true },
  } })).json();

  // add: new object member + array index insert + append via "-"
  let res = await patch(h, bin.meta.id, [
    { op: 'add', path: '/obj/y', value: 2 },
    { op: 'add', path: '/items/0', value: 'z' },
    { op: 'add', path: '/items/-', value: 'tail' },
  ], bin.etag);
  assert.equal(res.status, 200, await res.clone().text());
  let rec = await res.json();
  assert.deepEqual(rec.value.obj, { x: 1, y: 2 });
  assert.deepEqual(rec.value.items, ['z', 'a', 'b', 'tail']);
  assert.equal(rec.meta.currentVersion, 2);

  // replace must require an existing target
  res = await patch(h, bin.meta.id, [{ op: 'replace', path: '/obj/x', value: 9 }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.equal(rec.value.obj.x, 9);

  res = await patch(h, bin.meta.id, [{ op: 'replace', path: '/obj/missing', value: 1 }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'target_not_found');

  // remove object member
  res = await patch(h, bin.meta.id, [{ op: 'remove', path: '/keep' }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.equal(rec.value.keep, undefined);

  // remove array element
  res = await patch(h, bin.meta.id, [{ op: 'remove', path: '/items/0' }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.deepEqual(rec.value.items, ['a', 'b', 'tail']);

  // move + copy
  res = await patch(h, bin.meta.id, [
    { op: 'move', from: '/obj', path: '/moved' },
    { op: 'copy', from: '/moved', path: '/copied' },
  ], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.deepEqual(rec.value.moved, { x: 9, y: 2 });
  assert.deepEqual(rec.value.copied, { x: 9, y: 2 });
  assert.equal(rec.value.obj, undefined);

  // copy must deep-clone, never share a reference
  res = await patch(h, bin.meta.id, [{ op: 'add', path: '/copied/y', value: 100 }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.equal(rec.value.copied.y, 100);
  assert.equal(rec.value.moved.y, 2);

  // test success (a successful patch creates a new version, so refresh the etag)
  res = await patch(h, bin.meta.id, [{ op: 'test', path: '/moved/x', value: 9 }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();

  // test failure -> 409, pointer + index only, no leaked value
  res = await patch(h, bin.meta.id, [{ op: 'test', path: '/moved/x', value: 999 }], rec.etag);
  assert.equal(res.status, 409);
  const failure = await res.json();
  assert.equal(failure.error, 'json_patch_test_failed');
  assert.equal(failure.operation, 0);
  assert.equal(failure.path, '/moved/x');
  assert.equal(JSON.stringify(failure).includes('999'), false);
});

test('JSON Patch: RFC 6901 pointer escaping, empty key, root replace and bounds', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'pointer', value: { 'a/b': 1, 'x~y': 2, '': 'empty', arr: [10] },
  } })).json();

  // ~1 escapes "/", ~0 escapes "~"
  let res = await patch(h, bin.meta.id, [
    { op: 'replace', path: '/a~1b', value: 'slash' },
    { op: 'replace', path: '/x~0y', value: 'tilde' },
    { op: 'replace', path: '/', value: 'empty-key' },
  ], bin.etag);
  assert.equal(res.status, 200, await res.clone().text());
  let rec = await res.json();
  assert.equal(rec.value['a/b'], 'slash');
  assert.equal(rec.value['x~y'], 'tilde');
  assert.equal(rec.value[''], 'empty-key');

  // invalid escape
  res = await patch(h, bin.meta.id, [{ op: 'replace', path: '/a~2b', value: 1 }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'invalid_pointer_escape');

  // missing leading slash
  res = await patch(h, bin.meta.id, [{ op: 'add', path: 'nope', value: 1 }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'invalid_pointer');

  // array out of bounds
  res = await patch(h, bin.meta.id, [{ op: 'replace', path: '/arr/9', value: 1 }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'target_not_found');

  // add beyond length is also rejected (only "-" appends)
  res = await patch(h, bin.meta.id, [{ op: 'add', path: '/arr/5', value: 1 }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'index_out_of_bounds');

  // root replace is allowed
  res = await patch(h, bin.meta.id, [{ op: 'replace', path: '', value: { root: true } }], rec.etag);
  assert.equal(res.status, 200);
  rec = await res.json();
  assert.deepEqual(rec.value, { root: true });

  // removing the root is rejected
  res = await patch(h, bin.meta.id, [{ op: 'remove', path: '' }], rec.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'cannot_remove_root');
});

test('JSON Patch: invalid operations, missing from, move cycles and operation limit', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'invalid', value: { a: { b: { c: 1 } }, list: [1, 2] },
  } })).json();

  const cases = [
    [[{ op: 'frobnicate', path: '/a' }], 'unsupported_op'],
    [[{ op: 'add', path: '/a', value: 1, unexpected: true }], null],
    [[{ op: 'move', from: '/a', path: '/x' }], null],
    [[{ op: 'copy', from: '/a', path: '/y' }], null],
    [[{ op: 'test', path: '/a', value: { b: { c: 1 } } }], null],
  ];
  assert.equal(cases.length, 5, 'operation matrix documented');

  // unknown op
  let res = await patch(h, bin.meta.id, cases[0][0], bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'unsupported_op');

  // missing "from"
  res = await patch(h, bin.meta.id, [{ op: 'move', path: '/x' }], bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'missing_from');
  res = await patch(h, bin.meta.id, [{ op: 'copy', path: '/x' }], bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'missing_from');

  // move parent into its own child
  res = await patch(h, bin.meta.id, [{ op: 'move', from: '/a', path: '/a/b/moved' }], bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'move_into_child_cycle');

  // missing source
  res = await patch(h, bin.meta.id, [{ op: 'move', from: '/nope', path: '/x' }], bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'target_not_found');

  // patch must be an array
  res = await patch(h, bin.meta.id, { op: 'add', path: '/x', value: 1 }, bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'patch_must_be_array');

  // operation limit (100)
  const tooMany = Array.from({ length: 101 }, (_, i) => ({ op: 'add', path: `/k${i}`, value: i }));
  res = await patch(h, bin.meta.id, tooMany, bin.etag);
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'operation_limit_exceeded');

  // exactly 100 is allowed and creates a single version
  const exactly = Array.from({ length: 100 }, (_, i) => ({ op: 'add', path: `/k${i}`, value: i }));
  res = await patch(h, bin.meta.id, exactly, bin.etag);
  assert.equal(res.status, 200, await res.clone().text());
  const rec = await res.json();
  assert.equal(rec.meta.currentVersion, 2);
  assert.equal(rec.value.k99, 99);
});

test('JSON Patch: atomicity — a failing operation commits nothing', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'atomic', value: { a: 1 },
  } })).json();

  const res = await patch(h, bin.meta.id, [
    { op: 'add', path: '/b', value: 2 },
    { op: 'add', path: '/c', value: 3 },
    { op: 'test', path: '/a', value: 999 },
    { op: 'add', path: '/never', value: 4 },
  ], bin.etag);
  assert.equal(res.status, 409);

  const after = await (await h.request(`/bins/${bin.meta.id}`)).json();
  assert.equal(after.meta.currentVersion, 1, 'no new version may be committed');
  assert.deepEqual(after.value, { a: 1 }, 'bin value must be untouched');
  assert.equal(after.value.b, undefined);
  assert.equal(after.value.c, undefined);

  const versions = await (await h.request(`/bins/${bin.meta.id}/versions`)).json();
  assert.equal(versions.items.length, 1, 'only the original version exists');
});

test('JSON Patch: concurrent writers — exactly one CAS winner', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'cas', value: { counter: 0 },
  } })).json();

  const [a, b] = await Promise.all([
    patch(h, bin.meta.id, [{ op: 'replace', path: '/counter', value: 1 }], bin.etag),
    patch(h, bin.meta.id, [{ op: 'replace', path: '/counter', value: 2 }], bin.etag),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 412], 'exactly one winner, no silent overwrite');

  const final = await (await h.request(`/bins/${bin.meta.id}`)).json();
  assert.equal(final.meta.currentVersion, 2, 'only one version appended');
  assert.equal([1, 2].includes(final.value.counter), true);
});

test('JSON Patch: If-Match, lock and schema are all enforced', async (t) => {
  const h = await harness(t);

  // 428: precondition required
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'guards', value: { port: 80 },
  } })).json();

  let res = await h.request(`/bins/${bin.meta.id}`, {
    method: 'PATCH', value: [{ op: 'add', path: '/x', value: 1 }], headers: { 'Content-Type': PATCH },
  });
  assert.equal(res.status, 428);
  assert.equal((await res.json()).error, 'precondition_required');

  // 412: stale etag
  res = await patch(h, bin.meta.id, [{ op: 'add', path: '/x', value: 1 }], '"stale-etag"');
  assert.equal(res.status, 412);

  // 423: locked bin
  const locked = await (await h.request(`/bins/${bin.meta.id}/meta`, {
    method: 'PATCH', value: { locked: true }, headers: { 'If-Match': bin.etag },
  })).json();
  res = await patch(h, bin.meta.id, [{ op: 'add', path: '/x', value: 1 }], locked.etag);
  assert.equal(res.status, 423);
  assert.equal((await res.json()).error, 'bin_locked');

  // schema rejection after patch
  const schema = await (await h.request('/schemas', { method: 'POST', value: {
    name: 'Ports', schema: { type: 'object', properties: { port: { type: 'number', maximum: 1000 } }, required: ['port'] },
  } })).json();
  const bound = await (await h.request('/bins', { method: 'POST', value: {
    name: 'schematized', value: { port: 80 }, schemaId: schema.meta.id,
  } })).json();
  res = await patch(h, bound.meta.id, [{ op: 'replace', path: '/port', value: 65535 }], bound.etag);
  assert.equal(res.status, 422);
  const after = await (await h.request(`/bins/${bound.meta.id}`)).json();
  assert.equal(after.meta.currentVersion, 1);
  assert.equal(after.value.port, 80);
});

test('JSON Patch: prototype pollution keys stay plain data', async (t) => {
  const h = await harness(t);
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'proto', value: {},
  } })).json();

  const res = await patch(h, bin.meta.id, [
    { op: 'add', path: '/__proto__', value: { polluted: true } },
    { op: 'add', path: '/constructor', value: 'literal' },
    { op: 'add', path: '/nested', value: {} },
    { op: 'add', path: '/nested/prototype', value: 'also-literal' },
  ], bin.etag);
  assert.equal(res.status, 200, await res.clone().text());

  assert.equal(({}).polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(Object.prototype.polluted, undefined);

  const rec = await res.json();
  assert.equal(rec.value.constructor, 'literal');
  assert.deepEqual(rec.value.__proto__, { polluted: true });
  assert.equal(rec.value.nested.prototype, 'also-literal');
});

test('JSON Patch: merge patch semantics are unchanged for non-patch content types', async (t) => {
  const h = await harness(t);

  // Array document via merge-patch replaces the whole target (RFC 7396)
  const bin = await (await h.request('/bins', { method: 'POST', value: {
    name: 'merge-compat', value: { a: 'b' },
  } })).json();
  let res = await h.request(`/bins/${bin.meta.id}`, {
    method: 'PATCH', value: ['c'], headers: { 'Content-Type': 'application/merge-patch+json', 'If-Match': bin.etag },
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual((await res.json()).value, ['c']);

  // application/json keeps legacy merge behaviour
  const bin2 = await (await h.request('/bins', { method: 'POST', value: {
    name: 'legacy', value: { keep: 1, drop: 2 },
  } })).json();
  res = await h.request(`/bins/${bin2.meta.id}`, {
    method: 'PATCH', value: { drop: null }, headers: { 'Content-Type': 'application/json', 'If-Match': bin2.etag },
  });
  assert.equal(res.status, 200);
  const rec = await res.json();
  assert.deepEqual(rec.value, { keep: 1 }, 'null still deletes a member');
});

test('malformed operations and pointer edge cases reject instead of misapplying (F10)', async t => {
  const h = await harness(t);
  const bin = await (await (await h.request('/bins', { method: 'POST', value: { name: 'f10', value: { keep: 1 } } })).json());

  // value member is required for add/replace/test: no implicit undefined.
  for (const ops of [[{ op: 'add', path: '/bad' }], [{ op: 'replace', path: '/keep', path2: 1 }], [{ op: 'test', path: '/keep' }]]) {
    const res = await patch(h, bin.meta.id, ops, bin.etag);
    assert.equal(res.status, 422, JSON.stringify(ops));
  }
  assert.equal((await (await h.request(`/bins/${bin.meta.id}`)).json()).value.keep, 1, 'no undefined member may leak into the document');

  // A null root has no /missing child: the comparison must not treat the
  // missing location as a null match (it used to return 200).
  const nullRoot = await (await (await h.request('/bins', { method: 'POST', value: { name: 'f10-null', value: null } })).json());
  const tested = await patch(h, nullRoot.meta.id, [{ op: 'test', path: '/missing', value: null }], nullRoot.etag);
  assert.equal(tested.status, 422);

  // Same-location move still verifies the source exists.
  const moved = await patch(h, bin.meta.id, [{ op: 'move', from: '/nope', path: '/nope' }], bin.etag);
  assert.equal(moved.status, 422);
  // RFC 6901: "" is the root pointer; "/" is the empty-string key. A
  // same-location move via the root form is a legal no-op.
  const rootMoved = await patch(h, bin.meta.id, [{ op: 'move', from: '', path: '' }], bin.etag);
  assert.equal(rootMoved.status, 200, 'move root -> root is a legal no-op');

  // "/" is the empty-string key, NOT the root: moving it to a sibling key must
  // be legal. The old string-prefix cycle check confused "/" with the root pointer.
  const keyedBin = await (await (await h.request('/bins', { method: 'POST', value: { name: 'f10-key', value: { '': { v: 1 }, x: 0 } } })).json());
  const keyMove = await patch(h, keyedBin.meta.id, [{ op: 'move', from: '/', path: '/x' }], keyedBin.etag);
  assert.equal(keyMove.status, 200);
  assert.deepEqual((await (await h.request('/bins/' + keyedBin.meta.id)).json()).value, { x: { v: 1 } });
  const keyedNow = await (await h.request('/bins/' + keyedBin.meta.id)).json();
  // The actual root pointer ("") contains every destination: a cycle.
  const fromRoot = await patch(h, keyedBin.meta.id, [{ op: 'move', from: '', path: '/x' }], keyedNow.etag);
  assert.equal(fromRoot.status, 422, 'the root contains every destination');
  // Moving a parent into its own child is a cycle as well.
  const intoChild = await patch(h, keyedBin.meta.id, [{ op: 'move', from: '/x', path: '/x/v' }], keyedNow.etag);
  assert.equal(intoChild.status, 422, 'a parent cannot move into its own child');
});
