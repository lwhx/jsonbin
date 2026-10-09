# JSONBin API Key 使用统计：KV 近似计数方案 B

> 状态：设计规格，待使用者审阅。本文不是实现完成报告，也不是实施计划。
> 日期：2026-10-09
> 源分支：`perf/read-path-analytics-20261009`（PR #6 尚未合并）。
> 范围：第二轮性能优化的 P0——API Key 使用次数，不含其他三个性能项目。

## 1. 用户目标与不可变约束

用户已明确选择方案 B：API Key 的凭据、撤销、有效期、Scope、资源授权、速率限制依旧由现有 R2 权威记录和认证链路判定；使用次数改成 Cloudflare KV 上的近似统计，业务请求不再同步等待统计写入。

- 保留 Cloudflare Workers + R2 + KV；不引入 D1、Durable Objects、外部数据库或第三方服务。
- API Key 的认证与权限绝不可依赖 KV，KV 为空、滞后或失败也不得扩大权限。
- 保留 `GET /api/v1/keys` 的 `items/total` 外层契约、原有 `usageTotal` / `usageDaily` / `lastUsedAt` 字段和原始已累计值。
- 客户端展示“约 N 次”，不声称精确计费、强一致或实时统计；无可用统计时显示“统计暂不可用/最近一次快照”，而非假装准确的零次。
- 保留管理员会话访问、撤销永久有效、Token 不出现在统计 KV、R2 旧数据不可批量覆盖。
- 部署时不清理 KV，不迁移或重写已有 Bin/Collection/Schema 历史。
- 延续原判定规则：有效 Bearer 且响应码 **不是** 401/403/429 才算一次使用；404/422/5xx 在已授权且通过限流后仍算一次“已授权请求”（并非“成功请求”）。

## 2. 代码现状（PR #6 分支）

- `src/worker/storage/keys.ts`：`readApiKey` 每次从 `keys/<id>/meta.json` 读取 R2 并验 Token；`useApiKey` 对完整 Key JSON 做最多 8 次 CAS 重试，更新 `usageTotal`、`usageDaily`、`lastUsedAt`。
- `src/worker/middleware/auth.ts`：`requireAccess` 完成鉴权、作用域和限流后设置 `apiKey`；`await next()` 之后对非 401/403/429 同步 `await useApiKey(...)`。因此已完成的业务响应仍可能等待 R2 CAS。
- `src/worker/index.ts`：全局中间件已在请求完成后调用 `recordAnalytics`，生产环境使用 `c.executionCtx.waitUntil`；直接调用 `worker.fetch` 的测试路径在没有 execution context 时等待其结算。
- `src/worker/storage/analytics.ts`：`analytics:agg:<UTC-hour>:<shard>`，每小时 4 个分片、保留 35 天；已经按 Key ID 记录请求数，但包含资源级拒绝和限流，不能直接等同“已授权使用”。
- `src/worker/routes/keys.ts`：只有会话管理员能获取 Key 列表；`KeysPage.tsx` 展示总次数、UTC 今日次数和最后使用时间。
- `src/worker/index.ts` + `wrangler.jsonc`：已有每 15 分钟一次的维护 Cron。

Cloudflare KV 是最终一致、没有原子加法的缓存；同一 KV 键最多每秒写入一次。直接为每次 API 请求新建另一个 KV 读改写计数器会增加费用、写热点和丢计数，**不采用**。复用现有 Analytics 的一次最佳努力写入才符合本项目的资源目标。

## 3. 架构与数据流

### 3.1 请求路径（热路径）

1. 保持 `readApiKey` → `authorizeApiKey` → 现有限流 → 资源级授权的顺序和 R2 权威检查。
2. 删除响应后同步执行的 `useApiKey` R2 统计 CAS。**不可**把 R2 权限验证也改成 KV 缓存。
3. 业务路由完成后，在现有 Analytics 数据点中增加只用于统计的布尔值，例如 `qualifiedKeyUse`，条件是：
   - 实际经过 Bearer 凭据验证，并且已设置有效 `apiKey`；
   - 最终响应状态不是 401、403、429；
   - 不是 OPTIONS；维持现有全局预检跳过逻辑。
4. Analytics 使用原有 `waitUntil(recordAnalytics(...))` 处理。每个请求 **不新增第二个 KV.put**，统计失败仍不改变业务 HTTP 状态。
5. `recordAnalytics` 在现有 `bucket.keys[keyId]` 添加 `authorizedUses`（一次最多 +1）与 `lastAuthorizedAt`（最大 ISO 时间），保留 `requests/count4xx/count429` 的含义；旧版桶没有新字段时视为新计数 0，绝不能把历史 `requests` 误计为使用次数。

### 3.2 R2 历史基线与幂等检查点

长期累计值仍要在 KV 35 天 TTL 后保留，因此允许**每日维护任务**将汇总后的近似统计落到原有 `keys/<id>/meta.json`，但每个请求不得写 R2。

- 现有 R2 `usageTotal` / `usageDaily` / `lastUsedAt` 原样作为升级时的历史基线；禁止初始化归零。
- Key 元数据增加私有幂等字段 `usageAppliedDays?: string[]`，保存最近最多 35 个已合并 UTC 日期。该字段不应暴露到公开 `ApiKey` JSON；`publicKey` 应显式排除它。
- 每日 UTC **00:30 之后**处理前一个完整 UTC 日，读取 `analytics:agg` 的 24 小时 × 4 分片及仍需兼容的 legacy 桶，只取 `authorizedUses` 和 `lastAuthorizedAt`。可以用 Workers KV `get(keys)`，每批最多 100 键，避免并行发出大量独立请求。
- 读取任何分片遇到 KV 错误、非法结构或无法确认的数据时，不得用不完整的正数快照推进该日“完成”标记；缺失的空桶允许按零处理，因为空闲小时本就没有数据。
- 仅对存在新增使用的 Key，以读取**最新 R2 元数据** + `etagMatches` CAS 的方式更新总数、对应 UTC 日期、最后使用时间和 `usageAppliedDays`。CAS 重试须保持最新 name、scopes、expiresAt、revokedAt、resourceAccess、rateLimitPerMinute 等不变。
- `usageAppliedDays` 已包含该日则跳过：Cron 重试、KV marker 丢失、重新部署都不能重复加总；purged Key 不得因为统计任务被重建；已 revoked Key 可以结算撤销前的历史使用，但不能被恢复有效。
- `usageDaily` 仍限制最近 31 天；`usageAppliedDays` 最多保留与 KV TTL 一致的 35 天记录，维护任务不再尝试回补超出 35 天的旧日期。
- 可使用 KV 非权威日完成标记（`keyusage:v2:done:<UTC-date>`）跳过重复扫描；其丢失只会触发幂等重放，而不是数据错误。
- 继续复用现有 15 分钟 Cron。每天重试昨日和最近未完成日期（常规恢复最多 3 天），每次限定批量和总工作量；超过重试窗口只允许专用、受控恢复流程，记录显式的统计缺口。

### 3.3 管理端的近期估算

`GET /api/v1/keys` 先获取 R2 Key 列表，针对 UTC 今天和昨日前仍未被 `usageAppliedDays` 结算的小时桶，以**有界批量读取**计算即时增量；展示：

- `usageTotal = R2 历史基线 + 尚未结算的合格使用估算`；
- `usageDaily[UTC-day] = R2 该日基线 + 若该日未结算的估算`；
- `lastUsedAt = max(R2 lastUsedAt, 尚未结算的 lastAuthorizedAt)`；
- 增加向后兼容的 `usageApproximate: true`、`usageAsOf: ISO-or-null`、`usageStatus: "ok" | "delayed" | "unavailable"` 字段供 UI 提示。旧 API 使用者忽略新增字段仍可正常工作。

如果今天/昨日尚未结算，可一次批量读取最多两天约 192 个分片键（拆成不超过 100 键/批）。不能将一整年的小时桶压进单次请求。若 KV 丢失或统计落后于回补窗口，显示旧 R2 基线和 `usageStatus="unavailable"/"delayed"`，不可将旧快照误报成实时准确值。管理接口不得输出 Token、摘要、原始请求路径或敏感 Body。

页面 `src/react-app/features/keys/KeysPage.tsx` 的总数、今日数前增加“约”，附一处“使用统计为近似值，可能延迟；不参与权限或限流判定”的低干扰说明。保持 UTC 今日口径，与现有日期表达式一致，不偷偷改成本地日历日。

## 4. 数据正确性和失败边界

- **旧数据**：老 `usageTotal` 永久保留；原来的 Analytics 小时桶不含 `authorizedUses` 就不回补；同一请求在“原 R2 累加”与“新 KV 事件统计”之间只计一次。切换期间禁止人为双写；如遇回滚/重新部署，要依据检查点验证未重复结算。
- **安全**：任何 KV 读取失败、计数低估、高估、延迟、重放都不能改变 `readApiKey`、作用域、撤销、过期、资源检查、限流或 HTTP 401/403/429。
- **强一致性不承诺**：KV 对同一键每秒仅可写一次且跨地区最终一致；项目现有“每小时 4 分片”也是读改写，在高并发时仍会因竞争而低估。不能宣传精准计费或规定不可证明的生产误差上界。
- **生命周期**：JWT/Token 轮换、Key 编辑、撤销或删除都由 R2 决定，后台更新只允许安全地合并计数；永久删除记录不能被统计任务复活。
- **失败**：如果生产不提供 `CACHE`，后台任务不得创建假的零值，`GET /keys` 只返回历史基线并显式标记不可用；测试环境没 execution context 时保持直接调用可用且不产生悬空 Promise。
- **时间**：从数据点 UTC timestamp 推导所属小时/日期，不能用 Cron 运行时间代替请求日期；00:00 边界与跨天延迟事件有独立测试。

## 5. 对外接口与改动范围

预期修改：
- `src/worker/storage/keys.ts`：移除每请求 R2 usage CAS；增量 checkpoint helper、公共 Key 字段映射；
- `src/worker/middleware/auth.ts`：移除 useApiKey 同步使用记录，保留业务授权链；
- `src/worker/index.ts`：在原有 Analytics 调用里传入合格使用标记；复用 scheduled handler 运行日结；
- `src/worker/storage/analytics.ts`：在现有 KV 数据点和每 Key 聚合中追加合格使用计数；
- 新 `src/worker/storage/key-usage.ts`：封装读取、聚合、检查点、幂等 CAS 和恢复窗口；
- `src/worker/routes/keys.ts`：为管理列表拼接新估算统计；
- `src/react-app/features/keys/api.ts`、`KeysPage.tsx`：显示近似性、时间戳和不可用情况；
- `tests/worker.test.mjs` 与独立计数单元测试：更新目前直接断言 R2 每请求 lastUsedAt 的老测试，并补充并发/重试/跨日/兼容性测试。

不修改 Bin 数据格式、不改变 R2 Key 的认证/授权字段、不引入迁移脚本、不更改公有数据读取、不触动 PR #6 已验证的详情页及缓存优化。

## 6. 验收与基准

必须有以下可复现的验证：

1. 1000 次合格 Bearer 调用期间，业务路径对 `keys/<id>/meta.json` 的 **R2.put 为 0 次**；仍逐次从 R2 做权威身份校验。当前 Analytics 之外不产生新增每请求 KV 写入。
2. 管理 Key 列表保留旧累计值；升级后请求造成的增量先在 KV 展现，次日按日期结算；两次运行同一天 Cron 不重复累加；超过 35 天依然保有 R2 已结算累计值。
3. 401/403/429 不计数；真实授权但资源不存在的 404、验证失败的 422 和授权请求的 5xx 按旧规则计数。无效 Token 及提前拒绝的请求不得影响 Key 使用时间。
4. 与管理员编辑、撤销、过期、并发更新交叉运行的 Cron 必须保留完整权限字段与撤销状态；永久删除绝不复活。
5. `CACHE` 故障或返回损坏桶不能导致普通 API 返回 500；管理端须标注统计不可用，且不能推进错误的日检查点。
6. 测试 R2 CAS 冲突、跨天 23:59/00:00、重复 Cron、KV 过期和旧 Analytics 格式兼容。
7. 运行 `npm run typecheck`、`npm run test`、`npm run test:browser`；报告明确通过/失败的数量并保留 GitHub Actions 证据。
8. 在相同模拟负载下测量改造前后 R2 读/写次数、KV 读/写次数、请求 P50/P95。目标是**去掉逐请求的 R2 统计写**，不是承诺未经测量的绝对加速百分比。

## 7. 发布与回退

1. 先合并或保持独立明确依赖 PR #6；**不可直接把第二轮改动并入生产 main**。
2. 第二轮创建独立功能分支及 PR，先完成测试再部署；校验旧 Key 的累计数字、撤销行为以及 UTC 跨天结果。
3. 观测两天 Cron 日结、错误数、R2 writes 和 KV 读取量；使用显式用户界面标签说明近似统计。
4. 如需要回滚业务代码，应保留 R2 元数据及 KV 桶；不得清零任何旧统计或人工重跑已经应用的日期。再次部署 v2 先验证 `usageAppliedDays` 与当日计数。
5. 本次只实现 P0；“30 天 Analytics rollup”“Bin 元数据索引和真分页”“全局搜索索引”是各自独立的后续架构规格。

## 8. 决策与取舍

- 选择：复用既有 Analytics KV 小时分片 + R2 **每日**幂等持久检查点 + 管理界面近期 KV 叠加。
- 不选择：逐请求 R2 CAS（延迟与写冲突）、逐请求额外 KV 累加（写热点/计费/最终一致）、新 Durable Object/D1（扩架构）。
- 关键取舍：统计为近似值且可能滞后；授权、撤销和资源权限仍由权威 R2 保证。若未来出现高并发精准计数需求，应另行设计串行写入/强一致服务，而不是偷偷改变此规格。
