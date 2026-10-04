# P10 Settings, Import and Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 P10 中文设置页、标准 JSON 导入、当前值下载和可保留 ID 恢复的业务 JSON / ZIP 备份。

**Architecture:** R2 保存系统默认值和恢复占位，业务备份使用封闭、版本化格式。导出逐资源核对快照；恢复条件创建文件，依赖就绪后 CAS 发布元数据。客户端只负责预览、固定 STORE ZIP 和按依赖顺序提交，服务端独立验证所有管理操作。

**Tech Stack:** 现有 React 19、TypeScript、Hono、Zod、Web Crypto、R2/KV、Node ≥22、node:test、Miniflare、Playwright Chromium、Python 3 标准库；不新增产品依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-p10-settings-backup-design.md`（用户已确认，2026-10-04 Asia/Shanghai）。

## Global Constraints

- 基线为远程 main `f2beb35c7fec65c6fe6e5437506e4f8633a22350`；当前分支 `codex/p10-settings-backup`。云任务已隔离，不创建 worktree。
- R2 权威、KV 非权威；仅 P10，不增加产品依赖、数据库、后台队列、自动备份或 P11 搜索。
- 新管理接口只允许 Session，显式 Authorization 返回 401 session_required；写入沿用 Origin 检查，响应 no-store。已有公共 /system/health 契约保持，不能被新子路由的通配鉴权拦截。
- 默认 private / 永不过期。defaultTtlSeconds 为 null 或 1–31536000 的整数秒；仅省略的创建字段使用服务端默认，显式 expiresAt:null 优先；不修改已有 Bin。
- 普通导入每文件及序列化 value 各最多 1 MiB，批次最多 100 项、10 MiB；业务 value 最大嵌套 64 层，不计请求包装。
- 备份最多 100 资源、250 逻辑存储对象、10 MiB UTF-8 JSON；meta/purged、每个版本/修订和 settings 各计 1。业务 value / 模型最大嵌套 64 层，不计包装；模型继续受 64 KiB 限制。
- ZIP STORE，只含 manifest.json / backup.json；总大小 ≤10 MiB + 64 KiB。不支持压缩、加密、ZIP64、描述符、路径或额外条目。
- 统计最多扫描 10000 业务对象、读取 500 元数据；超限/失败明确不可用，不输出局部数字充当完整计数。
- 业务包排除系统 Secret、认证配置、API Key/摘要、活动日志、KV、恢复收据及未知路径；普通 JSON value 原样保留。
- 保留 ID、源可见性/TTL/锁和历史；已有正常/删除/purged/旧档案/非本次文件跳过。关联冲突不换绑；设置另行 ETag 应用，不随恢复自动覆盖。
- pending 不进入正常读/列表/回收站或可用历史，也不被 Cron 清理；同内容可续作，异内容不接管。相同已发布收据返回 unchanged，普通修改清除收据。
- 页面中文、/#/settings，保留现有草稿/离页确认；文件只在内存，异步迟到结果不污染新文件或离开后的页面。
- 使用 `XDG_CONFIG_HOME=/workspace/.cloud-config WRANGLER_SEND_METRICS=false`；临时产物只放 `/workspace/.cloud-setup/p10`，建立本计划 progress.md。Node 直接加载的 TS 使用可擦除语法和显式 .ts 路径。
- 沿用原生执行：主 agent 连续实现全部任务；只在最后派一次 fresh whole-branch reviewer，不逐任务派实现/审查 agent。main 本地合并、推送授权有效，交付不再询问。

## Review Focus

1. Unicode、BOM、空键、__proto__、null/false/数组及数值溢出：业务 JSON 不被误识别、原型赋值或非有限值序列化改变。（Tasks 2/5/6）
2. 伪造正文长度、截断 UTF-8、ZIP 中央/本地头不同、重叠条目或大量文件：验证真实字节、先限制后解析，鉴权拒绝不读取业务正文。（Tasks 1/2/5）
3. 相同/不同内容竞争、R2 半途失败或发布后关联清理失败：既有文件不变、pending 不暴露，实际提交不得报告为未创建，重试不覆盖修改后的资源。（Tasks 4/6）
4. 旧 trash + active/purged canonical、版本号间隙、删除模型固定修订或 TTL 恰在恢复中到期：保留权威生命周期与约束，不复活永久删除或缺约束数据。（Tasks 3/4）
5. 默认设置迟到/变更、412、退出或切换文件时传输完成：明确创建时默认、保留手动选择/草稿，旧结果不触发下载或更新新预览。（Tasks 6/7）

## 文件与责任

- `src/shared/system.ts`：默认设置、系统统计、错误及请求结果类型；`backup-types.ts` / `backup.ts`：业务恢复格式、白名单、图校验、内容指纹和占位判别；`zip.ts`：有界 STORE ZIP。
- `src/shared/schema-validation.ts` / `draft7-meta-schema.json`：从现有 worker/validation 提取纯 Draft 7 校验，供前端/Worker 共用；原 schema.ts 保留同名 re-export 入口，许可证正文不变，仅更新 docs/licenses/JSON-Schema.txt 的文件位置说明。tsconfig.worker.json 仅启用 allowImportingTsExtensions，noEmit 不变，以支持共用模块的原生 TS 测试。
- `src/worker/lib/system-http.ts`：有界 UTF-8/JSON 正文读取、Session 管理中间件；`storage/settings.ts` / `system.ts`：默认值 CAS、读探测和统计。
- `src/worker/storage/backup-export.ts` / `backup-restore.ts`：逐资源快照、条件恢复；`routes/system.ts` / index.ts：管理接口接入。
- 现有 storage/bins.ts、bin-state.ts、collections.ts、schemas.ts、trash.ts：pending 全入口隔离、恢复历史时间；shared/activity.ts、storage/activity.ts、routes/activity.ts、ActivityPage.tsx：system 类型和固定动作。
- `src/react-app/features/settings/api.ts` / `files.ts` / `transfer.ts` / `download.ts`：请求、文件校验、恢复调度和 Blob 下载；SettingsPage.tsx、DefaultsForm.tsx、ImportPanel.tsx、ExportPanel.tsx：页面和表单。
- App.tsx：路由/默认创建/退出清理；BinDetailPage.tsx：已保存值下载；styles.css：响应式及反馈；features/docs/catalog.ts / examples.ts：P10 接口与三语言说明。
- 新增 tests/support/system-harness.mjs、backup-fixtures.mjs；system.test.mjs、backup-format.test.mjs、zip.test.mjs、backup-export.test.mjs、backup-restore.test.mjs、import.test.mjs、transfer.test.mjs、browser/settings.spec.ts。既有 tests 继续执行。

## 共享接口契约

以下是任务间唯一命名；完整 meta 字段白名单逐项按 spec §6 声明，不引入 Worker 存储类型到客户端。

`UserDefaults = {defaultVisibility:'private'|'public', defaultTtlSeconds:number|null}`；`SystemSettings = UserDefaults & {schemaVersion:1, updatedAt:string|null}`（null 仅虚拟默认）；`SettingsRecord = {settings:SystemSettings, etag:string}`；`SettingsPatch = Partial<UserDefaults>`，非空且无未知字段。

`ProbeStatus = 'unconfigured'|'reachable'|'unavailable'`；`BusinessStats = Record<'activeBins'|'trashBins'|'pendingImports'|'collections'|'schemas'|'versions'|'currentValueBytes'|'storedBytes',number>`；`SystemInfo = {service:'jsonbin',runtime:'cloudflare-workers',version:string,checkedAt:string,storage:{r2:ProbeStatus,kv:ProbeStatus},oauth:{githubConfigured:boolean},statistics:{status:'available',data:BusinessStats}|{status:'unavailable',error:'statistics_limit_exceeded'|'storage_unavailable'}}`。

`SystemError` 为含 status:number / code:string 的 Error，构造器显式赋值，不能用 TS parameter properties。异常只使用固定 code，不带用户正文。`DEFAULT_SETTINGS_ETAG` 为带引号的 settings-default-v1。

`BackupCollection = {meta:BackupCollectionMeta}`；`BackupSchema = {meta:BackupSchemaMeta,revisions:{revision:number,uploadedAt:string,schema:JsonSchema}[]}`；`BackupBin = {meta:BackupBinMeta,versions:{version:number,uploadedAt:string,value:unknown}[]}`；`BackupPurged = {id:string,deletedAt:string}`。

`BackupScope = {kind:'all'}|{kind:'config'}|{kind:'bin',id:string}`；`BackupPackage = {format:'jsonbin-backup',schemaVersion:1,appVersion:string,exportedAt:string,scope:BackupScope,settings:UserDefaults,collections:BackupCollection[],schemas:BackupSchema[],bins:BackupBin[],purged:BackupPurged[]}`。各 namespace ID 唯一，bins/purged 共用同一 ID 域；版本/修订唯一且为正安全整数。

`ResourceKind = 'collection'|'schema'|'bin'|'purged'`；`RestoreResource` 为 `{kind, data}` 的对应四种判别联合；`RestoreDependency = {kind:'collection'|'schema',id:string,fingerprint:string}`；`RestoreRequest = {resource:RestoreResource,dependencies:RestoreDependency[]}`，Bin 依赖最多各一项，其他类型为空。

`ImportMarker = {importState:'pending',kind:ResourceKind,id:string,fingerprint:string,startedAt:string}`；`RestoreResult = {kind:ResourceKind,id:string,status:'created'|'unchanged'|'skipped'|'dependency_skipped'|'failed',error?:string,warnings?:('collection_detached'|'collection_cleanup_failed')[]}`。R2 customMetadata 使用 restoreFingerprint 和 originalUploadedAt；不放进 JSON meta。

`ImportItem = {name:string,value:unknown}`；`ImportResult = {index:number,status:'created',id:string}|{index:number,status:'failed',error:string}`；`ImportBatchResult = {results:ImportResult[]}`。

`ExportQuery = {scope:'all'|'config',format:'backup'}|{scope:'bin',id:string,format:'value'|'backup'}`；`ExportPayload = {body:Uint8Array,fileName:string,contentType:'application/json; charset=utf-8',activity:{action:'system.exported'|'bin.exported',resourceId:string|null}}`。

## Task 1: 系统设置、创建默认值和可核对的状态接口

**Files:** 新建 shared/system.ts、worker/lib/system-http.ts、storage/settings.ts、storage/system.ts、routes/system.ts、tests/support/system-harness.mjs、tests/system.test.mjs；修改 worker/index.ts、storage/bins.ts、tsconfig.worker.json 及上述 activity 文件。

**Interfaces:** 产出 `getSettings(env:Env):Promise<SettingsRecord>`、`updateSettings(env:Env,input:SettingsPatch,etag:string):Promise<SettingsRecord>`、`resolveCreateDefaults(env:Env,input:{visibility?:UserDefaults['defaultVisibility'],expiresAt?:string|null},now:number):Promise<{visibility:UserDefaults['defaultVisibility'],expiresAt:string|null}>`、`getSystemInfo(env:Env):Promise<SystemInfo>`；HTTP 层 `managementSession` 按 typeof requireSession、`readBoundedJson(request:Request,maxBytes:number):Promise<unknown>`。测试 helper `createSystemHarness(name:string)` 返回 worker/env/bucket/request/close，随机测试凭据只在内存；request 可覆盖 env，复用真实 R2 并注入读写失败。

- [x] 写 RED：get default 无 R2 对象；设置首次 CAS / 并发 CAS / 428 / 412 / 非法/损坏；省略默认与显式 private/null；修改默认不改变旧 Bin。示例断言：`assert.equal((await h.request('/system/settings')).status,200); assert.equal(await h.bucket.get('system/settings.json'),null);`。
- [x] Run `npm run build` 后 `node --test tests/system.test.mjs`。Expected: 新接口 404 等行为 RED，不以 helper 初始化错误作为目标失败。
- [x] 实现公共类型、上述设置函数和 createBin 的选择性默认读取；worker 编译配置仅启用 allowImportingTsExtensions。记录 onlyIf 条件，virtual updatedAt 为 null，持久设置更新时间必须为有效 ISO。实现逐路由 managementSession，不能对 system 子路由用通配 Session 鉴权拦截 health。
- [x] 写/运行状态与授权 RED：匿名 health 仍 200；管理接口匿名/Bearer+Cookie 为 401，同源失败 403；状态读失败不输出异常 canary；统计超 10000/500 不返回部分数字；无鉴权的巨型正文未读取。Expected: 针对未满足行为失败。
- [x] 实现 `getSystemInfo` 的只读探测/有界统计和 HTTP 真字节限制；补充 system 资源和六个固定 P10 动作（spec §11），更新封闭活动验证/筛选；仅成功设置提交记事件，活动失败不回滚设置。
- [x] Run `npm run typecheck`、`npm test`。Expected: 包含新 system 测试及旧活动/Worker/客户端全套 GREEN，无 skipped。
- [x] 提交 `feat: add system settings and server-side Bin defaults`。

## Task 2: 共用业务格式、图校验和独立可读的 ZIP

**Files:** 新建 shared/backup-types.ts、backup.ts、zip.ts、schema-validation.ts、draft7-meta-schema.json、tests/support/backup-fixtures.mjs、tests/backup-format.test.mjs、tests/zip.test.mjs；将现有 worker/validation/schema.ts 改为同名导出桥，原 meta-schema 移至 shared，更新 docs/licenses/JSON-Schema.txt 的位置说明。

**Interfaces:** 消费 UserDefaults / SystemError；产出 `validateBackup(value:unknown):BackupPackage`、`validateRestoreRequest(value:unknown):RestoreRequest`、`validateBusinessValue(value:unknown):void`、`fingerprintResource(resource:RestoreResource):Promise<string>`、`isImportMarker(value:unknown):value is ImportMarker`、`encodeBackupZip(backup:BackupPackage):Promise<Uint8Array>`、`decodeBackupZip(bytes:Uint8Array):Promise<BackupPackage>`。占位判别用于拒绝正常读取；恢复入口另做完整 marker 校验。fixtures 定义 minimalBackup / richBackup，包含 spec 的完整字段和独立 UUID。

- [x] 写 RED：严格管理白名单、格式版本、字节/对象/深度上限、唯一 ID/版本、缺当前文件/引用、模型定义及当前值约束；正常 value 的 null/false/数组、__proto__/format/空键/Unicode 原样往返，拒绝非有限数值。示例：`assert.deepEqual(validateBackup(minimalBackup(null)).bins[0].versions[0].value,null);`。
- [x] Run `node --test tests/backup-format.test.mjs`。Expected: 缺失 API 或格式行为断言 RED。测试引入缺失模块后明确断言，不掩盖语法/fixture 错误。
- [x] 实现格式接口和 SHA-256 指纹（对象键排序、数组顺序不变，无原型赋值）；提取现有纯 Draft 7 校验原逻辑，JSON 导入用 `with {type:'json'}` 兼容 Node 原生 TS，Worker 的已有函数名及 SchemaError 保持。
- [x] 写 ZIP 测试：真实往返和 Python zipfile 读取 bytes，核对 CRC/JSON/null/中文；变异重复/额外/路径条目、offset 重叠、头部不一致、截断、压缩、加密、ZIP64、描述符、CRC/SHA/长度错误全部拒绝。
- [x] Run `node --test tests/zip.test.mjs`。Expected: 缺 ZIP API 或格式行为 RED，变异用例触及实际解析，而非仅检查生成字符串。
- [x] 实现固定两条目 STORE 编解码，先检查真实大小再分配/解码，fatal UTF-8、CRC32、manifest 封闭字段/版本/摘要及图校验；不把任意 ZIP 交给无界解压器。
- [x] Run `node --test tests/backup-format.test.mjs tests/zip.test.mjs`、`npm run typecheck`、`npm test`。Expected: ZIP 独立工具与完整现有 Schema/Worker 回归 GREEN。
- [x] 提交 `feat: define validated business backups and bounded ZIP format`。

## Task 3: 白名单导出和逐资源快照验证

**Files:** 新建 storage/backup-export.ts、tests/backup-export.test.mjs；修改 routes/system.ts。

**Interfaces:** 消费 Task 1 设置/鉴权、Task 2 BackupPackage/validateBackup；产出 `exportData(env:Env,query:ExportQuery):Promise<ExportPayload>`。内部只收集规范路径和允许字段，返回前完成快照复查；route 根据 payload 设置 attachment 并 auditRequest。

- [x] 写 RED：用真实 Worker 创建集合、模型两修订、Bin 多版本/间隙/孤立版本、锁、过期/删除、旧 trash 和 purged；scope=value 返回已保存的 false/null，scope=bin 包含依赖/历史，config 仅设置，all 包含声明的全部业务状态。示例：`assert.equal((await h.request('/system/export?scope=all&format=backup')).status,200);`。
- [x] Run build + `node --test tests/backup-export.test.mjs`。Expected: 路由 404/缺导出行为 RED。
- [x] 实现 `exportData`、封闭参数解析、源元数据规范化（只补已知缺省字段）、逻辑历史时间与终止标记投影；GET 成功后只记固定 system.exported/bin.exported，不输出目录、源 ETag 或内部收据作为恢复字段。
- [x] 写并观察 RED：注入 metadata 改写、目录成员改变、缺版本/模型、deleting/purging/pending；active/purged canonical 压过旧 trash；系统/Key/未知命名空间 canary 不在包中、业务 canary 保留；超限 413 无截断下载。Expected: 检测遗漏/泄露时失败。
- [x] 实现读取前后 ETag、最终 metadata/目录核对和计数/字节限制；过渡或损坏源返回明确 409，检测修改为 backup_changed；说明扫描后新资源可能未捕获，不宣称全局事务。
- [x] Run `npm run build`、`node --test tests/backup-export.test.mjs`、`npm run typecheck`、`npm test`。Expected: GREEN、标准 Content-Type/文件名/no-store 正确。
- [x] 提交 `feat: export consistent business snapshots without credentials`。

## Task 4: 保留 ID 恢复、占位隔离和故障续作

**Files:** 新建 storage/backup-restore.ts、tests/backup-restore.test.mjs；修改 routes/system.ts、storage/bins.ts / bin-state.ts / collections.ts / schemas.ts / trash.ts / system.ts。

**Interfaces:** 消费 RestoreRequest、fingerprintResource、isImportMarker、既有 schema/集合清理；产出 `restoreResource(env:Env,input:RestoreRequest):Promise<RestoreResult>`。合法 created/unchanged/skipped 返回 HTTP 200；校验失败 422，内容冲突 409 restore_conflict，依赖失败 409 restore_dependency_conflict，存储失败 503。客户端在 Task 6 映射依赖错误为逐项 dependency_skipped。

- [x] 写 RED：源包导出后恢复到独立空 R2，比较 ID、当前 JSON、全部历史号/值/逻辑时间、固定模型修订、锁/可见性/TTL/删除及 purged；缺省配置不自动应用。示例：`assert.equal(result.status,'created'); assert.deepEqual(restored.value,source.value);`。
- [x] Run build + `node --test tests/backup-restore.test.mjs`。Expected: 404/没有恢复行为 RED。
- [x] 写并运行隔离 RED：直接种 pending 后正常读/匿名读/列表/回收站/Collection 成员/Schema 管理不暴露，普通写和 Cron 不碰文件；正常、删除、purged、legacy 或孤立目标冲突字节不变。Expected: 原有入口误读占位或覆盖时失败。
- [x] 实现 Stored*Meta 联合及所有读取/生命周期 guard；实现获取 canonical 占位前检查既有对象、marker 完整校验、条件文件写入/同内容续作、依赖收据和固定模型验证、CAS 发布。最终 meta 仅业务白名单；Bin 新 lifecycleId；版本 originalUploadedAt 及历史接口回退语义一起接入。
- [x] 写并观察故障 RED：第 N 次 put/get 抛异常、同/异指纹并发、已有文件不匹配、metadata 发布竞争、普通修改清除收据、依赖在占位后变化；同文件重试只补未完成文件且不重记成功事件。Expected: 不完整可见、覆写或重复发布时失败。
- [x] 实现完整文件集合核对、赢家收据识别和故障状态，只有 CAS 发布者记固定导入事件。中断保留隐藏占位，同 hash 可继续；不同 hash 跳过。普通更新不能保留旧 restoreFingerprint，版本原始时间不能因此丢失。
- [x] 写/观察发布后集合并发删除、detach 失败和 TTL 边界 RED；实现发布后重查/清理。已发布响应保留 created（重放为 unchanged），清理失败报告 collection_cleanup_failed、数据不回滚，重放可重查并重试关联清理；实际 detach 返回 collection_detached。模型修订仍不可变，过期项立即遵循回收站语义。
- [x] Run `npm run build`、`node --test tests/backup-restore.test.mjs`、`npm run typecheck`、`npm test`。Expected: GREEN，旧 Bin/Schema/Trash/活动/文档契约仍通过。
- [x] 提交 `feat: restore backups with conditional publication and resumable state`。

## Task 5: 标准 JSON 批量导入与明确的逐项结果

**Files:** 修改 routes/system.ts；新建 tests/import.test.mjs。

**Interfaces:** 消费 readBoundedJson、validateBusinessValue、createBin/defaults；产出 POST /system/import，body 为 `{items:ImportItem[]}`，返回 ImportBatchResult。全批结构不合法不写；已通过校验的批次逐项创建并 audit bin.imported。

- [x] 写 RED：null/false/数组/Unicode，缺 value、非有限值、100/101 项、真实正文/单项序列化超限、深度边界；显式 raw 模式含 format 的对象仍当业务值。示例：`assert.equal((await h.request('/system/import',{method:'POST',value:{items:[{name:'空值',value:null}]}})).status,200);`。
- [x] Run build + `node --test tests/import.test.mjs`。Expected: 导入 404/缺结果 RED。
- [x] 实现有界正文、整个 items 校验，再按顺序创建；不自动拆数组、绑定模型或改已有资源。默认值由 Task 1 服务端入口应用；每项 created 带 index/id，failed 带固定 error。
- [x] 写/观察单项 R2 失败、活动失败、伪造 Content-Length/截断 UTF-8 的 RED；实现失败逐项继续、诊断无 canary，坏批次无业务写；鉴权拒绝先于正文读取。
- [x] Run `npm run build`、`node --test tests/import.test.mjs`、`npm run typecheck`、`npm test`。Expected: GREEN、200 部分失败可辨识，活动只对应实际提交。
- [x] 提交 `feat: import JSON values with bounded per-item results`。

## Task 6: 系统客户端、文件解析和恢复调度

**Files:** 新建 features/settings/api.ts、files.ts、transfer.ts、download.ts、tests/transfer.test.mjs。

**Interfaces:** `createSystemClient(base?:string):SystemClient` 与默认 systemApi。SystemClient 方法为 `getInfo(signal?:AbortSignal):Promise<SystemInfo>`、`getSettings(signal?:AbortSignal):Promise<SettingsRecord>`、`patchSettings(patch:SettingsPatch,etag:string,signal?:AbortSignal):Promise<SettingsRecord>`、`importJson(items:readonly ImportItem[],signal?:AbortSignal):Promise<ImportBatchResult>`、`exportData(query:ExportQuery,signal?:AbortSignal):Promise<Uint8Array>`、`restoreResource(input:RestoreRequest,signal?:AbortSignal):Promise<RestoreResult>`。`SystemApiError` 含 status/code，网络失败为 status=0，无正文自动重试。

`parseStandardFiles(files:readonly File[]):Promise<ImportPreviewItem[]>`（fileName/name/value/type/bytes）；`readBackupFile(file:File):Promise<BackupPackage>`；`buildRestoreRequests(backup:BackupPackage):Promise<RestoreRequest[]>`；`runRestore(backup:BackupPackage,client:SystemClient,onResult:(r:RestoreResult)=>void,signal?:AbortSignal):Promise<RestoreResult[]>`；`downloadBytes(bytes:Uint8Array,fileName:string,contentType:string):void`。

- [x] 写 RED：真实本地 HTTP 捕获 credentials/If-Match/query 和只发一次写请求；100 项含部分失败正确返回；AbortError 不当成全失败；export 保留 UTF-8/raw scalar 字节。Expected: 缺函数或不正确协议失败。
- [x] Run `node --test tests/transfer.test.mjs`。Expected: 明确接口/行为 RED。
- [x] 实现 client（错误不回显正文），真实字节下载上限；文件数量/size 先检再读，fatal UTF-8/BOM、完整 JSON/名称限制、明确模式、不按 format 自动恢复。备份按固定 ZIP magic / JSON 分支校验。
- [x] 写/观察图调度 RED：集合/模型优先、同一指纹与服务器一致、依赖 failed/skipped 不请求相关 Bin、409 依赖错误映射 dependency_skipped，其他独立资源继续；取消后不发下一个请求，已提交结果保留且不声称回滚。
- [x] 实现 buildRestoreRequests 和 runRestore，配置只作为候选不发送自动 PATCH；导出 bytes 封装 ZIP 用 Task 2，downloadBytes 创建/释放 Blob URL。UI 生命周期控制由 Task 7 调用处负责。
- [x] Run `node --test tests/transfer.test.mjs`、`npm run typecheck`、`npm test`。Expected: GREEN，客户端不保存 Cookie/Token/文件到持久存储。
- [x] 提交 `feat: add bounded file transfer clients and restore orchestration`。

## Task 7: 中文设置页、真实导入导出和创建默认选择

**Files:** 新建 SettingsPage.tsx、DefaultsForm.tsx、ImportPanel.tsx、ExportPanel.tsx、tests/browser/settings.spec.ts；修改 App.tsx、BinDetailPage.tsx、styles.css。

**Interfaces:** SettingsPage({onDirtyChange:(dirty:boolean)=>void})；DefaultsForm({record:SettingsRecord,onSaved:(r:SettingsRecord)=>void,onDirtyChange:(dirty:boolean)=>void})；ImportPanel({client:SystemClient,onBusyChange:(busy:boolean)=>void,onCompleted:()=>void})；ExportPanel({client:SystemClient,onBusyChange:(busy:boolean)=>void})。消费 Task 6 systemApi/files/transfer/download；Query keys 为 system-info / system-settings，业务完成后刷新 bins / trash-bins / collections / schemas / activity。

- [x] 写浏览器 RED：侧栏设置启用、/#/settings 刷新；真实保存默认/新建省略默认与显式 null；412 保留草稿、确认离页；迟到默认数据不覆盖用户选择。Expected: 原禁用导航/缺路由或错误状态失败。
- [x] Run `npm run test:browser -- tests/browser/settings.spec.ts`。Expected: 目标 UI 断言 RED。
- [x] 实现路由与三组卡片、Loading/错误/重试/统计不可用；DefaultsForm 只在成功响应后提交草稿，412 显示重新读取；新建选项明确“以创建时设置为准”，默认/永不过期/自定义发送正确省略/null/时间，TTL 不在打开时预计算。退出清理系统查询。
- [x] 写并观察真实文件 RED：普通多文件预览无写、数组/null/BOM/非法编码/超限反馈、逐项部分失败、mode 区分；下载事件读实际 JSON/ZIP，迁移到空测试存储后核对恢复列表/历史，公开/过期提示可见。往返测试使用两套独立 createSystemHarness，经 Playwright API 路由透传真实 Worker/独立 R2，依次切换源/目的实例并转发实际正文；不伪造成功结果，也不依赖旧浏览器用例留下的大数据集。Expected: 缺流程、错误内容或无预览即写时失败。
- [x] 实现导入/恢复确认、结果列表与进度；source 配置只显示并提供单独 If-Match 应用。导出全量/config/选定 Bin；BinDetailPage “导出已保存 JSON”仅 GET，JSON/设置草稿不变。
- [x] 写并观察生命周期 RED：慢读/传输后改选文件、离页/退出、拒绝下载/失败；阻止重复点击，迟到结果不更新新预览、不触发离开后的下载；取消提示已提交可能继续。覆盖 390px 无整体横向溢出、深色模式和键盘操作。
- [x] 实现 generation / AbortController / mounted guard 与 Blob 清理，onDirtyChange 聚合草稿及 busy，沿用现有确认；文件只保留组件内存，失败不清掉可修正预览。
- [x] Run `npm run typecheck`、`npm test`、完整 `npm run test:browser`。Expected: GREEN，旧 40 项浏览器及新增项全部真实执行，记录实际数量。
- [x] 提交 `feat: add settings dashboard and reviewed import and backup flows`。

## Task 8: API 示例、备份说明和完整本地验收

**Files:** 修改 features/docs/catalog.ts / examples.ts、tests/docs-examples.test.mjs / docs-contracts.test.mjs、README.md、docs/ARCHITECTURE.md / DEVELOPMENT.md 和本 spec/plan 状态。

**Interfaces:** 消费现有 DocOperation / buildRequest / renderExample 和 Task 1–6 的实际接口。新增操作 ID system-info、system-settings-get/update、system-import、system-export-all/config/bin、system-restore，均为 session，无 Bearer Scope。请求示例 body 固定演示值，不读取实际文件或业务内容。

- [x] 写 RED：P10 操作存在、设置 If-Match 必需、导入 body 包装/逐项结果、封闭导出参数、restore discriminant/dependency 及 200/409 行为；每种语言在本地 Worker 执行代表性请求并核对响应，Python 仍显式 UTF-8 bytes。Expected: 缺目录/契约不符失败。
- [x] Run `npm run build`、`node --test tests/docs-examples.test.mjs tests/docs-contracts.test.mjs`。Expected: P10 契约 RED。
- [x] 实现目录和必要生成器扩展。
- [x] Run 上述 docs focused 命令。Expected: GREEN，既有恶意引用/隐私/三语言执行用例保持。
- [x] 更新 README/ARCHITECTURE/DEVELOPMENT：P10 必做勾选、旧格式当前不适用、URL/默认规则、STORE ZIP 支持、10 MiB/100/250/深度/批量限制、保留 ID/冲突/续作/未完成占位、不覆写设置、逐资源一致与公开/TTL 语义。远端检查此时明确待核对，不预先称成功。
- [x] Run `npm run typecheck`、`npm run build`、`npm test`、`npm run test:browser`。Expected: 最终产品树全套 GREEN，无失败/skip；只记录实际数量（基线 91 / 40），将输出保存在本计划临时目录。
- [x] 提交 `docs: document P10 settings and backup contracts with local acceptance`，产品树/文档可供整分支审查。


## Task 9: 一次整分支审查及已授权的 main 交付

**Files:** 必要时修改以上产品/测试文件；更新本 spec/plan 和 README/DEVELOPMENT 的交付状态。临时目录 `/workspace/.cloud-setup/p10` 仅供本计划。

- [x] 基于原始 base 到最终产品 HEAD，一次 fresh whole-branch reviewer，附已确认 spec/plan、五项 Review Focus、真实测试结果和执行 ledger；使用当前允许的最强 reviewer。Expected: 明确 Critical/Important/Minor 和未判断项，不把自审称独立审查。
- [x] 重新判断发现的用户影响；Critical/Important 在一次修复阶段逐项先复现 RED 再改为 GREEN，跑适当全套；Minor 和未采纳项/未判断项如实记入 ledger，不再次派审查。Expected: 所有重要发现已验证修复，或有明确待解决阻塞。
- [x] fetch main 并检查远端变更，按远程权威要求处理冲突但保留无关用户修改；已通过测试后本地合并到 main，不 force push。Run 合并树 typecheck / `npm test`；新增产品变更才补跑相关 browser。Expected: 合并树 GREEN，再普通 push origin main。
- [x] 核对精确功能 SHA 的 GitHub CI / Workers Builds；成功后同步 README/DEVELOPMENT/spec/plan，提交最后文档并 push，再核对最终文档 SHA 的远端检查。Expected: 两次 SHA 的 checks 均 success，最终 HEAD 等于实际远程 main，工作区干净。
- [x] 收集全部 Ruling / deferred minor 到最终报告；清理已合并本阶段分支及 `/workspace/.cloud-setup/p10`，保留其他目录。生产 auth/CORS、部署浏览器和 live Cron 没有 URL/认证时仍未验证；下一阶段 P11。

## 自审、覆盖与执行约定

spec §1 范围/备份选择由 Tasks 2–8 承接；§2 默认值由 1/7 承接；§3 系统状态由 1/7 承接；§4 授权由 1/3/4/5/8 承接；§5 JSON 导入由 5/6/7 承接；§6–8 格式/完整性/Secret 由 2/3/4/6 承接；§9 恢复和故障由 4/6/7 承接；§10 UI 由 6/7 承接；§11 文档/验收/交付由 8/9 承接。Review Focus 每条已在所属 task 加行为验收。

共享接口以本节命名为准，特别是 defaultTtlSeconds、BackupScope.kind、RestoreResource.data、restoreFingerprint / originalUploadedAt 和结果 status；后续任务不得另造同义字段。状态接口与设置虽可单独使用，但普通导入依赖默认值、备份包含配置，恢复状态又进入统计，因此按一个已确认 P10 计划连续执行。追加测试若已经覆盖现有正确行为，记录 GREEN 事实，不人为破坏代码；每项新增交付目标必须先观察实际 RED。

用户已选择原生执行方式，此计划沿用，不再次询问方式。用户已确认本实施计划，连续执行九项任务，不逐任务请求确认；最终按已有 main 合并与推送授权交付。

本地最终验收（2026-10-04，Asia/Shanghai）：修复后的类型检查/构建、132 项 Worker/客户端测试及 48 项 Chromium 测试通过，0 失败/skip；一次独立整分支审查的三项 Important 已 RED→GREEN 修复，两项 Minor 文档已按用户要求同步，无延期 Minor。接续操作见 DEVELOPMENT.md §11。全部改动已合并普通推送 main；功能 SHA `804fa4bf9d706e75c62f280491e0b8f2db9accae` 的 [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37163198650) / [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/9d2ef383-8491-4acf-8dea-d9cc69a8b982) 均 success。最后进度文档提交在推送后核对自身检查及 HEAD == origin/main，结果由其 GitHub checks 和交付回复记录。生产 auth/CORS、部署浏览器及真实 Cron 未验证；P10 交付时 P11 尚未开始；最新进度以 DEVELOPMENT.md 为准。
