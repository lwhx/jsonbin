# 备份、恢复与 v3 发布验收

适用于当前 Cloudflare Workers / R2 / KV 实现。生产验收结果记录在 [开发进度](DEVELOPMENT.md#p12-稳定性安全与-v300)；构建部署成功和业务运行验收分别记录。

## 配置与安全

部署绑定 DATA 到目标 R2 桶，CACHE 到可丢弃的目标 KV 命名空间。密码登录 IP 分级封禁记录存放在 DATA 的 `auth/login-guard/` 下，R2 CAS 防止并发失败计数丢失，存储键是基于 SESSION_SECRET 的 IP HMAC，不包含明文 IP。错误 3 次锁定 60 秒；24 小时失败累计达到 6 次则该 IP 的密码登录封禁 24 小时。OAuth、既有 Session 和 API Key 不受影响；每日 03:00 UTC 的现有 Cron 清理至多 100 个已过期且超过 48 小时未更新的记录。R2 不可用时密码登录返回 503 而不会降级成无限制；密钥轮换会使 IP 锁状态使用新的标识。密码、SESSION_SECRET、可选 TOKEN_PEPPER/GITHUB_CLIENT_SECRET 使用 Cloudflare Secrets；SESSION_SECRET 至少 32 字符。登录配置只有具备有效签名 Secret 才显示启用。更换 SESSION_SECRET 使旧登录失效，并使此前加密保存的 API Key 完整明文无法再次解密；API Key 的 digest 认证本身不依赖 SESSION_SECRET，因此原 Token 仍可继续认证。TOKEN_PEPPER 轮换前创建并验证替代 API Key，再撤销旧 Key，否则旧 HMAC Key 失效。

APP_ORIGIN 默认可省略，浏览器仅允许请求站点自身。显式值必须是完整规范 Origin，例如 `https://json.example.com`，没有路径、末尾斜杠、凭据或通配符；错误配置拒绝 browser Origin。登录、退出、Session 写入也使用该规则。无 Origin 的 curl/Python 仍须有效认证；配置 CORS 不会授予 Scope。

API 一律 no-store。静态安全响应头来自 `public/_headers`，JSON API 来自 Worker；Monaco 的 inline style/self/blob worker 是 CSP 的已验证需求，脚本不允许 unsafe-eval。应用异常日志仅有固定事件、请求 ID 和方法。不要把密码、Token、Cookie、OAuth code/state 或用户 JSON 放入 URL、命令行、共享日志。平台级访问日志可能记录 URL，另行设置可访问人员和保留时间；排查通过响应 `X-Request-ID` 关联应用日志。

## SEC-002 限流发布与回滚

此版本把 API Key 和公开 Bin 匿名读取的安全限流从非原子的 CACHE KV 迁移到 SQLite-backed Durable Object。保持 R2 Key 元数据、Scope、资源权限、过期/撤销、Token 以及现有 Key 自定义 `rateLimitPerMinute` 不变。发布不修改任何业务 Bin 或 Key 数据。

- 部署前先核对 `wrangler.jsonc` 的 `RATE_LIMITER` binding 和 `exports.ApiRateLimiter`（`storage: sqlite`）；新的 class 会在首次发布时自动建立命名空间。不要使用 KV-backed DO。检查 Cloudflare 账户对 Durable Objects 的请求、运行时间与 SQLite rows written 配额；每个受限请求新增一次 DO RPC/最多一次 SQL 行写入。
- 在完全隔离的测试 Worker + R2 + KV 中运行 `npm ci`、`npm run typecheck`、`npm test`、`npm run test:browser`、`npx wrangler deploy --dry-run`。本地 Miniflare 使用 `useSQLite: true`，真实 Cloudflare 边缘会写入 `CF-Connecting-IP`；模拟调用时需显式提供合法测试 IP。
- 在灰度环境验证：同 Key 第 N 次成功、N+1 次 429、`Retry-After`；两个 Key 不共享计数；不同匿名 IP 不共享计数；无效/撤销/Scope 不足的 Bearer 不能退回匿名；public→private 立即拒绝新匿名请求；有效 Session 读取不占匿名桶；DO binding 故障显式 503。执行少量并发请求确认没有超配额通过。
- 发布前先检查 `GET /api/v1/system/health` 的 `rateLimiterConfigured:true`，并通过 `/api/v1/auth/config` 确认至少启用了密码或 GitHub OAuth 一种管理员登录方式。生产检查脚本 `scripts/check-production.mjs` 已将二者列入必过项，防止漏配限流命名空间或丢失登录 Secret 后仍误认为可以上线。**`rateLimiterConfigured` 只表示绑定存在，不代表 DO RPC/SQLite 已实测成功**；要验证真实限流仍需受控 Key 请求的 429/Retry-After 和 503 告警检查。
- 监控 Worker 的 429/503 占比、DO 请求/存储用量、P95 延迟与业务错误率；`503 rate_limit_unavailable` 需要修复 binding 或服务，**不能**靠删除限流调用来降级。公开读缺少 `CF-Connecting-IP` 返回 `503 anonymous_identity_unavailable`，应核对代理链和可信边缘来源。
- **生命周期变更不能直接回滚旧 Worker 版本。** 首次通过 `exports.ApiRateLimiter` 创建 SQLite Durable Object 命名空间后，Cloudflare 不允许跨越这次生命周期变更执行平台版本回滚，也不能恢复旧版 `migrations` 配置。出现严重故障应**向前部署补救版本**：保留同名 `ApiRateLimiter` 类导出、`exports.ApiRateLimiter` 与 `RATE_LIMITER` 绑定，恢复上一版已经验证的其他业务路由逻辑，重新构建并执行 `wrangler deploy`；不要删除 R2、Key、DO 命名空间，也不能只把 Git HEAD reset 到引入 DO 前再直接部署。若临时改回 KV best-effort 计数，必须显式记录安全性下降并启用 Cloudflare WAF 兜底，绝不能默认关闭限流；API Key 的 Token、Scope 和用量保持原状。
- Durable Object 限流针对应用级请求额度，不替代 Cloudflare WAF、DDoS 防御或账户登录独立 R2 封禁。对全站公开健康/API 文档接口、异常高频探测和大量随机 Bin ID 请求，应另外在 Cloudflare Security 配置并验收 per-IP 规则；不要把内部 HMAC 身份标识与日志关联泄露。

### SEC-002：隔离 Preview 准备（只操作非生产资源）

仓库已设置 `previews.durable_objects.bindings.RATE_LIMITER`，Worker Previews 为每个 Preview 自动分配独立的 DO namespace。预览读取 `previews.r2_buckets.DATA` 指向 **`jsonbin-sec002-preview-data`**，与生产 `jsonbin-data` 不同；本批 Preview 为避免未知 KV ID 误绑生产，暂不配置 `CACHE`（索引/近似统计可能不可用，完整 KV 功能须另建 Preview 专用命名空间再加绑定）。生产配置、Cron 和部署分支均不变。

1. **在 Cloudflare R2 新建空桶** `jsonbin-sec002-preview-data`（仅测试数据）。可运行 `npx wrangler r2 bucket create jsonbin-sec002-preview-data`；不得将 `previews.DATA` 改为生产桶，也不要复制生产数据到 Preview。
2. 在 Cloudflare Workers → `jsonbin` → Settings → Builds 查看当前分支预览模式。既有项目如仍使用旧 Preview 模式，在 **Set up Worker Previews** 向导中明确核对并执行一次性切换（**不可逆**）。新的 Preview command 必须是 `npx wrangler preview`，**禁止**填 `npx wrangler deploy`，否则可能发布到生产。生产分支仍为 `main`。
3. 预览不继承生产 secrets。**当前 SEC-002 Preview 已存在**：需分别运行 `npx wrangler preview secret put ADMIN_PASSWORD --name security-sec-002-api-key-public-rate-limits` 和 `npx wrangler preview secret put SESSION_SECRET --name security-sec-002-api-key-public-rate-limits`，交互输入两个新的预览专用值，至少 32 字符，切勿复用生产。`preview base-config secret put` **只会影响之后新建的 Preview，不能给已经存在的 SEC-002 Preview 补 Secret**。用户名由 `previews.vars.ADMIN_USERNAME` 设置为 `preview-admin`，不必配置 GitHub OAuth。
4. 重新运行 Preview Build，核查 PR 返回的真实 Preview URL，记录 DO 和 R2 binding。先创建公开/私有测试 Bin、测试 API Key，再实际验证第 N+1 次 429、`Retry-After`、撤销/过期、public→private、503 故障处理。不得用真实 API Key 或生产 Bin 作为测试对象。
5. 若要进一步验证 KV 搜索与用量统计，单独创建非生产 KV 命名空间后，将**其真实 ID**填到 `previews.kv_namespaces` 的 `CACHE` 项；切勿直接复制顶层生产 `CACHE.id`。测试结束删除专用 Preview 以及测试桶/命名空间之前核对资源归属，切勿误删生产资源。

SEC-002 的 Preview 构建已于 2026-10-09 在独立测试 R2 桶创建后**成功**：Wrangler 4.147.0 通过 `npx wrangler preview` 发布；Cloudflare 记录为 Success。GitHub Actions 的只读实站测试确认 HTTP 健康状态、预览 R2/无生产 KV、401 鉴权与 CORS。已确认 `GET /api/v1/auth/config` 的 `passwordEnabled:false`，因此**有凭据测试尚未完成**，下一步先单独配置该 Preview 的 Secret。

### 只读检查 Cloudflare 构建失败原因

GitHub PR 只展示 `Workers Builds: jsonbin` 的失败结果，不包含 Cloudflare 账户内的原始构建日志。使用仓库脚本检索对应构建的错误摘要；它只执行 Cloudflare API 的 `GET`，不会触发部署、重试、修改 R2/KV/DO 或切换预览模式。

1. 在 Cloudflare 创建仅具备 **Workers CI Read** 权限的临时 API Token，并在运行终端的环境变量 `CLOUDFLARE_API_TOKEN` 中设置。不要在命令行参数、仓库、截图或聊天中直接传递 Token。
2. 从 GitHub PR 的 Workers Builds 检查结果打开 Cloudflare 构建详情，复制浏览器的 Build URL。例如：
   ```bash
   node scripts/inspect-cloudflare-build.mjs --url "https://dash.cloudflare.com/<account>/workers/services/view/jsonbin/production/builds/<build-uuid>"
   ```
   如果只有 Build UUID，可以设置 `CLOUDFLARE_ACCOUNT_ID` 后使用 `--build <build-uuid>`。
3. 脚本读取构建元信息和分页日志，默认仅显示错误或部署相关行；`--all` 可读取最近 100 行，`--json` 便于复制结构化诊断结果。脚本会尽力遮蔽常见凭据，但**分享日志前仍必须人工检查**是否包含 URL 参数、Token 或其它敏感信息。
4. 核对实际 `deploy_command`、错误码及失败所在阶段。如果仍为旧版 `wrangler versions upload`，先评估账户级不可逆的 Worker Previews 切换；不要在未确认配置与资源隔离时将 PR 分支命令改为 `wrangler deploy`。

Cloudflare 官方只读日志接口：`GET /accounts/{account_id}/builds/builds/{build_uuid}/logs`。本脚本不会保存 API Token 或日志到磁盘，也不以构建失败状态作为调用失败。

### SEC-002 有凭据 Preview 验收

自动化只读测试（GitHub Actions 的 `SEC-002 Preview Runtime Smoke`）已经通过，证明测试 R2/公开路由/跨域规则可用，但这**不等于**真实 API Key 和 429 限流验收通过。

1. 在本项目 Git 分支 `security/sec-002-api-key-public-rate-limits` 所在目录执行下面两条命令，分别输入与生产完全不同的 Preview Secret（`SESSION_SECRET` 至少 32 字符）。**必须使用单个 Preview 的命令，不要只修改 Base Secret**：

```bash
npx wrangler preview secret put ADMIN_PASSWORD --name security-sec-002-api-key-public-rate-limits
npx wrangler preview secret put SESSION_SECRET --name security-sec-002-api-key-public-rate-limits
```

2. 在 Preview URL 打开 `/api/v1/auth/config`，确认 `passwordEnabled:true`。用户名是 `preview-admin`。不要在 PR、聊天、截图或命令参数中泄露密码。若有新部署，等其完成。
3. 在本地运行仓库的**可选有凭据验收脚本**：它只接受 SEC-002 Preview 固定域名，要求显式 `--execute` 才会创建临时 Bin/Key；验证公开/私有读、资源作用域、3/min 配额的第 4 次请求返回 429、`Retry-After`、不限流 `null`、撤销、公开转私有；退出时按本次创建的 UUID 尝试清理测试数据。

```powershell
$secret = Read-Host '输入预览专用 ADMIN_PASSWORD' -AsSecureString
$env:SEC002_PREVIEW_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $secret).Password
node scripts/check-sec002-preview-auth.mjs --execute
Remove-Item Env:SEC002_PREVIEW_ADMIN_PASSWORD
```

4. 验证清理警告并检查 `jsonbin-sec002-preview-data` 对应 Preview 的回收站；出现中断或错误时只清理 `SEC002-` 前缀的本轮测试资源，不清理生产数据。此脚本不验证 240/min 大流量的匿名限流边界；该边界由 Miniflare 原子并发测试覆盖，必要时另在专用测试流量配额下实测。

**上线门槛：** GitHub CI + Cloudflare Preview 部署 + 只读实测已通过；有凭据真实 E2E、发布回滚演练和生产发布审批仍待完成。保持 PR Draft，严禁直接把测试配置部署到 `main`。

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
