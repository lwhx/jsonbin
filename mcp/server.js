#!/usr/bin/env node
/**
 * Official JSONBin Model Context Protocol (MCP) Server.
 * Exposes JSONBin operations to AI coding agents (Hermes, Claude Desktop, Cursor, Codex).
 * Operates strictly over the standard JSONBin HTTP API via @jsonbin/client.
 */
import { JsonBinClient, JsonBinError } from "../sdk/typescript/dist/index.js";
function getClient() {
    const url = process.env.JSONBIN_URL || "http://localhost:8787";
    const token = process.env.JSONBIN_TOKEN || "";
    return new JsonBinClient({
        baseUrl: url,
        token,
    });
}
const tools = {
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
            },
        },
        handler: async (args) => {
            return await getClient().search.metadata(args.query);
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
/**
 * Standard JSON-RPC 2.0 stdio loop for MCP Server.
 */
async function runStdioServer() {
    let buffer = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", async (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let msg;
            try {
                msg = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const id = msg.id;
            if (msg.method === "initialize") {
                sendResponse({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: "2024-11-05",
                        capabilities: { tools: {} },
                        serverInfo: { name: "jsonbin-mcp", version: "3.2.0" },
                    },
                });
            }
            else if (msg.method === "tools/list") {
                const toolList = Object.entries(tools).map(([name, def]) => ({
                    name,
                    description: def.description,
                    inputSchema: def.parameters,
                }));
                sendResponse({
                    jsonrpc: "2.0",
                    id,
                    result: { tools: toolList },
                });
            }
            else if (msg.method === "tools/call") {
                const toolName = msg.params?.name;
                const toolArgs = msg.params?.arguments || {};
                const tool = tools[toolName];
                if (!tool) {
                    sendResponse({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", tool: toolName }) }],
                            isError: true,
                        },
                    });
                    continue;
                }
                try {
                    const output = await tool.handler(toolArgs);
                    sendResponse({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
                        },
                    });
                }
                catch (err) {
                    const errorMsg = err instanceof JsonBinError
                        ? JSON.stringify({ error: err.name, statusCode: err.statusCode, details: err.data })
                        : JSON.stringify({ error: "operation_failed", message: err.message || "Unknown error" });
                    sendResponse({
                        jsonrpc: "2.0",
                        id,
                        result: {
                            content: [{ type: "text", text: errorMsg }],
                            isError: true,
                        },
                    });
                }
            }
        }
    });
}
function sendResponse(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
}
if (process.argv[1] && process.argv[1].endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
    runStdioServer();
}
export { tools, runStdioServer };
