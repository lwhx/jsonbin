import { Hono } from "hono";
import type { Context } from "hono";
import { version } from "../../../package.json";
import { readApiKey } from "../storage/keys";
import { readBoundedJson } from "../lib/system-http";
import { SystemError } from "../../shared/system";
// Circular on purpose: index.ts registers this router, and tool calls
// dispatch back through the same app. The binding is only dereferenced at
// request time, long after both modules finished evaluating.
import { app as rootApp } from "../index";

const app = new Hono<{ Bindings: Env }>();

const SERVER_NAME = "jsonbin-remote-mcp";
/** Protocol revisions this transport understands; initialize echoes a supported request. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
/** A request body and a JSON-RPC batch can never legitimately exceed these. */
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_ITEMS = 100;

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const MCP_TOOLS = [
  {
    name: "create_bin",
    description: "Create a new bin with an initial JSON value (version 1).",
    inputSchema: {
      type: "object",
      required: ["name", "value"],
      properties: {
        name: { type: "string", description: "Bin name (1-160 chars)" },
        value: { description: "Initial JSON value" },
        slug: { type: "string", description: "Optional custom slug alias" },
        description: { type: "string", description: "Optional description" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        visibility: { type: "string", enum: ["private", "public"], description: "Optional visibility (default private)" },
        collectionId: { type: "string", description: "Optional collection UUID to create the bin in (collection-restricted keys can only create inside a granted collection)" },
      },
    },
  },
  {
    name: "list_bins",
    description: "List accessible bins with optional filtering by tag, favorite, or pinned status.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter bins by tag" },
        favorite: { type: "boolean", description: "Filter by favorite status" },
        pinned: { type: "boolean", description: "Filter by pinned status" },
      },
    },
  },
  {
    name: "get_bin",
    description: "Get metadata and current JSON content of a bin by ID or slug.",
    inputSchema: {
      type: "object",
      required: ["idOrSlug"],
      properties: {
        idOrSlug: { type: "string", description: "Bin UUID or slug" },
      },
    },
  },
  {
    name: "get_published_bin",
    description: "Get the production published version of a bin by ID or slug.",
    inputSchema: {
      type: "object",
      required: ["idOrSlug"],
      properties: {
        idOrSlug: { type: "string", description: "Bin UUID or slug" },
      },
    },
  },
  {
    name: "search_bins",
    description: "Search bin names, descriptions, and metadata.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search term" },
        limit: { type: "integer", description: "Maximum results (1-50, default 20)" },
      },
    },
  },
  {
    name: "search_json",
    description: "Search inside JSON keys or scalar values across bins with content search enabled.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search term" },
        mode: { type: "string", enum: ["keys", "all"], description: "keys (keys only) or all (keys and values)" },
      },
    },
  },
  {
    name: "list_bin_versions",
    description: "List stored immutable historical versions of a bin.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
      },
    },
  },
  {
    name: "get_bin_version",
    description: "Retrieve a specific immutable historical version of a bin.",
    inputSchema: {
      type: "object",
      required: ["id", "version"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Historical version number" },
      },
    },
  },
  {
    name: "update_bin",
    description: "Full update of a bin's JSON content with CAS precondition check.",
    inputSchema: {
      type: "object",
      required: ["id", "value", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        value: { description: "New complete JSON value" },
        etag: { type: "string", description: "Expected ETag (for CAS lock)" },
        message: { type: "string", description: "Optional version change note" },
      },
    },
  },
  {
    name: "merge_patch_bin",
    description: "Incremental modification of a bin using RFC 7396 JSON Merge Patch.",
    inputSchema: {
      type: "object",
      required: ["id", "patch", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        patch: { type: "object", description: "RFC 7396 merge patch object" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
  },
  {
    name: "json_patch_bin",
    description: "Atomic structural modification of a bin using RFC 6902 JSON Patch (add, remove, replace, move, copy, test).",
    inputSchema: {
      type: "object",
      required: ["id", "operations", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        operations: {
          type: "array",
          description: "List of RFC 6902 operations",
          items: {
            type: "object",
            required: ["op", "path"],
            properties: {
              op: { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] },
              path: { type: "string" },
              from: { type: "string" },
              value: {},
            },
          },
        },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
  },
  {
    name: "publish_bin",
    description: "Publish a bin version to the production release pointer.",
    inputSchema: {
      type: "object",
      required: ["id", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Optional specific version to publish (defaults to latest)" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
  },
  {
    name: "rollback_bin",
    description: "Rollback production release pointer to a previous version without appending history.",
    inputSchema: {
      type: "object",
      required: ["id", "version", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Target historical version" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
  },
  {
    name: "clone_bin",
    description: "Clone a bin snapshot into a new private bin with initial version 1.",
    inputSchema: {
      type: "object",
      required: ["id", "etag"],
      properties: {
        id: { type: "string", description: "Source bin UUID" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
  },
];

/**
 * Dispatch an internal API request within the Worker while forwarding the client's Authorization header.
 */
async function internalFetch(c: Context<{ Bindings: Env }>, path: string, options: RequestInit = {}): Promise<{ status: number; data: any; headers: Headers }> {
  const url = new URL(c.req.url);
  const targetUrl = `${url.origin}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(options.headers);

  // Forward client auth
  const auth = c.req.header("Authorization");
  if (auth && !headers.has("Authorization")) {
    headers.set("Authorization", auth);
  }

  let executionCtx: any;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const res = await rootApp.fetch(new Request(targetUrl, { ...options, headers }), c.env, executionCtx);

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { status: res.status, data, headers: res.headers };
}

/** Structured tool failure carrying the normalized MCP error code. */
class McpToolError extends Error {
  payload: Record<string, unknown>;

  constructor(payload: Record<string, unknown>) {
    super(String(payload.error));
    this.payload = payload;
  }
}

/**
 * Project an upstream API failure onto the stable MCP error vocabulary.
 * Known API codes pass through; auth/limit codes are normalized; the rest map by status.
 */
function normalizeApiError(status: number, data: any): Record<string, unknown> {
  const codeAliases: Record<string, string> = {
    unauthorized: "authentication_failed",
    insufficient_scope: "permission_denied",
    rate_limit_exceeded: "rate_limited",
  };
  const statusCodes: Record<number, string> = {
    400: "validation_failed",
    401: "authentication_failed",
    403: "permission_denied",
    404: "not_found",
    409: "conflict",
    412: "etag_conflict",
    422: "validation_failed",
    423: "bin_locked",
    428: "precondition_required",
    429: "rate_limited",
  };

  const body = data && typeof data === "object" ? data : {};
  const raw = typeof body.error === "string" ? body.error : "";
  const code = codeAliases[raw] || raw || statusCodes[status] || "server_error";

  const payload: Record<string, unknown> = { error: code, statusCode: status };
  if (Array.isArray(body.issues)) payload.issues = body.issues;
  if (Array.isArray(body.requiredScopes)) payload.requiredScopes = body.requiredScopes;
  return payload;
}

function requireOk(status: number, data: any): any {
  if (status >= 400) throw new McpToolError(normalizeApiError(status, data));
  return data;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Execute a specific tool on behalf of the caller.
 */
async function executeTool(c: Context<{ Bindings: Env }>, name: string, args: any): Promise<any> {
  switch (name) {
    case "create_bin": {
      const body: Record<string, unknown> = { name: args.name, value: args.value };
      for (const field of ["slug", "description", "tags", "visibility", "collectionId"] as const) {
        if (args[field] !== undefined) body[field] = args[field];
      }
      const { status, data } = await internalFetch(c, "/bins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return requireOk(status, data);
    }
    case "list_bins": {
      const q = new URLSearchParams();
      if (args.tag) q.set("tag", args.tag);
      if (args.favorite !== undefined) q.set("favorite", String(args.favorite));
      if (args.pinned !== undefined) q.set("pinned", String(args.pinned));
      const qs = q.toString() ? `?${q.toString()}` : "";
      const { status, data } = await internalFetch(c, `/bins${qs}`);
      requireOk(status, data);
      return {
        total: data.total,
        bins: (data.items || []).map((b: any) => ({
          id: b.id,
          name: b.name,
          slug: b.slug,
          tags: b.tags,
          currentVersion: b.currentVersion,
          publishedVersion: b.publishedVersion,
          locked: b.locked,
          updatedAt: b.updatedAt,
        })),
      };
    }
    case "get_bin": {
      const path = UUID_PATTERN.test(args.idOrSlug) ? `/bins/${args.idOrSlug}` : `/b/${args.idOrSlug}`;
      const { status, data, headers } = await internalFetch(c, path);
      requireOk(status, data);
      if (data && typeof data === "object" && !data.etag) {
        data.etag = headers.get("ETag") || "";
      }
      return data;
    }
    case "get_published_bin": {
      const path = UUID_PATTERN.test(args.idOrSlug) ? `/bins/${args.idOrSlug}/published` : `/b/${args.idOrSlug}/published`;
      const { status, data } = await internalFetch(c, path);
      return requireOk(status, data);
    }
    case "search_bins": {
      const limit = args.limit || 20;
      const { status, data } = await internalFetch(c, `/search?q=${encodeURIComponent(args.query)}&type=bin&limit=${limit}`);
      return requireOk(status, data);
    }
    case "search_json": {
      const qs = args.mode ? `&mode=${encodeURIComponent(args.mode)}` : "";
      const { status, data } = await internalFetch(c, `/search/content?q=${encodeURIComponent(args.query)}${qs}`);
      return requireOk(status, data);
    }
    case "list_bin_versions": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/versions`);
      return requireOk(status, data);
    }
    case "get_bin_version": {
      const { status, data, headers } = await internalFetch(c, `/bins/${args.id}/versions/${args.version}`);
      requireOk(status, data);
      if (data && typeof data === "object" && !data.etag) {
        data.etag = headers.get("ETag") || "";
      }
      return data;
    }
    case "update_bin": {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "If-Match": args.etag,
      };
      if (args.message) {
        headers["X-JSONBin-Message"] = encodeURIComponent(args.message);
      }
      const { status, data } = await internalFetch(c, `/bins/${args.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ value: args.value }),
      });
      return requireOk(status, data);
    }
    case "merge_patch_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/merge-patch+json",
          "If-Match": args.etag,
        },
        body: JSON.stringify(args.patch),
      });
      return requireOk(status, data);
    }
    case "json_patch_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json-patch+json",
          "If-Match": args.etag,
        },
        body: JSON.stringify(args.operations),
      });
      return requireOk(status, data);
    }
    case "publish_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": args.etag,
        },
        body: JSON.stringify({ version: args.version }),
      });
      return requireOk(status, data);
    }
    case "rollback_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/rollback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": args.etag,
        },
        body: JSON.stringify({ version: args.version }),
      });
      return requireOk(status, data);
    }
    case "clone_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/clone`, {
        method: "POST",
        headers: { "If-Match": args.etag },
      });
      return requireOk(status, data);
    }
    default:
      throw new McpToolError({ error: "unknown_tool", tool: name });
  }
}

/** Reject requests without a valid, non-revoked, non-expired Bearer API key. */
async function verifyBearer(c: Context<{ Bindings: Env }>): Promise<Response | null> {
  const authorization = c.req.header("Authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
  if (!token) {
    c.header("WWW-Authenticate", 'Bearer realm="JSONBin MCP"');
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: valid Bearer token required" } }, 401);
  }
  const key = await readApiKey(c.env, token);
  if (!key) {
    c.header("WWW-Authenticate", 'Bearer realm="JSONBin MCP", error="invalid_token"');
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: invalid or revoked token" } }, 401);
  }
  return null;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: any; result?: unknown; error?: unknown };

/** JSON-RPC 2.0 request ids are strings, numbers or null — nothing else. */
function isRequestId(id: unknown): boolean {
  return typeof id === "string" || typeof id === "number" || id === null;
}

function invalidRequest(id: unknown, detail?: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: detail ? `Invalid Request: ${detail}` : "Invalid Request" } };
}

/**
 * Handle one JSON-RPC 2.0 message with strict envelope validation: a wrong
 * jsonrpc version or a non-scalar id is an Invalid Request, never executed.
 * Only a structurally VALID message without an id counts as a notification
 * (no response, per the JSON-RPC 2.0 and MCP specifications). Mirrored in
 * mcp/server.ts for the stdio transport.
 */
async function handleJsonRpc(c: Context<{ Bindings: Env }>, msg: any): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return invalidRequest(null, "not a message object");
  const { jsonrpc, id, method } = msg as Record<string, unknown>;

  if (jsonrpc !== "2.0") return invalidRequest(isRequestId(id) ? id : null, "jsonrpc must be exactly \"2.0\"");
  if (id !== undefined && !isRequestId(id)) return invalidRequest(null, "id must be a string, number or null");
  if (typeof method !== "string" || !method) return invalidRequest(id === undefined ? null : id, "method must be a non-empty string");
  // A valid envelope without an id is a notification: never answer it.
  if (id === undefined) return null;

  if (msg.method === "initialize") {
    const requested = msg.params?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version },
      },
    };
  }

  if (msg.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (msg.method === "tools/call") {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments ?? {};
    if (typeof toolName !== "string" || !toolName) return invalidRequest(id, "params.name must be a tool name");
    if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) return invalidRequest(id, "params.arguments must be an object");
    try {
      const output = await executeTool(c, toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        },
      };
    } catch (err: any) {
      const payload = err instanceof McpToolError
        ? err.payload
        : { error: "server_error", message: "Operation failed" };
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        },
      };
    }
  }

  if (msg.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

/** 204 for notification-only payloads; a single JSON-RPC object otherwise. */
async function respondToBatch(c: Context<{ Bindings: Env }>, messages: any[]): Promise<Response> {
  // An empty batch is a single Invalid Request; oversized batches are rejected
  // outright instead of amplifying into unbounded internal tool executions.
  if (messages.length === 0) return c.json(invalidRequest(null, "empty batch"));
  if (messages.length > MAX_BATCH_ITEMS) return c.json(invalidRequest(null, `batch exceeds ${MAX_BATCH_ITEMS} items`));
  const responses = (await Promise.all(messages.map((item) => handleJsonRpc(c, item)))).filter(Boolean);
  if (responses.length === 0) return c.body(null, 204);
  if (responses.length === 1 && messages.length === 1) return c.json(responses[0]);
  return c.json(responses);
}

// 1. Streamable HTTP POST: POST /api/v1/mcp (stateless server: no session header issued)
app.post("/", async (c) => {
  const denied = await verifyBearer(c);
  if (denied) return denied;

  let body: any;
  try {
    body = await readBoundedJson(c.req.raw, MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof SystemError && error.status === 413) {
      return c.json(invalidRequest(null, "payload exceeds the request budget"), 413);
    }
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (Array.isArray(body)) return respondToBatch(c, body);
  const response = await handleJsonRpc(c, body);
  if (!response) return c.body(null, 204);
  return c.json(response);
});

// Stateless streamable server: no server-initiated stream and no session to terminate.
app.get("/", (c) => c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" }));
app.delete("/", (c) => c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" }));

// 2. Legacy HTTP+SSE transport (2024-11-05): REMOVED. This stateless Worker
// could never deliver responses over the GET stream, so a spec-compliant SSE
// client connected, sent requests and waited forever. Old clients now get an
// explicit 410 pointing at Streamable HTTP instead of a connection that
// silently accepts requests and never answers. (Audit F12)
const legacySseRemoved = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "legacy_sse_removed", message: "The HTTP+SSE transport is no longer supported; use Streamable HTTP: POST /api/v1/mcp" }, 410, { Allow: "POST", "Deprecation": "true" });
app.get("/sse", legacySseRemoved);
app.post("/message", legacySseRemoved);

export default app;
