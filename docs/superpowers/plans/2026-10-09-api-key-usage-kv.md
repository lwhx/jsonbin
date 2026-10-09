# JSONBin API Key KV Usage Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持 R2 权威鉴权的前提下，将 API Key 的逐请求 R2 统计写入改为复用现有 KV Analytics 的近似计数，并提供每日 R2 幂等结算与管理端兼容展示。

**Architecture:** API Key 身份和权限每次仍从 R2 校验；全局 Analytics 复用现有 `waitUntil` 和每小时 4 个分片，将“已授权使用”与常规 HTTP 请求数分开。读取 KV 近期增量供管理页显示，15 分钟维护 Cron 在 UTC 日界完成后以 R2 ETag CAS 每日结算，私有日期检查点确保重试不重复累计。

**Tech Stack:** TypeScript 7、Cloudflare Workers、Hono、R2、Workers KV、React/TanStack Query、Miniflare 5、Node.js 22+ 内置测试、Playwright。

**Spec:** `docs/superpowers/specs/2026-10-09-api-key-usage-kv-design.md`

## Global Constraints

- **严格沿用已审阅方案 B。** 只实施 P0 API Key 使用统计；30 天 Analytics rollup、R2 列表索引、搜索索引留到独立 PR。
- 不增加 D1、Durable Objects、第三方数据库、其他计数服务或任何新环境变量；生产 `wrangler.jsonc` 继续绑定 `DATA` 和 `CACHE`。
- R2 是认证、权限和旧累计值的权威来源；KV 不可决定 Token、Scope、资源范围、过期、撤销和限流；无 `CACHE` 时业务照常工作。
- 原字段 `usageTotal`、`usageDaily`、`lastUsedAt` 保留且历史基线不清零；`GET /api/v1/keys` 仍为 `{items,total}`；新增展示字段只能是可选且不泄漏私有检查点。
- **旧统计口径:** 凭据已通过 Bearer 校验和限流、响应状态不为 `401`、`403`、`429` 才记一次；`404`、`422`、`5xx` 保留为“已授权使用”；`OPTIONS` 不计。
- KV 读改写非原子、同键写入最多每秒一次，计数只能近似；每请求不可产生比旧 Analytics 更多的 KV PUT；已知数据缺口显式标注。
- KV 多键 `get(keys, "json")` 每批最多 **100 keys**，返回 `Map`；每个完整 UTC 日需要 **24 × (4 shards + 1 legacy) = 120** 个键；两整天最多 **240** 键（原设计的“约 192”未计入 legacy）。
- 旧 R2 `keys/<id>/meta.json` 不批量重写；仅日结成功后对有正增量的 Key 采用 CAS。`usageDaily` 最多保留 31 天，私有 `usageAppliedDays` 最多 35 天，Analytics KV 小时桶原 TTL 35 天。
- Cron 沿用 `*/15 * * * *`；UTC 昨日最早在次日 **00:30** 开始结算；常规回看最多 3 日；禁止超过 KV TTL 的自动回补。
- 必须使用先失败再修复的 TDD；所有提交仅进独立功能分支，不直接修改 `main`、不合并 PR #6、不断言未经实际测量的提升百分比。
- 平台依据：[KV bulk read](https://developers.cloudflare.com/kv/api/read-key-value-pairs/) 与 [KV write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)。

## Review Focus

以下 5 个最容易在规格边界遗漏的场景，各自落实到指定任务的测试：

1. **无效 Bearer + 有效管理 Cookie** 不得回退到会话，也不得产生 `authorizedUses` → Task 1；其余拒绝码与 404/422/5xx 的差异同测。
2. **UTC 23:59/00:00 和 00:30 grace**：请求归属看 Analytics 时间戳，不看 Cron 发起时刻；任务不会过早完成昨天 → Tasks 3、5。
3. **KV Map 中缺失键、旧格式、损坏 JSON / 写入失败**：前二者兼容，损坏/失败不得推进日结完成标记；普通 API 不返回 500 → Tasks 3、5、6。
4. **R2 撤销、权限编辑、永久删除与日结并发**：CAS 保留最新安全字段，已删 Key 不复活，同一日期最多累计一次 → Task 4。
5. **KV 断连和应用回滚/重新部署后的混合格式**：管理端保留旧数字、标注近似或不可用，不能将无数据误称精确零；旧计数不会被新事件重复追加 → Tasks 1、6。

---

## File Ownership / Public Interfaces

本计划在第一轮 PR #6 已验证的分支 `perf/read-path-analytics-20261009` 基础上工作；设计与计划目前保存于 `design/api-key-kv-usage-20261009`。执行时从包含两份文档及 PR #6 代码的设计分支创建**新**功能分支，PR 以 `perf/read-path-analytics-20261009` 为 base，或先经审查将 PR #6 合并后再调整 base。

| 文件 | 唯一职责 |
|---|---|
| `src/worker/storage/analytics.ts` | 定义 `qualifiedKeyUse?: boolean` 事件字段；按 Key 写 `authorizedUses`、`lastAuthorizedAt`，导出读取共享的前缀和分片常量 |
| `src/worker/index.ts` | 采集最终状态的合格使用标记；沿用现有 `waitUntil`；维护 Cron 接入日结 |
| `src/worker/middleware/auth.ts` | 移除 `useApiKey` 同步等待及已失效的 `apiKeyUsage` 状态，完整保留认证/授权/限流 |
| `src/worker/storage/keys.ts` | 原有 R2 Key 模型与 CAS；保密 `usageAppliedDays`；提供 `applyAuthorizedUsageDay` 和一次扫描所得的 `listKeysWithUsageState` |
| **新** `src/worker/storage/key-usage.ts` | 读/验 KV 日快照（≤100/批）、合并“尚未落盘”的近似值、日结调度和完成标记 |
| `src/worker/routes/keys.ts` | 管理列表返回旧数字+近期估计的兼容公开结构 |
| `src/react-app/features/keys/api.ts` | 向前端声明可选 `usageApproximate/usageAsOf/usageStatus` |
| `src/react-app/features/keys/KeysPage.tsx` | “约”计数、延迟/不可用说明与 UTC 今日口径 |
| `tests/worker.test.mjs` | 复用 Miniflare 集成测试：安全、请求分类、R2 写削减、日结/列表合同 |
| **新** `tests/key-usage.test.mjs` | 隔离的假 KV Map/R2 CAS 交错测试；如直接导入 TS 不可用，使用现有 Miniflare Worker 编译产物，**不**新增生产依赖 |
| **新** `scripts/bench-key-usage.mjs` | 可重复的离线吞吐/操作数对照脚本；仅开发使用 |
| `docs/OPERATIONS.md` | 明确近似统计口径、KV 35 天 TTL、每日落盘、部署/回退及验证 |

### Shared interfaces (must remain identical between tasks)

```ts
// src/worker/storage/analytics.ts
export const ANALYTICS_PREFIX = "analytics:agg:";
export const ANALYTICS_SHARDS_COUNT = 4;
export type AnalyticsDataPoint = {
  timestamp: string; method: string; route: string; status: number;
  durationMs: number; authType: "session" | "api_key" | "anonymous" | "system";
  keyId?: string | null; resourceType?: string; error?: string | null;
  qualifiedKeyUse?: boolean;
};
// Hourly bucket.keys[keyId] receives authorizedUses?: number,
// lastAuthorizedAt?: string | null, keeping the old requests/4xx/429 fields.

// src/worker/storage/keys.ts
export type KeyWithUsageState = { key: ApiKey; usageAppliedDays: string[] };
export async function listKeysWithUsageState(env: Env): Promise<KeyWithUsageState[]>;
export async function applyAuthorizedUsageDay(
  env: Env, keyId: string, utcDay: string, increment: number,
  lastAuthorizedAt: string | null
): Promise<"applied" | "already_applied" | "missing" | "busy">;

// src/worker/storage/key-usage.ts
export type UsageIncrement = { count: number; lastUsedAt: string | null };
export type DailyUsageSnapshot = {
  day: string; status: "ok" | "unavailable";
  byKey: Record<string, UsageIncrement>; asOf: string | null;
};
export async function readDailyKeyUsage(
  env: Env, utcDay: string, nowMs?: number
): Promise<DailyUsageSnapshot>;
export async function listKeysWithEstimatedUsage(
  env: Env, nowMs?: number
): Promise<ApiKey[]>;
export async function settleRecentKeyUsage(
  env: Env, nowMs?: number
): Promise<{ scannedDays: string[]; applied: number; delayedDays: string[] }>;
```

`ApiKey` 在 `keys.ts` 和客户端 `features/keys/api.ts` 只**可选增加**字段
`usageApproximate?: true`、`usageStatus?: "ok" | "delayed" | "unavailable"`、
`usageAsOf?: string | null`；`usageAppliedDays` 仅在私有 R2 `StoredKey`，不得输出给 API。

### Task 1: Capture Authorized Use in Existing Analytics

**Files:**
- Modify: `src/worker/storage/analytics.ts:1-25,175-235`
- Modify: `src/worker/index.ts:32-90`
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Produces: `AnalyticsDataPoint.qualifiedKeyUse`, `ANALYTICS_PREFIX`, `ANALYTICS_SHARDS_COUNT`, bucket `keys[id].authorizedUses/lastAuthorizedAt`.
- Consumes: existing `c.get("apiKey")` only after authorization and rate limit.

- [ ] **Step 1: Write failing integration tests** named `key usage: only eligible Bearer responses record authorizedUses`. Use a Key with `rateLimitPerMinute:null`, inspect KV's 4 current-hour shards and assert one 200 and one authorized-but-404 increment `authorizedUses`, while invalid Bearer+Cookie, 403 and 429 do not. Assert a valid authorized 422/5xx when generated by a legitimate route still increment; legacy `requests` continues unchanged. Assert ISO `lastAuthorizedAt` matches the event's UTC day and no token/digest is serialized to KV.
- [ ] **Step 2: Run red tests.** `npm run build && node --test --test-name-pattern="key usage: only eligible Bearer responses record authorizedUses" tests/worker.test.mjs`. Expected assertion FAIL because existing analytics contains no `authorizedUses`.
- [ ] **Step 3: Implement the production interface.** Export existing prefix/shard constants, add `qualifiedKeyUse?: boolean`, pass it from `index.ts` using `Boolean(authenticatedKey) && ![401,403,429].includes(status)`; OPTIONS remains excluded. In `recordAnalytics` increment `authorizedUses` once and update maximum valid UTC ISO `lastAuthorizedAt` only for `dp.qualifiedKeyUse && dp.keyId`. Keep legacy `requests/count4xx/count429` and existing `waitUntil` unchanged; no additional KV PUT.
- [ ] **Step 4: Run green tests.** Same focused command; expected PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit.** `git add src/worker/index.ts src/worker/storage/analytics.ts tests/worker.test.mjs && git commit -m "feat: record qualified API key uses in existing KV analytics"`.

### Task 2: Remove Synchronous R2 Usage Writes

**Files:**
- Modify: `src/worker/middleware/auth.ts:1-75`
- Modify: `src/worker/storage/keys.ts:225-261`
- Test: `tests/worker.test.mjs` (replace obsolete `last-used time is recorded` assumptions)

**Interfaces:**
- Consumes: Task 1's global qualified-use event.
- Produces: unchanged `readApiKey` / `authorizeApiKey` / R2 permission checks, no `useApiKey` use from the request hot path.

- [ ] **Step 1: Add a failing R2 write-count test** `key usage: 1000 authorized reads never PUT key metadata`. In an isolated Worker request harness with a Proxy wrapping R2 `put`, issue 1000 serial authorized Bearer GETs on a Key configured with no rate limit, count exactly zero `put("keys/<id>/meta.json", ...)`. Assert R2 `get` authentication still occurs, invalid/expired/revoked Token and restricted resource status codes remain unchanged. Rewrite legacy test expectations to read last-use from `GET /keys` once Tasks 5-6 land; meanwhile assert the old `lastUsedAt` R2 snapshot is not altered by hot-path requests.
- [ ] **Step 2: Run red tests.** `npm run build && node --test --test-name-pattern="key usage: 1000 authorized reads never PUT key metadata" tests/worker.test.mjs`. Expected FAIL because `await useApiKey` writes R2.
- [ ] **Step 3: Remove the synchronous commit only.** Delete `apiKeyUsage` and `useApiKey` from `auth.ts` and remove obsolete `useApiKey` from `keys.ts` once callers are gone. Keep `readApiKey`, `authorizeApiKey`, `apiKeyId`, `apiKey`, activity identity, per-Key rate-limit check, resource check, and status handling untouched. Do not turn R2 Key metadata into a KV authentication cache.
- [ ] **Step 4: Verify.** Repeat focused test (PASS), then `npm run typecheck`; examine forbidden/revoked tests to ensure no privilege widening. No `CACHE` must still allow authorized calls.
- [ ] **Step 5: Commit.** `git add src/worker/middleware/auth.ts src/worker/storage/keys.ts tests/worker.test.mjs && git commit -m "perf: decouple API key usage bookkeeping from response path"`.

### Task 3: Read and Validate Bounded Daily KV Snapshots

**Files:**
- Create: `src/worker/storage/key-usage.ts`
- Test: `tests/key-usage.test.mjs`

**Interfaces:**
- Consumes: `ANALYTICS_PREFIX` / `ANALYTICS_SHARDS_COUNT` and Task 1's per-Key KV bucket fields.
- Produces: `readDailyKeyUsage(env, utcDay, nowMs) -> DailyUsageSnapshot`.

- [ ] **Step 1: Write failing tests** `key usage: daily reader batches 100 and rejects corrupt shards`. Fake `KVNamespace.get(keys, "json")` returns `Map<string, unknown>`; populate all 24 UTC hours × 4 shards plus legacy keys (120); assert exactly 2 bulk calls (sizes 100 and 20), count summation and latest timestamp for two Keys, no Token leakage. Current UTC day reads only elapsed hours, across 23:59/00:00 boundary. Missing key/null and old `keys[id].requests` without `authorizedUses` mean zero; invalid counts, malformed JSON/object and rejected bulk GET produce `status:"unavailable"` instead of a partial trusted snapshot. Empty/missing CACHE is unavailable. `asOf` denotes read time, not exact freshness.
- [ ] **Step 2: Run red tests.** `npm run build && node --test tests/key-usage.test.mjs`. Expected FAIL: `readDailyKeyUsage` is not yet implemented.
- [ ] **Step 3: Implement reader only.** Construct keys per hour with **4 shards + legacy** and UTC date validation, chunk into arrays ≤100, call `env.CACHE.get(keys, "json")` and validate the resulting Map of objects/null. Aggregate **only** numeric nonnegative integer `authorizedUses`, max finite ISO `lastAuthorizedAt`, and keep unknown legacy-only bucket fields ignored. Catch KV/parse failures and return whole-snapshot unavailable; do not silently accept malformed active buckets as zero.
- [ ] **Step 4: Run green.** `npm run build && node --test tests/key-usage.test.mjs`; `npm run typecheck`. Expected PASS.
- [ ] **Step 5: Commit.** `git add src/worker/storage/key-usage.ts tests/key-usage.test.mjs && git commit -m "feat: add bounded KV usage snapshot reader"`.

### Task 4: R2 CAS Day Checkpoint With Historical Baseline

**Files:**
- Modify: `src/worker/storage/keys.ts:10-52,99-102,140-261`
- Test: `tests/key-usage.test.mjs`
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Produces: `KeyWithUsageState`, `listKeysWithUsageState`, `applyAuthorizedUsageDay`.
- Consumes: Task 3 daily `UsageIncrement`; R2 `getJson`, `putJson` and ETags.

- [ ] **Step 1: Write failing tests** `key usage: daily R2 checkpoint is idempotent under concurrent edits`. Seed stored key with historical `usageTotal:117`, `usageDaily[day]:9`, `lastUsedAt`. Apply delta 3 twice: totals become 120/12 (not 123/15), `lastUsedAt` is max(old,new), `usageAppliedDays` contains the UTC day, and Key public JSON exposes none of the private marker/digest/ciphertext. In controlled CAS conflict, concurrently update scopes/name and revoke Key; retries must preserve the latest fields and revokedAt. `purgeKey` followed by checkpoint returns `"missing"` and does not recreate the record. Assert daily windows trim to 31 and 35 days; 0 increment cannot create unnecessary R2 PUT.
- [ ] **Step 2: Run red tests.** `npm run build && node --test tests/key-usage.test.mjs`; expected FAIL for missing checkpoint function or private-field leakage.
- [ ] **Step 3: Implement canonical R2 helper.** Add private `StoredKey.usageAppliedDays?: string[]`, explicitly strip from `publicKey`; refactor current `listKeys` to share **one** metadata scan with `listKeysWithUsageState` (no duplicate list). `applyAuthorizedUsageDay` must always read latest `keys/<id>/meta.json`, check already-applied and missing before CAS, preserve revoked/expired and credential fields, update only usage stats/marker, bounded CAS retry (8), and never resurrect purged keys. For retry, re-read fresh R2 metadata, never reapply stale snapshots.
- [ ] **Step 4: Run green.** Same focused command plus `npm run typecheck`; expected PASS.
- [ ] **Step 5: Commit.** `git add src/worker/storage/keys.ts tests/key-usage.test.mjs tests/worker.test.mjs && git commit -m "feat: retain API key usage in idempotent R2 day checkpoints"`.

### Task 5: UTC Daily Settlement Using Existing Cron

**Files:**
- Modify: `src/worker/storage/key-usage.ts`
- Modify: `src/worker/index.ts:160-183`
- Test: `tests/key-usage.test.mjs`
- Test: `tests/worker.test.mjs`

**Interfaces:**
- Produces: `settleRecentKeyUsage(env,nowMs) -> {scannedDays,applied,delayedDays}`.
- Consumes: Task 3 reader and Task 4 `applyAuthorizedUsageDay`.

- [ ] **Step 1: Write failing Cron tests** `key usage: scheduled settle respects 00:30 grace and crashes safely`. Inject controlled `ScheduledController.scheduledTime`: at UTC 00:15 yesterday stays untouched, at 00:30 previous day increments R2; repeated runs keep the same totals; verify replay if one Key CAS fails after others applied (global KV done marker must **not** advance), then successful retry catches up. If KV bucket is corrupted/missing binding, no day done marker is written. Seed shards around UTC 23:59 and 00:00 to prove correct per-day assignment. Verify management-edit/revoke race and permanent purge protections by calling scheduled/settler.
- [ ] **Step 2: Run red.** `npm run build && node --test tests/key-usage.test.mjs`; expected FAIL because settlement is not wired.
- [ ] **Step 3: Implement bounded settle.** Select yesterday/previous 2 days (max 3), never process yesterday before UTC 00:30, skip previously completed `keyusage:v2:done:<YYYY-MM-DD>` KV markers; cap at 100 R2 Key CAS attempts/run and allow next Cron to resume. Only put a completion marker with 35-day TTL after every positive-Key update is `applied` / `already_applied` / `missing`; if any is `busy` or KV data unavailable, leave day unmarked and record delayedDays. Key-level `usageAppliedDays` makes replay idempotent even if marker write fails. Use existing `scheduled` handler with `controller.scheduledTime`, preserving trash/activity/webhook maintenance. Never fail business API due to schedule errors.
- [ ] **Step 4: Run green + baseline.** `npm run build && node --test tests/key-usage.test.mjs` and `npm run typecheck`; expected PASS. Check 15-minute scheduled maintenance regression in existing worker tests.
- [ ] **Step 5: Commit.** `git add src/worker/index.ts src/worker/storage/key-usage.ts tests/key-usage.test.mjs tests/worker.test.mjs && git commit -m "feat: settle approximate API key usage daily with resumable cron"`.

### Task 6: Admin Compatibility Overlay and Honest UI

**Files:**
- Modify: `src/worker/storage/key-usage.ts`
- Modify: `src/worker/routes/keys.ts:40-45`
- Modify: `src/worker/storage/keys.ts` (public `ApiKey` optional fields only)
- Modify: `src/react-app/features/keys/api.ts:4-8`
- Modify: `src/react-app/features/keys/KeysPage.tsx:223-234`
- Test: `tests/worker.test.mjs`
- Test: `tests/key-usage.test.mjs`
- Browser Test: `tests/browser/keys.spec.ts` (if actual file differs, use the repository's existing API Key browser spec and note the verified path before editing)

**Interfaces:**
- Produces: `listKeysWithEstimatedUsage(env,nowMs) -> ApiKey[]`, public optional `usageApproximate/usageAsOf/usageStatus`.
- Consumes: Task 4 `listKeysWithUsageState` and Task 3 `readDailyKeyUsage`.

- [ ] **Step 1: Write failing API/UI tests** `key usage: manager sees R2 baseline plus only unapplied KV deltas`. Seed total 117, prior-day 9, new today 3, yesterday 2 and `usageAppliedDays` containing yesterday; assert public `usageTotal` is 120 (not 122) and today's `usageDaily` is 3, `lastUsedAt` is max, R2 stored baseline remains 117 until daily settlement. Force KV failure / missing CACHE and assert no API 500, no fake exact 0, `usageStatus:"unavailable"`; corrupted recent data similarly. Legacy Key with no counters still produces compatible fields. Browser text must show “约” and a visible, unobtrusive approximate/freshness explanation, with UTC date unchanged. `GET /keys` must remain session-only, with no private `usageAppliedDays` or token.
- [ ] **Step 2: Run red tests.** `npm run build && node --test --test-name-pattern="key usage: manager sees R2 baseline plus only unapplied KV deltas" tests/worker.test.mjs` and the selected Playwright API Key case; expected FAIL for absent overlay/metadata.
- [ ] **Step 3: Implement overlay/UI.** Management handler performs one R2 Key listing, one bounded KV read for UTC today and yesterday; for each Key add recent estimates **only** for days absent from its `usageAppliedDays`. Preserve R2 old fields on unavailable days; mark `delayed` when eligible uncheckpointed dates fall outside displayed window, `unavailable` on KV errors, otherwise `ok`. Add only optional public fields, no persisted UI-only numbers or API auth state. Keep current UTC `toISOString().slice(0,10)` today.
- [ ] **Step 4: Run green.** Repeat focused tests, `npm run typecheck` and API Key browser acceptance, expected PASS.
- [ ] **Step 5: Commit.** `git add src/worker/storage/key-usage.ts src/worker/storage/keys.ts src/worker/routes/keys.ts src/react-app/features/keys/api.ts src/react-app/features/keys/KeysPage.tsx tests/worker.test.mjs tests/key-usage.test.mjs tests/browser && git commit -m "feat: show compatible approximate API key usage in dashboard"`.

### Task 7: Cross-Version Acceptance, Metrics, Docs and PR

**Files:**
- Create: `scripts/bench-key-usage.mjs`
- Modify: `docs/OPERATIONS.md`
- Modify: `tests/worker.test.mjs`, `tests/key-usage.test.mjs` (only remaining integration gaps)
- Modify: actual API Key browser spec when necessary

**Interfaces:**
- Consumes: all Tasks 1–6.
- Produces: deterministic benchmark JSON, documented rollout/rollback and a reviewable feature PR against PR #6's branch.

- [ ] **Step 1: Add failing final regression tests** `key usage: mixed legacy and new buckets do not double count` and `key usage: KV errors do not alter Bearer authorization`. Exercise 35-day TTL expiration after R2 checkpoint, skip old legacy-only requests and test restarts/redeploy simulation (no destructive migration). Include 1000 authorized calls with R2 `keys/<id>/meta.json` PUT counter exactly 0, KV PUT count no greater than baseline Analytics write count, with identical R2 GET per-call credential verification.
- [ ] **Step 2: Run red.** `npm run build && node --test --test-name-pattern="key usage:" tests/worker.test.mjs` and `node --test tests/key-usage.test.mjs`. A missing rollback/mixed-format guard must fail before changing code.
- [ ] **Step 3: Implement only minimal missing behavior and benchmark.** Add `scripts/bench-key-usage.mjs` to execute same isolated 1000-request scenario against baseline PR #6 SHA and candidate build; record R2 key-meta GET/PUT, KV GET/PUT, p50/p95 ms. Use fake/instrumented bindings consistently; never send requests to production. Document that counts remain approximate and that no statistically valid production speedup is guaranteed.
- [ ] **Step 4: Run complete gates.** `npm run typecheck`, `npm run test`, `npm run test:browser` and `node scripts/bench-key-usage.mjs`. Confirm 0 failures, record exact totals and raw benchmark outputs; if any fails, stop, fix and rerun all. Complete `docs/OPERATIONS.md` release/rollback and UTC settlement runbook.
- [ ] **Step 5: Inspect actual diff and commit.** Verify no authentication changes, no new database, no secret fields leaked, no duplicate daily counts, no changed Bin files. `git add scripts/bench-key-usage.mjs docs/OPERATIONS.md tests && git commit -m "test: verify KV key usage migration and document safe rollout"`.
- [ ] **Step 6: Publish review PR only.** Push isolated implementation branch, open a PR **against `perf/read-path-analytics-20261009` unless PR #6 has already been merged**, attach CI logs/benchmark measurements and migration risks. Do not auto-merge or deploy; wait for acceptance.

## Self-Review and Release Gates

- Spec `1` security, compatibility, performance: Tasks 1,2,4,6,7.
- Spec `3.1` request hot path: Tasks 1–2; `3.2` R2 checkpoint: Tasks 3–5; `3.3` dashboard: Task 6.
- Spec `4` failure/rollover: Tasks 1,3,4,5,6,7.
- Spec `5` complete affected files: Tasks 1–7; no new bindings; `6` test/bench: Task 7; `7` rollback/docs: Task 7.
- Five `Review Focus` cases each have explicit tests above.
- Cross-component identifiers are exactly `qualifiedKeyUse`, `authorizedUses`, `lastAuthorizedAt`, `usageAppliedDays`, `readDailyKeyUsage`, `applyAuthorizedUsageDay`, `listKeysWithUsageState`, `listKeysWithEstimatedUsage`, `settleRecentKeyUsage`.
- **No deployment or merge authorization is implied by plan approval.** Implementation approval permits only feature-branch work and opening a PR for review.
