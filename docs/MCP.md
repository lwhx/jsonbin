# JSONBin MCP Server

JSONBin 提供标准 Model Context Protocol (MCP) Server，让 AI Agent（Hermes、Claude Desktop、Cursor、Windsurf、Codex 等）能够安全地读取与修改 JSON 配置。

JSONBin 支持两种接入模式：
1. **云端 Remote MCP（推荐，零本地依赖）**：通过部署在 Cloudflare Worker 上的原生 SSE / Streamable HTTP 端点直连，本地无需安装 Node.js 或克隆代码库；
2. **本地 stdio 模式**：本地运行 `mcp/server.ts` 编译产物，适合本地隔离开发。

无论哪种模式，所有操作均受 JSONBin API Key 统一权限控制（Scope、Resource Access、ETag 条件写入与不可变版本模型）。

---

## 1. 云端连接配置（Remote MCP，推荐）

直接连接已部署的线上环境（如 `https://js.gnn.im`），**无需任何本地路径或安装**。

### Cursor / Windsurf (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "jsonbin": {
      "url": "https://js.gnn.im/api/v1/mcp/sse",
      "headers": {
        "Authorization": "Bearer jb_live_xxxxxxxx"
      }
    }
  }
}
```

或者使用单端点 Streamable HTTP：
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
