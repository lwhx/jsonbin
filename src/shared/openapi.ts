import { version } from "../../package.json";

/**
 * Security model (kept in sync with the runtime middleware):
 * - CookieAuth only  -> Session-only management endpoints (requireSession/managementSession)
 * - Cookie or Bearer -> resource routes (requireAccess), Bearer scopes noted per operation
 * - security: []     -> anonymous-capable endpoints (public Bin reads, health, auth flows)
 */
const SESSION_ONLY = [{ CookieAuth: [] }];
const SESSION_OR_BEARER = [{ CookieAuth: [] }, { BearerAuth: [] }];
const PUBLIC: Record<string, never>[] = [];

const etagParameter = { name: "If-Match", in: "header", required: true, schema: { type: "string" }, description: "当前快照 ETag（条件写入前置）" };
const optionalEtagParameter = { name: "If-Match", in: "header", required: false, schema: { type: "string" } };
const idParameter = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const slugParameter = { name: "slug", in: "path", required: true, schema: { type: "string" } };

type Security = typeof SESSION_ONLY | typeof SESSION_OR_BEARER | typeof PUBLIC;

function op(summary: string, options: {
  security?: Security;
  scopes?: string;
  description?: string;
  parameters?: Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  const { security = SESSION_OR_BEARER, scopes, description, parameters, requestBody, responses } = options;
  const operation: Record<string, unknown> = {
    summary,
    security,
    responses: responses ?? { "200": { description: "成功" } },
  };
  const notes: string[] = [];
  if (description) notes.push(description);
  if (scopes) notes.push(`Bearer API Key 需要 scope: ${scopes}`);
  if (notes.length) operation.description = notes.join("。");
  if (parameters?.length) operation.parameters = parameters;
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { "application/json": { schema } },
});

const ok = (description = "成功") => ({ "200": { description } });
const created = (description = "创建成功") => ({ "201": { description } });
const notFound = { "404": { description: "未找到" } };

export function generateOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "JSONBin API",
      version,
      description: "Cloudflare Workers + R2 + KV 原生架构的生产级企业 JSON 存储与管理服务平台。所有带 ETag 的 GET 端点支持 If-None-Match 条件读取（未变化返回空 304）。Bearer 请求按密钥限流（默认 120 次/分钟，可配置/关闭），匿名公开读取按 IP 限流 240 次/分钟，超限返回 429 rate_limit_exceeded + Retry-After。",
    },
    servers: [
      {
        url: "/api/v1",
        description: "当前实例 API v1",
      },
    ],
    tags: [
      { name: "system" }, { name: "search" }, { name: "activity" }, { name: "auth" },
      { name: "keys" }, { name: "bins" }, { name: "collections" }, { name: "schemas" },
      { name: "trash" }, { name: "templates" },
    ],
    components: {
      securitySchemes: {
        CookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "jb_session",
          description: "控制台管理 Session Cookie（Session-only 端点不接受 Bearer）",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "自动化与外部集成 API Key (jb_live_...)，权限由 scopes 与 resourceAccess 决定",
        },
      },
    },
    security: SESSION_OR_BEARER,
    paths: {
      "/": {
        get: op("API v1 元信息", { security: PUBLIC, responses: ok("服务名与版本") }),
      },
      "/openapi.json": {
        get: op("获取 OpenAPI 规范", { security: PUBLIC, responses: ok("OpenAPI 3.1 文档") }),
      },
      "/system/health": {
        get: op("系统健康状态检查", { security: PUBLIC, responses: ok("健康运行中，含版本与存储绑定状态") }),
      },
      "/system/settings": {
        get: op("读取系统默认设置", { security: SESSION_ONLY, responses: { ...ok(), "401": { description: "未登录" } } }),
        patch: op("修改系统默认设置", {
          security: SESSION_ONLY,
          parameters: [etagParameter],
          requestBody: jsonBody({ type: "object", properties: { defaultVisibility: { type: "string", enum: ["private", "public"] }, defaultTtlSeconds: { type: "integer", nullable: true } } }),
          responses: { ...ok(), "428": { description: "缺少 If-Match" } },
        }),
      },
      "/system/info": {
        get: op("系统信息与统计", { security: SESSION_ONLY }),
      },
      "/system/export": {
        get: op("导出备份或单仓数据", {
          security: SESSION_ONLY,
          parameters: [
            { name: "scope", in: "query", required: true, schema: { type: "string", enum: ["all", "config", "bin"] } },
            { name: "format", in: "query", required: true, schema: { type: "string", enum: ["backup", "value"] } },
            { name: "id", in: "query", schema: { type: "string", format: "uuid" }, description: "scope=bin 时必填" },
          ],
          responses: ok("attachment 备份文件（v2 含 templates）"),
        }),
      },
      "/system/restore": {
        post: op("恢复单个备份资源（幂等）", {
          security: SESSION_ONLY,
          description: "collection/schema/bin/template/purged 单资源恢复；依赖以 fingerprint 校验",
          requestBody: jsonBody({ type: "object" }),
          responses: { ...ok("created/unchanged/skipped"), "409": { description: "restore_conflict" } },
        }),
      },
      "/system/import": {
        post: op("批量导入 JSON 为数据仓", {
          security: SESSION_ONLY,
          requestBody: jsonBody({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: {} } } } } }),
          responses: created(),
        }),
      },
      "/search": {
        get: op("全站多资源快速搜索", {
          scopes: "bin:read + collection:read + schema:read（按 type 组合要求）",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", maxLength: 160 } },
            { name: "type", in: "query", schema: { type: "string", enum: ["all", "bin", "collection", "schema"] } },
            { name: "limit", in: "query", schema: { type: "integer", maximum: 50 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { ...ok(), "400": { description: "invalid_query" } },
        }),
      },
      "/search/index": {
        get: op("查看搜索索引状态", { security: SESSION_ONLY }),
      },
      "/search/rebuild": {
        post: op("重建搜索索引", { security: SESSION_ONLY, responses: { ...ok(), "409": { description: "search_changed" }, "503": { description: "KV 不可用" } } }),
      },
      "/search/content": {
        get: op("Bin JSON 内容深度搜索", {
          security: SESSION_ONLY,
          description: "仅扫描 contentSearchMode 非 off 的活跃 Bin；路径遵循 RFC 6901 JSON Pointer 转义",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "mode", in: "query", schema: { type: "string", enum: ["keys", "all"] } },
          ],
          responses: { ...ok(), "503": { description: "content_search_limit_exceeded" } },
        }),
      },
      "/activity": {
        get: op("操作审计日志", {
          security: SESSION_ONLY,
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "action", in: "query", schema: { type: "string" } },
            { name: "resourceType", in: "query", schema: { type: "string" } },
          ],
        }),
      },
      "/analytics/overview": {
        get: op("获取 API 请求性能与调用分析概览", {
          security: SESSION_ONLY,
          parameters: [
            { name: "range", in: "query", schema: { type: "string", enum: ["1h", "24h", "7d", "30d"] } },
          ],
        }),
      },
      "/mcp": {
        post: op("Remote MCP Streamable HTTP POST 端点", {
          security: SESSION_OR_BEARER,
        }),
        get: op("Remote MCP 无状态服务器不提供服务端推送流，固定 405", {
          security: SESSION_OR_BEARER,
          responses: { "405": { description: "method_not_allowed，仅支持 POST" } },
        }),
        delete: op("Remote MCP 无状态服务器没有会话可终止，固定 405", {
          security: SESSION_OR_BEARER,
          responses: { "405": { description: "method_not_allowed，仅支持 POST" } },
        }),
      },
      "/mcp/sse": {
        get: op("Remote MCP SSE 长连接端点", {
          security: SESSION_OR_BEARER,
        }),
      },
      "/mcp/message": {
        post: op("Remote MCP SSE 消息下发回执端点", {
          security: SESSION_OR_BEARER,
        }),
      },
      "/auth/config": {
        get: op("认证方式配置", { security: PUBLIC }),
      },
      "/auth/login": {
        post: op("用户名密码登录", {
          security: PUBLIC,
          requestBody: jsonBody({ type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } } }),
          responses: { ...ok("设置 Session Cookie"), "401": { description: "凭据错误" } },
        }),
      },
      "/auth/logout": {
        post: op("退出登录", { security: PUBLIC, description: "写操作校验 Origin" }),
      },
      "/auth/me": {
        get: op("当前会话用户", { security: SESSION_ONLY, responses: { ...ok(), "401": { description: "未登录" } } }),
      },
      "/auth/github": {
        get: op("发起 GitHub OAuth 登录", { security: PUBLIC, responses: { "302": { description: "重定向到 GitHub" } } }),
      },
      "/auth/github/callback": {
        get: op("GitHub OAuth 回调", {
          security: PUBLIC,
          parameters: [
            { name: "code", in: "query", schema: { type: "string" } },
            { name: "state", in: "query", schema: { type: "string" } },
          ],
          responses: { "302": { description: "重定向回控制台" } },
        }),
      },
      "/keys": {
        get: op("列出 API 密钥（不含机密）", { security: SESSION_ONLY }),
        post: op("创建 API 密钥（仅创建时返回明文 token）", {
          security: SESSION_ONLY,
          requestBody: jsonBody({
            type: "object", required: ["name", "scopes"],
            properties: {
              name: { type: "string" },
              scopes: { type: "array", items: { type: "string", enum: ["bin:read", "bin:create", "bin:update", "bin:delete", "collection:read", "collection:write", "schema:read", "schema:write", "history:read"] } },
              expiresAt: { type: "string", format: "date-time", nullable: true },
              resourceAccess: { type: "object", description: "{mode:'all'} 或 {mode:'restricted',binIds,collectionIds}" },
              rateLimitPerMinute: { type: "integer", minimum: 1, maximum: 10000, nullable: true, description: "Bearer 每分钟请求上限；null 不限，缺省 120" },
            },
          }),
          responses: created(),
        }),
      },
      "/keys/{id}/token": {
        get: op("揭示可恢复密钥明文", { security: SESSION_ONLY, parameters: [idParameter], responses: { ...ok(), ...notFound, "409": { description: "不可揭示" } } }),
      },
      "/keys/{id}/purge": {
        delete: op("永久删除密钥记录", { security: SESSION_ONLY, parameters: [idParameter], responses: ok() }),
      },
      "/keys/{id}": {
        delete: op("撤销密钥（保留记录）", { security: SESSION_ONLY, parameters: [idParameter], responses: ok() }),
        patch: op("更新密钥名称、权限、资源范围与过期时间（撤销后不可改）", {
          security: SESSION_ONLY,
          description: "修改立即对后续请求生效；撤销密钥返回 409 key_revoked",
          parameters: [idParameter],
          requestBody: jsonBody({
            type: "object", description: "至少一个字段；expiresAt 传 null 清除过期",
            properties: {
              name: { type: "string" },
              scopes: { type: "array", items: { type: "string", enum: ["bin:read", "bin:create", "bin:update", "bin:delete", "collection:read", "collection:write", "schema:read", "schema:write", "history:read"] } },
              expiresAt: { type: "string", format: "date-time", nullable: true },
              resourceAccess: { type: "object", description: "{mode:'all'} 或 {mode:'restricted',binIds,collectionIds}" },
              rateLimitPerMinute: { type: "integer", minimum: 1, maximum: 10000, nullable: true, description: "null 不限" },
            },
          }),
          responses: { ...ok(), "404": { description: "未找到" }, "409": { description: "key_revoked / key_update_conflict" }, "422": { description: "校验失败" }, "429": { description: "rate_limit_exceeded（密钥自身限流）" } },
        }),
      },
      "/bins": {
        get: op("列出数据仓", {
          scopes: "bin:read",
          parameters: [
            { name: "tag", in: "query", schema: { type: "string" } },
            { name: "favorite", in: "query", schema: { type: "boolean" } },
            { name: "pinned", in: "query", schema: { type: "boolean" } },
          ],
          responses: { ...ok("数据仓列表"), "429": { description: "rate_limit_exceeded" } },
        }),
        post: op("新建数据仓", {
          scopes: "bin:create",
          requestBody: jsonBody({
            type: "object", required: ["name", "value"],
            properties: {
              name: { type: "string" }, slug: { type: "string" }, tags: { type: "array", items: { type: "string" } },
              favorite: { type: "boolean" }, pinned: { type: "boolean" }, description: { type: "string" },
              visibility: { type: "string", enum: ["private", "public"] },
              collectionId: { type: "string", format: "uuid" }, schemaId: { type: "string", format: "uuid" },
              schemaRevision: { type: "integer", description: "显式固定 Schema revision" },
              schemaLocked: { type: "boolean" }, expiresAt: { type: "string", format: "date-time", nullable: true }, value: {},
            },
          }),
          responses: created(),
        }),
      },
      "/bins/batch": {
        post: op("批量数据仓独立 CAS 操作", {
          scopes: "bin:update（trash 为 bin:delete）",
          requestBody: jsonBody({
            type: "object", required: ["operation", "items"],
            properties: {
              operation: { type: "string", enum: ["move_collection", "set_visibility", "add_tags", "remove_tags", "set_favorite", "unset_favorite", "set_pinned", "unset_pinned", "trash"] },
              items: { type: "array", items: { type: "object", required: ["id", "etag"], properties: { id: { type: "string" }, etag: { type: "string" } } } },
              payload: { type: "object" },
            },
          }),
          responses: ok("逐项返回操作状态"),
        }),
      },
      "/bins/{id}": {
        get: op("获取指定数据仓元数据及 JSON 内容", {
          security: PUBLIC,
          description: "public Bin 可匿名读取；private Bin 需 Session 或 Bearer（bin:read）且受 resourceAccess 约束",
          parameters: [idParameter],
          responses: { ...ok(), ...notFound },
        }),
        put: op("全量更新数据仓 JSON 内容", {
          scopes: "bin:update",
          parameters: [idParameter, etagParameter],
          requestBody: jsonBody({ type: "object", required: ["value"], properties: { value: {} } }),
          responses: { ...ok("生成不可变新版本"), "412": { description: "ETag 冲突" }, "423": { description: "已锁定" } },
        }),
        patch: op("RFC 7396 Merge Patch 或 RFC 6902 JSON Patch 修改数据仓", {
          scopes: "bin:update",
          parameters: [idParameter, etagParameter],
          description: "Content-Type 为 application/json-patch+json 时按 RFC 6902 执行（add, remove, replace, move, copy, test）；为 application/merge-patch+json 或 application/json 时按 RFC 7396 合并",
          requestBody: {
            required: true,
            content: {
              "application/merge-patch+json": { schema: { type: "object", description: "RFC 7396 增量合并对象" } },
              "application/json-patch+json": {
                schema: {
                  type: "array",
                  description: "RFC 6902 操作列表",
                  items: {
                    type: "object",
                    required: ["op", "path"],
                    properties: {
                      op: { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] },
                      path: { type: "string", description: "RFC 6901 JSON Pointer 路径" },
                      from: { type: "string", description: "源路径（move / copy 操作必需）" },
                      value: { description: "操作值（add / replace / test 必需）" },
                    },
                  },
                },
              },
            },
          },
          responses: { ...ok(), "409": { description: "test 操作不匹配或数据冲突" }, "412": { description: "ETag 冲突" }, "422": { description: "Patch 校验失败" }, "423": { description: "数据仓已锁定" } },
        }),
        delete: op("移入回收站（软删除）", {
          scopes: "bin:delete",
          parameters: [idParameter, optionalEtagParameter],
          responses: ok(),
        }),
      },
      "/bins/{id}/value": {
        get: op("读取当前 JSON 值（可加 /value/{path} 子路径）", {
          security: PUBLIC,
          description: "public Bin 可匿名读取；private 需要凭据",
          parameters: [idParameter],
        }),
        put: op("按 JSON Pointer 路径写入值", {
          scopes: "bin:update",
          parameters: [idParameter, etagParameter],
          responses: { ...ok(), "412": { description: "ETag 冲突" } },
        }),
      },
      "/bins/{id}/value/{path}": {
        get: op("按 JSON Pointer 读取当前值子路径", { security: PUBLIC, parameters: [idParameter, { name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok(), ...notFound } }),
        put: op("按 JSON Pointer 写入子路径值", {
          scopes: "bin:update",
          parameters: [idParameter, etagParameter, { name: "path", in: "path", required: true, schema: { type: "string" } }],
          responses: { ...ok(), "412": { description: "ETag 冲突" } },
        }),
      },
      "/bins/{id}/meta": {
        patch: op("修改数据仓元数据（统一强制 If-Match）", {
          scopes: "bin:update",
          description: "所有字段（slug/tags/favorite/pinned/name/description/visibility/collectionId/schemaId/schemaLocked/contentSearchMode/locked/expiresAt）均要求 If-Match",
          parameters: [idParameter, etagParameter],
          requestBody: jsonBody({ type: "object", description: "至少一个可变更字段" }),
          responses: { ...ok(), "412": { description: "ETag 冲突" }, "428": { description: "缺少 If-Match" } },
        }),
      },
      "/bins/{id}/versions": {
        get: op("列出历史版本", { scopes: "history:read", parameters: [idParameter] }),
      },
      "/bins/{id}/versions/{version}": {
        get: op("读取不可变历史版本", { scopes: "history:read", parameters: [idParameter, { name: "version", in: "path", required: true, schema: { type: "integer" } }] }),
      },
      "/bins/{id}/versions/{version}/restore": {
        post: op("将历史版本恢复为新版本", {
          scopes: "bin:update history:read",
          parameters: [idParameter, { name: "version", in: "path", required: true, schema: { type: "integer" } }, etagParameter],
          responses: { ...ok(), "412": { description: "ETag 冲突" } },
        }),
      },
      "/bins/{id}/clone": {
        post: op("快照克隆当前数据仓", {
          scopes: "bin:read bin:create",
          description: "Restricted Key 需目标 Collection 在允许列表内，403 时不产生任何写入",
          parameters: [idParameter, etagParameter],
          responses: { ...created(), "403": { description: "resource_forbidden" }, "412": { description: "ETag 冲突" }, "428": { description: "缺少 If-Match" } },
        }),
      },
      "/bins/{id}/save-as-template": {
        post: op("将当前版本另存为模板（Session-only）", {
          security: SESSION_ONLY,
          parameters: [idParameter, etagParameter],
          responses: created(),
        }),
      },
      "/bins/{id}/publish": {
        post: op("发布指定版本为生产版本", {
          scopes: "bin:update",
          description: "最终写入使用 R2 CAS；并发冲突返回 412",
          parameters: [idParameter, etagParameter],
          requestBody: jsonBody({ type: "object", properties: { version: { type: "integer" } } }),
          responses: { ...ok(), "412": { description: "ETag 冲突" } },
        }),
      },
      "/bins/{id}/rollback": {
        post: op("回滚生产版本到指定历史版本", {
          scopes: "bin:update",
          parameters: [idParameter, etagParameter],
          requestBody: jsonBody({ type: "object", required: ["version"], properties: { version: { type: "integer" } } }),
          responses: { ...ok(), "412": { description: "ETag 冲突" } },
        }),
      },
      "/bins/{id}/published": {
        get: op("读取已发布版本", {
          security: PUBLIC,
          description: "public Bin 可匿名读取；未发布返回 404",
          parameters: [idParameter],
          responses: { ...ok(), ...notFound },
        }),
      },
      "/bins/{id}/published/value": {
        get: op("读取已发布版本 JSON 值（可加子路径）", { security: PUBLIC, parameters: [idParameter] }),
      },
      "/bins/{id}/published/value/{path}": {
        get: op("按 JSON Pointer 读取已发布版本的子值", { security: PUBLIC, parameters: [idParameter, { name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok(), ...notFound } }),
      },
      "/b/{slug}": {
        get: op("通过自定义 Slug 别名快速访问 Bin", {
          security: PUBLIC,
          description: "public Bin 可匿名读取",
          parameters: [slugParameter],
          responses: { ...ok(), ...notFound },
        }),
      },
      "/b/{slug}/published": {
        get: op("通过 Slug 读取已发布版本", { security: PUBLIC, parameters: [slugParameter], responses: { ...ok(), ...notFound } }),
      },
      "/b/{slug}/value": {
        get: op("通过 Slug 读取 JSON 值（可加子路径）", { security: PUBLIC, parameters: [slugParameter] }),
      },
      "/b/{slug}/value/{path}": {
        get: op("按 JSON Pointer 通过 Slug 读取子值", { security: PUBLIC, parameters: [slugParameter, { name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok(), ...notFound } }),
      },
      "/b/{slug}/published/value": {
        get: op("通过 Slug 读取已发布版本的 JSON 值（可加子路径）", { security: PUBLIC, parameters: [slugParameter] }),
      },
      "/b/{slug}/published/value/{path}": {
        get: op("按 JSON Pointer 通过 Slug 读取已发布版本的子值", { security: PUBLIC, parameters: [slugParameter, { name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok(), ...notFound } }),
      },
      "/collections": {
        get: op("列出集合", { scopes: "collection:read" }),
        post: op("新建集合", { scopes: "collection:write", responses: created() }),
      },
      "/collections/{id}": {
        get: op("读取集合", { scopes: "collection:read", parameters: [idParameter], responses: { ...ok(), ...notFound } }),
        patch: op("修改集合", { scopes: "collection:write", parameters: [idParameter, etagParameter] }),
        delete: op("删除集合（成员自动脱离）", { scopes: "collection:write", parameters: [idParameter, etagParameter] }),
      },
      "/collections/{id}/bins": {
        get: op("列出集合成员", { scopes: "collection:read bin:read", parameters: [idParameter] }),
      },
      "/schemas": {
        get: op("列出数据模型", { scopes: "schema:read" }),
        post: op("新建数据模型", {
          scopes: "schema:write",
          requestBody: jsonBody({ type: "object", required: ["name", "schema"], properties: { name: { type: "string" }, description: { type: "string" }, schema: {} } }),
          responses: created(),
        }),
      },
      "/schemas/{id}": {
        get: op("读取数据模型（当前 revision）", { scopes: "schema:read", parameters: [idParameter], responses: { ...ok(), ...notFound } }),
        put: op("更新数据模型（追加不可变 revision）", { scopes: "schema:write", parameters: [idParameter, etagParameter], requestBody: jsonBody({ type: "object" }) }),
        delete: op("归档数据模型（既有绑定继续有效）", { scopes: "schema:write", parameters: [idParameter, etagParameter] }),
      },
      "/schemas/{id}/validate": {
        post: op("校验 JSON 样例是否符合模型", { scopes: "schema:read", parameters: [idParameter], requestBody: jsonBody({ type: "object", properties: { value: {} } }) }),
      },
      "/trash/bins": {
        get: op("列出回收站", { scopes: "bin:read" }),
      },
      "/trash/bins/purge": {
        post: op("批量永久删除（按批准的 ETag 快照）", {
          scopes: "bin:delete",
          requestBody: jsonBody({ type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["id", "etag"], properties: { id: { type: "string" }, etag: { type: "string" } } } } } }),
          responses: ok("逐项状态"),
        }),
      },
      "/trash/bins/{id}/restore": {
        post: op("从回收站恢复数据仓", {
          scopes: "bin:update history:read",
          description: "恢复强制 visibility=private、清除 published 指针并安全重建 slug 别名",
          parameters: [idParameter, etagParameter],
          responses: { ...ok(), "409": { description: "bin_purging/version_missing" } },
        }),
      },
      "/trash/bins/{id}": {
        delete: op("永久删除回收站数据仓", { scopes: "bin:delete", parameters: [idParameter, etagParameter] }),
      },
      "/templates": {
        get: op("列出所有模板", { security: SESSION_ONLY }),
        post: op("新建模板", {
          security: SESSION_ONLY,
          requestBody: jsonBody({
            type: "object", required: ["name", "value"],
            properties: { name: { type: "string" }, description: { type: "string" }, tags: { type: "array", items: { type: "string" } }, value: {}, schemaId: { type: "string", format: "uuid", nullable: true }, schemaRevision: { type: "integer", nullable: true } },
          }),
          responses: created(),
        }),
      },
      "/templates/{id}": {
        get: op("读取模板", { security: SESSION_ONLY, parameters: [idParameter], responses: { ...ok(), ...notFound } }),
        patch: op("更新模板（产生不可变新版本）", { security: SESSION_ONLY, parameters: [idParameter, etagParameter], responses: { ...ok(), "412": { description: "ETag 冲突" } } }),
        delete: op("删除模板（CAS tombstone 后清理）", { security: SESSION_ONLY, parameters: [idParameter, etagParameter] }),
      },
      "/webhooks": {
        get: op("列出 Webhook 订阅", { security: SESSION_ONLY, responses: ok("含可选事件模式与动作清单") }),
        post: op("创建 Webhook", {
          security: SESSION_ONLY,
          description: "资源生命周期事件回调；投递带 HMAC 签名，失败由 Cron 按退避重试",
          requestBody: jsonBody({
            type: "object", required: ["name", "url", "secret", "events"],
            properties: {
              name: { type: "string" },
              url: { type: "string", format: "uri", description: "http(s) 接收端地址" },
              secret: { type: "string", minLength: 16, description: "用于验证 X-JSONBin-Signature" },
              events: { type: "array", items: { type: "string" }, description: "组通配（bin.*）或精确动作（bin.updated）" },
              active: { type: "boolean" },
            },
          }),
          responses: created(),
        }),
      },
      "/webhooks/{id}": {
        get: op("读取 Webhook", { security: SESSION_ONLY, parameters: [idParameter], responses: { ...ok(), ...notFound } }),
        patch: op("更新 Webhook", { security: SESSION_ONLY, parameters: [idParameter, etagParameter], responses: { ...ok(), "412": { description: "ETag 冲突" }, "428": { description: "缺少 If-Match" } } }),
        delete: op("删除 Webhook 及其投递记录", { security: SESSION_ONLY, parameters: [idParameter, etagParameter] }),
      },
      "/webhooks/{id}/deliveries": {
        get: op("最近投递记录", { security: SESSION_ONLY, parameters: [idParameter], responses: ok("status/attempts/lastError") }),
      },
      "/webhooks/{id}/test": {
        post: op("发送测试投递（不要求 active）", { security: SESSION_ONLY, parameters: [idParameter], responses: ok("返回最新投递状态") }),
      },
      "/templates/{id}/create-bin": {
        post: op("基于模板新建数据仓", {
          security: SESSION_ONLY,
          description: "绑定模板保存的 schemaRevision",
          parameters: [idParameter],
          responses: created(),
        }),
      },
    },
  };
}
