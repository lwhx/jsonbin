# P11 全局搜索与 KV 索引设计

日期：2026-10-04（Asia/Shanghai）。范围仅为 P11；R2 保持唯一权威来源。实现已交付 main，交付 SHA 8b12d9e 的 146 项测试、52 项浏览器验收及 CI / Workers Builds 均通过；生产手动验收单独保留，详见 DEVELOPMENT.md P11。

## 接口与界面

- `GET /api/v1/search?q=...&type=all|bin|collection|schema&limit=20&cursor=...`：名称、描述、UUID 的 NFKC/大小写归一化子串匹配；Bin 额外匹配集合名称/UUID。不读取或搜索 JSON 正文。
- `q` trim 后 1–160 字符，limit 1–50；未知/重复参数返回 400。分页游标绑定查询、类型、页长和 R2 元数据清单指纹；指纹变化返回 409，客户端重新查询第一页。
- 所有搜索均需认证。all 需要三个 read Scope；bin 需要 bin:read + collection:read；collection/schema 只需自身 read。公开 Bin 不允许匿名发现；显式 Authorization 不回退 Session。
- `GET /search/index` 和 `POST /search/rebuild` 为 Session-only 管理接口，复用 Origin 检查；所有 Authorization 均拒绝。
- 顶部按钮及 Ctrl/Cmd+K 进入可刷新、可分享条件的 hash 搜索页；筛选、空状态、加载、错误重试和加载更多。结果使用既有详情路由，复用未保存内容保护。设置页显示状态并允许重建。

## 派生索引

- `idx:bin:<id>`、`idx:collection:<id>`、`idx:schema:<id>` 保存可用元数据摘要；`idx:slug:<slug>` 映射集合 ID。创建/更新/关系解除/恢复/导入后读取最新 R2 元数据并同步；删除、到期归档、purging/purged、归档模型清理索引。普通业务操作不因 KV 失败而失败。
- `search:snapshot:<generation>` 保存不可变聚合摘要，24 小时自动过期。`indexes/search/meta.json` 在 R2 中保存格式、generation、元数据清单 SHA-256、KV 正文 SHA-256、构建时间及数量；它是可重建的派生清单，备份排除。
- 搜索先分页列举 bins/collections/schemas 对象的 key/ETag，校验清单与 KV 正文摘要。缺失/失效/损坏/异常回退 R2 元数据扫描；已经读取的摘要尽力生成新缓存。避免仅重新读取候选却遗漏新匹配的常见失效问题。
- 候选返回前重新读取 R2 元数据及所属集合，检查 TTL、删除/归档/pending 状态及当前匹配条件。TTL 不依赖 Cron 或 KV。
- 重建扫描前后校验清单，同步派生行、清除废弃派生 key，上传唯一 KV 快照，再次检查清单并 CAS 发布 R2 清单；争用返回 409，不改业务数据。KV 同步失败返回 503。KV 最终一致可使随后查询继续回退 R2。
- 上限：10000 个 R2 对象、200 个元数据资源（含隐藏/终态）、2 MiB 快照；元数据读取并发 16；重建复用已扫描摘要，每次最多删除 200 个废弃 key，保留低于 1000 次内部服务调用的余量。额外清理返回 503 search_cleanup_limit_exceeded，可再次重建继续。超限明确失败，不展示部分查询结果。分页不构成事务快照；并发变动要求重查。

原计划的 token 倒排 key 和 dashboard summary 暂不采用：任意中文/UUID 子串匹配由小规模聚合摘要实现。普通 Bin 列表及概览仍走既有 R2 路径；后续容量优化需要另行设计，不能削弱权限或 TTL 检查。
