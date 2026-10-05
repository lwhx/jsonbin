import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeNodeType,
  moveNode,
  newNode,
  nodesFromObject,
  objectFromNodes,
  parseNumber,
  removeNode,
  updateNode,
  valueFromNode,
} from "../src/react-app/features/bins/json-form-model.ts";

test("prototype and whitespace keys round-trip as own properties", () => {
  const value = Object.fromEntries([
    ["__proto__", { kept: true }],
    ["constructor", "literal"],
    ["prototype", false],
    ["", "empty"],
    [" padded ", 1],
    ["padded", 2],
  ]);
  const result = objectFromNodes(nodesFromObject(value));
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, value);
  assert.equal(Object.hasOwn(result.value, "__proto__"), true);
});

test("strict JSON numbers reject lossy and non-JSON spellings", () => {
  assert.deepEqual(parseNumber("0"), { valid: true, value: 0 });
  assert.deepEqual(parseNumber("-1.25e+3"), { valid: true, value: -1250 });
  for (const raw of ["", "01", "1.", "0x10", "NaN", "Infinity", "9007199254740993", "9007199254740992.0", "9007199254740993.0", "9007199254740993e0", "1.0000000000000001", "-0", "-0.0", "1e309", "1e-324"]) {
    assert.equal(parseNumber(raw).valid, false, raw);
  }
});

test("large form models retain every entry within the supported structure budget", () => {
  const value = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`field-${index}`, index]));
  const nodes = nodesFromObject(value);
  assert.equal(nodes.length, 2_000);
  const changed = updateNode(nodes, nodes[1_999].id, node => ({ ...node, raw: "1998" }));
  const result = objectFromNodes(changed);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.value).length, 2_000);
  assert.equal(result.value["field-1999"], 1998);
});

test("multiline strings and recursive mixed structures round-trip", () => {
  const value = {
    text: " a\nb\t ",
    nested: [{ ok: true }, null, [1, "two"]],
  };
  const nodes = nodesFromObject(value);
  assert.equal(valueFromNode(nodes[0]).value, " a\nb\t ");
  const result = objectFromNodes(nodes);
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, value);
});

test("type changes use safe defaults without mutating the original node", () => {
  const original = newNode("string", "key");
  assert.equal(changeNodeType(original, "number").raw, "0");
  assert.equal(changeNodeType(original, "boolean").raw, "true");
  assert.deepEqual(changeNodeType(original, "object").children, []);
  assert.deepEqual(changeNodeType(original, "array").children, []);
  assert.equal(original.type, "string");
});

test("recursive update, move and remove retain stable node identities", () => {
  const root = nodesFromObject({ nested: ["a", "b", "c"] });
  const array = root[0];
  const third = array.children[2];
  const moved = moveNode(root, third.id, -1);
  const movedTwice = moveNode(moved, third.id, -1);
  assert.deepEqual(objectFromNodes(movedTwice).value, { nested: ["c", "a", "b"] });
  const firstId = movedTwice[0].children[1].id;
  const removed = removeNode(movedTwice, firstId);
  assert.deepEqual(objectFromNodes(removed).value, { nested: ["c", "b"] });
  const secondId = removed[0].children[1].id;
  const updated = updateNode(removed, secondId, node => ({ ...node, raw: "changed" }));
  assert.deepEqual(objectFromNodes(updated).value, { nested: ["c", "changed"] });
  assert.equal(updated[0].id, array.id);
});

test("duplicate raw keys are invalid but distinct whitespace and empty keys are valid", () => {
  const valid = objectFromNodes(nodesFromObject(Object.fromEntries([["", 1], [" a", 2], ["a", 3]])));
  assert.equal(valid.valid, true);
  const nodes = nodesFromObject({ a: 1, b: 2 });
  const duplicate = updateNode(nodes, nodes[1].id, node => ({ ...node, key: "a" }));
  const result = objectFromNodes(duplicate);
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].field, "key");
  assert.equal(result.issues[0].nodeId, nodes[1].id);
});
