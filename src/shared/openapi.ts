export function generateOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "JSONBin API",
      version: "3.1.0",
      description: "Cloudflare Workers + R2 + KV 原生架构的生产级企业 JSON 存储与管理服务平台",
    },
    servers: [
      {
        url: "/api/v1",
        description: "当前实例 API v1",
      },
    ],
    components: {
      securitySchemes: {
        CookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "jb_session",
          description: "控制台管理 Session Cookie",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "自动化与外部集成 API Key (jb_live_...)",
        },
      },
    },
    security: [
      { CookieAuth: [] },
      { BearerAuth: [] },
    ],
    paths: {
      "/system/health": {
        get: {
          summary: "系统健康状态检查",
          responses: {
            "200": {
              description: "健康运行中",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
      "/bins": {
        get: {
          summary: "列出数据仓",
          parameters: [
            { name: "tag", in: "query", schema: { type: "string" } },
            { name: "favorite", in: "query", schema: { type: "boolean" } },
            { name: "pinned", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            "200": { description: "成功返回数据仓列表" },
          },
        },
        post: {
          summary: "新建数据仓",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "value"],
                  properties: {
                    name: { type: "string" },
                    slug: { type: "string" },
                    tags: { type: "array", items: { type: "string" } },
                    favorite: { type: "boolean" },
                    pinned: { type: "boolean" },
                    description: { type: "string" },
                    visibility: { type: "string", enum: ["private", "public"] },
                    collectionId: { type: "string" },
                    schemaId: { type: "string" },
                    value: {},
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "创建成功" },
          },
        },
      },
      "/bins/batch": {
        post: {
          summary: "批量数据仓独立 CAS 操作",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["operation", "items"],
                  properties: {
                    operation: {
                      type: "string",
                      enum: [
                        "move_collection",
                        "set_visibility",
                        "add_tags",
                        "remove_tags",
                        "set_favorite",
                        "unset_favorite",
                        "set_pinned",
                        "unset_pinned",
                        "trash",
                      ],
                    },
                    items: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["id", "etag"],
                        properties: {
                          id: { type: "string" },
                          etag: { type: "string" },
                        },
                      },
                    },
                    payload: { type: "object" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "逐项返回操作状态" },
          },
        },
      },
      "/bins/{id}": {
        get: {
          summary: "获取指定数据仓元数据及 JSON 内容",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "返回 Bin 详情与当前内容" },
            "404": { description: "数据仓未找到" },
          },
        },
        put: {
          summary: "全量更新数据仓 JSON 内容",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": { description: "更新成功，生成不可变新版本" },
            "412": { description: "ETag 冲突" },
          },
        },
        patch: {
          summary: "RFC 7396 Merge Patch 增量修改数据仓",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: { "200": { description: "增量合并成功" } },
        },
        delete: {
          summary: "移入回收站（软删除）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "If-Match", in: "header", schema: { type: "string" } },
          ],
          responses: { "200": { description: "成功移入回收站" } },
        },
      },
      "/bins/{id}/clone": {
        post: {
          summary: "快照克隆当前数据仓",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            "201": { description: "克隆成功" },
            "412": { description: "ETag 冲突" },
            "428": { description: "缺少 If-Match 前置条件" },
          },
        },
      },
      "/bins/{id}/save-as-template": {
        post: {
          summary: "将当前数据仓当前版本另存为模板",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "If-Match", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            "201": { description: "模板创建成功" },
          },
        },
      },
      "/b/{slug}": {
        get: {
          summary: "通过自定义 Slug 别名快速访问 Bin",
          parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "成功返回" },
            "404": { description: "别名未找到" },
          },
        },
      },
      "/templates": {
        get: {
          summary: "列出所有模板",
          responses: { "200": { description: "返回模板列表" } },
        },
        post: {
          summary: "新建模板",
          responses: { "201": { description: "创建成功" } },
        },
      },
      "/templates/{id}/create-bin": {
        post: {
          summary: "基于模板新建数据仓",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "201": { description: "实例化成功" } },
        },
      },
      "/collections": {
        get: { summary: "列出集合", responses: { "200": { description: "成功" } } },
        post: { summary: "新建集合", responses: { "201": { description: "成功" } } },
      },
      "/schemas": {
        get: { summary: "列出数据模型 (JSON Schema)", responses: { "200": { description: "成功" } } },
        post: { summary: "新建数据模型", responses: { "201": { description: "成功" } } },
      },
      "/keys": {
        get: { summary: "列出 API 密钥", responses: { "200": { description: "成功" } } },
        post: { summary: "创建 API 密钥", responses: { "201": { description: "成功" } } },
      },
      "/trash/bins": {
        get: { summary: "列出回收站已删除数据仓", responses: { "200": { description: "成功" } } },
      },
      "/search": {
        get: {
          summary: "全站多资源快速搜索",
          parameters: [{ name: "q", in: "query", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "返回搜索结果" } },
        },
      },
      "/activity": {
        get: { summary: "操作审计日志记录", responses: { "200": { description: "成功" } } },
      },
    },
  };
}
