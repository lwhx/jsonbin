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
- 现有生产写入格式为每小时 4 个 KV 分片（兼容更早的非分片小时桶），每个请求进行一次读-改-写。**分片不提供强一致计数**，同一个 KV Key 每秒最多可写一次；高频时统计可能丢失，绝不能作为精确计费或权限控制依据。
- **读路径优化**：管理后台查询采用 Cloudflare 原生 KV 批量 `get(keys, "json")`，每批最多 100 个键、并发最多 6 批，并分窗口合并。30 天共 720 小时 ×（4 分片 + 1 个历史桶）= **3,600 个键，最多 36 次批量 KV 读取操作**，避免原来的 3,600 个独立子请求超过 Worker 的 1,000 次操作上限。
- 批量读取失败时接口仍返回已成功读取的聚合值，但额外返回 `partial: true`；管理后台显示显著提示。缺少 `CACHE` 绑定时同样标记为不完整。**这不是高频写入问题的解决方案**，仅减少查询子请求和内存峰值；KV 读取计费仍按查询的键数量计算。

### 2.2 Analytics Engine 写入迁移前置条件

下一阶段可以使用 Cloudflare Workers Analytics Engine 的 `writeDataPoint()` 承担高频事件写入，再通过无需 API Token 的 Workers Analytics SQL binding 查询；但必须独立验收、分阶段开启，不能直接用新增绑定替换当前 KV：

1. 既有 `readDailyKeyUsage` / `settleRecentKeyUsage` 与 API Key 使用次数估算依赖 KV 桶中的 `authorizedUses` 与 `lastAuthorizedAt`；需要完整的迁移读取和日结幂等方案。
2. 管理端历史 1h / 24h / 7d / 30d 数据及 P95 直方图必须校验与原口径相容，包括 Analytics Engine 可能发生的数据采样。
3. Preview 数据集必须与生产分离，生产读取异常应回退至旧 KV，任何阶段不得改变认证、限流、R2 CAS 与审计的安全边界。
4. 验证 Analytics Engine 实际成本、统计误差、延迟以及回滚后恢复旧 KV 读写的路径，再决定是否关闭 KV 高频聚合写入。

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

响应可额外包含 `partial: boolean`：`false` 表示批量读取完整（不保证 KV 在多地域强一致），`true` 表示部分 KV 批次失败或 CACHE 不可用。

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

### Analytics Engine 影子采集（默认关闭，第一阶段试运行）

本阶段只新增 **可选、只写入** 的 Analytics Engine 适配器；不切换统计查询，`recordAnalytics()` 仍写入现有 KV。缺少绑定或开关时不会执行额外写入，生产行为保持原样。

准备试运行时，在 Wrangler 中增加绑定，**生产与 Preview 使用不同数据集**：

```json
"analytics_engine_datasets": [
  { "binding": "ANALYTICS_EVENTS", "dataset": "jsonbin-api-shadow-prod" }
]
```

Preview 配置应改用数据集 `jsonbin-api-shadow-preview`，并在环境变量中设置 `ANALYTICS_EVENTS_SHADOW=1` 才启动采集。务必先验证 Preview 的最终绑定和数据集隔离。**当前 PR 不修改 Wrangler 配置，不启用采集。**

每条事件固定使用如下字段顺序：

| Analytics Engine 列 | 内容 |
|---|---|
| blob1 | 标准 HTTP 方法 |
| blob2 | 脱敏规范化路由模板 |
| blob3 | HTTP 状态码 |
| blob4 | 认证类型 |
| blob5 | 安全错误码（不接受自由文本） |
| blob6 | 授权 API Key 使用标志（`0` / `1`） |
| double1 | 单次请求计数 `1` |
| double2 | 截断后的请求耗时（ms） |
| double3 | UTC 时间戳（毫秒） |
| index1 | 常量 `jsonbin` |

**绝不发送 Key ID、Token、IP、Cookie、Slug、查询参数或业务 JSON**。对非规范化路由拒绝影子采集；采集失败不阻断业务，也不会影响原有 KV 指标。

启用条件：通过 Preview 采样率/延迟/成本、隐私检查，以及 Key 使用量日结兼容性后，才能规划查询和结算迁移。关闭开关或移除绑定即可回退到仅 KV 指标。该阶段 **不会降低 KV 写入次数**，因为尚未转移 Dashboard 与 Key 结算读路径。

### Analytics Engine SQL 与 KV 并行校验（第二阶段，默认关闭）

新增只读管理诊断端点：`GET /api/v1/analytics/shadow-compare?range=1h`。支持 `1h`、`24h`、`7d`、`30d`。必须是 **管理员 Session**；Bearer API Key 访问返回 401。未完全配置时返回 404，不会调用 SQL，也不会改变原 `/analytics/overview`。

只有明确完成以下配置，才会启用对照查询。**本 PR 不修改生产 Wrangler 配置，也不打开开关。**

```jsonc
// 仅作为分环境配置示例：生产与 Preview 应隔离数据集。
"analytics_engine_datasets": [
  { "binding": "ANALYTICS_EVENTS", "dataset": "jsonbin-api-shadow-preview" }
],
"analytics": { "binding": "ANALYTICS_SQL" },
"vars": {
  "ANALYTICS_EVENTS_SHADOW": "1",
  "ANALYTICS_SHADOW_COMPARE": "1",
  "ANALYTICS_SHADOW_DATASET": "jsonbin-api-shadow-preview",
  "ANALYTICS_SHADOW_STARTED_AT": "2026-10-29T04:00:00.000Z"
}
```

- `ANALYTICS_SHADOW_STARTED_AT` 必须填写实际**开启影子写入**的 UTC 时间，不得使用部署前的假日期；否则历史窗口会被误判为可比较。
- 正式生产数据集为 `jsonbin-api-shadow-prod`。SQL 数据集标识符由代码白名单固定，不接受查询参数或任意配置字符串拼接；Preview 不得指向生产数据集。
- 只使用当前 Cloudflare 官方 `analytics` SQL binding（Wrangler 4.145.0+），**不需要向 Worker 提供 Analytics API Token**。
- 使用 `_sample_interval` 做权重求和，延迟 P95 使用 `quantileExactWeighted(0.95)`。KV 的 P95 是分桶上界，二者口径并非精确相同。
- `coverage` 为 `unknown` 或 `partial_window` 时不返回误导性的差异值（`deltas: null`）；只有完整窗口且 KV 查询完整时，才返回请求量差异，并明确仅为近似运营比对。
- `shadow.available=false` 表示 SQL 出错或数据格式异常，仍返回 legacy KV 统计，**绝不自动把空 SQL 结果替代旧数据**。SQL 读取失败不得影响业务请求。
- 高流量样本可能被采样，后台写入存在可见性延迟。比对结果不用于身份鉴权、计费或 API Key 使用量结算。当前 Analytics Engine 不存储 Key ID，也不能取代 KV `authorizedUses` 和日结机制。
- 单次 SQL 诊断最多执行三个只读 SELECT（总览、状态码、最多 150 个热门 Endpoint）。没有常规后台自动轮询该诊断接口，避免额外查询成本。

建议先在独立 Preview 环境使用真实数据验证 SQL 方言、数据集可读性、指标一致性及成本，确认后再独立设计历史拼接和 Key 结算的切换策略。请勿同时修改线上 KV 写入路径。
