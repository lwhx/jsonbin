# JSONBin v3.1 网页与生产加固设计

> 日期：2026-10-05（Asia/Shanghai）
>
> 基线：`main` / `520165d`
>
> 目标版本：`3.1.0`
>
> 状态：用户已确认方案 A

## 1. 范围

本阶段修复代码审查和生产验证中确认的问题，并完成相应的容量、安全、性能、测试和维护性优化。保持 Cloudflare Workers + Hono + R2 + KV + React/Vite 架构，不引入 Durable Objects、Queues、Workflows、D1 或外部数据库。

本阶段明确排除：

- 移动端导航和移动端整体改版；
- 框架迁移；
- 多用户或多租户；
- 与审查结论无关的新业务功能；
- 未经单独确认的生产部署、Git push 和生产数据写入。

## 2. 不变约束

1. R2 继续保存全部权威业务和安全状态；KV 只保存可重建索引或短期派生状态。
2. Bin 版本和 Schema 修订正文不可覆盖；并发发布使用 R2 条件写入。
3. 显式 `Authorization` 不回退 Cookie 或匿名公开访问。
4. 管理接口继续保持 Session-only。
5. 公开 Bin 只开放当前快照和深层读取，不开放列表、历史和写入。
6. 所有 API 继续使用 `Cache-Control: no-store` 和 `X-Request-ID`。
7. 现有业务备份不包含 Session、API Key、活动记录、KV 和安全 Secret。

## 3. 交付拆分

实现分为六个可独立验证的工作包。每个工作包先增加失败测试，再实施最小修复，并在完成后运行定向测试。最后统一执行完整门禁。

### 3.1 桌面网页交互正确性

#### 创建弹窗

- 创建请求开始后，右上角关闭、取消、Escape 和遮罩关闭全部禁用。
- 组件维护 generation/mounted 状态；弹窗被卸载、退出登录或请求被显式停止后，迟到响应不得调用 `onCreated` 或改变路由。
- `AbortController` 只停止等待，不声称撤销已经到达服务器的写入。
- 浏览器回归覆盖：提交 → pending → 尝试关闭 → 迟到成功/失败。

#### 导入草稿保护

- `ImportPanel` 向 `SettingsPage` 暴露独立的 `dirty` 和 `busy`。
- 已解析的普通文件、已解析的备份、编辑后的目标名称均属于未提交草稿。
- 完成导入、显式重置或退出时清除草稿状态；仅传输完成不自动丢弃结果展示。
- 站内导航、退出登录和 `beforeunload` 使用相同的合并保护状态。

#### Hash 历史导航

- 取消浏览器 Back 时不得用当前详情地址覆盖已经遍历到的历史项。
- 路由层维护当前 history entry 的单调索引；取消 `popstate/hashchange` 导航时按方向执行一次受控 `history.go()` 恢复原 entry，并忽略恢复产生的内部事件。
- 站内导航继续使用明确的 push；删除成功等替换行为继续使用 replace。
- 回归覆盖：列表 → 详情 → 草稿 → Back → 取消 → 再次 Back → 接受，最终必须回到列表而非越过列表。

#### 认证与缓存状态

- `/auth/me` 网络错误或 5xx 显示独立错误页和重试，不渲染登录表单。
- `/auth/config` 未完成或失败时不推断密码登录已启用。
- 退出成功后取消在途请求并清空整个 React Query 缓存，避免 `staleTime: Infinity` 的历史值跨登录保留。

#### Tabs 与页面拆分

- Bin 详情 Tabs 实现 roving `tabIndex`、ArrowLeft/ArrowRight、Home/End、`aria-controls` 和 `aria-labelledby`。
- 将 `AuthenticatedApp` 壳、Overview、Bins 列表、CreateBinDialog 从 `App.tsx` 拆为聚焦组件。
- Settings、Docs、Activity、Keys、Trash、Schemas、Collections 和 Search 页面使用 `React.lazy` 按页面加载；Monaco 继续按需加载。
- 拆分不得改变桌面视觉信息架构和现有 URL。

## 4. 输入边界与 Schema 安全

### 4.1 统一有界 JSON 读取

所有 JSON API 在解析前使用流式字节计数，不信任 `Content-Length`：

| 输入 | 上限 |
| --- | ---: |
| 登录 | 保持 4 KiB |
| 小型元数据、Collection、Key、Trash 批次 | 64 KiB |
| Schema 定义请求 | 128 KiB，Schema 正文本身仍限 64 KiB |
| Bin 创建、完整替换、Merge Patch、深层写入、Schema 样本验证 | 1 MiB |
| 系统导入/恢复 | 保持现有 10 MiB 批次限制 |

超过上限返回 `413 payload_too_large`；非法 UTF-8 或 JSON 返回稳定的 400/422，不产生 R2 写入。

### 4.2 最终业务值验证

- Bin 创建、PUT、Merge Patch 和深层 PUT 在任何版本预留前，对最终 JSON 值执行 1 MiB 紧凑 UTF-8 大小和最大 64 层业务深度检查。
- 值必须是标准 JSON 数据；拒绝非有限数字和无法序列化结构。
- Schema `/validate` 的样本使用同样的 1 MiB/64 层边界。
- R2 写入复用已经生成的紧凑序列化结果，避免同时持有 compact、pretty 和额外编码副本；新业务对象不再 pretty-print，读取保持兼容旧对象。

### 4.3 JSON Schema pattern

- `pattern` 最长 256 个字符。
- 被 pattern 检查的单个字符串最长 64 KiB。
- 定义阶段拒绝已知灾难性回溯结构，包括量词包裹的重复量词和重复的模糊分支。
- 保留现有 JavaScript RegExp 兼容性，不引入运行时代码生成或 `unsafe-eval`。
- 测试覆盖嵌套量词、长字符串和合法常用表达式。

### 4.4 资源标识

所有 Bin、Collection、Schema、Key 和 Trash 路由在访问 R2 前统一验证规范 UUID。非法 ID 返回 404，避免存在性差异和异常长度键。

## 5. 版本、修订与创建完整性

### 5.1 新版本预留协议

新写入对象使用随机 `reservationId`，并在 R2 custom metadata 标记为 reserved。成功流程：

1. 读取当前 canonical metadata 并验证权限、锁、ETag 和 Schema。
2. 从 metadata 的 `nextVersion`/`nextRevision` 开始条件创建保留对象；碰撞时有限递增，不扫描完整历史。
3. CAS 发布 canonical metadata。
4. 创建不可变 commit receipt，记录资源 ID、序号、reservationId 和正文 ETag。
5. 下一次写入前确保当前版本的 receipt 存在，从而修复“metadata 已提交、receipt 尚未写入”之间的中断。

历史、导出和恢复仅接受：

- 没有 reservation metadata 的遗留对象；
- 有有效 commit receipt 的新对象；
- canonical metadata 当前明确指向的新对象。

CAS 失败时尽力删除本请求的 reserved 对象；即使清理失败，没有 receipt 的失败 payload 也不会出现在历史、恢复和备份中。

### 5.2 创建状态机

Bin 和 Schema 创建改为：

1. 条件创建 `pending` canonical metadata，包含创建 ID、内容指纹和开始时间；
2. 条件创建版本/修订正文；
3. 验证写入内容和依赖；
4. CAS 发布为活动 metadata；
5. 发布失败时保留不可见 pending，供清理程序处理。

普通列表、读取、搜索、备份和统计隐藏 pending。Cron 只清理超过 24 小时且仍为 pending 的创建记录及其专属正文；清理前重新读取并检查 ETag，不能删除已发布资源。

### 5.3 遗留兼容

- 旧版本/修订没有 reservation metadata，继续视为已提交。
- 已存在的 orphan 保持可读取兼容一次发布周期，但在首次索引重建时识别并生成只读报告；不自动删除无法证明来源的旧对象。
- v3.1 新产生的失败预留不会暴露。

## 6. 列表分页与 Cloudflare 调用预算

### 6.1 API 契约

Bins、Collections、Schemas、Keys、Trash、Collection members 和 Bin history 新增：

```text
?limit=1..100&cursor=<opaque>
```

分页响应保留 `items`，新增 `nextCursor`。`total` 在能从权威摘要得到时返回数字，否则返回 `null`，并在前端改用“已加载数量”和 `nextCursor` 判断结束。

兼容规则：

- 带 `limit` 或 `cursor` 使用分页模式。
- 不带分页参数的旧客户端使用 legacy 模式；最多读取 200 个有效资源。超过边界返回明确的 `503 list_limit_exceeded`，绝不静默截断。
- API 文档和生成示例全部改用分页模式。

游标签名并绑定资源类型、limit、筛选条件和 R2 扫描锚点；错误、跨查询或过长游标返回 400。

### 6.2 R2 读取

- metadata body 读取并发限制为 16。
- 每次请求显式维护内部调用预算；接近阈值时返回可继续的 cursor，而不是继续无界读取。
- 列表按稳定 R2 key 顺序分页；前端不再假设全局 `updatedAt` 排序。
- Overview 最近更新改从受限的派生摘要读取，摘要失效时显示“暂不可用”而不是全库扫描。
- Collection member index 为可重建派生索引；返回前复核 canonical Bin metadata。KV/R2 派生索引失效时使用有上限的 R2 回退，不能影响权限判断。

### 6.3 前端分页

- 各列表和历史页使用“加载更多”或页码，不自动抓取全部页面。
- Bin 列表取消每 30 秒全量 refetch；仅当前可见页按需刷新，创建/更新/恢复后精确失效相关查询。
- 历史 Diff 只请求选中的两个版本，不缓存整个历史正文集合。

## 7. 后台维护与批量操作

### 7.1 Cron

- `purgeState === "purged"` 立即跳过，不同步索引、不扫描版本目录、不增加 purged 计数。
- 单次 Cron 最多处理 50 个到期或 purging Bin，并将 continuation/checkpoint 保存到 R2。
- 每个批次保留内部调用余量，再执行活动保留清理。
- 下次 Cron 从 checkpoint 继续；完成一轮后删除 checkpoint。
- pending 创建清理和 Session 过期清理也使用独立的小批次预算。

### 7.2 集合删除

- 每次 DELETE 最多解除 50 个成员，返回 `202`、当前进度和 continuation；重复请求或 Cron 继续处理。
- 前端显示“删除处理中”，轮询有界状态；页面关闭不影响服务端 continuation。
- 每次解除前复核 Bin canonical metadata 和集合 ID，不能覆盖并发迁移或 JSON 保存。

### 7.3 版本号分配

使用 metadata 高水位和有限条件创建替代每次全目录扫描。版本列表本身通过分页 API读取，不影响写入成本。

## 8. 认证与凭据加固

### 8.1 登录限流

应用层使用 R2 强一致条件写入维护匿名登录失败窗口：

- 客户端标识只信任 `CF-Connecting-IP`；使用 `SESSION_SECRET` HMAC 后存储，不保存原始 IP。
- 每个标识 15 分钟最多 10 次失败；全局窗口设置高阈值防止明显洪泛。
- 超限返回 429 和 `Retry-After`。
- 成功登录清除对应失败窗口。
- 登录失败活动只记录首次、达到阈值和窗口结束摘要，不逐请求写 R2。
- OAuth state/callback 的无效失败同样受限；GitHub 上游请求增加 10 秒超时和响应大小限制。

运维文档要求生产环境同时配置 Cloudflare WAF/Rate Limiting。应用层限制是纵深保护，不宣称能独立抵御大规模分布式攻击。

### 8.2 可撤销 Session

- Session payload 增加随机 `sid`。
- 登录时在 `system/sessions/<sid>.json` 创建带到期时间的权威记录。
- 每次 Session 认证读取该记录并核对用户、provider 和 expiry。
- Logout 删除当前 sid；被复制的同一 Cookie 随即失效。
- 设置页增加“注销全部会话”，通过递增 `system/auth/session-generation.json` 使所有旧 Session 失效。
- Cron 分批清理过期 Session。

### 8.3 API Key 明文加密

- 新增必需 Secret：`TOKEN_ENCRYPTION_SECRET`，至少 32 字符，只用于 API Key 明文 AES-GCM 加密。
- 新创建 Key 不再使用 `SESSION_SECRET` 加密。
- 旧记录通过持久化的 encryption algorithm/version 继续使用旧 Secret 解密；成功 reveal 后可在同一条件写中迁移为新 Secret。
- 未配置新 Secret 时禁止创建新的可再次显示 Key，返回 503；现有摘要认证不受影响。
- reveal 操作要求最近 10 分钟内重新验证管理员密码或 GitHub OAuth；未满足返回 `reauth_required`。
- 部署顺序必须先配置 Secret，再发布代码。

### 8.4 API Key 使用时间

- 认证仍每次读取权威 Key metadata，保持即时撤销。
- `lastUsedAt` 仅在旧值超过 10 分钟时 best-effort 条件更新。
- 时间戳更新冲突或失败不阻断已经通过的认证请求；撤销、过期和 Scope 判断仍然阻断。

## 9. 测试、依赖与质量门禁

### 9.1 Windows 可移植性

- 测试 helper 探测 `python3`、`python` 和 Windows `py -3`，所有 ZIP/文档测试统一调用 helper。
- curl 示例测试使用 UTF-8 临时正文文件和 `--data-binary`，避免 Windows 控制台代码页改变中文。
- 活动保留夹具以有限并发批量写入 2010 个对象，避免 Miniflare/Undici socket 关闭。

### 9.2 静态质量

- 添加 ESLint flat config，覆盖 TS/TSX/MJS；CI 对 error 零容忍，warning 初始预算为零。
- 不在本阶段引入 Prettier 或进行无关格式化。
- 增加覆盖率报告和关键模块最低基线；首先覆盖本阶段新增状态机、限流、分页和 UI 行为。

### 9.3 Bundle budget

- 初始客户端入口压缩前不超过 450 KiB、gzip 不超过 140 KiB。
- Monaco 与 JSON mode 继续独立异步块；CI 记录但不将编辑器资源计入初始入口预算。
- 超出预算使 CI 失败，并输出具体资源大小。

### 9.4 容量回归

测试用计数代理包装 R2/KV：

- 单页列表、Cron 批次、集合删除批次均保持在 1000 次内部调用以下，并预留至少 100 次余量。
- 超过 legacy 边界返回明确错误，不出现部分成功响应。
- 分页无重复、无遗漏，游标绑定条件变化。

## 10. 发布与迁移

1. 本地完成全部工作包和完整测试。
2. 配置生产 `TOKEN_ENCRYPTION_SECRET`，核对 Cloudflare WAF/Rate Limiting。
3. 部署预览或隔离 Worker，使用空 R2/KV 执行迁移、分页、Cron 和 Session 验收。
4. 业务备份生产数据。
5. 部署 v3.1.0；旧对象按读取兼容，不执行破坏性批量迁移。
6. 运行公开生产探针、登录、分页、Bin CRUD、Schema、API Key reveal、Session 撤销、Cron/集合删除和浏览器验收。
7. 只有精确提交的 GitHub CI、Workers Build 和生产验收全部通过后才能打 `v3.1.0` Tag。

## 11. 完成标准

- 生产复现的三个桌面网页问题均有失败测试和通过的浏览器回归。
- 所有 JSON 写入口具备字节和深度边界。
- v3.1 失败的并发写入不出现在历史、恢复和备份中。
- 新建中断不会产生可见资源或永久不可回收对象。
- 所有大列表、Cron 和集合删除有分页/批次及调用预算测试。
- 登录有 429 行为，Session 可撤销，API Key 使用独立加密 Secret。
- Windows 上 `npm test` 可运行通过。
- `npm run typecheck`、build、lint、完整 Node 测试、完整 Chromium 测试、bundle budget 和 `git diff --check` 全部通过。
- README、ARCHITECTURE、DEVELOPMENT、OPERATIONS 和内置 API 文档与实现一致。
- 原有生产数据可读取，R2 仍为唯一权威数据源。
