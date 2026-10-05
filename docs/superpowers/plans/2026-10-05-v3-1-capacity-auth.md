# JSONBin v3.1 容量、后台任务与认证实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将全量 R2 扫描和热点认证写入改造成有界分页/批次任务，并加入登录限流、可撤销 Session 和独立 API Key 明文加密。

**架构：** 所有面向用户的列表采用签名 cursor 和 limit；旧无参数调用保留 200 条兼容边界。Cron 和集合删除保存 R2 checkpoint、每批处理 50 项。认证继续以 R2 为权威，KV 不参与安全决策；登录失败窗口、Session sid 和凭据加密均使用独立的权威 R2 对象。

**技术栈：** Cloudflare Workers、Hono、R2、KV、WebCrypto、React Query、Playwright、Node test

**规格：** `docs/superpowers/specs/2026-10-05-v3-1-hardening-design.md` §6–§10。

---

## 文件结构

### 创建

- `src/worker/lib/cursor.ts` — cursor 签名、绑定与解析。
- `src/worker/storage/checkpoints.ts` — Cron/集合删除 continuation。
- `src/worker/auth/rate-limit.ts` — 登录失败窗口和匿名标识 HMAC。
- `src/worker/auth/session-store.ts` — sid、generation 和清理。
- `tests/pagination.test.mjs`
- `tests/maintenance-budget.test.mjs`
- `tests/auth-hardening.test.mjs`
- `scripts/check-bundle-budget.mjs`（若网页计划尚未创建）
- `eslint.config.js`
- `tests/support/python-command.mjs`

### 修改

- 所有 list route/storage/client/page
- `src/worker/storage/r2.ts`
- `src/worker/storage/trash.ts`
- `src/worker/storage/collections.ts`
- `src/worker/storage/keys.ts`
- `src/worker/routes/auth.ts`
- `src/worker/auth/session.ts`
- `src/worker/middleware/auth.ts`
- `src/react-app/features/*/api.ts` 与列表页
- `package.json`、`package-lock.json`
- `.github/workflows/v3-ci.yml`
- `wrangler.jsonc`、`.dev.vars.example`
- ZIP/文档/活动测试
- README、ARCHITECTURE、DEVELOPMENT、OPERATIONS、内置 API docs

---

### 任务 1：共享签名 Cursor 与有界 R2 读取

- [ ] 写失败测试：cursor 篡改、跨资源/limit/filter 使用、超长、inventory 变化；metadata GET 并发不超过 16。
- [ ] 用 `SESSION_SECRET` 派生 cursor HMAC key，cursor 只包含版本、资源、limit、锚点和筛选摘要，不包含 Secret。
- [ ] 将 `listJsonObjects` 改为接受 limit/cursor/budget，16 并发批量读取并返回 continuation，不再默认扫完整前缀。
- [ ] 运行现有 search cursor 回归，避免产生第二套不兼容编码规则。
- [ ] Commit：`feat(API): 添加通用签名分页游标`。

### 任务 2：资源列表和历史分页 API

- [ ] 逐个为 Bins、Collections、Schemas、Keys、Trash、Collection members、Bin history 写 RED：limit 1–100、nextCursor、无重复/遗漏、状态变化处理。
- [ ] 新模式响应 `{items,nextCursor,total}`；无法权威低成本计算 total 时为 null。
- [ ] legacy 无参数模式最多 200 条，超限返回 `503 list_limit_exceeded`，不返回部分数据。
- [ ] 更新客户端为 Infinite Query/加载更多；详情只请求当前页和选中版本。
- [ ] 移除 Bin 每 30 秒全量刷新；创建/更新后精确 invalidation。
- [ ] 更新 API docs 三语言示例和契约测试。
- [ ] Commit：`feat(API): 为资源列表和历史添加分页`。

### 任务 3：Overview 摘要和 Collection member 派生索引

- [ ] 写 KV 缺失/损坏/最终一致和 R2 回退预算测试。
- [ ] 增加可重建 overview summary 与 collection-member index；资源写入 best-effort 同步。
- [ ] 返回前复核 canonical metadata、TTL、pending/deleted 状态和 collectionId。
- [ ] R2 回退超过预算明确 unavailable，不扫描全库。
- [ ] 前端概览在摘要不可用时显示不可用，不伪造 0。
- [ ] Commit：`perf(概览): 使用可重建的有界摘要索引`。

### 任务 4：Cron 有界批次和 purged 跳过

- [ ] 写 RED：`purged` 标记不产生版本 LIST/KV 同步/计数；200 个到期项单次只处理 50，保存 checkpoint，四次续作完成。
- [ ] checkpoint 记录 R2 key cursor 和扫描 generation；每批保留至少 100 个内部调用余量。
- [ ] 到期、purging、pending 创建和 Session 清理使用独立 checkpoint，失败不阻断其他维护类。
- [ ] 活动 retention 在业务批次后运行且有独立预算。
- [ ] Commit：`fix(Cron): 分批续作生命周期维护`。

### 任务 5：集合删除分批续作

- [ ] 写 200 成员测试，单次最多解除 50；并发移入/移出/JSON 保存不被覆盖。
- [ ] DELETE 首次 CAS 标记 deleting，返回 202 + progress + continuation；重复 DELETE 或 Cron 从 checkpoint 继续。
- [ ] 每项解除前复核 canonical ETag 与 collectionId；错误保留可重试状态。
- [ ] 前端显示进度并有界轮询，离页不取消服务端状态机。
- [ ] Commit：`fix(集合): 分批续作成员解除`。

### 任务 6：API Key lastUsedAt 节流

- [ ] 写高并发认证测试：授权每次读取 canonical，10 分钟内不重复写 lastUsedAt；时间戳 CAS 失败不阻断业务；撤销竞争仍拒绝新请求。
- [ ] 将 `useApiKey` 拆为权威认证和 best-effort touch；Scope/过期/撤销判断在 touch 前完成。
- [ ] 仅超过 10 分钟时 touch，一次 CAS，不循环 8 次阻断请求。
- [ ] Commit：`perf(密钥): 降低最后使用时间写入争用`。

### 任务 7：登录限流和活动采样

- [ ] 写 RED：同一 `CF-Connecting-IP` 15 分钟第 11 次失败返回 429 + Retry-After；伪造 X-Forwarded-For 无效；成功清除窗口；原始 IP 不落盘。
- [ ] 使用 `SESSION_SECRET` HMAC 标识和 R2 CAS 窗口；全局窗口使用单独高阈值。
- [ ] 活动只写首次、达到阈值和窗口结束/成功摘要，敏感输入不进入记录。
- [ ] OAuth state/callback 失败共用限制；上游 fetch 加 10 秒超时和有界 JSON 响应。
- [ ] OPERATIONS 增加 Cloudflare WAF/Rate Limiting 配置验收，不把应用限制描述为 DDoS 防护。
- [ ] Commit：`feat(认证): 添加登录失败限流`。

### 任务 8：可撤销 Session

- [ ] 写 RED：登录创建 sid；复制 Cookie 后 logout 原会话立即 401；generation 递增使全部旧 Cookie 失效；过期清理有界。
- [ ] Session payload 增加 sid/generation，R2 `system/sessions/<sid>.json` 保存用户/provider/expiry/generation。
- [ ] `readSession` 验证签名后读取权威 sid；logout 删除 sid；设置 API 提供注销全部 Session。
- [ ] 前端设置页增加带确认的“注销全部会话”，成功后清缓存并回登录页。
- [ ] 增加旧无 sid Cookie 的明确迁移策略：部署后视为未认证，README 标记需要重新登录。
- [ ] Commit：`feat(会话): 支持服务端撤销和全部注销`。

### 任务 9：独立 API Key 明文加密 Secret 与重新认证

- [ ] 写 RED：新 Key 密文不能用 SESSION_SECRET 解密；缺 TOKEN_ENCRYPTION_SECRET 时创建返回 503；旧算法 reveal 后条件迁移；摘要认证不受影响。
- [ ] `env.d.ts`、`.dev.vars.example`、wrangler types 添加 `TOKEN_ENCRYPTION_SECRET`，长度至少 32。
- [ ] StoredKey 持久化 encryptionVersion，AES-GCM 新记录只用新 Secret；旧记录按版本兼容。
- [ ] 增加 10 分钟 reauth receipt：密码管理员重新输入密码；GitHub 管理员重新走 OAuth；receipt 为 Session sid 绑定、短期 R2 状态。
- [ ] reveal 未满足返回 403 `reauth_required`；前端打开站内重新认证流程后重试。
- [ ] OPERATIONS 明确“先 Secret、后代码”的部署顺序和回滚策略。
- [ ] Commit：`feat(密钥): 使用独立 Secret 保护可显示令牌`。

### 任务 10：Windows 测试可移植性

- [ ] 创建 python command helper，探测 `python3`、`python`、`py -3`；替换 ZIP/文档测试硬编码。
- [ ] curl UTF-8 示例通过临时 UTF-8 文件 + `--data-binary`，Linux/Windows 均断言中文原文。
- [ ] 活动 2010 对象夹具按 16 并发批量写入，避免 socket close。
- [ ] 在当前 Windows 实际运行 `npm test`，必须 0 failed。
- [ ] Commit：`test(跨平台): 修复 Windows 验收环境`。

### 任务 11：ESLint、覆盖率、容量和 Bundle 门禁

- [ ] 添加 ESLint flat config 与 `npm run lint`，只修实际 error，不做全仓格式化；warning 预算 0。
- [ ] 加入 c8 或 Node coverage，先为新状态机设置文件级基线，不用虚高全局阈值阻塞旧代码。
- [ ] R2/KV 计数代理断言列表/Cron/集合删除 < 900 内部调用。
- [ ] 接入网页计划的 `check:bundle`；CI 顺序为 npm ci、lint、typecheck、build/bundle、Node tests、browser tests。
- [ ] Commit：`ci: 增加静态质量和容量门禁`。

### 任务 12：完整发布文档和验收准备

- [ ] 同步 README、ARCHITECTURE、DEVELOPMENT、OPERATIONS、内置 API docs。
- [ ] 运行 `npm ci`、lint、typecheck、build、bundle、完整 Node tests、完整 Chromium tests、production probe、`git diff --check`。
- [ ] 独立审查安全、容量、迁移和数据完整性；所有真实缺陷修复后重跑。
- [ ] 输出 Secret/WAF/隔离恢复/生产 smoke 的人工发布清单；不自动部署、push 或触碰生产数据。
- [ ] Commit：`docs(v3.1): 完成生产加固发布说明`。
