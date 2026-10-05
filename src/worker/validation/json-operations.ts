function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// RFC 7396: object members merge, null removes a member; other values replace.
export function mergePatch(target: unknown, patch: unknown, depth = 0): unknown {
  if (depth > 128) throw new Error("patch_too_deep");
  if (!isObject(patch)) return patch;
  const result = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, {
      value: mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value, depth + 1),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

// Decode each URL segment exactly once, then JSON Pointer's ~1 and ~0 escapes.
export function valuePath(url: string): string[] {
  const suffix = new URL(url).pathname.match(/(?:\/bins\/[^/]+|\/b\/[^/]+)\/value(\/.*)?$/)?.[1];
  if (!suffix) return [];
  const segments = suffix.slice(1).split("/");
  if (segments.length > 128) throw new Error("invalid_path");
  return segments.map(segment => {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { throw new Error("invalid_path"); }
    if (/~(?:[^01]|$)/.test(decoded)) throw new Error("invalid_path");
    return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

function arrayIndex(token: string, length: number): number {
  const index = Number(token);
  if (!/^(0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(index) || index >= length) {
    throw new Error("path_not_found");
  }
  return index;
}

function child(value: unknown, token: string): unknown {
  if (Array.isArray(value)) return value[arrayIndex(token, value.length)];
  if (!isObject(value) || !Object.hasOwn(value, token)) throw new Error("path_not_found");
  return value[token];
}

export function readValue(value: unknown, path: string[]): unknown {
  for (const token of path) value = child(value, token);
  return value;
}

export function writeValue(value: unknown, path: string[], replacement: unknown): unknown {
  if (!path.length) return replacement;
  const [token, ...rest] = path;
  if (Array.isArray(value)) {
    const result = [...value];
    if (token === "-" && !rest.length) result.push(replacement);
    else {
      const index = arrayIndex(token, value.length);
      result[index] = rest.length ? writeValue(value[index], rest, replacement) : replacement;
    }
    return result;
  }
  if (!isObject(value)) throw new Error("path_not_found");
  const next = rest.length ? writeValue(child(value, token), rest, replacement) : replacement;
  const result = { ...value };
  // Treat __proto__, constructor and prototype as ordinary JSON keys.
  Object.defineProperty(result, token, { value: next, enumerable: true, configurable: true, writable: true });
  return result;
}
