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
- **健康与认证配置探测的写入优化**：匿名 `GET /api/v1/system/health` 与 `GET /api/v1/auth/config` 且 HTTP 状态为 **200** 时，直接跳过 Analytics KV 读-改-写（每次节省一次 KV 单键读取、一次 KV 写入）。只有这两条**完整匹配**的规范化 Route 适用。Bearer、管理员 Session、已识别 API Key、任何非 200 状态、非 GET 请求和其余业务接口仍按原逻辑记录。API Key 的 `authorizedUses`、`lastAuthorizedAt`、日结及 429/5xx 异常统计不受影响。
- **统计口径与历史提示**：Dashboard 的请求量是已采集的 API 请求量，**不再包含上述两类成功匿名探测**；上线前旧 KV 分桶会一直保留至其 35 天 TTL 到期，因此跨版本的 7/30 天窗口存在正常的口径切换。若要计算全量 HTTP 探测流量，应以 Cloudflare Worker 请求指标或独立开启的 Analytics Engine 事件为准，勿将当前 Dashboard 数值视为全量边缘流量。高频探测占比不明时不可承诺全站统一节省百分比。
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
  "ANALYTICS_SHADOW_STARTED_AT": "2026-10-29T04:00:00.000Z",
  "ANALYTICS_KV_PROBE_FILTER_STARTED_AT": "2026-10-29T04:00:00.000Z"
}
```

- `ANALYTICS_SHADOW_STARTED_AT` 必须填写实际**开启影子写入**的 UTC 时间，不得使用部署前的假日期；否则历史窗口会被误判为可比较。
- `ANALYTICS_KV_PROBE_FILTER_STARTED_AT` 也必须填写**成功匿名探测写入排除策略实际部署至生产**的 UTC 时间。该值与影子写入开始时间可能不同，不能照抄示例日期。如果未配置或查询窗口包含切换前数据，诊断返回 `coverage=unknown/partial_window`、`comparable=false`、`deltas=null`；避免把过去包含探测流量的 KV 桶拿来与新口径 SQL 比对。
- SQL 对照查询会过滤与 KV 相同的成功匿名 `GET /system/health`、`GET /auth/config` 事件，但 Analytics Engine 底层 **原始事件仍保留**它们；Cloudflare Studio 可查看完整探测流量。该过滤只影响只读 SQL 诊断，不影响生产鉴权、API Key 日结和异常状态监控。

- 正式生产数据集为 `jsonbin-api-shadow-prod`。SQL 数据集标识符由代码白名单固定，不接受查询参数或任意配置字符串拼接；Preview 不得指向生产数据集。
- 只使用当前 Cloudflare 官方 `analytics` SQL binding（Wrangler 4.145.0+），**不需要向 Worker 提供 Analytics API Token**。
- **注意两个 SQL API 采样规则不同**：本项目使用新 Analytics SQL binding（`events.analyticsEngine.*`），`COUNT(*)`、`SUM(double2)`、`countIf(...)` 已由 SQL API 自动执行采样加权；只有 P95 使用 `quantileWeighted(0.95, double2, sampleInterval)` 传入显式权重。不得套用旧 Analytics Engine SQL API 的 `SUM(_sample_interval * ...)`，否则可能重复加权。KV 的 P95 是固定直方图分桶上界，和 Engine 加权分位数并不完全等价。
- `coverage` 为 `unknown` 或 `partial_window` 时不返回误导性的差异值（`deltas: null`）；只有完整窗口且 KV 查询完整时，才返回请求量差异，并明确仅为近似运营比对。
- `shadow.available=false` 表示 SQL 出错或数据格式异常，仍返回 legacy KV 统计，**绝不自动把空 SQL 结果替代旧数据**。SQL 读取失败不得影响业务请求。
- 高流量样本可能被采样，后台写入存在可见性延迟。比对结果不用于身份鉴权、计费或 API Key 使用量结算。当前 Analytics Engine 不存储 Key ID，也不能取代 KV `authorizedUses` 和日结机制。
- 单次 SQL 诊断最多执行三个只读 SELECT（总览、状态码、最多 150 个热门 Endpoint）。没有常规后台自动轮询该诊断接口，避免额外查询成本。

建议先在独立 Preview 环境使用真实数据验证 SQL 方言、数据集可读性、指标一致性及成本，确认后再独立设计历史拼接和 Key 结算的切换策略。请勿同时修改线上 KV 写入路径。

### P22：独立 SQLite Durable Object API Key 使用量影子计数（默认关闭）

现行 `analytics:agg:<hour>:<shard>` KV 读-改-写不是原子操作。高并发的两个 Worker 可能基于同一旧值覆盖彼此，故 Dashboard 的 Key 用量、`authorizedUses`、R2 日结仍只属于**近似使用量**，不能当作严格计费记录。

本阶段声明独立的 `ApiKeyUsageCounter` SQLite Durable Object，绑定名称 `KEY_USAGE_COUNTER`。**每个 API Key UUID 对应一个独立 DO**；与 `ApiRateLimiter` 完全分离，因后者会清理空闲限流状态，不得存放长周期用量。

- **生产/Preview 默认均关闭**：`KEY_USAGE_DO_SHADOW` 未设置为字符串 `"1"` 时，Worker 不向用量 DO 发送 RPC。两种环境分别使用自己的 Worker Preview namespace。配置内仅增加独立 DO class/export/binding，不新增任何 Secret、不访问生产 KV Preview。
- 仅当实际鉴权成功、路由完成后 `qualifiedKeyUse=true`，才以 `ctx.waitUntil()` 异步写一条内部 `POST /usage/increment`，内容只有服务器生成的 UTC ISO 时间戳。401/403/429、匿名、Session、畸形 Key ID 等不会写；HTTP 500 如被现行 `qualifiedKeyUse` 口径认定为有效使用，也会写入，保持与原 KV 语义一致。
- DO 使用 `INSERT ... ON CONFLICT(utc_day) DO UPDATE SET authorized_uses=authorized_uses+1`，同一 Key 的并发增长由 SQLite 事务串行化，避免 KV 上丢失更新。另保存最新 `last_authorized_at`。提供**仅内部 stub 可访问**的 `GET /usage/day/YYYY-MM-DD` 读取，未增加任何对外 API 或管理员路由。
- 每个 DO 通过 alarm 清理超过 35 天的记录；没有记录时删除 SQLite 实例数据。DO 原始计数不会携带 Token、Cookie、IP、请求体或 Bin 内容。
- **不做来源切换**：`recordAnalytics`、`readDailyKeyUsage`、`settleRecentKeyUsage`、R2 CAS checkpoint、原 Dashboard/Top Keys 全部不变。新 DO 失败一律 best-effort 忽略，不改变授权、限流和 API 响应。该阶段**不会减少** API Key 的 KV 写入；只有将来明确切换读/日结来源才能节省 KV 成本。
- **不能声称已达到财务级精确计费**：虽然单个 DO 的已接受 UPSERT 不会因并发丢失，但异步 `waitUntil` 失败可能漏计，当前影子接口也没有事件幂等去重；不要自动重试可能已提交但丢失响应的 RPC。升级为正式结算来源前，须增加请求事件幂等键、跨 UTC 日的延迟事件封账与可重放/对账、R2 checkpoint 迁移策略、KV 历史拼接、故障告警，以及实际 Preview/生产成本和配额验收。
- **成本权衡**：影子开启后每次有效 Key 调用增加一笔 DO RPC 和 SQLite 写入成本；请先通过 CI/Preview 及账单验证，不要在未完成迁移时为节省 KV 而直接打开。关闭 `KEY_USAGE_DO_SHADOW` 可立即停止新写入，KV 旧逻辑始终独立可用。

测试覆盖大量并发同 Key 累加、不同 Key 隔离、跨 UTC 零点、异常输入过滤、HTTP 401/403/429 排除和 DO 故障回退。生产发布门槛：CI Node、Playwright、Wrangler dry-run、Cloudflare Preview 与生产构建全部正常，且不更改原有 Key 结算源。

### P24：影子计数事件幂等与有限失败重试

P22 的 SQLite DO 已能对每次成功提交的事件原子累加，但 **RPC 响应丢失** 时，直接重试可能导致重复计数；另一方面，单次异步投递错误可能丢失事件。

本阶段在仍默认关闭的 `KEY_USAGE_DO_SHADOW=1` 通道上增加以下防护：

- Worker 为每个 API 请求生成不可由客户端覆盖的 UUIDv4（同一服务端 `X-Request-ID`），并只把 `{ timestamp, eventId }` 发送到对应 API Key 的内部 DO。API Key ID 仅用于选择 DO 实例，不进入事件表字段，也不在失败日志中输出。
- 每个 Key 的 SQLite `usage_event_ids(event_id PRIMARY KEY, utc_day, timestamp)` 与 `daily_key_usage` 计数聚合在**同一个 `transactionSync`** 完成。第一次调用累计一次；同一 UUID + 同一时间戳重试返回 `deduplicated=true`、不再次计数；同一 UUID + 不同时间戳返回 HTTP 409，数据不变。
- 仅对异常网络响应、HTTP 429 或 5xx 做最多 **3 次总尝试**、固定短退避（0/30/120ms）；HTTP 400/409/422 等确定性错误不重试。所有重试复用同一个 JSON 负载，不因失去确认而再次生成 ID。失败日志为固定 `key_usage_shadow_delivery_failed` 和有限错误类别、尝试次数，不记录 Key ID、Token、事件 UUID、原始异常。
- 为限制无限增长，去重表与日计数数据均保留 35 天并通过 DO alarm 清理；过期超过 35 天、超前超过 5 分钟的事件直接返回 422，杜绝已删除去重记录的历史重放复活。使用范围限制而非主观猜测历史封账。
- **生产默认仍关闭**；既有 KV `authorizedUses`、R2 CAS 日结、限流和 API 成功响应都不受影响。读/写计数来源仍是 KV。只在 Preview 隔离环境显式开启后才会产生额外 DO 调用和 SQLite 存储成本。

**明确限制：这仍不是零丢失或财务级 exactly-once。** `waitUntil()` 有执行截止期限；如果 Worker 在把第一条事件可靠投递前终止，简单重试无法找回数据。下一小阶段必须引入可持久化的队列/Outbox（例如 Cloudflare Queues，并明确启用成本及消费端）和可观测 DLQ，完成“写入已持久化 → 可重放 → 按 Key 结算”全链路验证后才可替代 KV 的 API Key 用量来源。

- **上线检查**：GitHub Node+Playwright 全套、Wrangler dry-run、Cloudflare Preview 构建全部通过；真实 Preview 双写压测必须验证同 Key 并发、重放、强制失败、跨日边界、R2 日结保持不变。若未真正开启 Preview 影子开关，测试只能证明本地 Miniflare 行为而不是 Cloudflare 平台端真实写入。


### P24b：持久化 Queue 与独立 Staging 消费验收（默认关闭）

本阶段新增 Queue.send 成功确认、消息级 ACK/retry、DLQ 私有 R2 归档和无效消息脱敏隔离。**生产原有 `wrangler.jsonc` 不含 Queue binding；KV `authorizedUses`、R2 日结、鉴权、限流和公开路由均不切换。** PR #25 未通过真实 Staging/成本验收前保持 Draft。

**Cloudflare 官方限制（2026-10）**：Workers Previews **可以发送** Queue 消息，但**无法注册为 Queue consumer**。不能通过 PR Preview 的部署成功来宣称 Queue 处理链路可用。真实消费者必须部署到一个 **独立命名的 Staging Worker**。参考：
- https://developers.cloudflare.com/workers/previews/resources/
- https://developers.cloudflare.com/queues/configuration/dead-letter-queues/

#### 投递与消费

- `KEY_USAGE_QUEUE_SHADOW=1` 且 `KEY_USAGE_EVENTS_QUEUE` 已绑定：符合条件的请求在返回 HTTP 响应前等待 `Queue.send()` 成功；发送失败保留原业务响应，且只有显式同时开启原 `KEY_USAGE_DO_SHADOW=1` 时才回退原有 best-effort DO 影子计数。同一服务端 UUIDv4、UTC timestamp 始终复用。
- `KEY_USAGE_CONSUMER_ENABLED=1` 是**另一独立开关**。关闭生产方并不意味着已有消息可丢弃；但新连接的 consumer 缺少显式启用时会失败、触发 Queue 重试，而非悄悄 ACK。正常消费端按每条消息 ACK 或 retry，不因为其他消息成功而误确认失败事件。
- 主 Queue 消息固定为 `{version:1,keyId,eventId,timestamp}`，Key ID 为内部 UUID，不传 Token、请求体、Cookie、IP、路由或任意用户标签。对应 Key 的 SQLite DO 根据 eventId 幂等，重复消费不增加计数。
- 超过消费失败重试次数进入 DLQ。有效消息写入**独立私有 R2** 的 `internal/key-usage-dlq/v1/<UTC day>/<Key UUID>/<event UUID>.json`，保留人工重放所需最少字段；无效或注入敏感字段的消息**不保存原始内容**，只产生 `internal/key-usage-quarantine/v1/...` 固定类别的脱敏墓碑记录。归档失败会重试，不会主动 ACK。
- Staging 配置把 DLQ 归档失败的消息继续转到第三个 `jsonbin-key-usage-quarantine-staging` 队列（无 consumer，供故障时人工介入）。**这不是永久备份**，到达保留期仍会删除，必须设置积压/重试/归档异常告警；没有完成监控之前严禁升级为权威计数路径。

#### 独立 Staging 配置（仅模板，不自动部署）

`wrangler.usage-staging.jsonc` 是独立 Worker `jsonbin-usage-staging` 的**专用配置**，和生产 `jsonbin` Worker 不是同一个服务：单独 SQLite DO 命名空间、测试 R2 DATA 桶、独立 R2 死信归档桶、独立 Queue 与三层 DLQ。没有绑定生产 KV/R2；不运行生产 Cron。配置的生产/消费影子开关默认都是字符串 `"0"`。

创建云资源属于有成本的操作，需要先确认 Cloudflare 账户、额度、队列管辖区和环境隔离。操作示例（**不要在生产部署脚本中执行**）：

```bash
npx wrangler queues create jsonbin-key-usage-events-staging
npx wrangler queues create jsonbin-key-usage-dlq-staging
npx wrangler queues create jsonbin-key-usage-quarantine-staging
npx wrangler r2 bucket create jsonbin-usage-staging-data
npx wrangler r2 bucket create jsonbin-usage-staging-deadletters
npx wrangler deploy --config wrangler.usage-staging.jsonc
```

Staging 的 ADMIN_PASSWORD / SESSION_SECRET 必须为**新生成、与生产完全无关**的强随机 Secret，绝不可提交 Git；额外用 Cloudflare Access 或 IP 白名单保护测试域名。资源都正常后，才可在**独立 Staging** 配置将两个影子开关分别设为 `"1"`，实际验证登录、创建**测试专用** API Key、重复投递、429/503、DO 强制失败、DLQ 故障、跨 UTC 日、R2 去重与消费指标。

#### 持续验收与回退

1. GitHub Node、Playwright、TypeScript、默认及 Staging Wrangler dry-run；分支 Preview 仅校验不含 Queue 的 HTTP/DO 构建。
2. 独立 Staging Worker 验证消息真正进入 Queue 并被其独立 DO 消费，确认每条消息状态与 R2 归档一致；测试 Queue.sends、消费者重试、DLQ backlog、费用、延迟、用户端 P95。
3. 观测报警：主 Queue 最老消息年龄、DLQ/隔离队列积压、R2 归档错误数、DO 409/422、重放次数。明确责任人、应急手册和短保留期内的人工介入方式。
4. 当需要停止新事件时，仅关闭 `KEY_USAGE_QUEUE_SHADOW`；先确认并处理队列 backlog，再考虑关闭 `KEY_USAGE_CONSUMER_ENABLED`。保留既有 KV/R2 权威日结，**不能为了降本直接关闭 KV 写入**。

**剩余一致性限制**：业务请求成功与 Queue.send 不能组成同一个数据库原子事务，Worker 在持久化发送前终止仍可能漏报；R2 中超过 35 天的事件会被 DO 拒绝（422），无法无限期重放；此外 Cloudflare Queue 保留期与重试次数有限，DLQ 末端故障仍可能丢失。此阶段既不是全程 exactly-once，也不是财务级准确结算。正式切换还需要跨日封账、KV 历史衔接、可靠对账及故障恢复方案。
