# JSONBin MCP Server

JSONBin 提供标准 Model Context Protocol (MCP) Server，让 AI Agent（Hermes、Claude Desktop、Cursor、Codex 等）能够安全地读取与修改 JSON 配置。

**MCP Server 只通过官方 SDK 调用 JSONBin HTTP API**，绝不直连 R2，也不调用 Worker 内部函数。因此权限完全由 JSONBin 的 API Key 权威控制。

```text
AI Agent
   ↓  stdio (JSON-RPC 2.0)
JSONBin MCP Server  (mcp/server.js)
   ↓  @jsonbin/client
JSONBin HTTP API
   ↓  Authentication → Scope → Resource Access → Rate Limit → ETag → Lock → Schema → Immutable Version
R2
```

---

## 1. 构建

```bash
cd mcp
npx tsc        # 输出 mcp/server.js
```

---

## 2. 配置

只需两个环境变量，**不需要** R2 Access Key、KV Token 或 Cloudflare API Token：

```bash
JSONBIN_URL=https://js.example.com
JSONBIN_TOKEN=jb_live_xxxxxxxx_yyyyyyyy
```

### Claude Desktop / Cursor (`mcp.json`)

```json
{
  "mcpServers": {
    "jsonbin": {
      "command": "node",
      "args": ["/absolute/path/to/jsonbin/mcp/server.js"],
      "env": {
        "JSONBIN_URL": "https://js.example.com",
        "JSONBIN_TOKEN": "jb_live_xxx"
      }
    }
  }
}
```

---

## 3. 权限模型

**不要为 MCP 重新设计 ACL**。MCP 的权限上限就是 `JSONBIN_TOKEN` 本身拥有的权限。

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

### 只读工具

| Tool | 说明 |
| :--- | :--- |
| `list_bins` | 列出可访问数据仓（支持 `tag` / `favorite` / `pinned` 过滤），只返回元数据，不返回完整 JSON |
| `get_bin` | 按 ID 或 Slug 获取元数据、当前 JSON 与 ETag |
| `get_published_bin` | 获取生产已发布版本 |
| `search_bins` | 搜索名称、描述与元数据 |
| `search_json` | 搜索已开启内容索引的 JSON 键或标量值（`mode`: `keys` / `all`） |

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

`test` 操作保证只有在当前值与预期一致时才执行修改；若 ETag 已过期，服务器返回 `412`，MCP 会以 `etag_conflict` 错误返回，AI 需重新读取后再试。

---

## 6. 返回与安全

- Tool 返回遵循 bounded response 原则，避免一次返回超大 JSON 淹没上下文；
- 错误统一映射为 `authentication_failed`、`permission_denied`、`resource_forbidden`、`etag_conflict`、`schema_validation_failed`、`bin_locked`、`rate_limited`、`not_found`；
- 错误信息**绝不**包含 Token、Cookie、内部 R2 Key、Secret 或堆栈跟踪。

---

## 7. 测试

```bash
node --test tests/mcp.test.mjs
```

测试使用真实 Worker 与真实 SDK（不 Mock SDK），覆盖 `list_bins`、`get_bin`、`json_patch_bin`、`publish_bin`、`get_published_bin` 全链路。
