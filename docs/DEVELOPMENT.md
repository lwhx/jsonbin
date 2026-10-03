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
| 数据仓更新 | ✅ 后端完成 | PUT + ETag/If-Match 基础逻辑 |
| 数据仓删除 | ✅ 后端基础完成 | meta 移入 trash，活动版本暂保留 |
| 数据仓详情页 | ⬜ 未开始 | 需要编辑器、保存、删除、元数据 |
| 版本历史 | ⬜ 未开始 | R2 已保存不可变版本，但无历史 API/UI |
| 集合 | ⬜ 未开始 | 只有导航占位 |
| 数据模型 | ⬜ 未开始 | 只有导航占位 |
| API 密钥 | ⬜ 未开始 | 只有导航占位 |
| 活动记录 | ⬜ 未开始 | 只有导航占位 |
| API 文档 | ⬜ 未开始 | 只有导航占位 |
| 回收站 | ⬜ 未开始 | 后端有最基础 trash 写入，无 UI/恢复 |
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

- 将 Bin 的元数据写入 trash/bins/<id>/meta.json。
- 删除活动区 bins/<id>/meta.json。
- 版本文件暂时保留，以支持恢复。

恢复：

- 将回收站元数据恢复为活动 meta.json。
- 不修改历史版本内容。

永久删除：

- 删除 trash 记录。
- 删除 bins/<id>/versions/ 下所有版本。
- 清理相关 KV 索引。

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

- [ ] Worker health 中版本号与 package.json 自动保持一致
- [ ] 检查中文化后 CSS class 不应使用“私有/公开”作为状态类名
- [ ] 为 ETag 引号和 Weak ETag 兼容增加测试
- [ ] 增加最基础 API smoke test

---

## P1 数据仓详情页与 JSON 编辑器

目标：让“数据仓”从只能创建/查看卡片，变成真正可编辑的数据管理页面。

后端：

- [ ] 保持 GET /api/v1/bins/:id
- [ ] 完善 PUT /api/v1/bins/:id
- [ ] 增加更新 Bin 元数据接口
- [ ] 支持修改名称、描述、可见性
- [ ] 明确 ETag 返回和 If-Match 行为

前端：

- [ ] 点击数据仓卡片进入详情页
- [ ] 增加详情页顶部信息栏
- [ ] 增加 JSON 编辑器
- [ ] JSON 语法校验
- [ ] 格式化 JSON
- [ ] 保存按钮
- [ ] 未保存状态提示
- [ ] 保存成功提示
- [ ] 412 冲突提示
- [ ] 423 锁定提示
- [ ] 删除确认
- [ ] 复制 Bin ID
- [ ] 复制 API 地址

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

---

## P2 版本历史、Diff 与恢复

后端计划：

~~~text
GET  /api/v1/bins/:id/versions
GET  /api/v1/bins/:id/versions/:version
POST /api/v1/bins/:id/versions/:version/restore
~~~

功能：

- [ ] 列出全部历史版本
- [ ] 显示版本号、时间、大小
- [ ] 查看任意旧版本
- [ ] 当前版本与旧版本 Diff
- [ ] 两个任意版本 Diff
- [ ] 恢复旧版本

恢复规则：

恢复旧版本时不能修改历史文件，而是把旧值复制成一个新的最新版本。

P2 验收：

- 历史版本永久可读。
- Diff 可清楚展示增删改。
- Restore 后 currentVersion 增加，而不是倒退。

---

## P3 集合 Collections

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

- [ ] 集合列表
- [ ] 新建集合
- [ ] 编辑集合
- [ ] 删除集合
- [ ] Bin 移入/移出集合
- [ ] Collection 详情页
- [ ] 显示集合内 Bin 数量

删除集合默认不能删除其中的 Bin，只解除 collectionId 或要求用户确认处理方式。

---

## P4 数据模型 / JSON Schema

建议使用 AJV 做 JSON Schema 校验，Zod 继续只负责 API 请求结构校验。

R2：

~~~text
schemas/
  <schemaId>/
    meta.json
    schema.json
~~~

API：

~~~text
GET    /api/v1/schemas
POST   /api/v1/schemas
GET    /api/v1/schemas/:id
PUT    /api/v1/schemas/:id
DELETE /api/v1/schemas/:id
POST   /api/v1/schemas/:id/validate
~~~

功能：

- [ ] Schema 创建/编辑/删除
- [ ] Bin 绑定 Schema
- [ ] 创建 Bin 时校验
- [ ] 更新 Bin 时校验
- [ ] 恢复历史版本时校验
- [ ] schemaLocked
- [ ] 前端显示具体字段错误

---

## P5 API 密钥与外部 API 认证

Token 格式：

~~~text
jb_live_<random>
~~~

安全规则：

- Token 明文只展示一次。
- R2 永远不保存完整明文 Token。
- 保存 Token digest。
- 建议加入 TOKEN_PEPPER Secret。
- 日志禁止输出 Authorization Header。

初始权限范围：

~~~text
bin:read
bin:create
bin:update
bin:delete
collection:read
collection:write
schema:read
schema:write
history:read
~~~

功能：

- [ ] 创建 API Key
- [ ] 一次性显示明文
- [ ] 复制
- [ ] 命名
- [ ] 设置 Scope
- [ ] 设置过期时间
- [ ] 撤销
- [ ] 最后使用时间
- [ ] Bearer Token 中间件

P5 完成后，JSONBin 才正式具备脚本/自动化工具调用能力。

---

## P6 高级 Bin API

功能：

- [ ] JSON Merge Patch
- [ ] 深层路径读取
- [ ] 深层路径写入
- [ ] 数据锁 locked
- [ ] Schema 锁 schemaLocked
- [ ] Public/Private 真正生效
- [ ] public Bin 无登录只读
- [ ] private Bin 必须 Session 或 API Key

计划 API：

~~~text
PATCH /api/v1/bins/:id
GET   /api/v1/bins/:id/value/*
PUT   /api/v1/bins/:id/value/*
~~~

所有写入最终仍然生成新的不可变版本。

---

## P7 TTL 与回收站

TTL：

- [ ] 设置 expiresAt
- [ ] 到期后禁止正常读取
- [ ] 定时任务清理/移入回收站
- [ ] Dashboard 显示剩余时间

回收站：

- [ ] 列表
- [ ] 恢复
- [ ] 永久删除
- [ ] 批量清空
- [ ] 显示删除时间

API：

~~~text
GET    /api/v1/trash/bins
POST   /api/v1/trash/bins/:id/restore
DELETE /api/v1/trash/bins/:id
~~~

---

## P8 活动记录

记录重要操作：

- 登录成功/失败
- 创建 Bin
- 更新 Bin
- 删除/恢复 Bin
- 创建/撤销 API Key
- Schema 修改
- Collection 修改

禁止记录：

- 明文密码
- Session Cookie
- Authorization Header
- 完整 API Token
- 敏感 JSON 内容

建议记录：

~~~text
id
action
resourceType
resourceId
actor
provider
timestamp
summary
requestId
~~~

个人版可限制保留最近 1000～5000 条，避免无限增长。

---

## P9 API 文档

Dashboard 内提供可直接复制的文档：

- [ ] 登录/认证说明
- [ ] API Key 使用
- [ ] Bin CRUD
- [ ] ETag 示例
- [ ] PATCH 示例
- [ ] deep-path 示例
- [ ] Collection API
- [ ] Schema API
- [ ] 错误码
- [ ] curl 示例
- [ ] JavaScript fetch 示例
- [ ] Python requests 示例

每个 Bin 的详情页还要提供“此 Bin 的 API”页签，自动生成对应 URL 和示例。

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
- [ ] API Key Scope 测试
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

当前不要直接开始“集合/API Key/Schema”。

下一步固定为：

**P1：数据仓详情页与 JSON 编辑器**

P1 完成并验收后，再进入 P2 版本历史。

这样可以先把最核心的 Bin 使用链路彻底打通：

~~~text
创建 -> 打开 -> 查看 -> 编辑 -> 保存 -> 版本增加 -> 冲突保护 -> 删除
~~~

这是后续集合、Schema、API Key、回收站等功能的共同基础。
