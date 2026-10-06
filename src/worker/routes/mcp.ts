import { Hono } from "hono";
import type { Context } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const MCP_TOOLS = [
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

let rootApp: any = null;

async function getRootApp() {
  if (!rootApp) {
    const mod = await import("../index");
    rootApp = mod.app;
  }
  return rootApp;
}

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

  const appInstance = await getRootApp();
  let executionCtx: any;
  try {
    executionCtx = c.executionCtx;
  } catch {
    executionCtx = undefined;
  }
  const res = await appInstance.fetch(new Request(targetUrl, { ...options, headers }), c.env, executionCtx);

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

/**
 * Execute a specific tool on behalf of the caller.
 */
async function executeTool(c: Context<{ Bindings: Env }>, name: string, args: any): Promise<any> {
  switch (name) {
    case "list_bins": {
      const q = new URLSearchParams();
      if (args.tag) q.set("tag", args.tag);
      if (args.favorite !== undefined) q.set("favorite", String(args.favorite));
      if (args.pinned !== undefined) q.set("pinned", String(args.pinned));
      const qs = q.toString() ? `?${q.toString()}` : "";
      const { status, data } = await internalFetch(c, `/bins${qs}`);
      if (status >= 400) throw new Error(JSON.stringify(data));
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
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.idOrSlug);
      const path = isUuid ? `/bins/${args.idOrSlug}` : `/b/${args.idOrSlug}`;
      const { status, data, headers } = await internalFetch(c, path);
      if (status >= 400) throw new Error(JSON.stringify(data));
      if (data && typeof data === "object" && !data.etag) {
        data.etag = headers.get("ETag") || "";
      }
      return data;
    }
    case "get_published_bin": {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.idOrSlug);
      const path = isUuid ? `/bins/${args.idOrSlug}/published` : `/b/${args.idOrSlug}/published`;
      const { status, data } = await internalFetch(c, path);
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    case "search_bins": {
      const limit = args.limit || 20;
      const { status, data } = await internalFetch(c, `/search?q=${encodeURIComponent(args.query)}&type=bin&limit=${limit}`);
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    case "search_json": {
      const qs = args.mode ? `&mode=${encodeURIComponent(args.mode)}` : "";
      const { status, data } = await internalFetch(c, `/search/content?q=${encodeURIComponent(args.query)}${qs}`);
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    case "list_bin_versions": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/versions`);
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    case "get_bin_version": {
      const { status, data, headers } = await internalFetch(c, `/bins/${args.id}/versions/${args.version}`);
      if (status >= 400) throw new Error(JSON.stringify(data));
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
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
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
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
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
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
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
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
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
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    case "clone_bin": {
      const { status, data } = await internalFetch(c, `/bins/${args.id}/clone`, {
        method: "POST",
        headers: { "If-Match": args.etag },
      });
      if (status >= 400) throw new Error(JSON.stringify(data));
      return data;
    }
    default:
      throw new Error(`unknown_tool: ${name}`);
  }
}

/**
 * Handle JSON-RPC 2.0 messages.
 */
async function handleJsonRpc(c: Context<{ Bindings: Env }>, msg: any): Promise<any> {
  const id = msg?.id ?? null;

  if (msg?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "jsonbin-remote-mcp", version: "3.2.0" },
      },
    };
  }

  if (msg?.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: MCP_TOOLS },
    };
  }

  if (msg?.method === "tools/call") {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
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
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: err.message || "Operation failed" }],
          isError: true,
        },
      };
    }
  }

  if (msg?.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

// 1. Direct Streamable HTTP POST: POST /api/v1/mcp
app.post("/", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: Bearer token required" } }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((item) => handleJsonRpc(c, item)));
    return c.json(responses);
  }

  const response = await handleJsonRpc(c, body);
  return c.json(response);
});

// 2. Standard MCP SSE Endpoint: GET /api/v1/mcp/sse
app.get("/sse", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth) {
    return c.text("Unauthorized: Bearer token required", 401);
  }

  const sessionId = crypto.randomUUID();
  const endpointUrl = `/api/v1/mcp/message?sessionId=${sessionId}`;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointUrl}\n\n`));
      // Heartbeat comment
      controller.enqueue(encoder.encode(`: ping\n\n`));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
});

// 3. MCP SSE Postback: POST /api/v1/mcp/message
app.post("/message", async (c) => {
  const auth = c.req.header("Authorization");
  if (!auth) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: Bearer token required" } }, 401);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, 400);
  }

  const response = await handleJsonRpc(c, body);
  return c.json(response);
});

export default app;
