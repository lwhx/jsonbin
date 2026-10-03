# P9 API 文档设计

状态：用户已确认设计方向（2026-10-04，Asia/Shanghai）；本书面设计已确认；实施计划已确认，正在原生执行。

依据：用户要求按 `docs/DEVELOPMENT.md` 继续下一阶段。基线为 `main` 的 `37ac984273ca4ca68ffdc4006209aed8f3dd6c95`，P0–P8 已完成。P9 要求 Dashboard 文档、三种语言示例以及每个 Bin 的动态 API 页签。现有 Bin「API」页签已有简要说明，需要扩展并复用文档内容。

## 目标和验收结果

让使用者在已登录的 Dashboard 中了解当前 API 的请求方式、权限、响应和失败处理，并复制适用于当前部署及具体 Bin 的示例。

- 中文文档完整覆盖 P9 清单：登录/认证、API Key、Bin CRUD、ETag、PATCH、deep-path、Collection、Schema、错误码、curl、JavaScript fetch、Python requests。
- 通用文档使用当前站点 origin；Bin 页使用当前 origin、实际 Bin ID、已保存记录的 ETag，以及实际公开/私有状态。
- 示例可复制，示例语义与现有 Worker 一致；切换语言和查看文档不会发出业务写请求。
- Bin 页保留 JSON 和设置草稿，文档离页沿用现有导航确认；支持移动端、明暗主题和键盘操作。

## 范围及方案选择

采用前端类型化文档目录、纯函数请求示例生成器和共享展示组件。该方案能复用通用页和 Bin 页的数据，并把同一请求转换为三种语言，减少示例间的不一致。

另两种方案：Markdown 页面便于编辑文章，但动态 Bin URL/ETag 和多语言请求仍需另写生成逻辑；OpenAPI/Swagger 文档站提供更多自动化能力，但引入依赖、规范维护和界面整合。本阶段不采用这两种方案。

P9 不增加 Worker 接口、不调整权限/存储/ETag 行为、不引入产品依赖。不增加在线请求执行器、Token 输入或保存、导出站点、全文搜索，也不实现 P10 设置/导入导出。

## 页面和交互

### Dashboard API 文档

启用侧栏「API 文档」，路由为 `/#/docs`，沿用现有登录和 hash 导航。页面包含中文章节目录、当前 API 基础地址、语言选择和正文。

章节按认证与密钥、Bin CRUD、版本和元数据、ETag、局部更新与路径、集合、模型、生命周期、活动记录、错误处理组织。生命周期和活动记录只说明现有接口，帮助使用者理解删除/过期和管理权限，不增加这些功能。

每个资源操作列出 HTTP 方法/路径、认证和 Scope、请求字段、成功状态/响应形状、ETag 要求以及必要的错误说明。配套请求代码块支持三种语言和复制按钮。OAuth 使用流程说明与入口地址，不生成用于手动重放 callback 的 code/state 示例。

目录采用页内导航，不改写应用路由；刷新 `/#/docs` 仍进入文档。语言选择只影响示例展示，不保存到 LocalStorage。代码块内部允许横向滚动，页面整体不溢出。

### 此 Bin 的 API

保留现有「API」页签和标题，使用共享组件替换手写示例，提供当前读取、完整更新、Merge Patch、路径读写、元数据、删除、历史读取/恢复的示例及对应权限提示。

示例使用演示 JSON，不自动复制已存 JSON、资源名称/描述、未保存 JSON 或设置草稿。当前 ETag 来自已保存记录；保存、恢复或重新加载后的示例随记录更新。后续独立写操作必须重新读取最新 ETag，不能暗示一次 ETag 可连续用于多个写入。

公开 Bin 提供匿名当前读取示例，同时说明列表、历史和写入仍需认证；私有读取使用 API Key 示例。显式 Authorization 即使在公开 Bin 上也要正常认证，不能把无效 Token 当作匿名访问。锁定或到期状态的提示只反映已保存的状态。

### 复制反馈

点击复制后报告成功；剪贴板不可用时显示可操作的提示并保留完整可选择的代码。每个代码块反馈独立，不能把拒绝或旧的复制结果显示为本次成功。页面离开后不更新组件状态。代码以 React 文本呈现，不注入 HTML。

## 内容以当前实现为准

### 认证与权限

- 管理网页登录使用 HttpOnly Session Cookie，密码登录为 `POST /api/v1/auth/login`；GitHub 登录使用 `/api/v1/auth/github`。Cookie 有效期为 14 天。受 Session 保护的资源管理写入若携带 Origin，须符合应用 origin。
- 外部资源调用发送 `Authorization: Bearer <API_TOKEN>`。明确的 Authorization 不回退到 Cookie；无效 Token 为 401，Scope 不足为 403。
- API Key 管理和活动列表仅支持管理 Session，带 Authorization 时返回 401 `session_required`。创建密钥只返回一次完整 Token；文档不读取密钥列表或 Token。
- 使用现有九种 Scope：`bin:read/create/update/delete`、`collection:read/write`、`schema:read/write`、`history:read`。集合成员读取需 `collection:read` 和 `bin:read`；历史恢复及回收站恢复需 `bin:update` 和 `history:read`。
- JavaScript Session 示例使用 `credentials: 'include'`，API Key 示例使用 Bearer。跨站浏览器调用须满足部署的 CORS 配置，不承诺任意跨域调用可用。

### 请求和响应

- Bin 创建、完整 PUT 和路径 PUT 的 JSON 值使用 `{value: ...}` 包装；Merge Patch 请求体是补丁本身，不再包装 value。读取普通 Bin 返回 `{meta, value, etag}`；路径读取返回 `{id, path, value, etag, version}`。
- Bin 创建/内容写入响应包含 `ETag` 和 `X-JSONBin-Version`；版本变化及元数据变化按真实接口说明，不把所有写入都描述为创建 JSON 历史版本。
- Bin 列表返回 `{items,total}`，当前没有文档化分页或服务端搜索；不提供未实现的参数。
- Collection 覆盖列表、创建、详情、成员读取、PATCH、删除；删除集合保留 Bin，并解除集合归属。
- Schema 覆盖列表、创建、详情、PUT、删除和 validate；当前 JSON Schema Draft 7 及引用限制按验证器说明。validate 的不匹配结果仍为 HTTP 200，通过 `valid`/`issues` 判断；绑定 Bin 的不匹配写入为 422。Bin 使用固定模型修订，不暗示修改模型会自动升级已有绑定。
- 补充现有 TTL、回收站列表/恢复/永久删除/批量清理以及活动列表。批量清理 HTTP 200 仍需逐项检查 `results[].status`；活动列表可能返回空页，须以 `nextCursor` 判断是否结束。

### ETag 和局部更新

- 从响应头读取原样 ETag，包括引号；示例始终建议携带 `If-Match`。412 后重新读取并由调用者处理冲突，不提供静默覆盖或自动重试写入逻辑。
- 区分“建议携带”和“接口强制要求”：Bin 普通 PUT/DELETE 当前允许省略；Bin Merge Patch、路径 PUT、历史恢复、Collection/Schema 更新或删除、回收站恢复或永久删除必须携带。Bin 元数据修改 `locked` 或 `expiresAt` 必须携带，其他元数据字段按实际接口允许省略。
- Merge Patch 按 RFC 7396：对象递归合并、对象成员 null 删除、数组整体替换、非对象补丁替换整个值。成功内容写入产生新版本。
- deep-path 先进行 JSON Pointer 转义（`~`→`~0`，`/`→`~1`），再按 URL 路径段编码；读取与写入使用一致的路径。数组从 0 开始，最终 `-` 可追加；父节点必须存在，路径 PUT 最终对象成员可新建；`/value` 读写根 JSON。示例展示普通嵌套路径及特殊字段名。
- 演示局部更新前给出所需结构。不能让示例暗示任意真实 Bin 都已存在 `settings/theme`；模型约束、锁定、到期可能导致写入失败。

### 错误处理

按 HTTP 状态、实际 `error` 值、含义和恢复建议列出代表性错误，至少包括 400、401、403、404、409、412、422、423、428、500、502、503。错误字段来源限于现有路由，不编造统一的错误封装。

`issues`、`requiredScopes` 仅在对应响应存在时说明；`/auth/me` 的未登录响应为 `{authenticated:false}`，不得假设所有 401 都有 error。版本号错误、非法 JSON/路径、模型错误、回收站冲突及服务不可用均注明具体操作条件。全局 500 不暴露内部异常。

## 组件、数据流与依赖

- `features/docs/catalog.ts`：类型化操作和章节目录，字段包含稳定 ID、方法、路径模板、认证、Scope、ETag 策略、演示请求/响应、中文说明。纯静态内容，无业务请求。
- `features/docs/examples.ts`：纯函数，根据目录项、语言、当前 origin 和可选 Bin ID/ETag 生成示例；同一请求描述是方法/URL/headers/body 的唯一来源。
- `features/docs/CodeExample.tsx`：语言切换配套展示、复制及反馈；`DocsPage.tsx` 负责目录和通用内容；`BinApiPanel.tsx` 使用只包含 id/etag/可见性/锁定/到期状态的输入。
- `App.tsx` 接入文档 section/hash/导航；`BinDetailPage.tsx` 接入共享 Bin API 面板；样式沿用项目组件并处理移动端代码块。
- Worker/storage 不依赖前端目录。文档目录不导入服务器密钥存储模块，避免把服务端依赖打入客户端；Scope 名称可在目录内声明并在契约验收中核对。

页面渲染 → 取得当前 origin 和已保存的 Bin 描述 → 纯函数生成示例 → 用户选择语言/复制。文档自身不调用认证、密钥创建或业务修改接口；应用既有数据查询保持原有行为。

## 示例的执行规则和隐私

curl 面向 Bash，使用安全参数引用；JavaScript 使用 fetch 并检查 `response.ok`；Python 使用 requests 并调用 `raise_for_status()`。Python 请求体可使用 JSON 字符串配合 Content-Type，避免把 JSON 的 true/false/null 直接当成 Python 常量。Python requests 是使用者示例依赖，不成为项目依赖。

通用示例使用明确的资源 ID、Token、ETag 和登录用户名/密码占位符；用户需要替换占位符。顺序示例实际捕获响应 ID/ETag，不在后续步骤重用过期值。实际 Bin 页提供已保存 ETag，但提示它只代表当前快照。

不接收真实 Token 输入，不从 Cookie、密钥创建响应、LocalStorage、环境变量或 Bin 内容提取 Secret。文档仅包含固定演示值；测试用随机凭据保存在内存。origin、ID、ETag 在代码生成时按目标语言引用和编码，不能造成脚本或 HTML 注入。

## 验证、审查与交付

1. 示例契约：使用生成器的同一请求描述，在临时 Miniflare/R2 上验证代表性创建/读取/更新、Merge Patch、特殊路径、Collection、Schema、历史恢复、回收站操作和活动页续作；验证 Scope、必需 ETag、412/428、Schema validate 的 200 失败结果。
2. 语言示例：核对 curl/JS/Python 的 URL、方法、头和 body 一致；实际执行代表性 JavaScript 示例，解析/执行代表性 curl 请求及 Python 语法验证；全部业务请求仅发往本地临时测试 Worker。避免仅断言与实现一模一样的字符串。
3. 隐私与动态状态：输入带 Secret canary 的真实 Bin 内容/草稿，证明文档和复制文本只含演示值；实际 Bin ID/ETag、公开/私有提示在保存/刷新后更新。
4. 浏览器：文档导航/刷新、三语言选择和复制、剪贴板失败、Bin API、保留草稿及离页确认、移动端/深色模式、页面没有新增业务写请求。
5. 运行完整 typecheck、生产构建、Worker/客户端测试和 Chromium 浏览器回归；记录真实数量。一次整分支审查重点检查接口准确性、ETag 顺序、路径编码、跨语言引用、Secret 排除和草稿保护；重要发现先复现后修复，无必要的反复派审查。
6. 更新 README、DEVELOPMENT 的 P9 勾选/行为/验收证据。用户此前的 main 本地合并与推送授权继续适用；交付前 fetch 核对远端，验证合并树，不 force push；核对具体提交的 GitHub CI / Workers Builds。没有生产 URL/适用认证时，继续明确生产交互及真实 Cron 手动验收未执行。下一阶段为 P10。

## 书面设计自审

已按 P9 十二项清单及 Bin 动态页签核对范围；没有待定产品决策。认证、ETag 可选/必需、body 包装、Schema validate 状态与 Worker 路由一致；既有接口补充属于文档内容，产品范围仍为 P9。复制失败、动态更新、语言引用和隐私边界均有验收项。书面设计批准后才进入实施计划。
