# JSONBin v3 开发文档

> 基线日期：2026-10-03  
> 主分支：main  
> 当前版本：3.0.0-alpha.4  
> 本文档是后续开发的执行清单。新增功能原则上按本文档顺序推进；每完成一个阶段，需要同步更新状态、API 文档和验收结果。

## 1. 产品定位

JSONBin v3 是一个面向个人使用的 Cloudflare 原生 JSON 存储、配置中心和轻量后端。

核心目标：

- 单用户、私有优先，不做多租户账号体系。
- Web 管理界面简单、现代、中文化。
- 提供稳定 REST API，方便脚本、青龙、VPS、Worker 和小型应用调用。
- R2 保存权威数据，KV 只做可重建缓存和索引。
- JSON 数据保留不可变版本历史，可查看、对比和恢复。
- 尽量减少基础设施，只依赖 Cloudflare Workers、R2、KV。

明确不使用：

- MongoDB
- D1
- Redis
- 独立 VPS 数据库
- 服务端 Session 数据库

## 2. 当前实际状态

| 模块 | 状态 | 当前能力 |
| --- | --- | --- |
| Cloudflare Workers | ✅ 已完成 | Hono API、静态前端、自动部署 |
| R2 | ✅ 已完成 | DATA 绑定，作为权威数据源 |
| KV | ✅ 已完成 | CACHE 绑定，暂未承担正式索引职责 |
| 登录 | ✅ 基础完成 | 用户名 + 密码；可选 GitHub OAuth |
| Session | ✅ 已完成 | HMAC 签名 Cookie，14 天有效期 |
| 中文界面 | ✅ 已完成 | 当前主要可见 UI 已中文化 |
| 概览 | ✅ 基础完成 | 数据仓数量、版本数、存储量、系统状态 |
| 数据仓列表 | ✅ 基础完成 | 列表、搜索、创建 |
| 数据仓读取 | ✅ 后端完成 | GET /api/v1/bins/:id |
| 数据仓更新 | ✅ 本地验收通过 | PUT + ETag/If-Match；版本文件不可覆盖；meta 条件更新 |
| 数据仓删除 | ✅ 后端完成 | canonical meta 条件写入删除标记，作为回收记录；历史版本保留，锁定时拒绝普通删除 |
| 数据仓详情页 | ✅ 本地验收通过，线上待验收 | Monaco 编辑器、保存、删除确认、元数据设置、深链接 |
| 版本历史 | ✅ 本地完成 | 版本列表、读取、任意两版 Diff、追加式恢复；线上验收待执行 |
| 集合 | ✅ 本地与 CI 验收完成 | 集合 CRUD、详情、成员计数、移入/移出及删除关联清理；Workers Builds 成功，生产功能待验收 |
| 数据模型 | ✅ 本地与 CI 验收完成 | Draft 7 模型 CRUD、样本校验、Bin 固定修订绑定/锁定/升级；Workers Builds 成功，生产功能待验收 |
| API 密钥 | ✅ 本地与 CI 验收完成 | Session 管理、一次性明文、Scope/过期/撤销/最后使用、Bearer 认证；Workers Builds 成功，生产功能待验收 |
| 高级 Bin API | ✅ 本地与 CI 验收完成 | Merge Patch、深层路径、数据锁、公开当前读取；Workers Builds 成功，生产功能待验收 |
| 活动记录 | ✅ 已完成；CI / Workers Builds 通过 | R2 操作记录、Session-only 列表、筛选/分页和保留清理 |
| API 文档 | ✅ 已完成；CI / Workers Builds 通过 | 中文文档页、三语言示例、Bin 动态 API 与复制反馈 |
| TTL 与回收站 | ✅ 本地验收完成，CI 待验证 | 到期读写控制、定时归档、恢复、永久删除及批量清空；兼容旧 trash 记录 |
| 设置 | ⬜ 未开始 | 只有导航占位 |
| 全局搜索 | ⬜ 未开始 | 顶部仅 UI 占位 |

## 3. 不允许随意改变的架构约定

### 3.1 R2 是唯一权威数据源

所有重要状态必须能够仅依靠 R2 完整恢复。

R2 保存：

- Bin 元数据和 JSON 版本
- Collection 元数据
- Schema 和 Schema 元数据
- API Key 摘要与权限
- 系统设置
- 回收站记录
- 需要永久保留的活动记录

### 3.2 KV 只能保存派生数据

KV 可以保存：

- slug -> ID
- 搜索索引
- 集合成员索引
- Dashboard 汇总
- 公共读取缓存
- 短期缓存

KV 内容被全部清空后，系统必须能够从 R2 重建。

禁止仅把以下信息放在 KV：

- 当前版本号
- 锁状态
- API Key 权限
- Schema 绑定关系
- 安全配置
- 唯一一份业务数据

### 3.3 Bin 版本不可修改

目标 R2 结构：

~~~text
bins/
  <binId>/
    meta.json
    versions/
      000001.json
      000002.json
      000003.json
~~~

versions 下已经写入的版本不得覆盖。

更新流程固定为：

1. 读取 meta.json。
2. 校验锁和 If-Match。
3. 写入新的版本文件。
4. 条件更新 meta.json 的 currentVersion。
5. 返回新的 ETag 和版本号。

如果第 3 步成功、第 4 步因并发冲突失败，允许出现孤立版本文件；meta.json 始终是当前版本的最终权威。

### 3.4 删除不是立即物理删除

普通删除：

- 通过 R2 条件写入，在 bins/<id>/meta.json 标记 deletedAt，保留其为唯一权威回收记录。
- P7 起不再另外写入 trash/bins/<id>/meta.json；读取兼容早期版本的归档文件，避免迟到的归档覆盖恢复或永久删除结果。
- 版本文件暂时保留，以支持恢复。

恢复：

- 检查回收记录 ETag、历史内容及绑定模型，条件清除删除标记。
- 清除过期时间、恢复为 private，保留数据锁、模型锁及有效集合关联。
- 不修改历史版本内容。

永久删除：

- 先以 CAS 标记 purging，阻止并发恢复，再删除 bins/<id>/versions/ 下全部版本及旧 trash 记录。
- 完成后只保留 ID、删除时间和 purged 状态的最小标记，阻止旧客户端/旧归档重新激活数据。原 JSON、名称、描述、模型关联等均移除。
- 清理失败可重试，定时任务也会续作；目前无正式 KV 派生索引，P11 引入索引后须同步清理。

## 4. Cloudflare 配置约定

### 4.1 Bindings

~~~text
DATA  -> R2 bucket: jsonbin-data
CACHE -> KV namespace
~~~

wrangler.jsonc 中必须保留：

~~~text
keep_vars: true
~~~

这样 GitHub 自动部署时不会覆盖 Cloudflare Dashboard 中手动配置的变量。

### 4.2 必需变量

~~~text
ADMIN_USERNAME
ADMIN_PASSWORD
SESSION_SECRET
~~~

建议：

- ADMIN_USERNAME：普通变量。
- ADMIN_PASSWORD：Cloudflare Secret。
- SESSION_SECRET：Cloudflare Secret，至少 32 个字符。
- TOKEN_PEPPER：可选 Cloudflare Secret，至少 32 个字符；用于新密钥 HMAC 摘要，需保持稳定。缺省/留空时使用 SHA-256；详细轮换行为见 P5。

APP_ORIGIN 可选；正式绑定固定域名后建议填写。

### 4.3 可选 GitHub OAuth

~~~text
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_ALLOWED_USER_ID
~~~

必须使用 GitHub 数字用户 ID 做最终授权判断，不能只按用户名判断。

## 5. API 统一规则

API 基础路径：

~~~text
/api/v1
~~~

### 5.1 返回格式

成功请求尽量直接返回资源：

~~~json
{
  "meta": {},
  "value": {}
}
~~~

失败统一至少包含：

~~~json
{
  "error": "machine_readable_code"
}
~~~

需要时增加：

~~~json
{
  "error": "validation_failed",
  "message": "可读说明",
  "issues": []
}
~~~

### 5.2 常用状态码

| 状态码 | 用途 |
| --- | --- |
| 200 | 成功读取/更新 |
| 201 | 创建成功 |
| 400 | 请求格式错误 |
| 401 | 未登录或 Token 无效 |
| 403 | 已认证但无权限 |
| 404 | 资源不存在 |
| 409 | 通用资源冲突 |
| 412 | ETag / If-Match 版本冲突 |
| 422 | 数据校验失败 |
| 423 | Bin 被锁定 |
| 429 | 限流 |
| 500 | 服务端异常 |

### 5.3 ETag 并发控制

读取 Bin：

~~~http
GET /api/v1/bins/:id
ETag: "xxxx"
~~~

保存时：

~~~http
PUT /api/v1/bins/:id
If-Match: "xxxx"
~~~

如果资源已被其他请求更新：

~~~text
412 etag_conflict
~~~

前端不得静默覆盖，必须提示用户重新加载或查看冲突。

## 6. Web UI 固定信息架构

左侧导航固定为：

~~~text
概览

数据
  数据仓
  集合
  数据模型

开发者
  API 密钥
  活动记录
  API 文档

系统
  回收站
  设置
~~~

界面语言默认中文。

以下技术名词保持英文，不强行翻译：

- JSON
- API
- R2
- KV
- Worker
- GitHub
- ETag
- JSON Schema

## 7. 开发阶段与执行顺序

后续严格按 P1 -> P12 推进。除修复线上故障外，不提前跳到后面的模块。

---

## P0 基础平台

状态：✅ 基本完成

已完成：

- [x] main 作为正式主分支
- [x] Cloudflare 自动构建和部署
- [x] R2 DATA 绑定
- [x] KV CACHE 绑定
- [x] keep_vars 保留 Dashboard 变量
- [x] 用户名密码登录
- [x] Session Cookie
- [x] 可选 GitHub OAuth 基础代码
- [x] 中文 Dashboard
- [x] 基础数据仓列表
- [x] 创建 Bin
- [x] 后端读取/更新/删除 Bin
- [x] GitHub Actions typecheck + build

P0 收尾技术债务：

- [x] Worker health 中版本号与 package.json 自动保持一致
- [x] 检查中文化后 CSS class 不应使用“私有/公开”作为状态类名
- [x] 为 ETag 引号和 Weak ETag 兼容增加测试
- [x] 增加最基础 API smoke test

---

## P1 数据仓详情页与 JSON 编辑器

状态：✅ 实现、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

目标：让“数据仓”从只能创建/查看卡片，变成真正可编辑的数据管理页面。

后端：

- [x] 保持 GET /api/v1/bins/:id
- [x] 完善 PUT /api/v1/bins/:id
- [x] 增加更新 Bin 元数据接口
- [x] 支持修改名称、描述、可见性
- [x] 明确 ETag 返回和 If-Match 行为

前端：

- [x] 点击数据仓卡片进入详情页
- [x] 增加详情页顶部信息栏
- [x] 增加 JSON 编辑器
- [x] JSON 语法校验
- [x] 格式化 JSON
- [x] 保存按钮
- [x] 未保存状态提示
- [x] 保存成功提示
- [x] 412 冲突提示
- [x] 423 锁定提示
- [x] 删除确认
- [x] 复制 Bin ID
- [x] 复制 API 地址

详情页预留 Tab：

~~~text
编辑器 | 树形视图 | 历史版本 | API | 设置
~~~

P1 验收：

1. 新建 Bin。
2. 点击进入详情。
3. 修改 JSON。
4. 保存。
5. 刷新页面后数据仍正确。
6. 版本号 +1。
7. 非法 JSON 无法提交。
8. 使用旧 ETag 写入返回 412。

本地验收记录（2026-10-03）：

- `npm run typecheck`：通过。
- `npm test`：包含生产构建，16 项 Worker/客户端测试通过，0 失败、0 跳过。
- `npm run test:browser`：实际 Chromium，9 项浏览器验收通过，0 失败、0 跳过（包含后续新增的删除确认键盘验收）。
- 已覆盖上述 8 条验收，以及元数据修改、JSON 标量、并发写入、孤立版本保留、Weak ETag、手机/深色界面、复制、键盘打开、前进后退、网络失败与 Session 过期。
- 已修复并回归验证：网络重连不能清空过期 Session 下的草稿；旧 GET 不能覆盖保存结果；已离开的详情页删除完成后不能切走新的编辑页。
- 浏览器锁定错误提示使用网络故障注入；真实 Worker 锁定行为由 R2 集成测试验证。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37121393676) 成功，验证提交 `86cb97a`；Cloudflare Workers Builds 对同一提交报告 success。生产功能验收尚未确认。
- 删除确认弹窗键盘焦点限制已完成：Tab / Shift+Tab 在弹窗内循环，外部焦点被拉回，Escape / 取消后恢复触发按钮焦点，删除请求期间焦点保留在弹窗，失败后恢复焦点。
- 浏览器验收使用独立的 `tests/wrangler.jsonc` 和临时本地存储，测试账号不再被开发用 `.dev.vars` 覆盖；保留开发者已有配置。
- 后续复验：类型检查、生产构建、16 项 Worker/客户端测试及 9 项浏览器验收通过。GitHub API 访问已恢复，CI 和 Workers Builds 的成功状态已核实；生产地址及功能验收结果尚未提供。

新增元数据接口：

~~~http
PATCH /api/v1/bins/:id/meta
Content-Type: application/json
If-Match: "当前 ETag"

{"name":"名称","description":"描述","visibility":"private"}
~~~

至少提供一个允许字段；名称 trim 后 1–160 字符，描述不超过 1000 字符，可见性仅支持 private/public。未知字段拒绝。成功返回 BinRecord、新 ETag 和当前版本号；不生成 JSON 新版本。P6 已补充公开只读访问与数据锁管理，详见该阶段说明。

并发写入以条件创建版本对象和条件更新 meta 保护：不会覆盖已存在的版本文件。冲突留下的孤立版本保留；后续保存跳过已占用编号，因此并发冲突后版本号可能不连续，正常连续保存仍为 +1。

---

## P2 版本历史、Diff 与恢复

状态：✅ 实现、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

后端接口：

~~~text
GET  /api/v1/bins/:id/versions
GET  /api/v1/bins/:id/versions/:version
POST /api/v1/bins/:id/versions/:version/restore
~~~

功能：

- [x] 列出全部历史版本
- [x] 显示版本号、时间、大小
- [x] 查看任意旧版本
- [x] 当前版本与旧版本 Diff
- [x] 两个任意版本 Diff
- [x] 恢复旧版本

恢复规则：

恢复旧版本时不能修改历史文件，而是把旧值复制成一个新的最新版本。

接口约定：

- 三个接口需要 Session 或相应 Scope 的 Bearer 认证；未认证返回 401。已删除或到期 Bin 的保留版本不能通过这些接口访问，P7 恢复后重新开放。
- 版本列表返回 `{ items: [{ version, createdAt, size }], currentVersion, total }`，按版本号降序；跨 R2 分页读取所有保留版本。时间为对象上传时间，大小为 R2 保存的 JSON 文件字节数。
- 列表包含并发冲突留下的孤立版本，不能将每个保留文件都认定为曾生效的最新版本；版本编号可能不连续。
- 读取版本返回 `{ id, version, createdAt, size, value, etag }`，响应 ETag 属于该不可变版本对象。
- 版本参数必须是正的安全整数，不接受前导零、负数或小数；非法参数返回 422，Bin 或版本不存在返回 404。
- 恢复请求必须携带**当前 Bin 元数据的 ETag**（从 `GET /api/v1/bins/:id` 获取），不能使用历史版本对象的 ETag。缺少 `If-Match` 返回 428，冲突返回 412，锁定返回 423。
- 恢复成功返回新的 BinRecord、ETag 和 `X-JSONBin-Version`；保留名称、描述及其他元数据，追加版本并条件更新 currentVersion，不重写历史对象。

恢复示例：

~~~http
POST /api/v1/bins/:id/versions/1/restore
If-Match: "当前 Bin 的 ETag"
~~~

界面在详情页的“历史版本”中提供列表、JSON 内容查看和本地打包的 Monaco Diff；可以选择任意两版，默认对比所选旧版和当前已加载版本。手机使用行内 Diff，支持深色模式。恢复前确认是否丢弃未保存的 JSON/设置；取消、网络错误、锁定、登录过期或冲突时保留草稿。

P2 验收：

- 历史版本永久可读。
- Diff 可清楚展示增删改。
- Restore 后 currentVersion 增加，而不是倒退。

本地验收记录（2026-10-03）：

- 类型检查、生产构建通过。
- Worker/客户端测试 21 项通过，0 失败、0 跳过；覆盖历史内容不变、标量 JSON、元数据保持、孤立版本保留、并发恢复只允许一次成功、权限/锁定/ETag 检查，以及超过 1000 个对象的分页列表与数值排序。
- Chromium 浏览器验收 12 项通过，0 失败、0 跳过；覆盖任意两版 Diff 的增删标记、旧值恢复成新版本、刷新后持久化、手机/深色布局，以及取消、冲突、网络错误、锁定和登录过期时的草稿保护。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37121393676) 成功，验证提交 `86cb97a`；同一提交的 Cloudflare Workers Builds 成功。生产功能验收尚未确认。

---

## P3 集合 Collections

状态：✅ 后端、界面、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

R2：

~~~text
collections/
  <collectionId>/
    meta.json
~~~

CollectionMeta 至少包含：

~~~text
id
name
description
slug
createdAt
updatedAt
~~~

API：

~~~text
GET    /api/v1/collections
POST   /api/v1/collections
GET    /api/v1/collections/:id
PATCH  /api/v1/collections/:id
DELETE /api/v1/collections/:id
GET    /api/v1/collections/:id/bins
~~~

功能：

- [x] 集合列表
- [x] 新建集合
- [x] 编辑集合
- [x] 删除集合
- [x] Bin 移入/移出集合
- [x] Collection 详情页
- [x] 显示集合内 Bin 数量

删除集合默认不能删除其中的 Bin，只解除 collectionId 或要求用户确认处理方式。

实现约定：

- 集合与成员关系均以 R2 为权威数据源。列表和详情从活动 Bin 元数据计算数量，不依赖 KV 计数。
- 创建/编辑支持名称（trim 后 1–160 字符）与描述（不超过 1000 字符）；名称可以重复。slug 创建时由 UUID 生成，保持唯一且稳定，不随改名变化，也不支持手动修改。
- 集合读取/修改响应包含 ETag；PATCH 和 DELETE 必须提供 `If-Match`，缺少返回 428、过期返回 412。管理界面使用 Session；P5 起外部调用可使用对应 Scope 的 Bearer Token，未认证返回 401。
- 新建 Bin 可以提供 `collectionId`；现有 Bin 通过 `PATCH /api/v1/bins/:id/meta` 设置 `collectionId` 为目标 UUID，或设为 null 移出。操作只修改元数据，不改变 JSON 或版本号；不存在或正在删除的集合返回 409。
- 集合删除先将状态设为 deleting 并阻止新成员加入，再逐个条件更新 Bin 的 collectionId；只解除关联，不删除 Bin 或版本文件，也不改变数据锁。最终记录 deleted 标记，列表/详情不再展示该集合。
- R2 多对象操作不能原子提交，删除中断时 deleting 记录仍可在列表打开，使用“重试删除集合”继续清理。重复删除已完成的集合成功返回，不重新创建集合。
- 移入过程中遇到集合被并发删除，会解除此次目标关联，Bin 保留为未分组；其他并发成员迁移通过 Bin ETag 保护，清理不会解除已迁往其他集合的关联。
- 集合详情支持修改、成员列表、打开成员、移出和确认删除；新建 Bin 与详情设置均可选择集合。未保存的集合修改在取消离开、网络失败、Session 过期和冲突时保留。

本地验收进度（2026-10-03）：

- 类型检查、生产构建通过。
- Worker/客户端测试 27 项通过，0 失败、0 跳过；覆盖校验、认证、集合 ETag、成员迁移/计数、删除后保留 JSON/版本、锁定 Bin 的关联清理、删除重试、并发迁入/删除，以及清理不覆盖并发 JSON 保存或迁往另一集合的关联。
- Chromium 浏览器验收 15 项通过，0 失败、0 跳过；包含集合新建/编辑/详情刷新、成员数量、直接分组创建、迁移和移出、删除保留数据，以及手机/深色布局、冲突/网络/Session 错误保留草稿。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37122583885) 成功，验证功能提交 `1bedbd6`，包含类型检查、生产构建、Worker/客户端测试和浏览器验收。
- Cloudflare Workers Builds：[构建记录](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/54a075f1-2654-489e-b5eb-f22a6390ff4f) 对同一功能提交报告 success，版本 ID 为 `05302cf1-6c9f-40c5-84b6-f4b0435e6363`。
- 生产功能验收：尚未确认；没有将构建成功等同于对生产 JSON/集合操作的功能验收。

---

## P4 数据模型 / JSON Schema

状态：✅ 后端、界面、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

采用 `@cfworker/json-schema` 4.1.1 解释执行 JSON Schema，Zod 只负责 API 请求结构校验。Workers 禁止运行时 `eval` / `new Function`，因此没有使用 AJV 的常规动态编译方式。官方 Draft 7 meta-schema 随源码保存，许可证见 [JSON Schema 许可](licenses/JSON-Schema.txt)。

R2：

~~~text
schemas/
  <schemaId>/
    meta.json
    revisions/
      000001.json
      000002.json
~~~

`meta.json` 包含 id、name、description、currentRevision、createdAt、updatedAt 和 status。修订对象条件创建且不可覆盖，meta 条件更新；并发失败的孤立修订保留，后续写入跳过已占用编号。模型编辑产生新修订，已有 Bin 不会自动改变约束。删除将 status 设为 deleted，保留所有修订；列表/详情隐藏已删除模型，已有绑定仍可按原修订校验、写入和恢复。

API（管理界面使用 Session；P5 支持对应 Scope 的 Bearer Token，未认证返回 401）：

~~~text
GET    /api/v1/schemas
POST   /api/v1/schemas
GET    /api/v1/schemas/:id
PUT    /api/v1/schemas/:id
DELETE /api/v1/schemas/:id
POST   /api/v1/schemas/:id/validate
~~~

创建 / 替换模型请求：

~~~json
{
  "name": "计数模型",
  "description": "非负整数",
  "schema": {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "properties": { "count": { "type": "integer", "minimum": 0 } },
    "required": ["count"],
    "additionalProperties": false
  }
}
~~~

- 创建返回 201；读取/修改返回 `{meta, schema, etag}` 和 ETag 响应头。替换与删除必须携带 `If-Match`，缺少返回 428，过期或并发冲突返回 412。
- name trim 后为 1–160 字符，description 最长 1000 字符。请求未知字段拒绝。`schema` 支持对象或布尔值，定义最长 64 KiB、嵌套最多 64 层。
- 当前支持 Draft 7；省略 `$schema` 时默认 Draft 7。定义使用官方 meta-schema 校验，未知关键字拒绝，扩展注释可用 `x-` 前缀。支持本地 JSON Pointer 引用、递归 properties/items、标准 format 和 Unicode 正则；不支持外部引用、嵌套独立 `$id`、其他草案或自定义 format。不能消费数据层级的引用循环会被拒绝，避免无限校验。定义无效返回 422 `invalid_schema`。
- `/validate` 请求为 `{"value": 任意JSON}`，必需包含 value；返回 200 `{valid, issues, revision}`。样本不合模型时 valid 为 false，不修改模型或 Bin。
- `issues` 最多返回 20 条，格式为 `{path, keyword, message}`，path 使用 `#/字段` JSON Pointer；必填字段错误指向缺失字段。响应不回显输入数值，校验不会填默认值、强制转换类型或删除字段。

Bin 绑定规则：

- 创建 Bin 可提供 `schemaId`（UUID 或 null）和 `schemaLocked`。绑定时先校验 JSON，成功后保存 schemaId 和 schemaRevision；无模型时 schemaRevision 为 null。已删除/不存在的模型返回 409 `schema_unavailable`。
- `PATCH /api/v1/bins/:id/meta` 支持 schemaId、schemaLocked、refreshSchema。修改绑定或 `refreshSchema: true` 会选择模型当前修订，并校验 Bin 的**已保存 JSON**；只改元数据，不追加版本。同一个 schemaId 的普通设置保存不会隐式升级。
- 锁定模型绑定前必须有模型，否则返回 422 `schema_required`。已锁定绑定禁止更换、解除和升级，返回 423 `schema_locked`，即使同次请求设置 schemaLocked 为 false 也不能绕过。必须先单独解锁保存，再更改绑定。符合模型的 JSON 仍可更新；现有数据锁 locked 继续阻止修改。
- JSON 更新和历史版本恢复均校验 Bin 绑定的固定修订。模型编辑或删除不会绕过校验；失败返回 422 `schema_validation_failed` 与字段 issues，不写新版本或改变 meta/ETag。
- 模型绑定与 JSON 保存同样通过 Bin meta 的条件写入保护并发请求；过期 If-Match 返回 412。模型与 Bin 之间没有跨对象事务，并发模型编辑/删除时已经取得的修订仍可能被绑定；由于修订永不删除，约束不会失效。后续新读取的绑定请求只允许活动模型。

功能：

- [x] Schema 创建/编辑/删除与详情刷新
- [x] Bin 绑定 Schema 固定修订、主动升级 / 解除绑定
- [x] 创建 Bin 时校验
- [x] 更新 Bin 时校验
- [x] 恢复历史版本时校验
- [x] schemaLocked 与单独解锁规则
- [x] 前端显示具体字段错误、失败后保留草稿
- [x] 模型样本校验、未保存导航保护、网络 / Session / ETag 错误处理

本地验收进度（2026-10-03）：

- 类型检查、生产构建通过。
- Worker/客户端测试 37 项通过，0 失败、0 跳过；新增模型 CRUD/认证/条件写入、定义/引用/格式校验、失败不写版本、历史恢复、固定修订升级、绑定锁、归档模型继续校验，以及并发修订不可覆盖、模型绑定与不合约束 JSON 保存竞争验收。
- Chromium 浏览器验收 19 项通过，0 失败、0 跳过；包含模型创建/编辑/刷新/删除、样本字段错误、Bin 创建与绑定锁/升级、JSON 和恢复失败，以及草稿保护、手机/深色布局、冲突/网络/Session 错误。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37125038758) 成功，验证功能提交 `a01a023`；Node 22 中类型检查、生产构建、37 项 Worker/客户端测试和 19 项浏览器验收全部通过。
- Cloudflare Workers Builds：[构建记录](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/0eed8402-04df-4098-a96b-9466a8c57426) 对同一功能提交报告 success，版本 ID 为 `8332d3aa-b507-4fa7-aaee-0aab62464959`。
- 生产功能验收：待确认，不将本地测试或构建成功等同于生产数据操作已验收。

---

## P5 API 密钥与外部 API 认证

状态：✅ 后端、界面、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

Token 格式：

~~~text
jb_live_<UUID去掉连字符>_<32随机字节的Base64URL>
~~~

UUID 是公开的查找标识，不参与秘密强度；后缀含 256 位随机秘密。认证时直接读取 `keys/<UUID>/meta.json`，不依赖 KV 或扫描全部密钥。

R2：

~~~text
keys/
  <keyId>/
    meta.json
~~~

保存 id、name、prefix、scopes、createdAt、expiresAt、revokedAt、lastUsedAt、digest 和 digestAlgorithm。prefix 只含 Token 类型与 UUID 前八位，不含随机秘密。明文不进入 R2、KV、日志、浏览器 localStorage/sessionStorage 或 React Query 缓存。

摘要与配置：

- 默认/空 `TOKEN_PEPPER` 使用 SHA-256 摘要，随机秘密保持 256 位；建议通过 `wrangler secret put TOKEN_PEPPER` 配置至少 32 字符的 Secret，以 HMAC-SHA-256 创建新密钥。
- digestAlgorithm 在每个密钥上持久化，添加 Pepper 不会使此前 SHA-256 密钥失效。更改或移除 Pepper 会让此前 HMAC 密钥无法认证；轮换前应准备替换密钥，再撤销旧密钥。已撤销状态不会随 Pepper 配置恢复。
- 非空但不足 32 字符的 Pepper 会阻止创建，返回 503 `key_service_unavailable`。管理 Session 不受 Pepper 变更影响。
- 摘要使用常量时间比较。日志禁止输出 Authorization、完整 Token 或 Pepper；现有异常日志只包含错误消息、路径和方法。

管理 API（只允许 Session；Token 不能管理密钥或获得登录 Session）：

~~~text
GET    /api/v1/keys
POST   /api/v1/keys
DELETE /api/v1/keys/:id
~~~

创建请求：

~~~json
{"name":"自动化只读","scopes":["bin:read","history:read"],"expiresAt":null}
~~~

- name trim 后 1–160 字符。scopes 至少一项，只允许下表九种权限，不允许重复。expiresAt 可以省略、设为 null，或指定未来的带时区 ISO 时间；未知字段拒绝，输入错误返回 422。
- 创建返回 201 `{key, token}`；明文只在该次响应及当前提示中显示，关闭提示、刷新或离开页面后不可重新获取。
- 列表返回 `{items, total}`，包括有效、已过期和已撤销记录。撤销返回 `{key}`；所有公开 key 对象均剔除 digest、digestAlgorithm 和明文，响应均为 `Cache-Control: no-store`。
- DELETE 为幂等的软撤销，保留首次 revokedAt；不存在的 UUID 返回 404。管理接口收到任何 Authorization 头时返回 401 `session_required`，即使同时提供 Cookie，也不会把 Bearer 权限升级为密钥管理权限。
- 最后使用时间记录通过 Scope 检查的认证请求（包括后续业务校验失败/404 的请求）；格式错误、Scope 不足、过期或撤销的请求不更新它。认证和撤销均以 R2 条件写入保护，冲突重读时再次验证摘要、权限及失效状态，无法覆盖撤销记录；争用重试耗尽分别返回认证服务 503 或管理操作 409。
- 每次外部请求都读取权威 R2 记录，撤销/过期无 KV 缓存延迟。已完成授权检查的在途请求可能继续完成，撤销后的新授权失败。

Bearer 权限规则：

- 使用 Cookie 的 Session 写请求若携带 Origin，必须匹配 APP_ORIGIN 或当前请求 origin，否则返回 403 `origin_not_allowed`。不携带 Origin 的可信脚本 Session 请求保留原行为；显式 Bearer 调用按 Scope 授权，不使用 Cookie 的来源规则。
- Worker 收到 Authorization 请求头时，优先检查 Bearer 凭据；无效/撤销/过期 Token 返回 401 与 `WWW-Authenticate`，不回退 Cookie 或公开访问。没有 Authorization 时使用 Session；P6 的公开 Bin 当前内容/路径读取允许匿名。
- Scope 不足返回 403 `insufficient_scope` 与 requiredScopes，并提供对应认证响应头。Session 管理员可使用全部已有资源接口。
- 权限作用于单用户仓库的全部对应资源，当前没有按 Bin/集合 ID 限制的子权限。新资源路由必须显式使用 `requireAccess(...)`，并加入 Scope 验收矩阵。

| Scope | 允许的现有接口 |
| --- | --- |
| bin:read | Bin 列表、当前 JSON/元数据详情及深层路径读取、回收站列表 |
| bin:create | 新建 Bin（含可选集合、模型绑定） |
| bin:update | 替换 JSON、Merge Patch、深层路径写入、修改元数据/绑定/锁定/TTL；恢复历史或回收记录还需 history:read |
| bin:delete | 普通删除 Bin、回收站永久删除及批量清空 |
| collection:read | 集合列表/详情；集合内 Bin 列表还需 bin:read |
| collection:write | 集合创建、修改、删除（只解除成员关联） |
| schema:read | 模型列表/详情、JSON 样本校验 |
| schema:write | 模型创建、替换、删除 |
| history:read | 历史列表/版本内容；恢复还需 bin:update |

外部调用继续复用现有 ETag、数据锁、模型锁、固定模型修订和历史恢复校验。集合/模型修改或删除、历史恢复仍必须携带 If-Match；Bin 写入继承既有 If-Match 行为。历史接口仍不能读取已删除 Bin。密钥有效不授予绕过业务约束的能力。

调用示例（把 origin 和 Token 保存在环境变量中）：

~~~bash
curl "$JSONBIN_ORIGIN/api/v1/bins" \
  -H "Authorization: Bearer $JSONBIN_TOKEN"
~~~

功能：

- [x] 创建 API Key 与命名
- [x] 一次性显示明文、复制、关闭提示后清除
- [x] 设置 Scope（默认只选 bin:read）
- [x] 设置未来过期时间或永不过期
- [x] 撤销、幂等重试及并发状态保护
- [x] 最后使用时间、有效/过期/撤销状态
- [x] Bearer Token 中间件及所有现有资源路由 Scope 校验
- [x] 手机/深色界面、草稿/未保存密钥导航保护及错误重试

本地验收进度（2026-10-03）：

- 类型检查、生产构建通过。
- Worker/客户端测试 48 项通过，0 失败、0 跳过。覆盖 21 条资源路由与九种单独 Scope 的矩阵、组合权限、密钥管理隔离、摘要/明文不落盘、HMAC/Pepper 轮换与 SHA 兼容、过期/撤销、并发认证不复活密钥、业务锁/ETag/模型校验，Cookie 写请求 Origin 校验，以及直接入口的空 Authorization 处理。运行时 HTTP 传输会移除空头，所以原始空头另通过构建后的入口验证。
- Chromium 浏览器验收 23 项通过，0 失败、0 跳过；新增一次性显示/复制与刷新清除、权限与期限保存、最后使用/撤销/过期、未保存内容导航保护，以及创建/列表/撤销的网络和 Session 错误重试。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37127314904) 成功，验证功能提交 `6a6db5f`；Node 22 中类型检查、生产构建、48 项 Worker/客户端测试和 23 项浏览器验收全部通过。
- Cloudflare Workers Builds：[构建记录](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/fa9e8d34-c36d-4b3f-ad72-4643223e8de6) 对同一功能提交报告 success，版本 ID 为 `18ccfd42-fe9b-4493-9bd2-b34c7d8450c6`。
- 生产功能验收：待确认，不将本地测试或构建成功等同于生产数据操作已验收。

P5 完成后，JSONBin 具备脚本/自动化工具调用能力；后续 P6 的新读写路径必须继续检查 Scope 并复用同一业务约束。

---

## P6 高级 Bin API

状态：✅ 后端、界面、本地验收及 GitHub CI 完成；Cloudflare Workers Builds 成功，生产功能验收待确认。

功能：

- [x] JSON Merge Patch（RFC 7396）
- [x] 深层路径读取
- [x] 深层路径写入
- [x] 数据锁 locked：设置页锁定/单独解锁、只读编辑器、删除禁用、冲突和网络错误提示
- [x] Schema 锁 schemaLocked：局部写入复用完整 JSON 与固定模型修订校验
- [x] Public/Private 真正生效
- [x] public Bin 无登录只读当前 JSON/元数据和路径；历史/列表/写入仍需认证
- [x] private Bin 必须 Session 或相应 Scope 的 API Key；新增路由加入权限矩阵

API：

~~~text
PATCH /api/v1/bins/:id
GET   /api/v1/bins/:id/value
GET   /api/v1/bins/:id/value/*
PUT   /api/v1/bins/:id/value
PUT   /api/v1/bins/:id/value/*
PATCH /api/v1/bins/:id/meta       # 新增 locked 字段
~~~

局部更新规则：

- PATCH 请求体直接是 Merge Patch 文档，推荐 `Content-Type: application/merge-patch+json`，兼容 `application/json`；不使用 `{value: ...}` 包装。对象递归合并，成员值 `null` 删除该字段，数组/标量整体替换，根 `null` 将整个 JSON 替换为 null。
- 路径 PUT 请求体为严格的 `{"value": ...}`，支持 null、布尔、数字、字符串、数组与对象，未知字段拒绝。GET 路径返回 `{id, path, value, etag, version}`，path 为已解码的 token 数组；写入返回完整 BinRecord。
- `/value` 表示根 JSON；`/value/` 表示空字符串键。路径按 `/` 分段，每段 URL 解码一次，再按 JSON Pointer token 规则解码 `~1` 为 `/`、`~0` 为 `~`。示例：`/value/a~1b/~0key` 访问 `value["a/b"]["~key"]`。URL 自身的 `.` / `..` 路径规范化规则仍适用；这类键可通过完整 JSON 读取或 Merge Patch 修改。
- 对象写入允许创建最后一级字段，所有父节点必须已存在。数组索引仅允许规范非负整数且必须存在，末尾 `-` 追加元素；不自动补父节点、创建稀疏数组或插入元素。普通对象的 `__proto__` / `constructor` / `prototype` 作为 JSON 自有字段处理，不沿 JavaScript 原型链遍历。
- 路径不存在或无法遍历返回 404 `path_not_found`；转义非法、路径超过 128 段返回 422 `invalid_path`。JSON 语法错误返回 422，Merge Patch 对象递归超过 128 层返回 422 `patch_too_deep`。
- PATCH 和路径 PUT 都必须提供当前 Bin 的 `If-Match`，缺少返回 428，过期返回 412。从同一快照计算新值，再通过已有写入流程检查 ETag、数据锁及完整 JSON Schema，然后追加不可变版本并条件更新 meta。失败的语法/路径/模型校验不写版本；CAS 竞争留下的孤立版本延续既有保留规则。
- 成功响应包含当前 Bin 的 ETag 和 `X-JSONBin-Version`。每次成功 JSON 写入（包括值未改变）生成新版本；元数据、锁定/解锁不生成 JSON 版本。

调用示例（每次后续写入都要使用最新 ETag）：

~~~bash
curl -X PATCH "$JSONBIN_ORIGIN/api/v1/bins/$BIN_ID" \
  -H "Authorization: Bearer $JSONBIN_TOKEN" \
  -H 'Content-Type: application/merge-patch+json' \
  -H "If-Match: $BIN_ETAG" \
  --data '{"settings":{"theme":"dark"},"obsolete":null}'

curl "$JSONBIN_ORIGIN/api/v1/bins/$BIN_ID/value/settings/theme" \
  -H "Authorization: Bearer $JSONBIN_TOKEN"

curl -X PUT "$JSONBIN_ORIGIN/api/v1/bins/$BIN_ID/value/settings/theme" \
  -H "Authorization: Bearer $JSONBIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "If-Match: $BIN_ETAG" \
  --data '{"value":"light"}'
~~~

数据锁与删除：

- 元数据 PATCH 接受 `locked: true/false`，提供此字段时必须携带 `If-Match`。已锁定时，仅允许单独的 `{"locked":false}` 解锁；同请求携带名称、模型、可见性等任何额外修改均返回 423。解锁不改变 `schemaLocked`。
- 数据锁阻止完整替换、Merge Patch、路径写入、历史恢复、元数据修改和删除；当前及历史读取继续按原权限开放。集合删除时清除成员关联延续 P3 的管理清理规则，可清除锁定 Bin 的失效关联，但不修改 JSON、模型或锁。
- DELETE 接受可选 `If-Match`（界面始终发送），并检查数据锁；锁定返回 423，旧 ETag / 并发冲突返回 412。通过 R2 CAS 在 `bins/<id>/meta.json` 写入 `deletedAt`，历史文件保持不变。P6 曾另外归档 `trash/bins/<id>/meta.json`；P7 起统一使用 canonical 删除记录并兼容旧归档。
- 持久删除标记防止在途写入重新激活 Bin，并让删除与锁定竞争同一个 ETag；普通详情/路径/历史/列表及集合成员计数均排除已删除 Bin。重复普通 DELETE 对仍在回收站的记录返回成功；完全不存在、已到期但未归档或已永久删除的 ID 返回 404。P7 恢复通过 CAS 处理删除标记。
- 设置页提供独立数据锁操作，存在草稿时先保存或显式重新加载；请求中禁用操作，失败保留状态并可重试。API 页提供局部写入示例和路径规则。

公开访问边界：

- 无 Authorization 时，`GET /bins/:id` 和 `/value...` 可匿名读取 public Bin 的当前快照，包括详情元数据。private Bin 与不存在的 ID 对匿名请求均返回 401；已认证请求对不存在的 Bin 返回 404。
- Bin 列表、集合及模型接口、历史列表/内容、所有写入仍需要 Session 或对应 Scope。公开当前版本不公开此前的私有历史，也不开放管理界面登录。
- 显式 Authorization 始终验证凭据和 `bin:read`，无效/过期/撤销返回 401，Scope 不足返回 403，不回退匿名或 Cookie。
- 可见性判断与返回 JSON 使用同一个 meta/不可变版本快照，避免并发转私有后读取到新私有内容。所有 Bin API 响应为 `Cache-Control: no-store`；转私有后的新请求必须认证，先前已授权的在途读取可以返回当时的公开快照。浏览器跨域仍遵循现有 APP_ORIGIN/CORS 配置。

本地验收进度（2026-10-03）：

- `npm run typecheck` 与生产构建通过；后者由 `npm test` 执行。Monaco 大 chunk 提示保留为既有优化项。
- Worker/客户端测试 58 项通过，0 失败、0 跳过；新增 RFC 7396 示例、路径/数组/转义/null、原型键、非法输入不写版本、Schema/锁/Scope、公开转私有、并发快照和删除/锁定竞争测试。Scope 矩阵覆盖 9 种单权限 × 26 个资源路由及组合权限。
- Chromium 浏览器验收 26 项通过，0 失败、0 跳过；新增数据锁持久化/只读/解锁保存、公开与私有切换/匿名读取、API 示例、锁定网络错误和过期 ETag 重试，既有编辑、历史、集合、模型和密钥验收继续通过。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37129864342) 成功，验证功能提交 `7ef26a5`；Node 22 中类型检查、生产构建、58 项 Worker/客户端测试和 26 项浏览器验收全部通过。
- Cloudflare：[Workers Builds: jsonbin](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/15a47920-25c6-4727-a4e2-7b8429815376) 对同一提交报告 success，Version ID `0d05555e-aabc-4632-b688-026200639764`。
- 生产功能验收：待确认；构建通过与生产功能验收分别记录。

---

## P7 TTL 与回收站

状态：✅ 后端、定时任务、界面及本地验收完成；CI / Workers Builds 待功能提交后核实，生产功能验收待确认。

TTL：

- [x] 创建和设置支持 expiresAt，支持清除期限
- [x] 到期后禁止正常读取及写入，包括公开、深层路径及历史 API
- [x] 定时任务清理/移入回收站（每 15 分钟，UTC）
- [x] Dashboard 列表与详情显示剩余时间、到期时间，列表每 30 秒刷新

回收站：

- [x] 列表、加载/空状态、错误重试及导航入口
- [x] 恢复（同 ID、版本保留、私有且清除期限）
- [x] 永久删除（确认、ETag、分页清理、失败续作）
- [x] 批量清空（明确快照、逐项结果、部分失败提示）
- [x] 显示删除/到期时间与删除原因

API：

~~~text
GET    /api/v1/trash/bins
POST   /api/v1/trash/bins/:id/restore
DELETE /api/v1/trash/bins/:id
POST   /api/v1/trash/bins/purge
~~~

TTL 规则：

- 创建 Bin 或元数据 PATCH 接受 `expiresAt: null`（永不过期）或未来的带时区 ISO 时间，统一保存为 UTC。非法、无时区或过去的时间返回 422。元数据中携带 expiresAt 时必须提供 If-Match；缺少 428，过期 412，数据锁 423。
- 到期判断为 `expiresAt <= 当前时间`，每个正常存储读写入口直接检查，不依赖 Cron/KV。到期 Bin 从列表、集合成员和计数排除；认证后的详情/路径/历史/更新返回 404，匿名当前读取返回 401，不泄露存在性。到期前已经授权的在途读取可以完成。
- 到期但尚未归档的记录立即出现在回收站，status 为 expired、deletedAt 为到期时间，恢复/永久删除无需等待 Cron。数据锁不能延长已配置的 TTL，到期的锁定 Bin 也会归档。
- Worker `scheduled` 处理器与 wrangler.jsonc 的 `*/15 * * * *` 定时触发器扫描 R2，以当前 ETag 写入过期删除标记；期限更新或其他并发状态变化导致 CAS 失败时保留新状态。已发起但中断的永久删除也在此续作；单项失败继续处理其他项，最终报告任务失败便于排查。
- UI 使用本地时区 datetime-local 输入并转换为 ISO，留空清除 TTL；校验错误不丢草稿。列表与详情显示剩余时间和实际到期时间。

回收站 API 与权限：

| 操作 | Bearer Scope | 条件/响应 |
| --- | --- | --- |
| GET /trash/bins | bin:read | `{items, total}`；每项 `{meta, etag, status}` |
| POST /trash/bins/:id/restore | bin:update + history:read | If-Match 必须；成功返回 BinRecord、ETag、版本号 |
| DELETE /trash/bins/:id | bin:delete | If-Match 必须；成功 `{ok:true}` |
| POST /trash/bins/purge | bin:delete | 请求体中的每个 ID 都必须有 ETag；返回逐项结果 |

- Session 管理员可执行全部操作；所有回收站接口禁止匿名，public 状态不授予访问。Cookie 写入继续检查 Origin，显式 Bearer 不回退 Cookie。响应均为 `Cache-Control: no-store`。
- 列表不返回 JSON 内容；meta 包含删除时间及 manual/expired 原因，status 为 deleted、expired 或 purging。每项 ETag 对应当前权威记录；单项操作缺少 If-Match 返回 428，过期返回 412，不存在/已恢复返回 404。
- 恢复前验证当前版本文件和固定 Schema 修订；内容不匹配返回 422，文件/模型修订缺失或正在永久删除返回 409，记录保留。模型已归档仍按原绑定修订校验。
- 恢复不新建 JSON 版本，保留所有历史、数据锁及模型锁；清除 expiresAt，设为 private，更新 lifecycleId 以区分不同删除/恢复轮次。原集合已删除或正在删除时解除关联，并处理集合删除的并发清理。
- 永久删除先通过 CAS 将同一记录设为 purging，之后不可恢复。分页删除全部版本（含孤立版本）及旧归档，完成后保留最小 purged 标记；恢复与永久删除竞争时最多一个成功，不能物理删除已恢复的数据。
- 物理清理失败时保留 purging 状态，可使用原批准 ETag 或列表的新 ETag 重试；Cron 也会续作。已完成的永久删除可幂等重试。极端中断留下的迟到写入文件由后续 Cron 再清理；正常在途写入 CAS 失败发现 purge 状态时会删除自己刚写入的文件。
- 批量清空请求为 `{"items":[{"id":"UUID","etag":"当前回收记录 ETag"}]}`，每批 1–100 项、ID 不重复、未知字段拒绝。返回 HTTP 200 `{results:[{id,status}]}`，逐项 status 为 200/404/412/500；客户端须检查每项，不能把 HTTP 200 当作全部成功。界面按确认时的完整列表分批执行，之后新进入回收站的记录不纳入该次操作；部分失败会保留并刷新列表。

存储兼容与约束：

- P7 新普通删除及 TTL 归档只更新 `bins/<id>/meta.json`；删除标记本身就是权威回收记录，避免另写可被旧请求覆盖的归档副本。
- 兼容只有 `trash/bins/<id>/meta.json` 的旧记录：首次操作条件创建 canonical 删除标记后继续；并发迁移/恢复/清理不能覆盖已有状态。已有 canonical 活动记录或 purged 标记时忽略陈旧的同 ID 归档。
- 永久删除仅保留 `{id, deletedAt, purgeState:"purged"}`；没有 JSON、名称、描述、集合或模型关联。当前 Cron 扫描 R2，适用于个人仓库；P11 索引优化不得让到期/权限判断依赖最终一致的 KV。

本地验收进度（2026-10-03）：

- `npm run typecheck`、生产构建通过；完整 Worker/客户端测试 71 项通过，0 失败、0 跳过。构建保留既有 Monaco 大 chunk 提示。
- 覆盖 TTL 输入/锁/ETag、所有读取入口、Cron 幂等与期限竞争、旧记录迁移、模型约束、分页清理、故障续作、恢复/永久删除竞争、迟到写入清理和批量快照保护。Scope 矩阵扩展至 9 种单权限 × 30 个资源路由及组合权限。
- Chromium 浏览器验收 31 项通过，0 失败、0 跳过；新增创建/设置 TTL、剩余时间、真实到期后恢复、永久删除确认/冲突、批量部分失败与重试、网络/Session 错误、手机深色布局。既有功能回归通过。
- P7 功能提交 `f75a9dfd37a6bc3e900a679c08167c4f5e5a658f` 的 [GitHub CI 37132071665](https://github.com/lwhx/jsonbin/actions/runs/37132071665) 成功；`Workers Builds: jsonbin` 成功，build `acb22f3c-53e1-464e-b9e6-91ea5f8006cb`，version `58faa799-ce29-48c9-a25c-e1d0b121308d`。生产功能及真实 Cron 手动验收仍待确认。

---

## P8 活动记录

状态：✅ 实现与本地验收完成；GitHub CI / Workers Builds 推送后核对，生产功能及真实 Cron 手动验收待确认。

- [x] 密码/GitHub 登录成功、失败（失败身份为匿名，不采集提交的用户名）
- [x] Bin 创建、完整/局部 JSON 更新、元数据/锁/TTL 修改、历史恢复、删除/回收站恢复/永久删除
- [x] 集合与模型创建、修改、删除；API Key 创建/撤销
- [x] Cron 真实到期归档、purging→purged 迁移；幂等 tombstone 续作不重复记迁移
- [x] 中文活动入口、刷新/深链接、操作/资源筛选、分页、Loading/Empty/Error/重试、手机及深色布局
- [x] R2 保存记录，每 15 分钟 Cron 最终清理至最近 2000 条

接口：

~~~text
GET /api/v1/activity?limit=50&cursor=...&action=...&resourceType=...
=> {items: ActivityEntry[], nextCursor: string|null, retentionLimit: 2000}
~~~

字段：`id / action / resourceType / resourceId / actor:{type,id} / provider / timestamp / summary / requestId`。action/resourceType/中文 summary 来自封闭映射；只使用真实资源 UUID、经过验证的用户 ID 或 key UUID，失败登录 actor.id 为 null。每个请求由服务端产生 requestId，批量成功项共享该 ID，各有独立 activity id。

权限与分页：

- 仅管理 Session 可读，匿名/过期 Session 返回 401；显式 Authorization 返回 401 `session_required`，即使带 Cookie 也不回退。不新增活动 Scope，所有现有 API Key 权限均不能读取活动列表。
- `Cache-Control: no-store`；limit 默认 50、范围 1–100，action/resourceType 为封闭枚举。非法/重复/未知参数及错误/过长/跨筛选游标返回 400；存储错误返回通用 500。
- 游标绑定筛选条件和 activity/ 内的扫描锚点（最多 1024 字节，编码游标最多 16384 字符）；新记录进入不重复已读页，清理后的旧锚点可继续读取。每请求最多扫描 1000 个对象、最多 40 次正文读取；达到预算可能返回少于 limit 或空页，nextCursor 非 null 时继续分页。
- `activity/<反向毫秒时间>-<UUID>.json` 使用条件创建，避免同毫秒/并发覆盖；时间来源是服务端时钟，不承诺严格跨请求提交顺序。读取严格校验，异常对象不回传任意字段。

隐私及故障语义：

- 不记录密码、Cookie、Authorization、完整 Token、Token 摘要、OAuth code/state、请求/响应正文、JSON 值、资源名/描述、字段路径或提交的用户名。customMetadata 仅包含 action/resourceType 枚举。创建密钥只取 key.id，不采集 token 响应。
- 普通读操作及失败业务写入不记成功事件；登录失败单独记录。批量回收站部分失败只记录实际成功项目。
- 业务与活动对象没有跨对象事务。业务提交后尝试记录，条件创建最多三次；活动失败保留原业务结果，固定诊断不打印异常内容。不承诺完整审计链，Worker/R2 故障可能缺少记录；不伪装为一次新的业务失败诱发危险重试。
- 保留清理在系统事件提交后独立尝试，即使 Bin 维护失败也会执行。清理失败后下一次 Cron 重试；两次 Cron 之间或故障期间可暂时超过 2000 条，仅删除标准 activity 键，不影响业务对象。
- UI 取消旧查询，筛选/刷新重置分页；加载更多失败或 401 时保留已有活动，原有详情草稿离页确认保持。

本地验收（2026-10-03）：

- `npm run typecheck`、生产构建通过；完整 Worker/客户端测试 **84 项通过，0 失败、0 跳过**。
- Chromium 浏览器测试 **36 项通过，0 失败、0 跳过**，包含全部 P0–P7 回归与 5 项活动页验收。
- 已覆盖可信身份、登录/OAuth、全操作矩阵、Scope 边界、Secret canary 排除、记录故障/条件冲突、同毫秒并发、跨 R2 页过滤/损坏记录读取预算、页尾无效键、大量损坏键的初始/续页前进、OAuth 网络/JSON 异常、2000 条保留、故障续作、后台 CAS 与幂等迁移、并发新增/清理。
- 功能提交：`2ea35a6` 已合并并推送到 main。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37136840897) 对功能提交 `2ea35a6` 报告 success，包含类型检查、生产构建、84 项 Worker/客户端测试和 36 项浏览器验收。
- Cloudflare Workers Builds：[构建记录](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/53499be9-9162-4b9c-ab17-46c98afad16c) 对 `2ea35a6` 报告 success，版本 ID 为 `c615b660-6c5e-413a-b2f3-7bd03f8c7bd7`。
- 生产功能及真实 Cron 手动验收仍待公开 URL 和适用认证。

---

## P9 API 文档

Dashboard 内提供可直接复制的文档：

- [x] 登录/认证说明
- [x] API Key 使用
- [x] Bin CRUD
- [x] ETag 示例
- [x] PATCH 示例
- [x] deep-path 示例
- [x] Collection API
- [x] Schema API
- [x] 错误码
- [x] curl 示例
- [x] JavaScript fetch 示例
- [x] Python requests 示例

每个 Bin 的详情页已提供「API」页签，自动生成当前 URL 和示例。

实现说明：

- 登录后访问 `/#/docs`，目录页内导航保持应用路由；curl、JavaScript fetch 和 Python requests 共用请求描述。
- 文档覆盖 P0–P8 的现有资源接口、权限/Scope、请求与响应形状、错误处理、生命周期及活动分页。GitHub OAuth 提供浏览器入口，不生成重放 callback 的示例。
- 「此数据仓的 API」使用当前 origin、实际 ID、已保存 ETag/可见性/锁定/TTL；内容是固定演示 JSON，不包含已存内容、资源名称、描述或未保存草稿。保存/重新加载后的示例更新；公开 Bin 只对当前与路径读取省略 Authorization。
- 所有资源 UUID、Token、ETag、登录占位符都需要替换。curl 单请求面向 Bash；顺序入门示例额外需要 Python 3 标准库解析 JSON。Python 示例需使用者安装 requests，JSON 正文在生成代码中显式编码为 UTF-8 字节，项目不新增依赖。Session Python 代码复用登录时建立的 session，curl 复用登录 cookie jar。
- 顺序示例会创建一个演示 Bin 并修改两次；每次重新 GET 取得 ETag。独立写入示例只代表当前快照。412 后重新读取并由调用者处理冲突，不自动覆盖。普通 Bin PUT/DELETE 允许省略 If-Match，局部更新、历史恢复、Collection/Schema 修改删除及回收站操作要求携带；元数据修改 locked/expiresAt 要求携带。
- Schema validate 不匹配仍返回 HTTP 200 + valid:false；绑定模型的 Bin 写入不匹配为 422。批量清理 HTTP 200 须逐项检查 results[].status；活动分页以 nextCursor 判断结束。
- 文档仅展示与复制，不执行业务请求。剪贴板拒绝保留可选择代码；旧的复制结果不会污染新语言/代码或已离开的页面。原有 JSON/设置草稿和离页确认保持。

验收状态（2026-10-04，Asia/Shanghai）：类型检查及构建通过；91 项 Worker/客户端测试通过（真实 Worker/R2 契约与三语言执行），40 项 Chromium 浏览器测试通过；独立审查发现的 Python UTF-8 兼容性问题已修复并通过回归，真实 requests/urllib3 两组版本验证完整正文，修复后完整 91 项测试、40 项浏览器验收和类型检查/构建再次通过。

- 功能提交：`1073436` 已合并并推送到 main。
- GitHub CI：[v3 CI](https://github.com/lwhx/jsonbin/actions/runs/37141128306) 对功能提交 `1073436` 报告 success，类型检查、生产构建、Worker/客户端测试和浏览器验收全部通过。
- Cloudflare Workers Builds：[构建记录](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/b37a3f07-8da5-4def-9ab2-d277d323dc3d) 对 `1073436` 报告 success，版本 ID 为 `dec2c317-bfff-4d0b-ad48-0a9dab596247`。
- 生产认证/CORS、部署页面交互及真实 Cron 未手动验收：缺少公开生产 URL 和适用认证，部署配置差异仍待验证。

---

## P10 设置、导入与导出

设置页：

- [ ] 系统信息
- [ ] Worker / R2 / KV 状态
- [ ] 当前版本
- [ ] 默认可见性
- [ ] 默认 TTL
- [ ] GitHub OAuth 状态
- [ ] 数据统计

导入：

- [ ] 单 JSON 文件
- [ ] 批量 JSON
- [ ] 旧 JSONBin 数据格式（如需要）

导出：

- [ ] 导出单 Bin
- [ ] 导出全部数据
- [ ] 导出配置和元数据
- [ ] ZIP 备份格式

Secret 永远不进入导出文件。

---

## P11 全局搜索与 KV 索引

当前 listBins 会扫描 R2。数据量小可以接受，但长期需要索引。

KV 计划：

~~~text
idx:bin:<id>
idx:slug:<slug>
idx:collection:<id>
search:bin:<token>
summary:dashboard
~~~

要求：

- [ ] 创建/更新时同步更新 KV 派生索引
- [ ] 删除时清理 KV
- [ ] 提供“从 R2 重建索引”
- [ ] KV 缺失时功能仍可回退到 R2
- [ ] 顶部全局搜索真正可用
- [ ] 支持名称、描述、ID、集合搜索

---

## P12 稳定性、安全与 v3.0.0

在发布 v3.0.0 stable 之前必须完成：

- [ ] API 单元测试
- [ ] R2 storage 测试
- [ ] ETag 并发测试
- [ ] Session 测试
- [x] API Key Scope 测试（P5 / P6 / P7 当前接口全矩阵；后续新增接口需扩展）
- [ ] Schema 校验测试
- [ ] Trash/Restore 测试
- [ ] npm run typecheck 通过
- [ ] npm run build 通过
- [ ] GitHub Actions 通过
- [ ] Cloudflare Production 部署通过
- [ ] 手机端基础适配
- [ ] 深色模式检查
- [ ] 中文 UI 检查
- [ ] Security Headers 检查
- [ ] CORS 检查
- [ ] 日志敏感信息检查
- [ ] R2/KV 备份与恢复说明
- [ ] README 与 API Docs 同步

## 8. 每个阶段的固定开发流程

每次开发按以下流程执行：

1. 先确认本阶段范围，不顺手加入下一阶段的大功能。
2. 先设计数据结构和 API。
3. 实现 Worker/storage 层。
4. 完成 TypeScript 类型。
5. 实现前端 UI。
6. 增加错误状态、Loading、Empty State。
7. 运行 typecheck。
8. 运行 production build。
9. 提交 main。
10. 等 GitHub Actions 通过。
11. 等 Cloudflare 部署成功。
12. 执行该阶段的手动验收。
13. 在本文件勾选完成项。
14. 再进入下一阶段。

## 9. Definition of Done

一个功能只有满足下面全部条件才算“完成”：

- 后端 API 可用。
- 前端有完整入口，不是占位按钮。
- 刷新页面数据不丢失。
- 错误状态可理解。
- 不会把 Secret 写进 Git。
- 不会把 Authorization/Cookie 写进日志。
- typecheck 通过。
- build 通过。
- CI 通过。
- Cloudflare 实际部署成功。
- 对应开发文档已更新。

## 10. 当前下一步

P7 TTL 与回收站已完成本地开发、本地验收、GitHub CI 及 Workers Builds。生产功能及真实 Cron 运行验收单独保留待确认状态。

P8 活动记录及 P9 API 文档已实现并合并推送 main，本地验收及功能提交 CI / Workers Builds 均通过；生产功能/真实 Cron 手动验收仍单独保留。下一阶段为 **P10 设置、导入与导出**。
