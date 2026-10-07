/**
 * Safe, zero-dependency serializers for JSON content negotiation.
 * Supports YAML, TOML, and .env key-value exports in Cloudflare Workers.
 */

export type ExportFormat = "json" | "yaml" | "toml" | "env";

export function detectFormat(url: string, acceptHeader?: string | null): ExportFormat {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".yaml") || pathname.endsWith(".yml")) return "yaml";
  if (pathname.endsWith(".toml")) return "toml";
  if (pathname.endsWith(".env")) return "env";

  if (acceptHeader) {
    const acc = acceptHeader.toLowerCase();
    if (acc.includes("application/x-yaml") || acc.includes("text/yaml")) return "yaml";
    if (acc.includes("application/toml") || acc.includes("text/toml")) return "toml";
    if (acc.includes("text/x-env") || acc.includes("text/env")) return "env";
  }

  return "json";
}

export function formatContentType(format: ExportFormat): string {
  switch (format) {
    case "yaml":
      return "text/yaml; charset=utf-8";
    case "toml":
      return "text/toml; charset=utf-8";
    case "env":
      return "text/plain; charset=utf-8";
    default:
      return "application/json; charset=utf-8";
  }
}

/**
 * Clean YAML serializer for JSON values without external packages.
 * Strings that a YAML parser would read as booleans, nulls or numbers are
 * quoted so the round trip preserves JSON types; sequences render as proper
 * block lists (no duplicated trailing lines).
 */
const YAML_SCALAR_WORDS = /^(?:true|false|null|yes|no|on|off|~)$/i;
const YAML_NUMERIC = /^[-+]?(\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d[\d_]*)$/;

function yamlString(value: string): string {
  const ambiguous = value === ""
    || YAML_SCALAR_WORDS.test(value)
    || YAML_NUMERIC.test(value)
    || value !== value.trim()
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(value)
    || value.includes(": ") || value.endsWith(":") || value.includes(" #");
  return ambiguous ? JSON.stringify(value) : value;
}

function yamlKey(key: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlLines(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return [pad + "null"];
  if (typeof value === "boolean") return [pad + (value ? "true" : "false")];
  if (typeof value === "number") return [pad + String(value)];
  if (typeof value === "string") return [pad + yamlString(value)];

  if (Array.isArray(value)) {
    if (value.length === 0) return [pad + "[]"];
    const lines: string[] = [];
    for (const item of value) {
      const inner = yamlLines(item, indent + 1);
      // The item was rendered one level deeper; fold its first line under "- ".
      lines.push(pad + "- " + inner[0].slice(pad.length + 2), ...inner.slice(1));
    }
    return lines;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [pad + "{}"];
  const lines: string[] = [];
  for (const [k, v] of entries) {
    const nested = typeof v === "object" && v !== null
      && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);
    if (nested) {
      lines.push(pad + yamlKey(k) + ":");
      lines.push(...yamlLines(v, indent + 1));
    } else {
      lines.push(pad + yamlKey(k) + ": " + yamlLines(v, indent + 1)[0].trim());
    }
  }
  return lines;
}

export function jsonToYaml(value: unknown, indent = 0): string {
  return yamlLines(value, indent).join("\n");
}

/**
 * TOML serializer for JSON objects. Nested objects become [table] sections and
 * arrays of objects become [[array-of-tables]]; heterogeneous arrays degrade to
 * a valid JSON string value rather than emitting invalid TOML.
 */
export function jsonToToml(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `# Primitive / Array value
value = ${tomlInline(value)}
`;
  }

  const lines: string[] = [];
  const tables: Array<{ path: string; obj: Record<string, unknown> }> = [{ path: "", obj: value as Record<string, unknown> }];
  const arrayTables: Array<{ path: string; rows: Record<string, unknown>[] }> = [];

  while (tables.length > 0) {
    const table = tables.shift()!;
    if (table.path) lines.push(`
[${table.path}]`);
    for (const [k, v] of Object.entries(table.obj)) {
      const path = table.path ? `${table.path}.${k}` : k;
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        tables.push({ path, obj: v as Record<string, unknown> });
      } else if (Array.isArray(v) && v.length > 0 && v.every(item => typeof item === "object" && item !== null && !Array.isArray(item))) {
        arrayTables.push({ path, rows: v as unknown as Record<string, unknown>[] });
      } else {
        lines.push(`${formatTomlKey(k)} = ${tomlInline(v)}`);
      }
    }
  }

  for (const array of arrayTables) {
    for (const row of array.rows) {
      lines.push(`
[[${array.path}]]`);
      for (const [k, v] of Object.entries(row)) {
        lines.push(`${formatTomlKey(k)} = ${tomlInline(v)}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

function tomlInline(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    // Homogeneous scalar arrays stay native; anything containing an object
    // degrades to a valid (lossy) JSON string instead of invalid TOML.
    const scalars = v.every(item => item === null || ["boolean", "number", "string"].includes(typeof item));
    return scalars ? `[${v.map(tomlInline).join(", ")}]` : JSON.stringify(JSON.stringify(v));
  }
  return JSON.stringify(v);
}

function formatTomlKey(k: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/**
 * Flattens JSON into .env KEY=VALUE lines for shell sourcing. Output is a
 * SHELL FRAGMENT: only a conservative reserved-character-free subset stays
 * bare; every other value is strictly single-quoted so no expansion, command
 * substitution or escape inside the data can ever execute. Sanitized keys
 * that collide get numeric suffixes instead of silently overwriting.
 */
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function jsonToEnv(value: unknown, prefix = ""): string {
  if (typeof value !== "object" || value === null) {
    return `VALUE=${shellQuote(String(value ?? ""))}
`;
  }

  const lines: string[] = [];
  const seen = new Map<string, number>();
  function emitKey(raw: string): string {
    const key = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(?=[0-9])/, "_");
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? key : `${key}_${n + 1}`;
  }

  function traverse(obj: Record<string, unknown>, currentPrefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      const sanitizedKey = emitKey(currentPrefix ? `${currentPrefix}_${k}` : k);
      if (v === null || v === undefined) {
        lines.push(`${sanitizedKey}=''`);
      } else if (typeof v === "boolean" || typeof v === "number") {
        lines.push(`${sanitizedKey}=${v}`);
      } else if (typeof v === "string") {
        if (/^[A-Za-z0-9_./:@+-]+$/.test(v)) {
          lines.push(`${sanitizedKey}=${v}`);
        } else {
          lines.push(`${sanitizedKey}=${shellQuote(v)}`);
        }
      } else {
        lines.push(`${sanitizedKey}=${shellQuote(JSON.stringify(v))}`);
      }
    }
  }

  traverse(value as Record<string, unknown>, prefix);
  return lines.join("\n") + "\n";
}

export function serializeContent(value: unknown, format: ExportFormat): string {
  switch (format) {
    case "yaml":
      return jsonToYaml(value);
    case "toml":
      return jsonToToml(value);
    case "env":
      return jsonToEnv(value);
    default:
      return JSON.stringify(value, null, 2);
  }
}
