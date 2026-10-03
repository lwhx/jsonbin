# P8 活动记录设计

状态：用户已确认（2026-10-03）；设计及实施计划均已确认；实现与本地验收完成，远端交付进行中。

依据：用户要求以远端仓库为准，按 `docs/DEVELOPMENT.md` 顺序继续。基线为 `main` 的 `f75a9dfd37a6bc3e900a679c08167c4f5e5a658f`；P0–P7 已实现，下一阶段为 P8。远端没有 P8 实现。本地重复 P2 分支已按用户要求删除。

## 目标与边界

为单用户管理界面提供可刷新、可分页的重要操作记录，回答何时、由哪类身份、对哪个资源进行了什么操作。记录位于 R2，KV 清空不丢失记录。不新增数据库、依赖或外部日志服务。

严格排除密码、Cookie、Authorization、完整 Token、Token 摘要、OAuth code/state、请求/响应正文及敏感 JSON。资源名称、描述、路径字段和自填用户名也不写入记录。P8 不加入 P9 文档站、导出、全文搜索、IP/浏览器指纹或完整审计合规功能。

开发文档规定的字段作为基础；以下关于权限、分页、故障和保留的细节是已确认的设计补充。

## 方案比较

1. **独立 R2 对象（推荐）**：每条记录独立不可变写入，避免多个请求竞争同一个日志文件；时间排序的对象键支持分页与清理。业务提交和记录写入是两次独立写入，需要明确故障语义。
2. 单个 R2 JSON 数组：读取方便，但每次追加都搬运全部记录，并发时需要 CAS 重试，容易与正常业务形成额外竞争。
3. 只写 KV 或平台 console：无法满足 R2 权威、刷新后持久读取和稳定管理入口要求。

选方案 1，保持 Cloudflare/R2 架构。此列表是操作记录，不承诺业务与日志跨对象事务或恰好一次投递。

## 数据结构与隐私

```ts
type ActivityActor = {
  type: 'session' | 'api_key' | 'anonymous' | 'system';
  id: string | null;
};
type ActivityEntry = {
  id: string;
  action: ActivityAction;
  resourceType: 'auth' | 'bin' | 'collection' | 'schema' | 'key';
  resourceId: string | null;
  actor: ActivityActor;
  provider: 'password' | 'github' | 'api_key' | 'anonymous' | 'system';
  timestamp: string;
  summary: string;
  requestId: string;
};
```

- id/requestId 由服务端产生 UUID；不把客户端 Request-ID 原样持久化。
- Session actor 只使用已验证的服务端用户 ID；API Key actor 使用已验证的 key UUID，不使用 token/prefix/name/digest。匿名登录失败不使用提交的 username。
- resourceId 仅使用真实成功操作对应的 UUID；auth 为 null。重复幂等请求可记录成功请求，不能把这种记录描述成一次新的状态迁移。
- action 与 summary 由封闭枚举和固定中文映射产生，调用者不能传入自由文本 summary、错误 message 或 JSON 值。
- 存储函数显式构造每个字段，不 spread 请求对象；字段和输出用严格类型/运行时白名单验证。R2 customMetadata 若用于列表过滤，也只包含 action/resourceType 等枚举。
- HTTP 响应及平台日志不返回或打印记录失败的异常 message/请求头/正文。记录模块的故障日志仅输出固定错误码与服务端 requestId。

对象键为 `activity/<反向毫秒时间>-<UUID>.json`，固定宽度数字让 R2 字典序等于时间降序，同毫秒使用 UUID 稳定排序。条件创建防止覆盖，冲突时使用新 UUID 重试。服务端时间是排序依据，不将它宣称为严格的跨请求提交顺序。

## 记录范围与接入

| 触发 | action | 记录时机 |
| --- | --- | --- |
| 密码或 GitHub 登录成功 | auth.login_succeeded | 已签发 Session |
| 密码登录失败、GitHub 回调失败 | auth.login_failed | 返回失败；actor 为匿名，不记录提交身份/错误细节 |
| 创建 Bin | bin.created | 创建成功 |
| 完整保存、Merge Patch、路径写入 | bin.updated | 条件写入成功；不记录值或路径 |
| Bin 设置、锁、模型、集合、TTL 修改 | bin.metadata_updated | 条件写入成功；不记录字段值 |
| 恢复历史内容 | bin.version_restored | 已生成新的 head |
| 删除 Bin | bin.deleted | 删除请求成功 |
| 回收站恢复 | bin.restored | 恢复成功 |
| 永久删除/清空回收站 | bin.purged | 按实际成功项目记录；部分失败不记成功 |
| 集合创建/修改/删除 | collection.created/updated/deleted | 对应操作成功 |
| 模型创建/修改/删除 | schema.created/updated/deleted | 对应操作成功；验证接口不记录 |
| 创建/撤销 API Key | key.created/revoked | 对应操作成功；不复制 token 响应 |
| Cron TTL 归档、继续完成清理 | bin.expired/bin.purged | system 身份，仅记录实际新提交的转移 |

普通 GET、匿名 public 读取、登录配置、健康检查、Schema 验证、活动列表不产生记录。普通写入的 401/403/404/412/422/423 不产生成功记录。登录失败是唯一需要记录的常规失败类别；此阶段不扩展到所有鉴权失败。

采用显式路由 helper，在成功结果确定后传入 action 和安全 resourceId；不使用自动读取响应正文的审计中间件，避免创建密钥时复制完整 token。认证中间件提供最小可信 actor；直接登录回调和 Cron 显式传入可信身份。后台生命周期仅在实际 CAS/状态提交成功后记录，已 purged 的幂等续作不重复产生 system 迁移事件。

每个请求有一个服务端 requestId；批量永久删除的各成功项共享该 ID，但各自有独立活动 id。

## 写入失败语义

正常业务提交后，尝试并等待一次有界的活动写入，然后返回原业务结果。条件创建冲突最多重试三次。活动写入失败不把已成功的业务改报 500，避免用户重试造成第二次更新、重复密钥或重复恢复；输出固定故障信号。

业务资源与活动对象没有跨对象事务。Worker 中断或 R2 活动写入故障可能缺少记录；不回滚业务，也不承诺完整审计链。界面说明这是最近操作记录。若未来要求绝不遗漏，应另设计与各资源 CAS 绑定的 outbox，再进入新的审阅流程。

登录记录故障同样不阻止正常登录/不掩盖凭据错误。保留清理故障不影响已提交记录和业务，后续 Cron 重试。

## 保留与分页

- 默认保留最近 **2000 条**，符合文档 1000–5000 条建议；P8 不增加设置项。
- 复用现有每 15 分钟 Cron，独立执行活动清理与 Bin 生命周期维护，一个任务失败不阻止另一个尝试。
- 从排序后的对象列表保留最新 2000 个，分页删除更旧对象，使用 R2 支持的批量删除上限；只操作标准 activity 前缀内的合法键。
- 清理是最终收敛的，两个 Cron 之间及存储故障时可能暂时超过 2000 条；不宣称并发下有硬容量上限。保留上限不取决于 KV。
- 列表一次返回 1–100 条，默认 50 条，支持 action/resourceType 枚举筛选。使用服务端对象键锚点游标，绑定本次筛选条件，严格校验键格式和参数；只能遍历 activity 前缀。
- 新记录进入时不重复已有页。清理导致下一页缺少旧记录时正常结束，不要求永久快照；过滤条件变化重新开始分页。
- R2 分页扫描设置有界工作量，必要时返回 nextCursor，允许某页少于 limit；不在单个请求里无限遍历。只获取返回项的 JSON；筛选用安全 customMetadata，旧/损坏记录跳过或给固定诊断，不返回任意存储字段。

## API 与权限

```text
GET /api/v1/activity?limit=50&cursor=...&action=...&resourceType=...
=> { items: ActivityEntry[], nextCursor: string | null, retentionLimit: 2000 }
```

仅管理 Session 可读。与密钥管理一样，显式 Authorization 返回 401 `session_required`，即使同时有 Cookie；不新增 activity Scope，也不通过 bin:read 等权限泄露整个操作记录。匿名/过期 Session 返回 401；非法 limit/filter/cursor 返回 400；存储失败返回通用 500；响应 `Cache-Control: no-store`。

不提供公共列表、前端提交记录或删除记录接口。新增 route 加入所有现有 API Key Scope 矩阵：每个单 Scope 与组合 Scope 都不能读取活动列表。

## 管理界面

启用现有侧栏“活动记录”，增加 `/#/activity` 深链接，沿用 hash 导航与未保存草稿离页保护。

以中文列表显示时间、固定操作摘要、资源类型/ID、身份类别/安全 ID、provider、requestId。UUID 在手机布局自动换行，不展示不可信 HTML，不依赖已删除资源仍可查询。提供刷新、按操作/资源筛选、加载更多，以及 Loading/Empty/Error/重试状态。查询消费 AbortSignal；离开页面、切换筛选或刷新后旧请求不能拼入新列表。401 说明登录过期，不静默清空原内容。

页面注明最近 2000 条的清理策略和故障下可能缺失的语义。主题、键盘操作和移动布局沿用现有组件样式。

## 验收与交付

1. Worker/R2：活动追加不覆盖、同毫秒并发、倒序分页/筛选/非法游标、超过 1000 对象的分页和清理、2000 保留收敛、故障续作、Session-only 权限矩阵。
2. 记录范围：登录成功/失败、Session/API Key 写入、资源管理、历史恢复、回收站批量部分成功、实际 Cron 转移；失败 CAS 不产生成功事件；活动写入失败不改报已成功业务。
3. 隐私：以唯一 canary 标记密码、用户名输入、Cookie、Authorization、Token、JSON、字段名/描述、OAuth 参数；读取全部活动对象与响应，验证标记未进入正文/customMetadata/固定诊断。正向核对安全 action/resourceId/actor/requestId，防止只通过“没有敏感字段”空测。
4. 浏览器：导航/刷新持久、分页/过滤、空状态与加载失败重试、网络/Session 失败、快速切换与慢响应、草稿离页确认、手机和深色布局。
5. 保留全部 P0–P7 回归；运行 typecheck、生产构建、完整 Worker/客户端与 Chromium 测试；新审查如可用则做一次整分支审查，无法完成时如实记录。
6. 更新 DEVELOPMENT/README，按已授权的 main 集成/推送方式交付，核对具体提交的 GitHub CI 与 Workers Builds。生产功能及真实 Cron 手动验收继续单独记录，缺少正式 URL/认证不标记通过。

## 审阅重点

记录的可信身份来源；创建密钥不能泄露 token；成功业务后记录失败不会诱发危险重试；后台幂等续作与批量部分成功；并发清理不误删更新的记录；分页慢请求不混入新筛选结果；声明的保留与完整性限制是否适合个人仓库。

此设计已确认；按逐任务 RED→GREEN 实施计划执行，沿用原生方式。
