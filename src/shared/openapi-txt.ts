/**
 * Plain-text, AI-readable API guide generated from the public OpenAPI contract.
 *
 * Keep the source of truth in generateOpenApiSpec(): this file must not carry
 * an independently maintained endpoint list or access-control matrix.
 * No secrets, cookies, environment variables or user data are consulted.
 */
type ObjectValue = Record<string, unknown>;

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const METHOD_ORDER = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

function asObject(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue : {};
}
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function siteOrigin(input: string): string {
  try {
    const url = new URL(input);
    if ((url.protocol === "https:" || url.protocol === "http:") &&
        !url.username && !url.password && url.origin.length <= 256) {
      return url.origin;
    }
  } catch { /* A neutral placeholder is safer than an untrusted host. */ }
  return "https://YOUR_JSONBIN_HOST";
}

function authLabel(security: unknown): string {
  if (!Array.isArray(security)) return "根据上方认证规则确认";
  if (security.length === 0) return "公开接口（数据仓是否允许匿名读取仍取决于可见性）";
  const names = new Set<string>();
  for (const item of security) {
    for (const key of Object.keys(asObject(item))) names.add(key);
  }
  const session = names.has("CookieAuth");
  const bearer = names.has("BearerAuth");
  if (session && bearer) return "管理员 Session Cookie 或 Bearer API Key（需授权 Scope / 资源范围）";
  if (session) return "仅管理员 Session Cookie；不接受 Bearer API Key";
  if (bearer) return "Bearer API Key（需授权 Scope / 资源范围）";
  return "根据接口的 OpenAPI security 定义";
}
function authMode(security: unknown): "public" | "session" | "bearer" | "either" {
  if (!Array.isArray(security) || security.length === 0) return "public";
  const names = new Set<string>();
  for (const entry of security) for (const key of Object.keys(asObject(entry))) names.add(key);
  const session = names.has("CookieAuth"), bearer = names.has("BearerAuth");
  if (session && bearer) return "either";
  return session ? "session" : bearer ? "bearer" : "public";
}

function paramLabel(raw: unknown): string {
  const param = asObject(raw);
  const schema = asObject(param.schema);
  const flags = [
    param.required === true ? "必填" : "选填",
    asString(schema.type, asString(schema.format, "string")),
    ...(Array.isArray(schema.enum) ? ["取值: " + schema.enum.map(String).join(" | ")] : []),
  ];
  return "  - " + asString(param.name, "?") + " [" + asString(param.in, "query") + "] (" +
    flags.join("; ") + ")" + (param.description ? "：" + String(param.description) : "");
}

function bodyDetails(raw: unknown): string[] {
  const data = asObject(raw);
  const content = asObject(data.content);
  const entries = Object.entries(content);
  if (entries.length === 0) return ["请求体：无"];
  const lines = ["请求体：" + (data.required === true ? "必填" : "选填")];
  for (const [type, definition] of entries) {
    const schema = asObject(asObject(definition).schema);
    lines.push("  Content-Type: " + type);
    lines.push("  Schema（结构说明，不是可以直接提交的实例值）：");
    for (const line of JSON.stringify(schema, null, 2).split("\n")) lines.push("    " + line);
  }
  return lines;
}

function responseDetails(raw: unknown): string[] {
  const entries = Object.entries(asObject(raw));
  if (!entries.length) return ["返回状态：以 HTTP 响应为准"];
  const lines = ["返回状态："];
  for (const [code, response] of entries) {
    lines.push("  - " + code + "：" + asString(asObject(response).description, "参照接口响应"));
  }
  return lines;
}

function operationCurl(method: string, path: string, operation: ObjectValue, security: unknown): string {
  const params = Array.isArray(operation.parameters) ? operation.parameters : [];
  const pathWithFields = path.replace(/\{([^}]+)\}/g, (_match, name: string) => "<" + name + ">");
  const query = params.map(asObject).filter(p => p.in === "query" && p.required === true)
    .map(p => encodeURIComponent(asString(p.name)) + "=<" + asString(p.name) + ">");
  const url = '"$JSONBIN_BASE_URL/api/v1' + pathWithFields +
    (query.length ? "?" + query.join("&") : "") + '"';
  const pieces = ["curl -i", "-X " + method.toUpperCase(), url];
  const mode = authMode(security);
  if (mode === "session") pieces.push("-b cookies.txt");
  else if (mode === "bearer" || mode === "either") pieces.push('-H "Authorization: Bearer $JSONBIN_TOKEN"');
  const parameters = params.map(asObject);
  if (parameters.some(p => p.in === "header" && p.name === "If-Match")) {
    pieces.push('-H "If-Match: <CURRENT_ETAG>"');
  }
  if (Object.keys(asObject(asObject(operation.requestBody).content)).length > 0) {
    pieces.push("-H 'Content-Type: application/json'");
    pieces.push("--data-raw '<按上方 Schema 构造 JSON>'");
  }
  return pieces.join(" ");
}

/**
 * Pure function so API and tests use the same contract.
 * Output is static documentation, NOT a dump of user records or credentials.
 */
export function renderOpenApiTxt(spec: ObjectValue, requestOrigin: string): string {
  const site = siteOrigin(requestOrigin);
  const info = asObject(spec.info);
  const paths = asObject(spec.paths);
  const operations: { method: string; path: string; doc: ObjectValue }[] = [];
  for (const [path, methods] of Object.entries(paths)) {
    const definitions = asObject(methods);
    for (const method of METHOD_ORDER) {
      if (METHODS.has(method) && Object.prototype.hasOwnProperty.call(definitions, method)) {
        operations.push({ method, path, doc: asObject(definitions[method]) });
      }
    }
  }
  const lines: string[] = [
    "JSONBin - AI 可读 API 使用指南（TXT）",
    "=======================================",
    "应用：" + asString(info.title, "JSONBin API"),
    "版本：" + asString(info.version, "unknown"),
    "当前站点：" + site,
    "API 根路径：" + site + "/api/v1",
    "机器可读规范：" + site + "/api/v1/openapi.json",
    "本 TXT 地址：" + site + "/api/v1/openapi.txt",
    "已登记接口操作数量：" + operations.length,
    "",
    "一、应用能力",
    "------------",
    "JSONBin 是自托管的私有 JSON 数据仓与配置管理平台。",
    "核心功能包括：JSON Bin 创建、读取、版本历史、修改与删除；",
    "集合与数据模型、Schema 校验；JSON Merge Patch、JSON Patch、JSON Pointer；",
    "配置发布与回滚、回收站与恢复、模板、搜索、Webhook、备份与导入；",
    "基于 Scope / 资源范围的 API Key、限流、审计、统计、SDK 和 MCP 接入。",
    "下面的端点清单以当前部署使用的 OpenAPI 规范自动生成；未提供的参数或字段不能自行假设。",
    "",
    "二、给 AI / Agent 的调用规则（重要）",
    "---------------------------------",
    "1. 本文件不包含真实 API Token、Cookie、密码、密钥或用户业务数据；绝不要把真实凭据加入共享的 TXT。",
    "2. REST 基础地址为 " + site + "/api/v1。使用之前应由用户提供合法的 API Key，或使用用户已登录的管理员 Session。",
    "3. Bearer API Key 请求：Authorization: Bearer <API_TOKEN>。所授 Scope 和可访问的 Bin / Collection 决定实际权限。",
    "4. 管理员专属接口仅允许 Session Cookie；不要尝试用 Bearer API Key 调用管理、密钥或系统设置端点。",
    "5. 标明公开的读取端点只对实际公开的资源开放；不能把私人 Bin、历史、管理操作视为匿名可访问。",
    "6. 修改数据前先 GET 资源，获取响应中的当前 ETag；需要条件更新时把原值传到 If-Match。遇到 412 重新读取，核对变更后再重试。",
    "7. JSON Merge Patch 使用 Content-Type: application/merge-patch+json；JSON Patch 使用 application/json-patch+json，并遵循 RFC 6902。",
    "8. 如果遇到 428 则需补充 If-Match；429 应按照 Retry-After 等待；401/403 是鉴权/授权问题；423 表示资源锁定。",
    "9. 任何删除、永久清除、发布、回滚或覆盖操作，AI 应取得用户明确授权后再执行。不要盲目重试非幂等写操作。",
    "10. 若已提供兼容 MCP 的客户端，可选 Streamable HTTP 端点：" + site + "/api/v1/mcp，遵守相同的授权与 ETag 规则。",
    "11. 本指南只是 API 接口说明，不会授予任何实际访问权限；调用必须遵循服务器响应。",
    "",
    "三、常用调用示例（Bash / curl）",
    "----------------------------",
    'export JSONBIN_BASE_URL="' + site + '"',
    '# 令牌须从受信任的环境安全获取，以下为占位符；不要写入此 TXT：',
    'export JSONBIN_TOKEN="<API_TOKEN>"',
    "",
    "# 1. 查看服务状态（不需要 Token）",
    'curl -i "$JSONBIN_BASE_URL/api/v1/system/health"',
    "",
    "# 2. 读取数据仓列表（需要 bin:read Scope）",
    'curl -i "$JSONBIN_BASE_URL/api/v1/bins" -H "Authorization: Bearer $JSONBIN_TOKEN"',
    "",
    "# 3. 创建私有数据仓（需要 bin:create Scope）",
    'curl -i -X POST "$JSONBIN_BASE_URL/api/v1/bins" -H "Authorization: Bearer $JSONBIN_TOKEN" -H "Content-Type: application/json" --data-raw \'{"name":"ai-example","visibility":"private","value":{"enabled":true}}\'',
    "",
    "# 4. 按 ID 读取数据仓，记录响应头 ETag（需要 bin:read，或资源公开）",
    'curl -i "$JSONBIN_BASE_URL/api/v1/bins/<BIN_ID>" -H "Authorization: Bearer $JSONBIN_TOKEN"',
    "",
    "# 5. 在取得最新 ETag 后执行 Merge Patch（需要 bin:update）",
    'curl -i -X PATCH "$JSONBIN_BASE_URL/api/v1/bins/<BIN_ID>" -H "Authorization: Bearer $JSONBIN_TOKEN" -H "If-Match: <CURRENT_ETAG>" -H "Content-Type: application/merge-patch+json" --data-raw \'{"enabled":false}\'',
    "",
    "# 6. 获取已发布的配置（需要资源允许读取）",
    'curl -i "$JSONBIN_BASE_URL/api/v1/bins/<BIN_ID>/published" -H "Authorization: Bearer $JSONBIN_TOKEN"',
    "",
    "# 调用模板中的 <BIN_ID>、<CURRENT_ETAG>、<API_TOKEN> 都是占位符。",
    "# 真实鉴权与资源权限以实际响应为准；请勿将这些示例直接用于未经授权的数据修改。",
    "",
    "四、完整 API 端点清单（从 OpenAPI 生成）",
    "------------------------------------",
  ];
  for (const [index, { method, path, doc }] of operations.entries()) {
    const security = doc.security ?? spec.security;
    lines.push(
      "",
      "[" + (index + 1) + "] " + method.toUpperCase() + " /api/v1" + (path === "/" ? "" : path),
      "用途：" + asString(doc.summary, "请参照 OpenAPI 规范"),
      "认证：" + authLabel(security),
    );
    if (doc.description) lines.push("补充说明：" + String(doc.description));
    const parameters = Array.isArray(doc.parameters) ? doc.parameters : [];
    if (parameters.length) {
      lines.push("参数：");
      lines.push(...parameters.map(paramLabel));
    } else lines.push("参数：无");
    lines.push(...bodyDetails(doc.requestBody));
    lines.push(...responseDetails(doc.responses));
    lines.push("调用模板（占位符需要替换，请检查 Content-Type 与请求体 Schema）：");
    lines.push("  " + operationCurl(method, path, doc, security));
  }
  lines.push("", "五、完整性与安全提示", "------------------",
    "文档来源：当前 Worker 的 OpenAPI 3.1 定义；不包含用户数据、现有 API Key、Session Cookie 或任何运行时 Secret。",
    "此 TXT 是 AI 理解 API 的帮助文档，不能替代权限检查。若接口说明与实际返回状态不一致，以服务端鉴权及响应为准。",
    "");
  return lines.join("\n");
}
