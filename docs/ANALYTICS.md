# JSONBin API 请求分析 (Analytics)

JSONBin 提供 API 请求指标分析能力，用于回答：

- 请求量是多少？什么时候请求最多？
- 哪个 API Key 请求最多？哪个 Endpoint 最热？
- 响应是否变慢？P95 延迟是多少？
- 哪些错误最多？429 是否频繁？412 是否异常增加？

---

## 1. Analytics 与 Activity 的区别

两者模型**不同，不得合并**：

| | Activity | Analytics |
| :--- | :--- | :--- |
| 性质 | 审计 / 业务事件 | 指标 / 可观测性 |
| 示例 | `11:31 修改 Bin`、`11:32 发布 Bin` | `11:00-12:00 请求 12,821 次，P95 118 ms` |
| 存储 | R2（业务数据） | KV 分桶聚合（可重建派生数据） |
| 丢失影响 | 不可丢失 | 可丢失，尽力而为 |

---

## 2. 存储与架构

```text
每个 API 请求
   ↓
规范化 Route
   ↓
写入 KV 小时分桶 (analytics:agg:<YYYY-MM-DDTHH>)
   ↓
保留 35 天，超期自动过期
```

- **不引入新的主数据库**：继续使用 Cloudflare Workers + KV 派生层；
- 若未来接入 Cloudflare Analytics Engine，仅作为指标存储，**不替代** R2 的业务数据职责；
- 分桶键示例：`analytics:agg:2026-10-06T04`；
- 写入使用 `ctx.waitUntil()`，**绝不阻塞或影响业务响应**。

### 2.1 写入失败不影响业务

```text
R2 提交成功 → HTTP 200
Analytics 写入失败 → 仍返回 HTTP 200
```

统计是 Best Effort；即使指标写入抛错也会被吞掉，绝不把成功的业务请求改成 500。

---

## 3. 采集字段

```json
{
  "method": "PATCH",
  "route": "/api/v1/bins/:id",
  "status": 200,
  "durationMs": 43,
  "authType": "api_key"
}
```

| 字段 | 说明 |
| :--- | :--- |
| `timestamp` | UTC 时间戳 |
| `method` | HTTP 方法 |
| `route` | **规范化**路由模板 |
| `status` | HTTP 状态码 |
| `durationMs` | 请求处理耗时（毫秒） |
| `authType` | `session` / `api_key` / `anonymous` |
| `keyId` | 调用方 API Key ID（可选） |
| `error` | 标准化错误码（可选） |

### 3.1 Route 必须规范化

高基数会摧毁分析数据的可用性，因此必须归一：

```text
❌ /api/v1/bins/3f2a…-uuid-A
❌ /api/v1/bins/7b91…-uuid-B
✅ /api/v1/bins/:id
✅ /api/v1/b/:slug
✅ /api/v1/collections/:id
```

---

## 4. 严禁采集的数据

Analytics **绝不保存**：

```text
Authorization     API Token       完整 Cookie
Password          Session Secret  Request Body
Response Body     完整用户 JSON    JSON Patch Value
Webhook Secret    GitHub OAuth Code
```

同时也不默认保存完整 Query String：

```text
❌ 记录 q=secret123
✅ 只记录 route=/api/v1/search/content
```

测试套件会直接扫描 KV 中的所有 analytics 分桶，断言不出现 Token、`Bearer`、`Cookie` 或用户 JSON 内容。

---

## 5. Analytics API

全部为 **Management Session Only**；使用 Bearer API Key 调用管理分析接口会返回 `401`。

```http
GET /api/v1/analytics/overview?range=24h
```

`range` 支持 `1h` / `24h` / `7d` / `30d`，默认 `24h`。

响应结构：

```json
{
  "overview": {
    "totalRequests": 24821,
    "successRate": 98.72,
    "avgDurationMs": 42,
    "p95DurationMs": 118,
    "count4xx": 196,
    "count5xx": 3,
    "count429": 74
  },
  "endpoints": [
    { "method": "GET", "route": "/api/v1/bins/:id", "requests": 9231,
      "avgDurationMs": 24, "p95DurationMs": 62, "errorRate": 0.2 }
  ],
  "statuses": [ { "status": 200, "count": 12201 }, { "status": 412, "count": 93 } ],
  "keys": [ { "keyId": "…", "requests": 4310, "count4xx": 12, "count429": 3 } ],
  "errors": [ { "error": "rate_limit_exceeded", "count": 382 } ]
}
```

**所有聚合在服务端完成**，前端只接收聚合结果，不会下载几十万条原始请求日志。

---

## 6. 控制台面板

Dashboard 新增「API 分析」页面（`#/analytics`）：

- **Overview 卡片**：总请求量、成功率、平均响应、429 限流次数；
- **时间范围切换**：最近 1 小时 / 24 小时 / 7 天 / 30 天；
- **Endpoint 排行**：方法、规范化路径、请求次数、平均与 P95 耗时、错误率；
- **状态码分布**：突出 `412`（ETag 冲突）、`422`（Schema 校验）、`423`（已锁定）、`429`（限流）；
- **高频 API Key**：按请求量排序并显示限流次数，**不显示完整 Token**。

界面继续支持 Desktop / Mobile / Dark Mode 与中文文案。

---

## 7. 测试

```bash
node --test tests/analytics.test.mjs
```

覆盖：

- 正确记录 method / route（规范化）/ status / latency / authType；
- Session 不产生伪 Key，Anonymous 正确归类；
- Session-only 强制（Bearer 调用返回 401）；
- 安全断言：KV 中不出现 Authorization / Token / Cookie / 用户 JSON / 搜索关键词。
