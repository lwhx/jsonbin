/**
 * RFC 6902 JSON Patch implementation for JSONBin v3.2.
 * Fully supports: add, remove, replace, move, copy, test.
 * Strictly complies with RFC 6901 JSON Pointer escaping (~1 -> /, ~0 -> ~).
 * Prototype-pollution safe.
 */

export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export class JsonPatchError extends Error {
  code: string;
  operationIndex: number;
  path: string;
  statusCode: number;

  constructor(code: string, operationIndex: number, path: string, statusCode = 422) {
    super(`json_patch_error: ${code} at operation ${operationIndex} (${path})`);
    this.name = "JsonPatchError";
    this.code = code;
    this.operationIndex = operationIndex;
    this.path = path;
    this.statusCode = statusCode;
  }
}

function parsePointer(pointer: string, opIndex: number): string[] {
  if (typeof pointer !== "string") {
    throw new JsonPatchError("invalid_pointer", opIndex, String(pointer));
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new JsonPatchError("invalid_pointer", opIndex, pointer);
  }

  const parts = pointer.slice(1).split("/");
  if (parts.length > 128) {
    throw new JsonPatchError("pointer_too_deep", opIndex, pointer);
  }

  return parts.map((part) => {
    if (/~(?:[^01]|$)/.test(part)) {
      throw new JsonPatchError("invalid_pointer_escape", opIndex, pointer);
    }
    return part.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function deepClone<T>(val: T): T {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(deepClone) as unknown as T;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(val)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      Object.defineProperty(out, k, { value: deepClone(v), enumerable: true, configurable: true, writable: true });
    } else {
      out[k] = deepClone(v);
    }
  }
  return out as T;
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], arrB[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEquals(objA[k], objB[k])) return false;
  }
  return true;
}

function resolveParent(
  root: unknown,
  tokens: string[],
  opIndex: number,
  originalPath: string,
): { parent: any; lastKey: string } {
  if (tokens.length === 0) {
    return { parent: null, lastKey: "" };
  }

  let curr: any = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (Array.isArray(curr)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) {
        throw new JsonPatchError("target_not_found", opIndex, originalPath);
      }
      const idx = Number(token);
      if (idx >= curr.length) throw new JsonPatchError("target_not_found", opIndex, originalPath);
      curr = curr[idx];
    } else if (isObject(curr)) {
      if (!Object.prototype.hasOwnProperty.call(curr, token)) {
        throw new JsonPatchError("target_not_found", opIndex, originalPath);
      }
      curr = curr[token];
    } else {
      throw new JsonPatchError("target_not_found", opIndex, originalPath);
    }
  }

  return { parent: curr, lastKey: tokens[tokens.length - 1] };
}

function getPointerValue(root: unknown, tokens: string[], opIndex: number, originalPath: string): unknown {
  if (tokens.length === 0) return root;
  const { parent, lastKey } = resolveParent(root, tokens, opIndex, originalPath);
  if (parent === null) return root;

  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(lastKey)) throw new JsonPatchError("target_not_found", opIndex, originalPath);
    const idx = Number(lastKey);
    if (idx >= parent.length) throw new JsonPatchError("target_not_found", opIndex, originalPath);
    return parent[idx];
  } else if (isObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, lastKey)) {
      throw new JsonPatchError("target_not_found", opIndex, originalPath);
    }
    return parent[lastKey];
  }
  throw new JsonPatchError("target_not_found", opIndex, originalPath);
}

function applyAdd(root: unknown, tokens: string[], value: unknown, opIndex: number, path: string): unknown {
  const clonedValue = deepClone(value);
  if (tokens.length === 0) {
    return clonedValue;
  }

  const { parent, lastKey } = resolveParent(root, tokens, opIndex, path);
  if (Array.isArray(parent)) {
    if (lastKey === "-") {
      parent.push(clonedValue);
    } else {
      if (!/^(0|[1-9]\d*)$/.test(lastKey)) throw new JsonPatchError("invalid_array_index", opIndex, path);
      const idx = Number(lastKey);
      if (idx > parent.length) throw new JsonPatchError("index_out_of_bounds", opIndex, path);
      parent.splice(idx, 0, clonedValue);
    }
    return root;
  } else if (isObject(parent)) {
    Object.defineProperty(parent, lastKey, {
      value: clonedValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    return root;
  }

  throw new JsonPatchError("target_not_found", opIndex, path);
}

function applyRemove(root: unknown, tokens: string[], opIndex: number, path: string): unknown {
  if (tokens.length === 0) {
    throw new JsonPatchError("cannot_remove_root", opIndex, path);
  }

  const { parent, lastKey } = resolveParent(root, tokens, opIndex, path);
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(lastKey)) throw new JsonPatchError("invalid_array_index", opIndex, path);
    const idx = Number(lastKey);
    if (idx >= parent.length) throw new JsonPatchError("target_not_found", opIndex, path);
    parent.splice(idx, 1);
    return root;
  } else if (isObject(parent)) {
    if (!Object.prototype.hasOwnProperty.call(parent, lastKey)) {
      throw new JsonPatchError("target_not_found", opIndex, path);
    }
    delete parent[lastKey];
    return root;
  }

  throw new JsonPatchError("target_not_found", opIndex, path);
}

/**
 * Apply array of RFC 6902 JSON Patch operations atomically to a document.
 */
export function applyJsonPatch(doc: unknown, patch: JsonPatchOperation[]): unknown {
  if (!Array.isArray(patch)) {
    throw new JsonPatchError("patch_must_be_array", 0, "");
  }
  if (patch.length > 100) {
    throw new JsonPatchError("operation_limit_exceeded", 100, "");
  }

  // Work on a deep clone to maintain complete atomicity
  let currentDoc = deepClone(doc);

  for (let i = 0; i < patch.length; i++) {
    const op = patch[i];
    if (!op || typeof op !== "object") {
      throw new JsonPatchError("invalid_operation", i, "");
    }

    const path = op.path;
    const tokens = parsePointer(path, i);

    switch (op.op) {
      case "add": {
        currentDoc = applyAdd(currentDoc, tokens, op.value, i, path);
        break;
      }
      case "remove": {
        currentDoc = applyRemove(currentDoc, tokens, i, path);
        break;
      }
      case "replace": {
        // Target must exist
        getPointerValue(currentDoc, tokens, i, path);
        if (tokens.length === 0) {
          currentDoc = deepClone(op.value);
        } else {
          currentDoc = applyRemove(currentDoc, tokens, i, path);
          currentDoc = applyAdd(currentDoc, tokens, op.value, i, path);
        }
        break;
      }
      case "move": {
        if (typeof op.from !== "string") {
          throw new JsonPatchError("missing_from", i, path);
        }
        if (op.from === path) break;

        // Prevent moving a parent into its own child
        if (path.startsWith(op.from === "/" ? "/" : `${op.from}/`)) {
          throw new JsonPatchError("move_into_child_cycle", i, path);
        }

        const fromTokens = parsePointer(op.from, i);
        const val = getPointerValue(currentDoc, fromTokens, i, op.from);
        currentDoc = applyRemove(currentDoc, fromTokens, i, op.from);
        currentDoc = applyAdd(currentDoc, tokens, val, i, path);
        break;
      }
      case "copy": {
        if (typeof op.from !== "string") {
          throw new JsonPatchError("missing_from", i, path);
        }
        const fromTokens = parsePointer(op.from, i);
        const val = getPointerValue(currentDoc, fromTokens, i, op.from);
        currentDoc = applyAdd(currentDoc, tokens, val, i, path);
        break;
      }
      case "test": {
        const actual = getPointerValue(currentDoc, tokens, i, path);
        if (!deepEquals(actual, op.value)) {
          // RFC 6902 Section 4.6: If the value is not equal, the test fails
          throw new JsonPatchError("json_patch_test_failed", i, path, 409);
        }
        break;
      }
      default:
        throw new JsonPatchError("unsupported_op", i, path);
    }
  }

  return currentDoc;
}
