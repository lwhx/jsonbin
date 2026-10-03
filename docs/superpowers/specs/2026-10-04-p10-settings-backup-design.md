# P10 设置、导入与导出设计

状态：用户已确认设计方向及本书面设计（2026-10-04，Asia/Shanghai），包括备份恢复保留原 ID、冲突跳过；实施计划已确认，正在按计划实施。

依据：`docs/DEVELOPMENT.md` 的 P10 清单；基线为已交付 P9 的 `main` 提交 `f2beb35c7fec65c6fe6e5437506e4f8633a22350`。沿用单用户、R2 权威存储、KV 可重建、中文 Dashboard、Session 管理及 ETag 条件写入。

## 1. 目标、范围与方案

让管理员能检查系统状态、设置新 Bin 的默认值、导入 JSON，并下载可以再次导入的业务备份。导入及恢复必须给出明确的逐项结果，不覆盖已有数据，备份不能包含系统认证凭据。

- 设置：系统信息、Worker / R2 / KV 状态、当前版本、默认可见性、默认 TTL、GitHub OAuth 配置状态和数据统计。
- 导入：单个或批量标准 JSON 文件；支持本阶段定义的 JSON / ZIP 备份恢复。
- 导出：单 Bin 当前 JSON、单 Bin 含历史备份、全部业务数据、非敏感设置与元数据、ZIP 备份格式。
- 备份覆盖 Bin 当前版本及全部保留版本、回收站数据、永久删除标记、集合、模型全部保留修订和默认设置。KV 索引、认证状态、API Key 和活动日志不属于业务恢复包；活动日志仍由当前实例产生和清理。
- 未发现已确定的旧 JSONBin 导出协议或样本。P10 的“如需要”项记录为当前不适用；不猜测历史格式，也不把任何普通 JSON 对象自动解包为旧格式。

采用版本化业务备份，恢复保留 ID，遇到既有资源跳过。这样迁移到空实例后 Bin API 地址的 ID 部分保持一致。生成新 ID 的副本恢复会要求修改外部调用地址，本阶段不实现；覆写现有资源也不提供。

不增加数据库、云凭据配置界面、自动备份、后台任务队列、全局索引或 P11 搜索。ZIP 使用标准未压缩 STORE 格式及固定条目，不引入产品依赖。保留现有公共 health 接口的响应契约。

## 2. R2 设置与新建默认值

权威对象为 `system/settings.json`，只包含 `schemaVersion: 1`、`defaultVisibility`、`defaultTtlSeconds` 和 `updatedAt`。默认可见性为 `private`；TTL 为 `null`（永不过期），或 1–31536000 的整数秒。

对象不存在时返回内置默认值和固定虚拟 ETag，不因读取而写入 R2。首次保存要求匹配虚拟 ETag，并用 `etagDoesNotMatch: *` 创建；后续保存使用当前真实 ETag 和 R2 CAS。缺少 If-Match 返回 428，冲突返回 412，非法或未知字段返回 422。损坏的设置对象返回明确的 503，不静默重置。

新建 Bin 的规则位于服务端共同存储入口，Dashboard、资源 API 和普通 JSON 导入一致：

- 未提供 visibility 时使用默认可见性；显式 private/public 优先。
- 未提供 expiresAt 时，按服务端创建时间加默认 TTL；显式 null 表示永不过期，显式时间沿用现有未来时间校验。
- 两项都显式提供时不必读取默认设置。仅在需要默认值时，配置不可用才阻止创建。
- 默认值变化不修改已有 Bin、锁、历史、回收站或导入的备份元数据。

新建对话框提供“使用系统默认”的选择，同时允许明确选择可见性、永不过期或自定义到期时间。相对 TTL 在提交时由服务端计算，不能在打开对话框时预先变成可能过期的时间。异步加载默认值不覆盖用户已经作出的选择；默认公开时沿用公开读取提示。

## 3. 系统信息与统计

设置页使用 Session-only 系统信息接口。返回 package.json 版本、服务及 runtime 标识、检测时间，以及存储的配置/读探测状态。R2 用只读 head，KV 用只读 get；不创建探测对象、不回传 KV 值或内部异常。区分未配置、读探测通过和读探测失败，不把绑定存在描述为完整读写验收。

OAuth 状态沿用现有 auth/config 的配置判定，只返回布尔值；不输出 client secret、用户限制值、密码或 Session Secret，不调用外部 OAuth 服务来声称登录成功。

统计包括正常 Bin、回收站、未完成恢复、可用集合、可用模型、保留版本文件数量、当前 JSON 逻辑字节数和业务对象实际 R2 字节数。字段说明区分当前值大小与包含历史的实际文件大小；永久删除后残留的待清理版本和未发布恢复文件不计入可用历史。

统计直接读取 R2，KV 不承担权威计数。扫描最多 10000 个业务对象、读取最多 500 个元数据对象；超出或失败时统计返回不可用状态，不把部分计数当作全量结果。系统信息和设置仍可独立展示、刷新。检测不会确认部署权限、写权限或真实 Cron 运行。

## 4. 管理接口与认证

除现有 health 外，新增接口均只允许管理 Session；显式 Authorization 直接返回 401 session_required，即使同时有有效 Cookie。写入复用现有同源 Origin 检查；全部响应 no-store。API Key 不获得新的系统权限。

| 接口 | 行为 |
| --- | --- |
| GET /api/v1/system/info | 系统状态及有界统计 |
| GET /api/v1/system/settings | 返回 settings 和 etag，响应头含 ETag |
| PATCH /api/v1/system/settings | 部分更新默认设置，必须 If-Match |
| POST /api/v1/system/import | 批量创建普通 JSON Bin，返回逐项结果 |
| GET /api/v1/system/export | 按 scope / format 生成 JSON 下载 |
| POST /api/v1/system/restore | 恢复一个经过校验的备份资源，保留 ID |

export 的封闭参数组合为：scope=all 或 config 且 format=backup；scope=bin、id 为 UUID，format=value 或 backup。未知、重复、缺失或不匹配的参数返回 400。value 只导出该 Bin 已保存的当前 JSON；backup 返回后述业务恢复包，包含必要的关联资源。

新接口固定错误包括 invalid_query、validation_failed、invalid_json、payload_too_large、settings_unavailable、backup_changed、backup_unavailable、restore_conflict、restore_dependency_conflict 和 storage_unavailable。422 校验问题不回显 JSON 值；413 上限错误、409 状态/依赖冲突、412 设置冲突和 503 存储不可用分别有中文恢复建议。未知错误返回通用 500，日志仅包含固定错误代码及请求 ID。

## 5. 标准 JSON 文件导入

每个文件代表一个完整 JSON 值，数组不会自动拆为多个 Bin。支持对象、数组、字符串、数值、false 和 null；接受 UTF-8（允许 BOM），拒绝非法编码、空文件及不合法 JSON。

浏览器先读取并校验文件，预览文件名、目标 Bin 名称、大小、JSON 类型、默认可见性和 TTL，不在预览时写入。默认名称来自文件基本名，去掉扩展名并规范化到现有名称限制；用户可修改。显示内容使用 React 文本，不注入文件名 HTML。

import 请求包含最多 100 项 `{name, value}`，名称沿用现有 1–160 字符限制；每个原始文件及其序列化 value 各最多 1 MiB，整批请求最多 10 MiB，每个业务 value 最大嵌套 64 层（不计请求包装层）。客户端预检和服务端有界正文读取/单项校验分别执行限制，不依赖 Content-Length 的声明。结构校验失败整批不写入；合法批次逐项创建，单项存储失败不撤销已完成项。

新 Bin 生成 UUID，创建版本 1，名称之外的元数据使用正常新建默认值，不自动绑定模型或集合。请求返回 HTTP 200 和 `{results}`，每项包含 index、id（成功时）、status 及固定 error（失败时）；前端逐项呈现成功和失败，不把 200 等同全部成功。

导入按钮防止重复提交，不自动重试写入。网络中断可能已有部分提交；提示检查列表后再重试，避免把未知结果当作全部失败而制造副本。文件及 JSON 值只保存在页面内存，退出或卸载时清理。

## 6. 业务恢复包格式 v1

统一 JSON 顶层字段为 format=jsonbin-backup、schemaVersion=1、appVersion、exportedAt、scope、settings、collections、schemas、bins 和 purged。schemaVersion 不兼容时拒绝恢复。所有管理结构为封闭白名单；数据 value 和合法模型定义保留自身字段。

- scope 为 all、config，或包含 Bin ID 的 bin 范围。
- settings 为可导入的默认可见性和默认 TTL，不包含环境变量或更新时间等运行状态。
- collections 条目保存业务 meta；状态只允许 active/deleted，包含 ID、名称、描述、slug 和时间。
- schemas 条目保存业务 meta 及所有保留 revisions；每个修订包含 revision、uploadedAt 和 schema。删除模型的固定修订同样保留，不能丢失仍被 Bin 使用的约束。
- bins 条目保存白名单 meta 及所有保留 versions；每版包含 version、uploadedAt 和 value。元数据包含 ID、名称/描述、可见性、集合、固定模型修订、currentVersion、size、数据/模型锁、创建/更新时间、TTL，以及存在时的删除时间和原因。
- purged 保存 `{id, deletedAt}` 终止标记，不带已永久删除的 JSON 或晚到孤立文件。

版本和修订号为正安全整数，不要求连续，也不要求最大保留版本等于 currentVersion；既有孤立版本仍按现有历史语义保留。必须存在当前版本/修订和被引用的模型修订。当前值须通过其固定模型验证；过去的版本不按当前模型重新判为无效。模型定义继续使用现有 Draft 7 验证及 64 KiB 限制。

保留创建/更新时间、版本号、值、锁、源可见性、TTL 和删除状态；不恢复原 ETag、purgeEtag、lifecycleId 或内部恢复标记。恢复生成新的 Bin 生命周期和当前对象 ETag。历史 uploadedAt 通过 R2 customMetadata 保存，历史读接口对恢复对象使用该逻辑时间，旧对象仍使用实际上传时间；文件大小按恢复后的真实序列化字节重新计算。

全量包最多 100 个资源（集合、模型、Bin 和 purged 合计）、250 个逻辑存储对象、10 MiB UTF-8 JSON。对象计数为每份资源 meta / purged 标记、每个版本/修订和设置各计 1；业务 value / 模型最大嵌套 64 层，不计备份包装层。超限明确返回 413，不下载截断备份。单资源恢复请求同样有界。单 Bin 含历史包包含它的关联集合及绑定模型所有修订；config 包仅含设置，其余资源数组为空。

## 7. 导出一致性与 Secret 排除

从规范业务路径逐项读取并投影到白名单，不枚举后直接打包整个 R2。排除 keys、system/auth、所有环境变量、Cookie、Authorization、Token/摘要、OAuth code/state、活动日志、KV、内部恢复指纹及未知命名空间。普通 JSON value 按原值导出，不通过猜测字段名删改用户业务内容；系统认证 Secret 与用户业务值是不同数据来源。

兼容既有 trash/bins 旧档案：canonical 记录优先，active / purged canonical 不被旧档案覆盖；仅无 canonical 时采用有效旧记录及其版本。已知旧 v3 元数据缺少可选的 TTL、关联或锁字段时，按其原有默认语义规范化，不猜测未知结构。检测到缺失当前版本/模型、删除集合尚处 deleting、Bin 尚处 purging 或恢复 pending 时，全量备份返回 409，不默默省略后仍称“全部”。

每个资源在读取前后核对元数据 ETag，导出结束再核对已捕获的元数据与版本目录成员；发现修改、删除、新版本或缺失对象，返回 backup_changed，让用户在操作完成后重试。R2 没有跨对象事务，不能承诺一个全局原子时间点；扫描开始后新建资源可能不在此包中，包定义为已捕获资源的逐资源一致备份。

下载返回正确 JSON Content-Type、attachment 文件名和 no-store。文件名使用固定安全格式与 UUID/时间，不直接插入未经处理的资源名称。导出 Bin 使用服务端已保存数据，不读取编辑器草稿，导出不丢弃草稿。

## 8. ZIP 文件与校验

ZIP v1 仅含 manifest.json 和 backup.json 两个 UTF-8 文件，使用标准 ZIP STORE，无压缩、加密、ZIP64、数据描述符或路径目录。manifest 包含格式版本、固定条目名、backup.json 字节数和 SHA-256；ZIP 自身写入标准 CRC32。

Worker 生成规范 JSON 恢复包，浏览器将其封装为 ZIP；恢复时浏览器先校验 ZIP、完整包和资源图，再逐项调用 Session-only restore。服务端不解析任意上传 ZIP，也不信任客户端校验。

ZIP 编解码为独立纯函数。限制总大小为 10 MiB + 64 KiB，只接受两个不同且固定名称的条目；校验中央目录、offset/长度、重复/重叠条目、CRC32、SHA-256、结尾及本地头一致性。压缩、路径穿越、额外文件、损坏、错误版本或伪造大小均拒绝，不解压到文件系统、不执行内容。此格式可被标准 ZIP 工具读取；本应用不导入任意普通 ZIP 或重打包后的压缩 ZIP。

完整性校验用于发现损坏，不把普通摘要当作来源签名。导出的 JSON 恢复包也可直接导入；普通 JSON 与备份由用户选择的导入模式区分，不凭一个 format 字段自动改变行为。

## 9. 保留 ID 的恢复、依赖与失败续作

客户端先校验整包，包括唯一 UUID、字段、状态、版本、修订、引用、当前模型约束和限制；随后按集合、模型、Bin / purged 顺序提交。服务端再次校验单个资源及真实依赖。配置先显示为可应用值，默认不自动修改；应用设置单独走有 If-Match 的 PATCH。

既有正常、删除、purged、旧回收档案或不属于本次恢复的对象均视为 ID 冲突，返回 skipped；不合并历史、不解锁、不复活、不覆盖。即使名称/内容相同也不能据此覆盖。依赖集合或模型冲突/失败时，其关联 Bin 返回 dependency_skipped；不静默换绑已有同 ID 的其他模型。独立资源继续恢复。

每个资源通过规范键顺序的 JSON SHA-256 生成内容指纹。服务器用条件创建在其 canonical meta 位置取得 importState=pending 的恢复占位，记录 kind、id、fingerprint 和开始时间；取得前检查该 ID 的现有对象。pending 不进入正常读、列表、回收站或计数，不能被普通更新/删除或 Cron 过期/清空处理。元数据读取和生命周期类型必须显式识别 pending，不能把缺少字段的占位当普通 Bin。

占位取得后，每个版本/修订只用条件创建。文件已存在时，只在占位指纹属于同一内容、文件属于输入集合且内容完全相符时继续；异物或不匹配返回 restore_conflict。全部文件和依赖就绪后，使用占位的 ETag CAS 发布完整 meta；集合/模型在发布后才可被关联，Bin 在发布后才可读。

发布的 R2 customMetadata 保留恢复指纹作为续作收据，不放进业务响应或备份。依赖使用 type / id / fingerprint 校验实际已恢复记录；普通管理修改后不保留旧收据。相同备份再次提交已完成资源返回 unchanged；不同内容或已经修改的既有资源返回 skipped。竞争者不能覆盖赢家，只有实际发布者记成功活动。

依赖核对不提供跨对象锁。Bin 发布后重查集合，复用既有关联清理：若集合并发删除，则解除关联并报告警告，保留已提交的 JSON / 历史；不把已提交结果报成未创建。模型绑定始终指向已验证的不可变修订，其后普通升级或归档不改变绑定。发布前检测到依赖已修改则跳过，不自动换绑。

中断留下的 pending 文件不可见、不自动清理，也不释放 ID 给别的内容；重新选择相同备份可继续条件创建并发布。统计显示未完成恢复数量，结果提示同文件重试。若依赖在中断后已被普通管理操作修改，续作仍跳过关联资源，不能通过重试覆盖它；此时可把原备份迁移到空实例。此阶段不提供强制接管或删除 pending 的界面。已有版本不可覆盖，pending 续作不得触碰非本次拥有的文件。

恢复保留源可见性、TTL 和锁。预览明确显示公开资源和已到期项；过去的 TTL 恢复后即受现有到期控制，进入回收站，不自动延长期限。结果按 created、unchanged、skipped、dependency_skipped、failed 分别展示；请求取消只停止等待，不承诺撤销已经提交的数据。

## 10. 页面与组件边界

启用侧栏“设置”，路由 /#/settings，刷新可恢复。页面沿用中文、明暗主题和响应式布局，分为系统信息、默认设置、导入与导出三组；提供 Loading、错误、重试、空状态和进度结果。

- 默认设置草稿接入现有 onDirty / 离页确认。保存成功才更新本地已保存状态和 Query 缓存；412 保留草稿并提供重新读取，不自动覆盖。
- 导入先选模式（普通 JSON / 业务备份）、选文件、预览，再点击确认导入。ZIP / JSON 备份显示资源和状态计数、冲突策略、公开/到期提示及配置差异。
- 导出提供全部业务 ZIP、配置 JSON，以及选定 Bin 的当前 JSON/含历史 ZIP。Bin 详情另有“导出已保存 JSON”，不向编辑器写值或触发放弃草稿。
- 文件处理/传输期间阻止重复提交；语言无关状态均用中文。旧文件/请求的异步结果不得污染新预览；卸载或退出后不继续下载或更新组件。网络取消不被显示为已回滚。
- 文件内容不写 LocalStorage、SessionStorage、日志或长期 React Query 缓存。退出清理 system/settings 查询及页面文件内存，Blob URL 下载后释放。

建议边界：shared/system.ts 保存设置和响应类型；shared/backup.ts 定义格式/白名单/纯校验；shared/zip.ts 处理有界 STORE ZIP；worker/storage/settings.ts、system.ts、backup.ts 分别管理设置、状态和备份/恢复；worker/routes/system.ts 统一管理授权、限制和响应。features/settings 的 API、文件处理、SettingsPage 和独立导入/导出面板分开；App 只接入路由和创建默认值。

pending 和恢复时间的必要兼容改动只落在 bins、bin-state、collections、schemas、trash 及相应读取入口。Worker 不导入 React 模块，前端不导入服务器凭据或存储实现。现有 health、资源 Scope、ETag 写入、模型锁及公共读取策略保持。

## 11. 活动记录、文档和验收

增加固定中文动作：system.settings_updated、system.exported、bin.exported、bin.imported、collection.imported、schema.imported；system 资源事件允许空 resourceId，其他资源继续使用 UUID。更新封闭类型、验证和筛选；仅实际成功提交/导出记事件，pending、skipped 和 unchanged 不伪造成功。沿用活动写入失败不回滚业务结果的约定，不记录文件名、名称、描述、JSON、正文、摘要或配置值。

验证必须覆盖：

1. 设置缺省读取无写入、首次/后续 CAS、并发 412、428、损坏配置、显式值/null 优先、TTL 按创建时间生效且旧 Bin 不变。
2. Session-only、显式 Bearer 不回退 Cookie、同源检查、no-store；状态探测失败及统计超限可读，不输出秘密/异常细节。
3. 单/批量 JSON 的数组/scalar/false/null、Unicode/BOM、非法编码/JSON、深度/字节/数量限制、单项失败、禁止自动重试及正确逐项结果。
4. 多版本、版本间隙、孤立版本、固定模型修订、删除模型、回收站/过期、锁、旧 trash 优先级、purged 终止标记的导出与空实例恢复往返。
5. 正常/删除/purged/孤立对象 ID 冲突零覆写；关联冲突跳过；竞争恢复、条件文件创建、发布 CAS、中断隐藏、同备份续作、普通修改后不得复用旧收据；Cron 不处理 pending。
6. ZIP 以 Python 标准库 zipfile 等独立工具验证可读和真实正文；错误校验和、重复/额外条目、越界/重叠 offset、压缩/ZIP64/描述符、路径名、损坏结尾和伪造大小均拒绝。实际解包与恢复，避免只镜像编码器的字符串断言。
7. 用系统 Secret / API Key 摘要 canary、未知 R2 命名空间和业务 JSON canary 验证备份白名单、正常 JSON 往返及日志不包含认证秘密。
8. Chromium 覆盖设置路由/刷新、保存/412 草稿、默认创建、真实文件选择/预览、部分失败、实际下载 ZIP/JSON 并解析、恢复公开/到期提示、导出保留编辑草稿、迟到异步结果、移动端和深色模式。

更新 Dashboard API 文档目录及三语言例子、README、ARCHITECTURE 和 DEVELOPMENT：写清参数、Session-only、默认规则、限制、ZIP 支持范围、恢复冲突/续作及非全局事务边界。运行完整 typecheck、build、Worker/客户端和 Chromium 回归，记录实际数量；已有基线为 91 / 40，不提前预估新增数量。

一次整分支独立审查重点检查 Secret 白名单、归档校验、恢复竞态、依赖/锁/TTL、pending 的全入口隐藏和失败续作。重要发现先观察回归 RED 后修复并验证全套 GREEN；不逐任务重复派审查。

已有 main 本地合并/推送授权继续适用。实施结束 fetch 核对远端，以远程仓库为准；合并、核对合并树、普通 push，不 force push；记录精确提交的 GitHub CI / Workers Builds。生产认证/CORS、部署浏览器行为及真实 Cron 在缺少公开 URL/适用认证时保持未手动验收，不以构建成功代替。下一阶段为 P11。

## 12. 书面设计自审

已覆盖 P10 全部必做清单；旧格式为有条件项，当前没有确定协议。设置默认值和恢复原元数据分别定义；恢复保留原 ID 与现有终止标记兼容；ZIP 与 JSON 共用一个业务格式；源 Secret、用户 JSON、临时占位、业务元数据和恢复收据有明确边界。字节/数量/深度上限、逐资源一致性、冲突及中断续作均可测试，没有待定产品决策。书面设计批准后编写实施计划。
