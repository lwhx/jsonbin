# JSONBin MCP Server

JSONBin 提供标准 Model Context Protocol (MCP) Server，让 AI Agent（Hermes、Claude Desktop、Cursor、Windsurf、Codex 等）能够安全地读取与修改 JSON 配置。

JSONBin 支持两种接入模式：
1. **云端 Remote MCP（推荐，零本地依赖）**：通过部署在 Cloudflare Worker 上的 Streamable HTTP 端点直连，本地无需安装 Node.js 或克隆代码库；
2. **本地 stdio 模式**：本地运行 `mcp/server.ts` 编译产物，适合本地隔离开发。

无论哪种模式，所有操作均受 JSONBin API Key 统一权限控制（Scope、Resource Access、ETag 条件写入与不可变版本模型）。

> 仪表盘「开发者 → **MCP 接入**」页面（`/#/mcp`）会基于当前部署地址自动生成下列各客户端的配置片段，支持粘贴令牌后即时填充（仅页面内存，不保存、不发送），可直接复制使用。

---

## 1. 云端连接配置（Remote MCP，推荐）

直接连接已部署的线上环境（如 `https://js.gnn.im`），**无需任何本地路径或安装**。

### Cursor / Windsurf (`.cursor/mcp.json`)，单端点 Streamable HTTP：

```json
{
  "mcpServers": {
    "jsonbin": {
      "url": "https://js.gnn.im/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer jb_live_xxxxxxxx"
      }
    }
  }
}
```

### 关于旧版 HTTP+SSE 传输（已移除）

旧版 2024-11-05 的 HTTP+SSE 传输（`GET /api/v1/mcp/sse` + `POST /api/v1/mcp/message`）已移除：该实现无法在这个无状态 Worker 上把响应通过 SSE 流回推，规范客户端会一直等待。旧端点现在返回 `410` 并指向 Streamable HTTP。请统一使用上方的 `POST /api/v1/mcp` 端点。

### Remote MCP 传输语义

- **Streamable HTTP（`POST /api/v1/mcp`）为无状态服务**：不下发 `Mcp-Session-Id`，`GET` / `DELETE /api/v1/mcp` 返回 `405`；
- 支持 JSON-RPC 批量请求；只含通知（无 `id`）的请求返回 `204` 无响应体，符合 JSON-RPC 2.0 规范；
- `initialize` 支持协议版本协商：`2025-06-18` / `2025-03-26` / `2024-11-05`，未识别的版本回落到 `2025-06-18`；
- 严格 JSON-RPC 2.0 信封校验：`jsonrpc` 不是 `"2.0"`、`id` 不是字符串/数字/null 均返回 `-32600 Invalid Request`；批量请求上限 100 条，请求体上限 10 MiB；
- 支持 `ping`；未知方法（带 `id`）返回 `-32601 Method not found`；
- `serverInfo.version` 与 `package.json` 版本号同源，不再手工维护。

---

## 2. 本地 stdio 模式构建与配置

若客户端仅支持本地进程 stdio 通信：

```bash
npm run build:sdk        # 输出 sdk/typescript/dist/
npm run build:mcp        # 输出 mcp/server.js
```

### 本地 `mcp.json`：

```json
{
  "mcpServers": {
    "jsonbin": {
      "command": "node",
      "args": ["/path/to/jsonbin/mcp/server.js"],
      "env": {
        "JSONBIN_URL": "https://js.gnn.im",
        "JSONBIN_TOKEN": "jb_live_xxxxxxxx"
      }
    }
  }
}
```

stdio 模式与 Remote MCP 保持相同的协议行为：`ping`、通知静默、未知方法 `-32601`、严格信封校验与协议版本协商；单行与批量同样受 10 MiB / 100 条预算约束，坏 JSON 行返回 `-32700` 而非静默丢弃。

---

## 3. 权限模型

**不要为 MCP 重新设计 ACL**。MCP 的权限上限就是 `JSONBIN_TOKEN` 本身拥有的权限。

Remote MCP 在每个 HTTP 请求上校验 Bearer 令牌（无效、已撤销或已过期返回 `401`）；每个 Tool 调用再按各自 Scope 由内部 API 精确鉴权。

例如创建一个专用密钥：

| 字段 | 值 |
| :--- | :--- |
| Name | `Hermes-MCP` |
| Scope | `bin:read`、`bin:update`、`history:read` |
| Resource | `cloudflare-config`、`qinglong-config` |

则 MCP 自动获得：

```text
✅ 读取指定 Bin   ✅ 修改指定 Bin   ✅ 读取历史版本
❌ 访问其他 Bin   ❌ 删除           ❌ 管理 API Key
```

第一版明确**不提供**：永久删除、API Key 管理、Secret 管理、系统设置修改等 Tool。

---

## 4. Tool 列表

### 创建与只读工具

| Tool | 说明 |
| :--- | :--- |
| `create_bin` | 新建 Bin 并写入初始 JSON（版本 1），需 `bin:create` |
| `list_bins` | 列出可访问数据仓（支持 `tag` / `favorite` / `pinned` 过滤），只返回元数据，不返回完整 JSON |
| `get_bin` | 按 ID 或 Slug 获取元数据、当前 JSON 与 ETag |
| `get_published_bin` | 获取生产已发布版本 |
| `search_bins` | 搜索名称、描述与元数据 |
| `search_json` | 搜索已开启内容索引的 JSON 键或标量值（`mode`: `keys` / `all`） |
| `list_bin_versions` | 列出不可变历史版本 |
| `get_bin_version` | 读取指定历史版本 |

### 写入工具（需 ETag）

| Tool | 说明 |
| :--- | :--- |
| `update_bin` | 全量替换 JSON（支持可选 `message` 变更说明） |
| `merge_patch_bin` | RFC 7396 JSON Merge Patch |
| `json_patch_bin` | RFC 6902 JSON Patch（AI 修改 JSON 的主要方式） |

### 发布类工具（建议单独分类确认）

| Tool | 说明 |
| :--- | :--- |
| `publish_bin` | 将指定版本发布到生产指针 |
| `rollback_bin` | 回滚生产指针到历史版本 |
| `clone_bin` | 克隆为新私有数据仓 |

---

## 5. 推荐交互流程

AI 修改配置时必须遵循 **读取 → 生成 Patch → 条件写入** 的安全模式：

```text
get_bin("cloudflare-config")
   ↓ 读取 ETag
json_patch_bin(
  id,
  etag,
  [
    { "op": "test",    "path": "/successRate", "value": 90 },
    { "op": "replace", "path": "/successRate", "value": 80 }
  ]
)
```

`test` 操作保证只有在当前值与预期一致时才执行修改；若 ETag 已过期，服务器返回 `412`，MCP 以 `etag_conflict` 错误返回，AI 需重新读取后再试。

---

## 6. 返回与安全

- Tool 返回遵循 bounded response 原则，避免一次返回超大 JSON 淹没上下文；
- 错误统一映射为稳定错误码（`statusCode` 保留原始 HTTP 状态，`issues` / `requiredScopes` 等细节按需附带）：

| 错误码 | 来源 |
| :--- | :--- |
| `authentication_failed` | 401（含无效/撤销/过期令牌） |
| `permission_denied` | 403 Scope 不足 |
| `resource_forbidden` | 403 资源不在 Key 的 Resource Access 范围内 |
| `not_found` | 404 |
| `conflict` | 409（Slug 冲突、版本数上限等） |
| `etag_conflict` | 412 ETag 过期 |
| `precondition_required` | 428 缺少 If-Match |
| `validation_failed` | 422 请求校验失败 |
| `schema_validation_failed` | 422 违反绑定的 JSON Schema |
| `bin_locked` | 423 数据锁 |
| `rate_limited` | 429 限流 |
| `server_error` | 5xx |
| `unknown_tool` | 调用了不存在的 Tool |

- 错误信息**绝不**包含 Token、Cookie、内部 R2 Key、Secret 或堆栈跟踪。

---

## 7. 测试

```bash
node --test tests/mcp.test.mjs tests/mcp-remote.test.mjs
```

测试使用真实 Worker 与真实 SDK（不 Mock SDK），覆盖 `create_bin`、`list_bins`、`get_bin`、`json_patch_bin`、`publish_bin`、`get_published_bin` 全链路，以及 Remote 端的 401 令牌校验、协议版本协商、通知静默（204）、签名会话校验与 ETag 冲突错误映射。
