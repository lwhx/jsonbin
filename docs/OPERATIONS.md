# 备份、恢复与 v3 发布验收

适用于当前 Cloudflare Workers / R2 / KV 实现。生产验收结果记录在 [开发进度](DEVELOPMENT.md#p12-稳定性安全与-v300)；构建部署成功和业务运行验收分别记录。

## 配置与安全

部署绑定 DATA 到目标 R2 桶，CACHE 到可丢弃的目标 KV 命名空间。密码登录 IP 分级封禁记录存放在 DATA 的 `auth/login-guard/` 下，R2 CAS 防止并发失败计数丢失，存储键是基于 SESSION_SECRET 的 IP HMAC，不包含明文 IP。错误 3 次锁定 60 秒；24 小时失败累计达到 6 次则该 IP 的密码登录封禁 24 小时。OAuth、既有 Session 和 API Key 不受影响；每日 03:00 UTC 的现有 Cron 清理至多 100 个已过期且超过 48 小时未更新的记录。R2 不可用时密码登录返回 503 而不会降级成无限制；密钥轮换会使 IP 锁状态使用新的标识。密码、SESSION_SECRET、可选 TOKEN_PEPPER/GITHUB_CLIENT_SECRET 使用 Cloudflare Secrets；SESSION_SECRET 至少 32 字符。登录配置只有具备有效签名 Secret 才显示启用。更换 SESSION_SECRET 使旧登录失效，并使此前加密保存的 API Key 完整明文无法再次解密；API Key 的 digest 认证本身不依赖 SESSION_SECRET，因此原 Token 仍可继续认证。TOKEN_PEPPER 轮换前创建并验证替代 API Key，再撤销旧 Key，否则旧 HMAC Key 失效。

APP_ORIGIN 默认可省略，浏览器仅允许请求站点自身。显式值必须是完整规范 Origin，例如 `https://json.example.com`，没有路径、末尾斜杠、凭据或通配符；错误配置拒绝 browser Origin。登录、退出、Session 写入也使用该规则。无 Origin 的 curl/Python 仍须有效认证；配置 CORS 不会授予 Scope。

API 一律 no-store。静态安全响应头来自 `public/_headers`，JSON API 来自 Worker；Monaco 的 inline style/self/blob worker 是 CSP 的已验证需求，脚本不允许 unsafe-eval。应用异常日志仅有固定事件、请求 ID 和方法。不要把密码、Token、Cookie、OAuth code/state 或用户 JSON 放入 URL、命令行、共享日志。平台级访问日志可能记录 URL，另行设置可访问人员和保留时间；排查通过响应 `X-Request-ID` 关联应用日志。

## SEC-001：可撤销 Session 与 14 天固定有效期

- 新版本的 Cookie 仍为 HttpOnly、HTTPS 下 Secure、SameSite=Lax，`Max-Age=1209600`，固定有效期 14 天。浏览器关闭、系统重启、刷新网页及普通请求均不会自动登出或续期。
- 服务端权威会话注册表：R2 `system/auth/sessions.json`。每次合法 Cookie 鉴权执行 **一次 R2 GET**，不产生写入；签名正确但已被撤销/不在注册表中的 SID 返回 401。退出当前设备与“退出所有设备”以 R2 ETag CAS 更新注册表；后者同时轮换会话代次和禁用旧版 Cookie。
- **兼容迁移：** 升级前签发的合法旧 Cookie **严格按照各自签名载荷中的原始 `exp` 自然过期**，不设置硬编码日历截止日（否则审批或部署延后可能提前注销用户）。旧 Cookie 没有 SID，不进入设备列表；用户主动退出时服务器保存其单向 HMAC 撤销指纹，管理员全设备退出立即禁用所有旧 Cookie。任何验证请求不会续期；新版本登录始终签发有 SID 的 Cookie。
- R2 失联、权限错误或策略文件损坏：受保护请求返回 503 `session_state_unavailable`，不发放新 Cookie，不把暂时错误当作用户退出。用户待 R2 恢复后重试。管理端“退出”只有服务端提交成功后才清理页面登录态。
- 所有 Session 统一依赖 R2；Secret 轮换依旧会使旧 Cookie 立即失效。**回滚到 SEC-001 之前的 Worker 版本会重新允许只验证 HMAC 的 Cookie，属于安全降级**，应优先回滚到含服务端校验的兼容版，必要时经批准轮换签名 Secret。恢复旧 R2 快照也可能恢复已撤销的 SID，必须考虑密钥轮换与会话重新登录。
- Cron 每日 UTC 03:00 清理过期的会话条目；所有 session 元数据都不会写入 KV、活动正文或业务导出。保留 R2 备份与回滚计划；不要手工删除 R2 policy。
- **合成性能对照：** [GitHub Actions 同机运行](https://github.com/lwhx/jsonbin/actions/runs/37880653901)，Miniflare、300 次顺序调用有效 Cookie 的 `GET /api/v1/auth/me`，旧代码对照 R2 GET=0、PUT=0，SEC-001 新代码 R2 GET=300、PUT=0；P50 **4.19ms → 10.44ms**，P95 **13.10ms → 14.01ms**。这是隔离合成结果，不可视为生产性能保证；按用户规模观察实际 Workers/R2 指标，再考虑在**不牺牲撤销即时性**的前提下降低 R2 单次读取成本。

## 日常业务备份

1. 管理 Session 登录设置页，导出全部业务备份；也可 `GET /api/v1/system/export?scope=all&format=backup`。ZIP 仅由浏览器包装，包含 manifest.json/backup.json、SHA-256 和 CRC32。
2. 在受控备份存储中记录环境、日期、文件 SHA-256、服务版本、资源/版本数量，并验证 JSON/ZIP 能被设置页正常预览。业务 JSON 可能包含用户自己的敏感数据，按真实业务数据限制备份访问。
3. 业务包保留默认设置、集合、模型修订、Bin 历史、回收站和永久删除标记。包上限 100 资源 / 250 逻辑对象 / 10 MiB。超限返回错误，不能把失败/部分文件视为备份。
4. 业务包不包含 API Keys/摘要、Secret、活动、KV 或内部恢复标记。需要完整灾难恢复时同时执行下方 R2 快照与独立配置清单；不要把凭据值写进业务包或 Git。

保留周期和备份频率根据部署者的恢复目标设置；仓库没有自动备份任务。回收站保留到手动永久删除，Cron 不会按 30 天自动清空。

## 完整 R2 备份

业务导出超限、需要恢复 API Key 元数据/活动，或需要完整灾难恢复时使用 Cloudflare R2 的 S3 兼容接口或账户支持的备份工具。R2 强一致性不等于跨多个对象的事务快照：复制期间暂停写入、导入和 Cron 维护，记录暂停窗口，复制所有对象及清单到独立受控目标，再恢复服务。不要在持续写入时把一次对象遍历称为一致快照。

示例为单向复制，使用已安全配置的 AWS profile / R2 endpoint。独立备份目的桶不绑定生产应用；不用 `--delete`，不覆盖已有备份前缀。

~~~bash
aws --profile "$JSONBIN_BACKUP_PROFILE" --endpoint-url "$JSONBIN_R2_ENDPOINT" \
  s3 sync "s3://$JSONBIN_SOURCE_BUCKET/" "s3://$JSONBIN_BACKUP_BUCKET/$JSONBIN_BACKUP_PREFIX/" \
  --only-show-errors
~~~

R2 对象包含 immutable versions、模型修订、canonical metadata、legacy trash、purged terminal markers、system settings、pending import 和 receipt 状态。不要只复制 current.json 或丢弃永久删除标记，否则恢复可能破坏历史/生命周期约束。保存对象键/大小及实际内容 SHA-256 清单并抽查下载；multipart ETag 不等于内容 SHA-256。`indexes/` 是派生数据，可以在恢复后重新生成。

独立保存绑定名称、桶/命名空间、兼容日期、Cron 配置、Origin、OAuth callback 和 Secret 版本的安全配置清单。系统 Secret 由安全凭据存储恢复；复制 R2 不会复制 Worker Secrets。API Key HMAC 元数据恢复后仍要求原 TOKEN_PEPPER，Session 使用新 Secret 时重新登录即可。

## 在隔离实例恢复并演练

1. 建立空 R2 桶和独立 KV，部署相同或兼容服务版本；设置独立域名、APP_ORIGIN、Secret 和 OAuth callback，先关闭 Cron。保留原环境及备份。
2. 业务包通过设置页预览后逐资源恢复，集合/模型在 Bin 之前。核对每项 created/unchanged/skipped/failed 和 warnings；HTTP 200 不代表全部成功。既有资源不会被覆盖，changed backup 不能接管中断恢复；需要完整迁移时用空实例。
3. 默认设置另行读取目标 ETag 并 PATCH。恢复保留 ID、历史、锁、公开性和 TTL；过期 Bin 按到期规则进入回收站。
4. 完整 R2 快照则复制到空目标桶，逐项核对清单；先核对 pending/purging/terminal 状态，不手工删除安全标记。恢复生产写入前验证当前值、历史、集合、模型、锁、公开读与私有读边界、ETag 冲突和 API Key Scope。
5. KV 无需备份恢复。设置页点击重建索引，或用 Session `POST /api/v1/search/rebuild`，核对 source/count/搜索结果。503 search_cleanup_limit_exceeded 可继续重建；KV 故障时 R2 搜索回退仍可用，认证/TTL 不能依赖缓存。
6. 确认通过后开启 Cron，核对真实一次 scheduled 执行及结果，再切换域名/绑定。失败时保持原服务可回退；不把切换和删除旧桶绑成一个步骤。

业务恢复的 ETag 由目标 R2 重新生成，不能沿用源环境缓存的 ETag。重复已完成恢复可 unchanged，中断可用同包续作；取消/网络失败不回滚已发布资源，先查列表再重试。

## stable 发布门槛

> v3.0.0 状态：✅ 已完成生产验收（2026-10-04，`https://js.gnn.im`）。以下清单继续作为后续 stable / patch 发布的标准验收模板。

本地执行 `npm run typecheck`、`npm test`、`npm run test:browser`。最后两项使用构建后的 Worker / 真实本地 R2/KV；生产构建浏览器另外通过 Assets 路由验证 CSP。用精确功能 SHA 核对 GitHub CI、Workers Builds success 和 Version ID。

生产 URL 确认后运行公开探针（只 GET/OPTIONS，无登录或业务写入）：

~~~bash
npm run check:production -- https://your-production-domain.example
~~~

如果 APP_ORIGIN 明确指向另一 Dashboard Origin，设置 `JSONBIN_BROWSER_ORIGIN` 为该 Origin 再运行。探针核对当前 package 版本、R2/KV 绑定声明、HTML/API 安全头、no-store、匿名管理拒绝及同站/跨站 CORS。health 只声明绑定存在，不能证明 R2/KV 的实际读写；探针不能验证以下登录项目。

在生产创建专用验收资源，记录结果并只清理这些资源：

| 项目 | 必须记录的实际证据 |
| --- | --- |
| 登录/退出 | 密码和配置启用时的 GitHub OAuth 成功；state 错误、非允许 GitHub ID 拒绝；HTTPS Cookie 属性与 Secret 轮换 |
| API 权限 | 匿名私有/历史/搜索拒绝，公开当前值可读；实际 Bearer 各 Scope、过期/撤销、显式 Bearer 不回退 Cookie |
| 数据与并发 | CRUD、不可变历史、If-Match 冲突、锁、Draft 7 校验、集合/模型关联、回收站恢复 |
| 页面 | 实际部署的 CSP 下登录/编辑/保存/刷新；390px 手机、深色模式、中文、无 CSP violation |
| 搜索与恢复 | 实际 KV 重建与 R2 回退；隔离环境导出/恢复演练及资源/历史核对 |
| TTL/Cron | 一个专用短 TTL Bin 请求到期后不可读；记录一次真实 15 分钟 Cron 日志和维护结果，含活动清理/续作任务 |

v3.0.0 已按上述门槛完成生产验收并晋升 stable。后续版本仍必须先完成对应生产项目、本地检查和远端部署证据，再更新版本号与发布标签；未完成时不得提前标记为 stable。

## API Key 近似使用统计：KV + R2 日结（方案 B）

> 适用第二轮 P0 性能优化。使用次数是**近似值**，不用于计费、强一致配额或权限判断。

- 每次 API Key 请求始终读取 R2 权威元数据，并按原先 Token 摘要、Scope、资源范围、过期、撤销和速率限制鉴权。`401` / `403` / `429` 不计入“已授权使用”；经过授权的 `404` / `422` / `5xx` 仍计入。
- 使用次数沿用已有 `analytics:agg:<UTC-hour>:<shard>` KV 统计，**每请求不额外写 KV，也不修改 R2 Key metadata**。Cloudflare KV 最终一致、同键写入有节流，存在短暂滞后或漏计，不承诺精确值。
- API Key 管理列表保留 `usageTotal` / `usageDaily` / `lastUsedAt` 旧字段并显示尚未结算的当日/昨日增量；新字段 `usageApproximate`、`usageStatus`、`usageAsOf` 只描述统计，`usageAppliedDays` 仅存在于 R2 内部，绝不对外返回。
- Cron 沿用 `*/15 * * * *`，于 UTC 次日 **00:30 后**开始结算完整昨日以及最多另外两天；每次最多为 100 个未结算 Key 写 R2 CAS。`usageAppliedDays` 实现幂等，即使 KV 日完成标记丢失也不会重复添加。KV 分片损坏或访问失败不得推进该日完成标记；后续 Cron 重试。
- 若 `CACHE` 缺失或读写失败，业务 API 继续依靠 R2 工作；管理端使用旧 R2 累计值并标注“统计暂不可用”。恢复 KV 后不应手动清零或覆盖 R2 Key metadata。
- 观察 `keyusage:v2:done:<YYYY-MM-DD>` 的存在与 Key metadata 中的对应 `usageAppliedDays`，核对日结、Cron 延迟、R2 PUT 次数。KV 小时桶保留 35 天，自动恢复窗口最多 3 日；超过窗口的统计缺口不可自动冒充完整。
- 发布：先让 PR #6 和当前功能 PR 完成 CI，通过隔离 R2/KV 测试环境验证旧 Key、撤销、跨日和重试；再执行灰度发布并观察连续两次 UTC 日结。**不要直接部署本分支到生产**。
- 回滚：保留全部 R2 Key 元数据和 KV 桶，严禁删除 `usageAppliedDays` 或重置 `usageTotal`；如果退回旧版会重新启用逐请求 R2 累加，切回新版前需比对该时间段是否已经计入新 KV 事件，防止交叉版本重复结算。不要把 API Key 业务备份中的缺失视为可安全删除凭据。
