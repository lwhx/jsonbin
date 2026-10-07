#!/usr/bin/env node
/**
 * Official JSONBin Model Context Protocol (MCP) Server.
 * Exposes JSONBin operations to AI coding agents (Hermes, Claude Desktop, Cursor, Codex).
 * Operates strictly over the standard JSONBin HTTP API via @jsonbin/client.
 */

declare const process: any;

import { JsonBinClient, JsonBinError } from "../sdk/typescript/dist/index.js";
import pkg from "../package.json" with { type: "json" };

const SERVER_NAME = "jsonbin-mcp";
const SERVER_VERSION = pkg.version;
/** Protocol revisions this server understands; initialize echoes a supported request. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function getClient() {
  const url = process.env.JSONBIN_URL || "http://localhost:8787";
  const token = process.env.JSONBIN_TOKEN || "";
  return new JsonBinClient({
    baseUrl: url,
    token,
  });
}

/**
 * Project a JsonBinError onto the stable MCP error vocabulary shared with the
 * remote MCP transport. Known API codes pass through; auth/limit codes are
 * normalized; the rest map by status.
 */
export function normalizeErrorPayload(err: unknown): Record<string, unknown> {
  if (!(err instanceof JsonBinError)) {
    return { error: "operation_failed", message: (err as any)?.message || "Unknown error" };
  }
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
  const body = err.data && typeof err.data === "object" ? (err.data as Record<string, unknown>) : {};
  const raw = typeof body.error === "string" ? body.error : "";
  const code = codeAliases[raw] || raw || statusCodes[err.statusCode] || "server_error";

  const payload: Record<string, unknown> = { error: code, statusCode: err.statusCode };
  if (Array.isArray(body.issues)) payload.issues = body.issues;
  if (Array.isArray(body.requiredScopes)) payload.requiredScopes = body.requiredScopes;
  return payload;
}

type ToolHandler = (args: any) => Promise<any>;

const tools: Record<
  string,
  {
    description: string;
    parameters: Record<string, unknown>;
    handler: ToolHandler;
  }
> = {
  create_bin: {
    description: "Create a new bin with an initial JSON value (version 1).",
    parameters: {
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
    handler: async (args) => {
      const input: Record<string, unknown> = { name: args.name, value: args.value };
      for (const field of ["slug", "description", "tags", "visibility", "collectionId"] as const) {
        if (args[field] !== undefined) input[field] = args[field];
      }
      return await getClient().bins.create(input as any);
    },
  },

  list_bins: {
    description: "List accessible bins with optional filtering by tag, favorite, or pinned status.",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Filter bins by tag" },
        favorite: { type: "boolean", description: "Filter by favorite status" },
        pinned: { type: "boolean", description: "Filter by pinned status" },
      },
    },
    handler: async (args) => {
      const res = await getClient().bins.list(args);
      return {
        total: res.total,
        bins: res.items.map((b) => ({
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
    },
  },

  get_bin: {
    description: "Get metadata and current JSON content of a bin by ID or slug.",
    parameters: {
      type: "object",
      required: ["idOrSlug"],
      properties: {
        idOrSlug: { type: "string", description: "Bin UUID or slug" },
      },
    },
    handler: async (args) => {
      const res = await getClient().bins.get(args.idOrSlug);
      if ("modified" in res && res.modified === false) {
        return { modified: false, etag: res.etag };
      }
      return res;
    },
  },

  get_published_bin: {
    description: "Get the production published version of a bin by ID or slug.",
    parameters: {
      type: "object",
      required: ["idOrSlug"],
      properties: {
        idOrSlug: { type: "string", description: "Bin UUID or slug" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.getPublished(args.idOrSlug);
    },
  },

  search_bins: {
    description: "Search bin names, descriptions, and metadata.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search term" },
        limit: { type: "integer", description: "Maximum results (1-50, default 20)" },
      },
    },
    handler: async (args) => {
      return await getClient().search.metadata(args.query, { type: "bin", limit: args.limit });
    },
  },

  list_bin_versions: {
    description: "List stored immutable historical versions of a bin.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.listVersions(args.id);
    },
  },

  get_bin_version: {
    description: "Retrieve a specific immutable historical version of a bin.",
    parameters: {
      type: "object",
      required: ["id", "version"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Historical version number" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.getVersion(args.id, args.version);
    },
  },

  search_json: {
    description: "Search inside JSON keys or scalar values across bins with content search enabled.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search term" },
        mode: { type: "string", enum: ["keys", "all"], description: "keys (keys only) or all (keys and values)" },
      },
    },
    handler: async (args) => {
      return await getClient().search.content(args.query, args.mode);
    },
  },

  update_bin: {
    description: "Full update of a bin's JSON content with CAS precondition check.",
    parameters: {
      type: "object",
      required: ["id", "value", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        value: { description: "New complete JSON value" },
        etag: { type: "string", description: "Expected ETag (for CAS lock)" },
        message: { type: "string", description: "Optional version change note" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.update(args.id, args.value, {
        etag: args.etag,
        message: args.message,
      });
    },
  },

  merge_patch_bin: {
    description: "Incremental modification of a bin using RFC 7396 JSON Merge Patch.",
    parameters: {
      type: "object",
      required: ["id", "patch", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        patch: { type: "object", description: "RFC 7396 merge patch object" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.mergePatch(args.id, args.patch, { etag: args.etag });
    },
  },

  json_patch_bin: {
    description: "Atomic structural modification of a bin using RFC 6902 JSON Patch (add, remove, replace, move, copy, test).",
    parameters: {
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
    handler: async (args) => {
      return await getClient().bins.jsonPatch(args.id, args.operations, { etag: args.etag });
    },
  },

  publish_bin: {
    description: "Publish a bin version to the production release pointer.",
    parameters: {
      type: "object",
      required: ["id", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Optional specific version to publish (defaults to latest)" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.publish(args.id, { version: args.version, etag: args.etag });
    },
  },

  rollback_bin: {
    description: "Rollback production release pointer to a previous version without appending history.",
    parameters: {
      type: "object",
      required: ["id", "version", "etag"],
      properties: {
        id: { type: "string", description: "Bin UUID" },
        version: { type: "integer", description: "Target historical version" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.rollback(args.id, { version: args.version, etag: args.etag });
    },
  },

  clone_bin: {
    description: "Clone a bin snapshot into a new private bin with initial version 1.",
    parameters: {
      type: "object",
      required: ["id", "etag"],
      properties: {
        id: { type: "string", description: "Source bin UUID" },
        etag: { type: "string", description: "Expected ETag" },
      },
    },
    handler: async (args) => {
      return await getClient().bins.clone(args.id, { etag: args.etag });
    },
  },
};

export type JsonRpcMessage = { jsonrpc: "2.0"; id: any; result?: unknown; error?: unknown } | null;

/** JSON-RPC 2.0 request ids are strings, numbers or null — nothing else. */
function isRequestId(id: any): boolean {
  return typeof id === "string" || typeof id === "number" || id === null;
}

function invalidRequest(id: any, detail?: string): NonNullable<JsonRpcMessage> {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: detail ? `Invalid Request: ${detail}` : "Invalid Request" } };
}

/**
 * Handle one JSON-RPC 2.0 message with strict envelope validation: a wrong
 * jsonrpc version or a non-scalar id is an Invalid Request, never executed.
 * Only a structurally VALID message without an id counts as a notification
 * (no response, per the JSON-RPC 2.0 and MCP specifications). Mirrored in
 * src/worker/routes/mcp.ts for the Streamable HTTP transport.
 */
export async function dispatchMessage(msg: any): Promise<JsonRpcMessage> {
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
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }

  if (msg.method === "tools/list") {
    const toolList = Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.parameters,
    }));
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: toolList },
    };
  }

  if (msg.method === "tools/call") {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    const tool = tools[toolName];

    if (!tool) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", tool: toolName }) }],
          isError: true,
        },
      };
    }

    try {
      const output = await tool.handler(toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        },
      };
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(normalizeErrorPayload(err)) }],
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

/** A stdio line or batch can never legitimately exceed these budgets. */
const MAX_LINE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_ITEMS = 100;

/**
 * Standard JSON-RPC 2.0 stdio loop for MCP Server: bounded input, strict
 * envelopes, batch support. Malformed JSON gets a Parse error response
 * instead of being silently dropped (a client would otherwise wait forever).
 */
async function runStdioServer() {
  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    // The remainder without a newline is the pending line: cap it so a client
    // streaming an endless line cannot grow memory without bound.
    if (buffer.length > MAX_LINE_BYTES) {
      sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: line exceeds ${MAX_LINE_BYTES} bytes` } });
      buffer = "";
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (line.length > MAX_LINE_BYTES) {
        sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: line exceeds ${MAX_LINE_BYTES} bytes` } });
        continue;
      }

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        sendResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }

      if (Array.isArray(msg)) {
        if (msg.length === 0) {
          sendResponse(invalidRequest(null, "empty batch"));
          continue;
        }
        if (msg.length > MAX_BATCH_ITEMS) {
          sendResponse(invalidRequest(null, `batch exceeds ${MAX_BATCH_ITEMS} items`));
          continue;
        }
        const responses = (await Promise.all(msg.map((item: any) => dispatchMessage(item)))).filter(Boolean);
        if (responses.length > 0) sendResponse(responses.length === 1 && msg.length === 1 ? responses[0] : responses);
        continue;
      }

      // Notifications produce no response at all.
      const response = await dispatchMessage(msg);
      if (response) sendResponse(response);
    }
  });
}

function sendResponse(obj: any) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (process.argv[1] && process.argv[1].endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  runStdioServer();
}

export { tools, runStdioServer };
