# P1 数据仓详情页与 JSON 编辑器实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成创建 → 打开 → 查看 → 编辑 → 保存 → 版本增加 → 冲突保护 → 删除的完整中文操作链路。

**Architecture:** 保留 Hono、R2、React Query 和现有 Dashboard。新增独立数据仓详情组件、客户端 API 模块和可刷新保留的数据仓导航；JSON 值写入产生新版本，元数据修改只更新 meta.json。所有存储写入使用条件更新，错误不能静默覆盖本地草稿。

**Tech Stack:** TypeScript、React、React Query、Hono、Zod、Cloudflare Workers/R2/KV；Monaco JSON 编辑器；Node 测试运行器及本地 Worker 集成测试。

**Spec:** 用户已指定并要求执行的 `docs/DEVELOPMENT.md`，远端 main 提交 `6faf6e640355a526bbdebe3d11a4f6c44e0e867f`；本计划覆盖 P0 收尾及 P1，不改变 P2–P12 顺序。

## Global Constraints

- Node.js >=22；复用现有 Cloudflare 运行和本地存储配置。
- R2 是唯一权威数据源；KV 只能保存派生数据。
- versions 下已经写入的版本不得覆盖；恢复和历史浏览留给 P2。
- 删除将元数据移入 trash，版本文件保留。
- 保留 keep_vars: true；不得输出 Secret、Authorization 或 Cookie。
- 界面默认中文，JSON/API/R2/KV/Worker/GitHub/ETag/JSON Schema 保持英文。
- 公共读取行为留给 P6；P1 的可见性修改只更改元数据，不绕过 Session。
- 不增加集合、Schema、API Key 等后续阶段大功能。
- 云环境使用 /workspace/.cloud-config 作为 XDG_CONFIG_HOME；本任务使用现有隔离检出目录。
- 每阶段分别记录本地验证、CI、生产部署及手动验收；未执行的检查不能勾选完成。

## Review Focus

1. 两个客户端同时写入相同下一版本：历史文件不得被覆盖，只有一个请求成功，另一个返回 412。
2. JSON 为 null、false、0、空字符串或数组：必须正常保存；缺少 value 字段必须返回 422。
3. 页面后台重新获取数据或用户切换数据仓：不能无提示丢弃或覆盖本地未保存内容。
4. 名称、描述和可见性变化后：JSON 值与历史版本号不变，旧 ETag 失效。
5. Cookie 过期、网络中断、锁定和资源删除：显示准确中文错误，保留可恢复草稿。

---

### Task 1: 同步文档基线和建立 P0/P1 测试入口

**Files:** 修改 `package.json`、`.github/workflows/v3-ci.yml`、`src/worker/index.ts`、`src/react-app/App.tsx`；新增 `tests/worker-smoke.mjs`。

**Interfaces:** 现有 npm run typecheck/build 保持；新增 npm test 执行真实本地 Worker API 测试。

- [ ] 核对 git status，确认 HEAD 可快进到上述文档提交，保留计划和用户改动后同步该基线；不 reset 或强推。
- [ ] 将当前外部环境 smoke 检查迁入仓库测试，运行正式构建 Worker；测试用随机凭据保存在内存，使用独立可清理的 R2/KV 状态。
- [ ] 添加失败断言：health.version 等于 package.json.version；未经认证的 bins 请求返回 401。
- [ ] 运行测试并记录实际失败，再从 package.json 导入版本信息，移除 Worker health 手写旧版本号。
- [ ] 修复 visibility-pill 状态类名为 private/public，显示文字继续为私有/公开。
- [ ] CI 加入 npm test，运行 typecheck/build/test；只提交已验证的本任务文件。

### Task 2: 可靠的条件写入与 JSON 更新

**Files:** 修改 `src/worker/storage/r2.ts`、`src/worker/storage/bins.ts`、`src/worker/routes/bins.ts`；扩充 `tests/worker-smoke.mjs`。

**Interfaces:** `updateBin(env, id, value, expectedEtag?) -> Promise<BinRecord | null>`；新增 `normalizeEtag(value: string): string`；PUT 返回资源、ETag、X-JSONBin-Version。

- [ ] 写失败测试：旧 ETag 返回 412；引号和 Weak ETag 按规范化值比较；锁定返回 423；不存在返回 404；请求缺少 value 返回 422；null/false/0/空字符串/数组保存后值完全一致。
- [ ] 写并发失败测试：同一 ETag 发起两次不同内容 PUT，恰好一次成功；旧版本内容不变，胜出版本内容与当前 meta 对应。
- [ ] 运行以上测试，确认失败来自现有存储/校验行为。
- [ ] 新版本对象以“不存在才写入”的条件写入；meta 始终以实际读取 ETag 条件更新，包括未传 If-Match 的兼容请求。R2 条件不满足返回 null 时转换为 etag_conflict，不能读取 null.httpEtag 导致 500。
- [ ] 明确处理成功写入版本、meta 条件更新失败留下孤立版本的情形；不得覆盖已有版本，也不得删除可能仍被其他请求引用的文件。
- [ ] 保持所有现有错误码，PUT 输入必须确实拥有 value 字段。
- [ ] 运行集成测试验证版本递增及旧内容不变；提交本任务。

### Task 3: Bin 元数据编辑接口

**Files:** 修改 `src/worker/storage/bins.ts`、`src/worker/routes/bins.ts`；扩充 `tests/worker-smoke.mjs`。

**Interfaces:** 新增 `updateBinMetadata(env: Env, id: string, input: {name?: string; description?: string; visibility?: 'private' | 'public'}, expectedEtag?: string): Promise<BinRecord | null>`；新增 `PATCH /api/v1/bins/:id/meta`。

- [ ] 写失败测试：修改名称/描述/可见性成功，value、currentVersion 和历史对象不变；ETag 改变；旧 ETag 返回 412；空 patch、空白名称、超长字段、未知字段或错误枚举返回 422；未登录返回 401。
- [ ] 运行测试确认新接口尚不存在。
- [ ] 使用 Zod strict object 校验：name 去除两端空白后 1–160 字符，description 最大 1000 字符，visibility 为 private/public，至少一个可编辑字段；拒绝 id/currentVersion/locked 等不可编辑字段。
- [ ] 实现条件写入 meta 并更新 updatedAt，返回当前 BinRecord 和新的 ETag；锁定返回 423，资源不存在返回 404。
- [ ] 测试通过后提交本任务。

### Task 4: 客户端 API 与可刷新导航

**Files:** 新增 `src/react-app/features/bins/api.ts`、`types.ts`、`navigation.ts`；修改 `src/react-app/App.tsx`；新增相关前端逻辑测试。

**Interfaces:** `getBin(id): Promise<BinRecord>`、`saveBin(id, value, etag): Promise<BinRecord>`、`saveBinMetadata(id, input, etag): Promise<BinRecord>`、`removeBin(id): Promise<void>`；BinRecord 包含 meta/value/etag。

- [ ] 写失败测试：GET ETag 保存到客户端记录；PUT/PATCH 发送 If-Match；412/423/401/404/网络错误能区分；null 值不被转为缺失值。
- [ ] 使用现有 React Query；抽出详情所需共享类型和 API 错误，所有认证请求携带 Cookie。
- [ ] 采用 hash 导航 `#/bins/<id>`，保持当前 shell；点击卡片、键盘 Enter/Space、刷新、浏览器前进后退都能定位同一详情。
- [ ] 查询失效使用 bins 和 bin/id；删除返回列表，保存成功同步详情及概览统计。
- [ ] 测试深链接刷新、无效 ID 和创建后打开详情；通过后提交。

### Task 5: JSON 编辑器和详情操作

**Files:** 新增 `src/react-app/features/bins/BinDetailPage.tsx`、`JsonEditor.tsx`、`editor-state.ts`；修改 `src/react-app/styles.css`、`src/react-app/App.tsx`、`package.json`；新增编辑状态测试及浏览器验收脚本。

**Interfaces:** `BinDetailPage({id, onBack, onDeleted})`；`JsonEditor({value, onChange, readOnly})`；编辑状态分别保存服务器记录、草稿及用于保存的 ETag。

- [ ] 写失败测试：非法 JSON 禁止提交；格式化不改变值；后台 refetch 不覆盖草稿；保存失败保留文本；保存成功替换 ETag/版本并清除 dirty 状态。
- [ ] 安装 Monaco React 集成与 Monaco Editor，使用本地 Vite worker，不使用 CDN；动态加载编辑器降低首页负担。
- [ ] 详情顶部展示名称、描述、可见性、ID、版本、大小、更新时间；提供返回、复制 ID 和完整 API URL。
- [ ] Tab 为编辑器、树形视图、历史版本、API、设置。P1 实现编辑器、基础 API 信息与元数据设置；树形/历史明确标记后续阶段，不伪造可用功能。
- [ ] 实现语法校验、格式化、保存按钮、未保存标记、成功反馈、412 冲突与重新加载确认、423 锁定提示、加载/失败/404 状态。
- [ ] 添加导航离开及 beforeunload 草稿保护；处理正在保存时的二次点击、切换和删除。
- [ ] 删除弹窗确认，失败保持详情，成功回列表；元数据使用独立表单，失败保留输入。
- [ ] 处理 Clipboard 不可用时的中文提示；小屏布局和明暗主题沿用现有风格；按钮使用真实 button 或 link。
- [ ] 测试通过后提交本任务。

### Task 6: P1 验收、文档与交付

**Files:** 修改 `docs/DEVELOPMENT.md`、`README.md`；需要时更新 API 文档。

**Interfaces:** P1 的全部条目和验收结果具有实际执行证据；P2 仍保留为下一阶段。

- [ ] 运行 npm run typecheck、npm run build、npm test，核对退出码和执行数量。
- [ ] 本地实际浏览器验收：创建、卡片打开、编辑、保存、刷新、版本 +1、非法 JSON、旧 ETag 412、锁定 423、删除确认、元数据编辑、复制、未保存离开、深链接、移动布局和深色主题。
- [ ] 核对并发测试和存储对象，确认已存在历史版本未被覆盖。
- [ ] 更新开发文档中经过验证的完成项及 API 示例；CI、Cloudflare 部署、生产验收未执行时明确标记待验收。
- [ ] 检查 git diff，清理仅由本任务生成的输出；提交功能和文档。
- [ ] 用现有 GitHub HTTPS 认证检查推送与 CI 操作能力；仅在授权和实际凭据支持时推送，观察真实 CI 与 Cloudflare 部署结果。不得用模拟部署替代验收。
- [ ] 若缺生产发布能力，完成全部本地验证后报告具体外部阻塞；不把 P1 标记全部完成或跳过验收直接进入 P2。

## 后续阶段（按开发文档逐阶段实施）

P1 验收通过后进入 P2 版本历史/Diff/恢复，再依次 P3 集合、P4 Schema、P5 API Key、P6 高级 Bin API、P7 TTL/回收站、P8 活动记录、P9 API 文档、P10 设置/导入导出、P11 搜索/KV 索引、P12 稳定性与发布。每阶段在开始前核对最新状态并制定该阶段计划；本计划不代表后续模块已经实现。

## 执行方式

建议原生执行：由当前助手在本会话逐项实施和验证，保持共享接口及存储并发语义一致。若用户选择子代理执行，再应用 subagent-driven-development 技能。计划经用户审阅并选择执行方式后开始产品代码修改。
