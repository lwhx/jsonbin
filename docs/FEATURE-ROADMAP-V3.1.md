# JSONBin v3.1 功能扩展开发设计文档

> 项目：lwhx/jsonbin  
> 基础版本：JSONBin v3.0.0  
> 目标版本：JSONBin v3.1.x  
> 技术栈：Cloudflare Workers + Hono + TypeScript + React + Vite + R2 + KV  
> 产品定位：单用户、私人 JSON 数据存储与配置管理平台

---

# 1. 开发目标

JSONBin v3.0.0 已经具备：

- Bin CRUD
- Collection
- JSON Schema
- API Key + Scope
- JSON Merge Patch
- Deep Path Read / Write
- 不可变版本历史
- Diff / Restore
- ETag / If-Match
- Data Lock / Schema Lock
- TTL
- 回收站
- 导入 / 导出 / 完整业务备份
- 全局元数据搜索
- 活动记录
- API 文档
- Monaco 编辑器
- JSON 表单编辑器
- JSON 树形视图

v3.1 的目标不是重写现有架构，而是在现有稳定基础上增加以下功能：

1. Bin 自定义别名 / Slug
2. API Key 限制到指定 Bin / Collection
3. 标签 / 收藏 / 置顶
4. 复制 / 克隆 Bin
5. JSON 模板
6. 批量操作
7. OpenAPI 规范 + 在线 API 调试器
8. API 使用统计
9. JSON 内容搜索
10. 配置发布 / 回滚机制

最终产品应从“JSON 数据存储平台”进一步演进为：

> Cloudflare 原生的私人配置、API 与自动化管理中心。

---

# 2. 强制架构原则

以下原则是硬性要求，新功能不得破坏。

## 2.1 R2 永远是权威数据源

R2 保存全部需要持久化和恢复的业务状态。

KV 只允许用于：

- 缓存
- 搜索索引
- 可重新生成的映射
- 临时派生数据

任何以下信息不得只存在 KV：

- Bin 权限
- Slug 所属关系
- API Key 权限范围
- 发布版本
- 模板
- 标签
- 收藏 / 置顶
- 业务状态

安全决策不得只依赖 KV。

## 2.2 不引入 D1

当前版本继续保持：

- R2：持久业务数据
- KV：缓存与索引

不引入：

- D1
- MongoDB
- Redis
- PostgreSQL
- 外部数据库

## 2.3 保持不可变版本模型

现有存储模型继续保持：

~~~
bins/<binId>/
  meta.json
  versions/
    000001.json
    000002.json
    000003.json
~~~

修改 JSON 数据时：

~~~
旧版本
  ↓
创建新的 immutable version
  ↓
CAS 更新 meta.json.currentVersion
~~~

任何新功能不得覆盖历史版本。

## 2.4 所有关键写操作继续使用 ETag / If-Match

包括：

- 修改 Bin
- 修改元数据
- 修改 Slug
- 批量操作
- 发布版本
- 回滚发布版本
- 模板修改
- API Key 修改

缺少前置条件：

~~~
428 Precondition Required
~~~

ETag 已过期：

~~~
412 Precondition Failed
~~~

禁止 silently overwrite。

## 2.5 保持旧 API 兼容

现有接口不能因为 v3.1 升级而改变原有含义。

例如：

~~~
GET /api/v1/bins/:id
~~~

仍然返回当前保存版本。

现有脚本升级 v3.1 后必须继续工作。

不得将现有 currentVersion 改成“已发布版本”。

发布功能必须通过新增字段和新增接口实现。

---

# 3. 推荐实施阶段

建议严格按照以下顺序开发：

| Phase | 功能 |
|---|---|
| P13 | Bin Slug + 标签 + 收藏 + 置顶 |
| P14 | API Key 资源级权限 |
| P15 | Clone Bin + JSON Template |
| P16 | 批量操作 |
| P17 | OpenAPI + 在线 API 调试器 |
| P18 | API 使用统计 |
| P19 | JSON 内容搜索 |
| P20 | 配置发布 / 回滚 |

每个 Phase 必须单独完成：

~~~
设计
→ 后端
→ 前端
→ 测试
→ 文档
→ CI 全通过
→ 再进入下一阶段
~~~

禁止一次性将 P13-P20 全部混在一个巨大提交中。

---

# 4. P13：Bin 自定义 Slug

## 4.1 目标

目前 Bin 访问依赖 UUID：

~~~
/api/v1/bins/0d324775-bc71-406c-8813-e69e46d87d4e
~~~

增加可选 Slug，例如：

~~~
cloudflare-config
qinglong-config
openai-config
workbuddy
~~~

允许：

~~~
GET /api/v1/b/cloudflare-config
~~~

访问对应 Bin。

## 4.2 数据模型

扩展 BinMeta：

~~~ts
type BinMeta = {
  // existing...
  slug: string | null;
};
~~~

旧 Bin 缺少字段时必须读取为：

~~~ts
slug = null
~~~

禁止要求一次性迁移全部旧 Bin。

## 4.3 Slug 格式

建议：

~~~text
^[a-z0-9][a-z0-9-_]{1,62}[a-z0-9]$
~~~

规则：

- 3～64 字符
- 仅小写英文字母、数字、-、_
- 首尾必须为字母或数字
- 自动转换为小写
- 不允许空格
- 不允许 /
- 不允许 %
- 不允许 Unicode URL 混淆字符

## 4.4 Slug 权威映射

不得仅使用 KV 的 slug → UUID 关系保证唯一性。

增加 R2 权威映射：

~~~
aliases/
  bins/
    cloudflare-config.json
~~~

示例：

~~~json
{
  "slug": "cloudflare-config",
  "binId": "0d324775-bc71-406c-8813-e69e46d87d4e",
  "lifecycleId": "...",
  "createdAt": "..."
}
~~~

创建 Slug 时使用 etagDoesNotMatch: "*" 原子抢占。

若已存在：

~~~
409 slug_conflict
~~~

## 4.5 修改 Slug

推荐流程：

1. 校验新 Slug。
2. R2 原子抢占新 Slug。
3. CAS 更新 Bin meta.json。
4. 删除旧 Slug 映射。
5. 同步 KV / Search。

如果第 3 步失败，必须尝试释放刚刚抢占的新 Slug。

读取 Slug 后必须再次验证：

- alias.binId
- alias.lifecycleId
- Bin.meta.slug
- Bin.lifecycleId

全部匹配后才能返回数据。

## 4.6 删除和恢复

普通删除到回收站后：

- Slug 不再允许读取 Bin
- Slug 继续保留
- 不允许其他 Bin 抢占该 Slug

永久删除完成后才释放 Slug。

恢复 Bin 后继续保留原 Slug。

## 4.7 API

创建 Bin 时允许：

~~~json
{
  "name": "Cloudflare",
  "slug": "cloudflare-config",
  "value": {}
}
~~~

修改：

~~~
PATCH /api/v1/bins/:id/meta
If-Match: ...
~~~

删除 Slug：

~~~json
{
  "slug": null
}
~~~

增加：

~~~
GET /api/v1/b/:slug
GET /api/v1/b/:slug/value/*
~~~

P20 再增加：

~~~
GET /api/v1/b/:slug/published
~~~

---

# 5. P13：标签 / 收藏 / 置顶

扩展 BinMeta：

~~~ts
tags: string[];
favorite: boolean;
pinned: boolean;
~~~

旧 Bin 默认：

~~~ts
tags = [];
favorite = false;
pinned = false;
~~~

## 5.1 Tag 约束

建议：

- 每个 Bin 最多 20 个 Tag
- 每个 Tag 1～32 字符
- 去除首尾空格
- 禁止空字符串
- 禁止重复
- 支持中文

示例：

~~~
Cloudflare
青龙
生产环境
VPS
自动化
~~~

## 5.2 列表和筛选

支持：

~~~
GET /api/v1/bins?tag=cloudflare
GET /api/v1/bins?favorite=true
GET /api/v1/bins?pinned=true
GET /api/v1/bins?collectionId=xxx
~~~

默认排序：

~~~
pinned DESC
updatedAt DESC
~~~

UI 增加：

- 置顶
- 收藏
- 标签
- 全部 / 收藏 / 置顶过滤
- 按标签筛选

---

# 6. P14：API Key 资源级权限

现有 Scope 继续保留：

- bin:read
- bin:create
- bin:update
- bin:delete
- collection:read
- collection:write
- schema:read
- schema:write
- history:read

在 Scope 之上增加第二层 Resource Access Policy。

## 6.1 数据结构

StoredKey 增加：

~~~ts
resourceAccess:
  | {
      mode: "all";
    }
  | {
      mode: "restricted";
      binIds: string[];
      collectionIds: string[];
    };
~~~

旧 API Key 没有该字段时：

~~~
mode = all
~~~

升级后不能突然让已有 API Key 失效。

## 6.2 权限判断

最终权限：

~~~
Scope 允许
AND
Resource Policy 允许
~~~

Collection 授权必须动态生效。

如果 API Key 被授权 Collection A，Bin X 当前属于 Collection A，则允许。

如果管理员将 Bin X 移到 Collection B，该 Key 必须立即失去访问权限。

权限判断必须读取当前 R2 权威状态。

不得将 Collection 权限永久展开为 Bin ID 列表。

## 6.3 List / Search 权限

Restricted Key 调用：

~~~
GET /api/v1/bins
~~~

应该只返回它可访问的 Bin，而不是直接返回 403。

搜索同样必须过滤。

不得通过名称、描述、Collection、Slug、搜索结果泄露无权访问资源的存在。

## 6.4 Restricted Key 创建 Bin

Restricted Key 使用 bin:create 创建 Bin 时，只有目标 collectionId 属于允许的 collectionIds 才能创建。

Restricted Key 第一版不允许创建未归属 Collection 的 Bin。

## 6.5 修改 Collection

若 API Key 将 Bin 移动到某个 Collection，目标 Collection 必须也在允许范围内。

否则：

~~~
403 resource_forbidden
~~~

## 6.6 UI

创建 / 编辑 API Key：

~~~
资源范围

● 所有资源

○ 限制资源

允许的 Bin
☑ Cloudflare Config
☑ Qinglong Config

允许的 Collection
☑ Cloudflare
☑ VPS
~~~

列表显示：

~~~
所有资源
~~~

或：

~~~
2 个 Bin
1 个 Collection
~~~

---

# 7. P15：复制 / 克隆 Bin

新增：

~~~
POST /api/v1/bins/:id/clone
~~~

要求：

- bin:read
- bin:create
- If-Match

If-Match 用于保证复制的是用户当前看到的快照。

## 7.1 Clone 默认规则

复制：

- 当前保存 JSON
- description
- tags
- collectionId
- 当前 pinned Schema + Revision

不复制：

- UUID
- Slug
- favorite
- pinned
- data lock
- schema lock
- expiresAt
- deletedAt
- publishedVersion
- contentSearchMode

新 Bin 默认：

~~~text
currentVersion = 1
visibility = private
locked = false
schemaLocked = false
slug = null
favorite = false
pinned = false
expiresAt = null
publishedVersion = null
contentSearchMode = off
~~~

默认名称：

~~~
原名称 - 副本
~~~

## 7.2 Schema Clone

如果源 Bin：

~~~
schemaId = X
schemaRevision = 3
~~~

Clone 应保留 X / Revision 3，而不是自动绑定最新 Revision。

必须验证 Clone JSON 对该 Revision 仍有效。

---

# 8. P15：JSON Template

新增独立资源：

~~~
templates/
  <templateId>/
    meta.json
    versions/
      000001.json
      000002.json
~~~

Template 同样使用不可变版本。

## 8.1 Template Meta

~~~ts
type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  tags: string[];
  schemaId: string | null;
  schemaRevision: number | null;
  createdAt: string;
  updatedAt: string;
};
~~~

Template 不包含：

- Slug
- TTL
- 锁
- 收藏
- 置顶
- Published Version

## 8.2 API

~~~
GET    /api/v1/templates
POST   /api/v1/templates

GET    /api/v1/templates/:id
PATCH  /api/v1/templates/:id
DELETE /api/v1/templates/:id

POST   /api/v1/bins/:id/save-as-template
POST   /api/v1/templates/:id/create-bin
~~~

第一阶段模板管理只允许 Dashboard Session，不增加 Template API Key Scope。

## 8.3 UI

新建数据时增加：

~~~
创建方式

○ 空白 JSON
○ 从模板创建
~~~

模板创建后继续进入现有 JsonFormEditor，减少手工输入 JSON 符号。

## 8.4 备份

Template 属于业务数据，必须进入完整 Backup。

Backup Schema：

~~~
schemaVersion 1 → schemaVersion 2
~~~

要求：

- Export 输出 v2
- Restore 支持 v1
- Restore 支持 v2
- 旧 v1 Backup 必须继续可恢复

---

# 9. P16：批量操作

Bin List 增加 Checkbox 和批量操作栏。

第一版支持：

- 移动 Collection
- 设置 Public / Private
- 添加 Tag
- 删除 Tag
- 设置收藏
- 取消收藏
- 设置置顶
- 取消置顶
- 移入回收站

第一版暂不支持：

- 批量修改 JSON Value
- 批量修改 Schema
- 批量永久删除

## 9.1 API

新增：

~~~
POST /api/v1/bins/batch
~~~

Route 必须注册在 /bins/:id 之前，避免 batch 被解析成资源 ID。

示例：

~~~json
{
  "operation": "add_tags",
  "items": [
    {
      "id": "uuid-1",
      "etag": "\"xxx\""
    },
    {
      "id": "uuid-2",
      "etag": "\"yyy\""
    }
  ],
  "payload": {
    "tags": ["Cloudflare"]
  }
}
~~~

## 9.2 限制

- 每批最多 100 个 Bin
- ID 不允许重复
- 每个 Item 独立 CAS
- 不提供跨 Bin 全局事务

返回 HTTP 200 并逐项报告：

~~~json
{
  "results": [
    {
      "id": "...",
      "status": "updated"
    },
    {
      "id": "...",
      "status": "etag_conflict"
    },
    {
      "id": "...",
      "status": "locked"
    }
  ]
}
~~~

不得因为某一项失败自动回滚之前已经成功的对象。

## 9.3 安全

所有 Item 必须逐项检查：

- API Scope
- Resource Access
- ETag
- Lock
- Collection 权限
- 当前生命周期
- TTL
- Trash 状态

Batch Endpoint 不能成为绕过权限或并发控制的捷径。

---

# 10. P17：OpenAPI 3.1

新增：

~~~
GET /api/v1/openapi.json
~~~

规范版本：

~~~
OpenAPI 3.1.0
~~~

内容覆盖完整 /api/v1。

必须描述：

- Paths
- Methods
- Parameters
- Request Body
- Response
- Status Code
- ETag
- If-Match
- Cookie Auth
- Bearer Auth
- API Scope
- Resource restriction
- Public Bin anonymous read
- Merge Patch
- JSON Pointer
- Batch
- Slug
- Published Config

Security Schemes 至少包含 CookieAuth 与 BearerAuth。

不得在 Example 中放真实：

- API Key
- Cookie
- Token
- 用户 JSON

## 10.1 防止规范漂移

推荐增加：

~~~
src/shared/openapi.ts
~~~

作为规范生成模块。

测试必须验证 Hono 注册的 /api/v1 route/method 与 OpenAPI paths 的覆盖关系。

如果新增 API 但没有更新 OpenAPI，CI 应失败。

---

# 11. P17：在线 API 调试器

现有 API 文档升级为：

~~~
API 文档

[文档] [在线调试] [OpenAPI]
~~~

调试器应支持：

- Method
- Path Parameters
- Query
- Request Body
- Authentication
- If-Match
- Response Status
- Response Headers
- Response Body
- 请求耗时

Bearer Token 只保存在页面内存。

禁止保存到：

- localStorage
- sessionStorage
- IndexedDB
- URL
- 日志
- Activity

调试器只能请求：

~~~
当前站点 /api/v1/*
~~~

禁止接受任意目标 URL，防止变成 SSRF / Proxy 工具。

危险请求发送前必须确认：

- DELETE
- 永久删除
- Restore
- Batch Delete
- Publish Rollback

GET Bin 后可以自动提取 ETag 到后续 If-Match 输入框，但必须允许用户手动修改。

---

# 12. P18：API 使用统计

当前 API Key 已有 lastUsedAt。

统计应尽量合并到现有 useApiKey() 的 R2 CAS 中，不增加每次请求额外的第二次 R2 写。

## 12.1 数据结构

StoredKey 增加：

~~~ts
usageTotal: number;
usageDaily: Record<string, number>;
~~~

例如：

~~~json
{
  "usageTotal": 18294,
  "usageDaily": {
    "2026-10-03": 421,
    "2026-10-04": 702,
    "2026-10-05": 831
  }
}
~~~

只保留最近 31 天，按 UTC 统计。

## 12.2 统计定义

第一版只统计：

> 成功通过 API Key 身份验证、Scope 和 Resource Access 检查的请求。

业务请求后续即使返回 404，也属于一次“已授权请求”。

不统计：

- Dashboard Session 请求
- Anonymous Public Read
- Auth 失败 Token
- Scope 不足
- Resource Access 拒绝

## 12.3 UI

API Key 页面显示：

- 今日已授权请求
- 最近 7 天
- 最近 30 天
- 总请求
- 最后使用
- 简洁趋势图

文案必须使用“已授权请求数”，避免误认为全部是业务成功请求。

---

# 13. P19：JSON 内容搜索

当前 P11 搜索继续负责 Metadata Search。

JSON Value 搜索作为独立功能，不要直接污染现有 P11 元数据索引。

## 13.1 数据模型

BinMeta 增加：

~~~ts
contentSearchMode:
  | "off"
  | "keys"
  | "all";
~~~

旧 Bin 和新 Bin 默认：

~~~
off
~~~

## 13.2 模式

off：

- 不搜索 JSON

keys：

- 搜索 Object Key
- 搜索 JSON Pointer Path
- 不搜索 Value

all：

- 搜索 Key
- Path
- string
- number
- boolean

用户开启 all 时必须提示：

> JSON 内容可能包含 Token、Cookie、密码或其他敏感值。开启完整内容搜索后这些值将参与搜索处理。

## 13.3 第一阶段不要把 JSON 内容写入 KV

P19 第一版采用 R2 权威实时有界搜索：

~~~
搜索请求
↓
R2 扫描 Active Bin Meta
↓
筛选 contentSearchMode != off
↓
读取 currentVersion
↓
递归 Flatten
↓
搜索
~~~

限制建议：

- 最多扫描 100 个开启内容搜索的 Bin
- 总读取 JSON 最多 20 MiB
- 最大递归 64 层
- 单 Bin 最多扫描 10,000 个 JSON Node
- 并发读取最多 8

超过能力：

~~~
503 content_search_limit_exceeded
~~~

不得只搜索一部分却返回看起来完整的结果。

## 13.4 API

~~~
GET /api/v1/search/content?q=example
~~~

可选：

~~~
mode=keys
mode=all
~~~

第一版只允许 Management Session。

## 13.5 Result

示例：

~~~json
{
  "items": [
    {
      "binId": "...",
      "name": "Cloudflare Config",
      "path": "/cloudflare/domain",
      "matchType": "value",
      "snippet": "example.com"
    }
  ]
}
~~~

Snippet 最大约 120 字符，不返回完整 JSON。

只搜索：

- Active
- 未过期
- Current Version

不搜索：

- Trash
- Purged
- Historical Version
- Import Pending
- Expired Bin

Locked Bin 可以搜索。

---

# 14. P20：配置发布 / 回滚

这是 v3.1 最重要的高级功能。

必须明确区分：

- 当前编辑版本
- 当前生产发布版本

## 14.1 不改变 currentVersion 语义

现有 currentVersion 继续表示：

> 当前最新保存的 JSON 版本。

增加：

~~~ts
publishedVersion: number | null;
publishedAt: string | null;
~~~

例如：

~~~
currentVersion = 12
publishedVersion = 9
~~~

表示：

- v12 = 当前工作版本
- v9 = 当前生产发布版本

用户继续保存 v13、v14、v15，不影响 publishedVersion，直到主动发布。

## 14.2 Publish API

~~~
POST /api/v1/bins/:id/publish
If-Match: ...
~~~

Body 为空表示发布 currentVersion。

也可指定：

~~~json
{
  "version": 12,
  "note": "正式配置"
}
~~~

发布要求：

- Bin Active
- 未过期
- 未 Locked
- Version 存在
- If-Match 正确
- API Key 有 bin:update
- Version JSON 对当前 pinned Schema 有效

历史版本若已经不符合当前 Schema：

~~~
422 schema_validation_failed
~~~

## 14.3 Published Read API

增加：

~~~
GET /api/v1/bins/:id/published
GET /api/v1/bins/:id/published/value/*
GET /api/v1/b/:slug/published
~~~

对于脚本和生产自动化，推荐读取 /published，而不是直接读取 currentVersion。

## 14.4 Public / Private

如果 Bin 为 public，Published Read 可以匿名。

如果为 private，仍然需要 Session 或 Bearer。

如果请求包含 Authorization Header，则继续执行现有严格规则：Authorization 必须有效，即使资源本身 Public。

## 14.5 Rollback

增加：

~~~
POST /api/v1/bins/:id/rollback
If-Match: ...
~~~

Body：

~~~json
{
  "version": 7,
  "note": "v9 出现问题，回退"
}
~~~

执行：

~~~
publishedVersion = 7
~~~

currentVersion 不变化。

Rollback 只是移动 Published Pointer，不创建新的 JSON Version。

如果用户要让历史版本重新成为当前工作版本，继续使用现有 Restore Version，该操作才会 append 新 Version。

必须严格区分：

~~~
Rollback Publication
≠
Restore Draft
~~~

## 14.6 History UI

History 页面显示：

~~~
v15  当前版本
v14
v13
v12
v9   当前已发布
v8
v7
~~~

操作：

- 查看
- Diff
- 恢复为当前版本
- 发布此版本
- 回滚发布到此版本

Bin Detail 顶部显示：

~~~
当前工作版本：v15
已发布版本：v9
[发布当前版本]
~~~

## 14.7 Trash 行为

普通删除 Bin 后：

- Published API 立即不可访问

从 Trash 恢复时为了安全：

~~~
publishedVersion = null
publishedAt = null
visibility = private
~~~

但是完整灾难恢复 Backup Restore 应保留原 publishedVersion。

Clone 永远不复制 publishedVersion。

---

# 15. Backup / Restore 扩展

Bin Backup 需要加入：

- slug
- tags
- favorite
- pinned
- contentSearchMode
- publishedVersion
- publishedAt

Template 资源也进入完整 Backup。

以下数据不直接 Backup：

- KV indexes
- Content Search 临时数据
- Alias KV cache
- 可重新生成的派生索引

Slug 本身备份，但 aliases/bins/* 不直接备份。

Restore 时根据 BinMeta 重建 R2 Slug 映射。

## 15.1 Restore Slug 冲突

向空实例恢复时保留原 Slug。

如果目标系统已有同名 Slug，不得覆盖。

优先保证 Bin 数据恢复：

~~~
Bin 恢复成功
slug = null
warning = slug_conflict_detached
~~~

---

# 16. 新 BinMeta 最终结构

完成 P20 后建议结构：

~~~ts
type BinMeta = {
  id: string;

  name: string;
  description: string;

  slug: string | null;

  tags: string[];
  favorite: boolean;
  pinned: boolean;

  visibility: "private" | "public";

  collectionId: string | null;

  schemaId: string | null;
  schemaRevision: number | null;

  currentVersion: number;

  publishedVersion: number | null;
  publishedAt: string | null;

  contentSearchMode:
    | "off"
    | "keys"
    | "all";

  size: number;

  locked: boolean;
  schemaLocked: boolean;

  createdAt: string;
  updatedAt: string;

  expiresAt: string | null;

  deletedAt?: string;
  deletionReason?: "manual" | "expired";

  purgeState?: "purging";
  purgeEtag?: string;

  lifecycleId?: string;
};
~~~

---

# 17. 旧数据兼容

禁止启动时 Rewrite 全部旧 R2 Object。

采用读取兼容：

~~~ts
slug ?? null
tags ?? []
favorite ?? false
pinned ?? false
contentSearchMode ?? "off"
publishedVersion ?? null
publishedAt ?? null
~~~

下一次正常修改资源时再写入新格式。

这样可以：

- 无停机迁移
- 减少 R2 写入
- 降低风险
- 容易回滚

---

# 18. Search Index 升级

P11 Metadata Search Index 可以加入：

- slug
- tags
- favorite
- pinned

JSON Value 不进入 P11 Metadata Search Snapshot。

P19 JSON 内容搜索必须保持独立。

---

# 19. Activity Records

新增 Action 类型建议：

~~~
bin.slug_updated
bin.cloned

template.created
template.updated
template.deleted
template.bin_created

bin.batch_updated

bin.published
bin.publication_rolled_back
~~~

Activity 不得记录：

- JSON Value
- JSON 搜索值
- Token
- Cookie
- API Key
- Authorization
- Template JSON 内容

发布记录只记录必要元数据，例如：

- Bin ID
- Version
- Request ID
- Action
- Timestamp

---

# 20. API 错误规范

建议新增：

~~~
invalid_slug
slug_conflict

resource_forbidden

template_not_found

batch_invalid
batch_limit_exceeded

content_search_limit_exceeded

not_published
publish_version_not_found

schema_validation_failed
~~~

HTTP 映射：

| Status | 含义 |
|---|---|
| 400 | 参数结构错误 |
| 401 | 未认证 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 409 | Slug / 业务状态冲突 |
| 412 | ETag 冲突 |
| 422 | 业务数据验证失败 |
| 423 | Locked |
| 428 | 缺少 If-Match |
| 503 | 有界搜索能力不足 |

---

# 21. UI 总体要求

继续保持现有：

> 现代 Developer SaaS

禁止引入另一套完全不同的 Admin Template 风格。

必须保持：

- 中文 UI
- Desktop
- Mobile
- Dark Mode
- Light Mode
- Keyboard navigation
- Draft protection
- Unsaved changes protection

## 21.1 Bin 页面

继续使用：

- 表单
- 编辑器
- 树形视图
- 历史版本
- API
- 设置

发布状态放在页面顶部、History 和 API 区域即可，不必新增大型独立 Tab。

## 21.2 Bin List

桌面建议字段：

- 选择
- 置顶
- 收藏
- 名称
- Slug
- Tag
- Collection
- 可见性
- 当前版本
- 发布版本
- 更新时间
- 操作

移动端折叠显示。

## 21.3 API Key 页面

建议字段：

- 名称
- Token Prefix
- Scopes
- 资源范围
- 今日使用
- 30 天使用
- 最后使用
- 过期时间
- 状态
- 操作

## 21.4 Template 页面

Sidebar 增加：

~~~
模板
~~~

支持：

- 创建模板
- 编辑
- 复制
- 创建 Bin
- 删除

---

# 22. 安全要求

所有新功能必须继续遵守现有安全模型。

## Authorization

不得绕过：

- Session
- Bearer
- Scope
- Resource Policy

## CORS / CSRF

继续使用现有 APP_ORIGIN 规则。

Cookie 写操作继续验证 Origin。

## Sensitive Data

禁止日志输出：

- Authorization
- Cookie
- Token
- JSON Value
- Template Value
- 敏感搜索内容

## KV

禁止用 KV 做安全权威。

## Public Bin

Public 只影响匿名读取。

不得允许匿名：

- History
- Write
- Template
- Content Search
- Key Admin
- Batch Write
- Publish
- Rollback

---

# 23. 并发测试

必须覆盖以下竞争：

- 两个客户端同时改 Slug
- 两个客户端同时 Publish
- Publish 与 Update 同时发生
- Batch 与普通 Update 同时发生
- API Key Revocation 与请求同时发生
- Bin Move Collection 与 Restricted Key 请求同时发生
- Clone 与源 Bin Update 同时发生
- Trash 与 Publish 同时发生
- Permanent Purge 与 Slug Resolve 同时发生

最终必须由：

~~~
R2 CAS
+
ETag
~~~

决定结果。

---

# 24. 各 Phase 验收要求

## P13

必须测试：

- Slug 创建 / 修改 / 删除
- Slug 冲突
- Slug 查询
- Trash 保留 Slug
- Purge 释放 Slug
- Tag CRUD
- Favorite
- Pinned
- Tag Filter
- Mobile UI
- Search 同步
- Backup

## P14

必须测试：

- 旧 Key 默认 all
- 指定 Bin
- 指定 Collection
- Bin 移入 / 移出 Collection
- Bin List Filter
- Search Filter
- History 权限
- Deep Path 权限
- Public + Bearer
- Create Bin
- Collection Write
- Revoked Key

## P15

必须测试：

- Clone Snapshot
- Clone ETag Conflict
- Clone Schema Revision
- Clone Private Default
- Clone 不复制 Slug
- Clone 不复制 Published
- Template CRUD
- Template ETag
- Save As Template
- Create From Template
- Template Backup
- v1 Backup Restore
- v2 Backup Restore

## P16

必须测试：

- 1 Item
- 100 Items
- 101 Items 拒绝
- 重复 ID 拒绝
- 部分成功
- ETag Conflict
- Locked
- Restricted API Key
- Collection Permission
- Batch Delete
- UI Retry

## P17

必须测试：

- openapi.json 可解析
- OpenAPI 3.1
- 所有 route 被覆盖
- Security Schemes 正确
- ETag 文档
- Slug 文档
- Batch 文档
- 在线 GET / POST / PATCH / DELETE
- Bearer 不持久化
- 危险操作确认

## P18

必须测试：

- 旧 Key usage = 0
- 首次请求 +1
- 并发请求 CAS
- 今日 / 7 日 / 30 日统计
- 31 日清理
- Revoked Key 不再计数
- Scope 失败不计数
- Resource 失败不计数

## P19

必须测试：

- off / keys / all
- 中文 / 英文 / 数字 / boolean
- Nested Object / Array / JSON Pointer
- Trash / Expired / Historical 排除
- 100 Bin
- 超过限制返回 503
- Session Only
- 敏感值不进入 Activity

## P20

必须测试：

- 首次 Publish
- 再次 Publish
- Publish 历史版本
- Schema Validation
- Locked
- ETag Conflict
- Current 更新后 Published 不变化
- Rollback
- Rollback 不改变 Current
- Published Public / Private Read
- Slug Published Read
- Published Deep Path
- Trash 后 Published 不可访问
- Trash Restore 清除 Published
- Backup Restore 保留 Published
- Clone 清除 Published

---

# 25. 统一质量门槛

每个 Phase 完成必须运行：

~~~bash
npm run typecheck
npm run build
npm test
npm run test:browser
~~~

全部 0 failure 才能进入下一 Phase。

禁止：

- 为了通过测试删除测试
- 使用 skip / only 临时掩盖失败
- 跳过已有核心验收

除非设计文档明确记录原因。

---

# 26. GitHub CI

必须继续保证：

~~~bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:browser
~~~

全部通过。

任何新依赖必须同步更新：

- package.json
- package-lock.json

---

# 27. Production Acceptance

v3.1 发布前继续运行：

~~~bash
node scripts/check-production.mjs https://js.gnn.im
~~~

并增加必要检查。

至少验证：

- Health
- Login
- CSP
- CORS
- Request ID
- 401 Barrier
- Slug
- Restricted Key
- Clone
- Template
- Batch
- OpenAPI
- Published Read

---

# 28. 文档同步

每完成 Phase 都必须同步：

- README.md
- docs/ARCHITECTURE.md
- docs/DEVELOPMENT.md
- docs/OPERATIONS.md

涉及 API 时同步：

- Dashboard API Docs
- OpenAPI

涉及备份时同步：

- Backup Format
- Restore Rules
- Operations Recovery

---

# 29. 建议代码结构

不要把所有代码继续塞入 bins.ts 或 App.tsx。

建议：

~~~
src/worker/storage/
  aliases.ts
  templates.ts
  publishing.ts
  content-search.ts

src/worker/routes/
  templates.ts
  openapi.ts

src/shared/
  templates.ts
  openapi.ts
  batch.ts
  publishing.ts

src/react-app/features/
  templates/
  api-explorer/
~~~

已有 bins、keys、search 等目录继续在原结构中扩展相应逻辑。

---

# 30. 禁止大型重构

本阶段目标是：

> 增量升级稳定 v3.0.0。

不是重写整个项目。

开发 AI 不应：

- 替换 Hono
- 替换 React
- 替换 R2
- 替换 KV
- 重写认证
- 重写 Backup
- 大规模改变 Route
- 改现有 UUID
- 改 existing API semantics

除非完成当前需求确实不可避免。

---

# 31. 非目标

本阶段暂时不开发：

- 多人账户
- 团队
- Organization
- RBAC
- 计费
- 套餐
- 支付
- 评论
- 多人协作编辑
- WebSocket 实时协作
- D1
- Secret Manager
- Webhook
- Dev / Test / Prod Environment

这些可以在 v3.2 以后考虑。

---

# 32. AI 开发执行要求

开发 AI 收到本文档后，应：

1. 首先完整读取：
   - README.md
   - docs/ARCHITECTURE.md
   - docs/DEVELOPMENT.md
   - docs/OPERATIONS.md

2. 阅读现有：
   - Bin Storage
   - Bin Routes
   - API Key Storage
   - Search
   - Backup
   - Trash
   - Activity
   - React Bin UI

3. 不要凭空重新设计已经存在的功能。

4. 每个 Phase 开发前，在 docs/superpowers/specs/ 创建对应详细设计文档。

建议命名：

~~~
2026-10-05-p13-resource-identity-design.md
2026-10-05-p14-resource-permissions-design.md
2026-10-05-p15-template-clone-design.md
~~~

5. 每个 Phase 单独提交。

6. 每个 Phase 完成后运行全部测试。

7. 测试全部通过后再进入下一 Phase。

8. 发现现有设计与本文档冲突时：
   - 优先保证数据安全
   - 优先保证向后兼容
   - 优先保证 R2 权威
   - 不允许静默破坏已有数据
   - 在设计文档中记录调整原因

---

# 33. 最终验收目标

v3.1 完成后，一个典型工作流应该可以做到：

~~~
创建一个 Cloudflare JSON 模板
        ↓
从模板创建 Bin
        ↓
设置 Slug：cloudflare-prod
        ↓
添加 Cloudflare / 生产环境 Tag
        ↓
设置收藏、置顶
        ↓
创建专用 API Key
        ↓
只授权这个 Bin
        ↓
自动化脚本读取：
/api/v1/b/cloudflare-prod/published
        ↓
用户修改 JSON
        ↓
产生新的 currentVersion
        ↓
生产环境继续使用旧 publishedVersion
        ↓
用户测试完成
        ↓
点击发布
        ↓
生产配置切换到新版本
        ↓
如果异常
        ↓
一键 Rollback 到历史 Published Version
~~~

同时必须继续满足：

- 完整版本历史仍然存在
- R2 始终是权威数据源
- KV 可以随时重建
- 旧 API 继续工作
- 旧 API Key 继续工作
- Backup 可以完整恢复
- 并发修改不会静默覆盖

这就是 JSONBin v3.1 的目标状态。
