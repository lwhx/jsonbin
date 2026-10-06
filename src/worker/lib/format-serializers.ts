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
 */
export function jsonToYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes('"') || value.includes(":") || value.includes("#") || value.startsWith(" ") || value.endsWith(" ")) {
      return JSON.stringify(value);
    }
    return value || '""';
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const inner = jsonToYaml(item, indent + 1);
          const firstLine = inner.trimStart();
          const rest = inner.slice(inner.indexOf("\n") + 1);
          if (inner.includes("\n")) {
            return `${pad}- ${firstLine}\n${rest}`;
          }
          return `${pad}- ${firstLine}`;
        }
        return `${pad}- ${jsonToYaml(item, indent + 1)}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        const keySafe = /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
        if (typeof v === "object" && v !== null && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0)) {
          return `${pad}${keySafe}:\n${jsonToYaml(v, indent + 1)}`;
        }
        return `${pad}${keySafe}: ${jsonToYaml(v, indent + 1)}`;
      })
      .join("\n");
  }

  return String(value);
}

/**
 * Basic TOML serializer for JSON objects.
 */
export function jsonToToml(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `# Primitive / Array value\nvalue = ${JSON.stringify(value)}\n`;
  }

  const lines: string[] = [];
  const tables: Array<{ path: string; obj: Record<string, unknown> }> = [];

  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      tables.push({ path: k, obj: v as Record<string, unknown> });
    } else {
      lines.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`);
    }
  }

  while (tables.length > 0) {
    const table = tables.shift()!;
    lines.push(`\n[${table.path}]`);
    for (const [k, v] of Object.entries(table.obj)) {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        tables.push({ path: `${table.path}.${k}`, obj: v as Record<string, unknown> });
      } else {
        lines.push(`${formatTomlKey(k)} = ${formatTomlValue(v)}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

function formatTomlKey(k: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function formatTomlValue(v: unknown): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(formatTomlValue).join(", ")}]`;
  }
  return JSON.stringify(v);
}

/**
 * Flattens JSON object into .env KEY=VALUE syntax for containers / shell scripts.
 */
export function jsonToEnv(value: unknown, prefix = ""): string {
  if (typeof value !== "object" || value === null) {
    return `VALUE=${JSON.stringify(String(value ?? ""))}\n`;
  }

  const lines: string[] = [];

  function traverse(obj: Record<string, unknown>, currentPrefix: string) {
    for (const [k, v] of Object.entries(obj)) {
      const sanitizedKey = (currentPrefix ? `${currentPrefix}_${k}` : k)
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_");

      if (v === null || v === undefined) {
        lines.push(`${sanitizedKey}=""`);
      } else if (typeof v === "boolean" || typeof v === "number") {
        lines.push(`${sanitizedKey}=${v}`);
      } else if (typeof v === "string") {
        // Plain unreserved strings stay unquoted for direct shell sourcing; anything else is JSON-escaped.
        if (/^[A-Za-z0-9_./:@+-]+$/.test(v)) {
          lines.push(`${sanitizedKey}=${v}`);
        } else {
          lines.push(`${sanitizedKey}=${JSON.stringify(v)}`);
        }
      } else if (Array.isArray(v)) {
        lines.push(`${sanitizedKey}=${JSON.stringify(JSON.stringify(v))}`);
      } else if (typeof v === "object") {
        traverse(v as Record<string, unknown>, sanitizedKey);
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
