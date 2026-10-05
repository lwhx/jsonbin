# JSONBin v3.1 数据完整性与输入边界实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为全部 JSON API 建立一致的字节/深度/ID边界，并保证并发失败 payload 和中断创建不会泄漏到历史、恢复或备份。

**架构：** 复用系统管理接口已有的有界流读取，新增共享业务 JSON 验证；以 reservation metadata + commit receipt 区分 v3.1 已提交历史与失败预留；创建先发布不可见 pending metadata，再写正文并 CAS 激活。旧对象保持兼容且不执行破坏性迁移。

**技术栈：** Cloudflare Workers、Hono、R2、TypeScript、Zod、Miniflare、Node test

**规格：** `docs/superpowers/specs/2026-10-05-v3-1-hardening-design.md` §4、§5。

---

## 文件结构

### 创建

- `src/worker/lib/bounded-json.ts` — 路由级 UTF-8/字节读取和错误映射。
- `src/worker/validation/business-json.ts` — 业务值深度、紧凑字节、有限数字验证。
- `src/worker/storage/reservations.ts` — reservation/receipt 键、校验和清理协议。
- `tests/json-boundaries.test.mjs` — 真实 Worker 输入边界。
- `tests/reservations.test.mjs` — 确定性 CAS 和中断状态机。

### 修改

- `src/worker/routes/bins.ts`
- `src/worker/routes/schemas.ts`
- `src/worker/routes/collections.ts`
- `src/worker/routes/keys.ts`
- `src/worker/routes/trash.ts`
- `src/worker/routes/system.ts`
- `src/worker/storage/r2.ts`
- `src/worker/storage/bins.ts`
- `src/worker/storage/schemas.ts`
- `src/worker/storage/backup-export.ts`
- `src/worker/storage/backup-restore.ts`
- `src/worker/storage/search.ts`
- `src/worker/storage/system.ts`
- `src/worker/storage/trash.ts`
- `src/worker/validation/schema.ts`
- `src/shared/schema-validation.ts`
- `tests/worker.test.mjs`
- `tests/backup-export.test.mjs`
- `tests/backup-restore.test.mjs`
- `tests/security.test.mjs`
- `docs/ARCHITECTURE.md`
- `docs/DEVELOPMENT.md`

---

### 任务 1：统一有界 JSON 读取

**文件：**
- 创建：`src/worker/lib/bounded-json.ts`
- 创建：`tests/json-boundaries.test.mjs`
- 修改：各 JSON route 文件

- [ ] 先写真实 Worker 测试：虚假 `Content-Length`、流式超限、非法 UTF-8、非法 JSON和每类端点上限。
- [ ] 运行定向测试确认 RED：普通 Bin/Schema 路由仍无界解析。
- [ ] 将 `readBoundedJson` 从 system-only helper 提升为共享 helper，区分 `payload_too_large`、`invalid_utf8`、`invalid_json`。
- [ ] 按规格将登录 4 KiB、小请求 64 KiB、Schema 请求 128 KiB、Bin/样本 1 MiB、系统恢复 10 MiB 显式传入。
- [ ] 运行定向测试确认所有错误在任何 R2 PUT 前返回。
- [ ] Commit：

```bash
git commit -m "fix(API): 限制所有 JSON 请求正文"
```

### 任务 2：最终业务 JSON 大小与深度

**文件：**
- 创建：`src/worker/validation/business-json.ts`
- 修改：Bin/Schema storage 与 route
- 测试：`tests/json-boundaries.test.mjs`、`tests/worker.test.mjs`

- [ ] 写失败测试：创建、PUT、Merge Patch、deep PUT 的请求本身小但最终值超过 1 MiB或 64 层；断言 413/422 且无版本对象。
- [ ] 实现一次紧凑序列化返回 `{text, bytes}`，迭代深度检查避免递归栈溢出，拒绝非有限数字。
- [ ] 让所有 Bin 写路径在 reservation 前复用 helper；Schema validate 使用同样值边界。
- [ ] 改造 `putJson` 支持已序列化文本，新业务正文不 pretty-print，旧对象读取不变。
- [ ] 运行定向测试和备份边界回归。
- [ ] Commit：`fix(存储): 统一 JSON 值容量边界`。

### 任务 3：统一资源 UUID 边界

- [ ] 写失败 Scope/路由矩阵：超长、非 UUID 和编码异常 ID 不触发 R2 GET，统一 404。
- [ ] 新增 route param UUID helper，应用到 Bin、Collection、Schema、Key、Trash、search filter 中的资源 ID。
- [ ] 保留 `/value/*` JSON Pointer 路径行为，不把 value path 当 UUID。
- [ ] 运行权限矩阵和公开/私有存在性回归。
- [ ] Commit：`fix(API): 统一资源标识校验`。

### 任务 4：Schema pattern CPU 边界

- [ ] 写失败测试：pattern 超 256、嵌套重复量词、模糊重复分支、64 KiB 以上被匹配字符串；合法邮箱/Unicode/本地引用保持通过。
- [ ] 在定义校验阶段实现保守高风险结构拒绝；错误映射为 `invalid_schema` 且包含 pattern path。
- [ ] 在运行校验前限制字符串长度，避免低权限 `schema:read` 触发超长 RegExp。
- [ ] 使用定时预算测试只作为补充，不依赖易抖动的毫秒阈值做唯一断言。
- [ ] Commit：`fix(模型): 限制高风险正则校验`。

### 任务 5：版本/修订 reservation 与 receipt

- [ ] 写确定性竞态 RED：两个同 ETag 请求按“先预留 A、预留 B、B 发布、A 412”顺序执行；A payload 不出现在历史/读取/恢复/备份。
- [ ] 定义 reservation custom metadata 与 `commits/<number>.json` receipt；新增键和校验 helper。
- [ ] 用 metadata 高水位 + 最多 8 次条件创建替代完整目录扫描。
- [ ] 发布 metadata 后写 receipt；下一次写入前补齐当前 canonical 指向对象的缺失 receipt。
- [ ] 历史、restore、export 过滤无 receipt 的新 reserved 对象；遗留无 reservation 对象继续可读。
- [ ] CAS 失败尽力删除本 reservation，删除失败仍保持不可见。
- [ ] 对 Schema revisions 实施同一协议。
- [ ] 运行 Bin/Schema 并发、历史、备份、计数耗尽回归。
- [ ] Commit：`fix(历史): 隔离失败的版本与修订预留`。

### 任务 6：Bin/Schema pending 创建状态机

- [ ] 写故障注入 RED：pending meta 成功而正文失败、正文成功而激活失败、Worker 重试；普通 API/search/export/statistics 全部隐藏。
- [ ] 创建先条件写 pending canonical meta（创建 ID、指纹、时间），再条件写正文，验证依赖，最后 CAS 激活。
- [ ] 相同创建 ID/指纹允许安全续作；不同内容不能接管 pending。
- [ ] Cron 分批清理超过 24 小时且 ETag 未变化的 pending 及其专属正文。
- [ ] 统计 stored bytes 仍计入 pending，业务数量不计入。
- [ ] 运行 restore pending、搜索和 Cron 回归。
- [ ] Commit：`fix(创建): 使用可恢复的待发布状态`。

### 任务 7：完整验证和文档

- [ ] 运行 typecheck、build、json boundaries、reservation、worker、backup、security 全套 Node 测试。
- [ ] 运行 API Scope 路由矩阵，确认新 helper 没有改变权限语义。
- [ ] 更新 ARCHITECTURE 的 R2 key、pending/reservation/receipt 和兼容规则。
- [ ] 更新 DEVELOPMENT，记录精确测试数和未部署状态。
- [ ] 独立审查数据丢失、崩溃窗口和兼容性；修复后完整重跑。
- [ ] Commit：`docs(v3.1): 记录数据完整性加固验收`。
