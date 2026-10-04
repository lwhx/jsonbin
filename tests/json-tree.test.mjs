import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleJsonTree, treePreview, TREE_PAGE_SIZE } from '../src/react-app/features/bins/json-tree.ts';

test('tree previews preserve falsy scalars and empty containers, and bound long text without changing its value', () => {
  for (const [value, kind] of [[null, 'null'], [false, 'boolean'], [0, 'number'], ['', 'string'], [[], 'array'], [{}, 'object']]) {
    const { rows, hasMore } = visibleJsonTree(value, new Set(['']));
    assert.equal(rows.length, 1); assert.equal(hasMore, false);
    assert.equal(rows[0].kind, kind); assert.equal(treePreview(rows[0]), JSON.stringify(value));
  }
  const value = 'x'.repeat(159) + '😀' + 'x'.repeat(1000);
  const node = visibleJsonTree(value, new Set()).rows[0];
  assert.ok(treePreview(node).length < 220); assert.equal(node.value, value);
  assert.ok(!treePreview(node).includes('\\ud83d')); // a truncated preview must not split the surrogate pair
});

test('tree expansion encodes JSON Pointer segments, preserves object and array ordering and treats prototype-like keys as data', () => {
  const value = JSON.parse('{"a/b":{"~key":false},"array":[null,0],"__proto__":{"safe":"value"},"":true}');
  const collapsed = visibleJsonTree(value, new Set([''])).rows;
  assert.deepEqual(collapsed.map(node => node.pointer), ['', '/a~1b', '/array', '/__proto__', '/']);
  const rows = visibleJsonTree(value, new Set(['', '/a~1b', '/array', '/__proto__'])).rows;
  assert.deepEqual(rows.map(node => node.pointer), ['', '/a~1b', '/a~1b/~0key', '/array', '/array/0', '/array/1', '/__proto__', '/__proto__/safe', '/']);
  assert.equal(rows[2].value, false); assert.equal(rows[4].kind, 'null'); assert.equal(rows[5].value, 0);
  assert.equal(rows[5].label, '[1]'); assert.equal(rows[5].position, 2); assert.equal(rows[5].siblings, 2);
  assert.equal(rows[7].parent, '/__proto__'); assert.equal(rows[7].depth, 2);
  assert.equal(Object.prototype.safe, undefined);
});

test('tree traversal pages wide objects without losing later values and handles deep expanded data without recursion', () => {
  const value = Array.from({ length: 1000 }, (_, index) => index);
  const first = visibleJsonTree(value, new Set(['']));
  assert.equal(first.rows.length, TREE_PAGE_SIZE); assert.equal(first.hasMore, true);
  const all = visibleJsonTree(value, new Set(['']), 1001);
  assert.equal(all.rows.length, 1001); assert.equal(all.hasMore, false); assert.equal(all.rows.at(-1).value, 999);
  let deep = null, pointer = '';
  const expanded = new Set(['']);
  for (let index = 0; index < 512; index++) { deep = { child: deep }; pointer += '/child'; expanded.add(pointer); }
  const nested = visibleJsonTree(deep, expanded, 600);
  assert.equal(nested.rows.length, 513); assert.equal(nested.hasMore, false); assert.equal(nested.rows.at(-1).depth, 512);
  assert.equal(nested.rows.at(-1).value, null);
});
