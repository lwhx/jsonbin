# JSONBin v3.1 结构化表单与桌面交互实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复生产复现的桌面交互问题，并把结构化表单改造成无损、可递归、键盘可用的 JSON 对象/数组编辑器。

**架构：** 先把表单值建模、递归编辑和表单草稿状态从 `JsonFormEditor` 的局部合法 JSON 输出中分离，使非法草稿也能参与详情页的 dirty 生命周期。随后以小型聚焦组件实现递归对象/数组、焦点恢复和只读呈现；最后修正详情 Tabs、创建弹窗、导入草稿、浏览器历史和认证错误状态。保持现有 REST API 与 R2 数据模型不变。

**技术栈：** React 19、TypeScript、TanStack Query、Vite、Playwright、Node test

**规格：** `docs/superpowers/specs/2026-10-05-v3-1-hardening-design.md` 的 §3.1、§3.2 与相关完成标准。

---

## 文件结构

### 创建

- `src/react-app/features/bins/json-form-model.ts` — JSON 表单节点、严格数字解析、无原型对象重建、递归更新和校验。
- `src/react-app/features/bins/JsonValueField.tsx` — 标量与递归对象/数组的行内编辑器。
- `tests/json-form-model.test.mjs` — 无 DOM 的数据完整性和边界测试。

### 修改

- `src/react-app/features/bins/JsonFormEditor.tsx` — 根对象表单编排、非法草稿状态、批量输入、焦点管理和只读模式。
- `src/react-app/features/bins/BinDetailPage.tsx` — 表单草稿生命周期、Tab 切换保护和标准键盘 Tabs。
- `src/react-app/styles.css` — 递归表单、textarea、只读状态和窄桌面布局。
- `src/react-app/App.tsx` — 创建弹窗迟到结果、认证错误、退出缓存和历史导航修复。
- `src/react-app/features/settings/SettingsPage.tsx` — 合并导入 dirty/busy 状态。
- `src/react-app/features/settings/ImportPanel.tsx` — 暴露准备态草稿和完成/重置语义。
- `tests/browser/bin-details.spec.ts` — 表单、Tabs、历史和创建迟到响应回归。
- `tests/browser/settings.spec.ts` — 导入草稿离页保护。
- `tests/client.test.mjs` — 纯状态 helper 回归，如拆出 helper 则在此测试。
- `docs/DEVELOPMENT.md` — 本工作包实现、验证和已知边界。

---

### 任务 1：建立无损 JSON 表单模型

**文件：**
- 创建：`src/react-app/features/bins/json-form-model.ts`
- 创建：`tests/json-form-model.test.mjs`

- [ ] **步骤 1：编写失败测试：原型键与空白键无损往返**

在 `tests/json-form-model.test.mjs` 导入构建后的表单模型，断言：

```js
const value = Object.fromEntries([
  ["__proto__", { kept: true }],
  ["constructor", "literal"],
  ["", "empty"],
  [" padded ", 1],
  ["padded", 2],
]);
const nodes = nodesFromObject(value);
expect(objectFromNodes(nodes)).toEqual({ valid: true, value });
expect(Object.hasOwn(objectFromNodes(nodes).value, "__proto__")).toBe(true);
```

- [ ] **步骤 2：运行 RED**

运行：

```bash
npm run build && node --test tests/json-form-model.test.mjs
```

预期：FAIL，模块或导出函数不存在。

- [ ] **步骤 3：实现最小节点模型和无损对象构建**

在 `json-form-model.ts` 定义：

```ts
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type JsonNode = {
  id: string;
  key?: string;
  type: "string" | "number" | "boolean" | "null" | "object" | "array";
  raw: string;
  children: JsonNode[];
};
export type FormResult =
  | { valid: true; value: JsonValue }
  | { valid: false; issues: FormIssue[] };
```

实现 `nodesFromObject()`、`valueFromNode()`、`objectFromNodes()`。对象重建使用 `Object.fromEntries` 或 `Object.create(null)` 后定义自有属性，不调用 `trim()`。

- [ ] **步骤 4：运行 GREEN**

运行同一步骤 2；预期所有原型键与空白键断言通过。

- [ ] **步骤 5：编写失败测试：严格数字和多行字符串**

覆盖：

```js
expect(parseNumber("0")).toEqual({ valid: true, value: 0 });
expect(parseNumber("-1.25e+3")).toEqual({ valid: true, value: -1250 });
for (const invalid of ["", "01", "1.", "0x10", "NaN", "Infinity", "9007199254740993"]) {
  expect(parseNumber(invalid).valid).toBe(false);
}
expect(valueFromNode(nodesFromObject({ text: " a\nb\t " })[0]).value).toBe(" a\nb\t ");
```

- [ ] **步骤 6：运行 RED，确认当前宽松转换被捕获**

预期：严格数字相关断言失败。

- [ ] **步骤 7：实现严格数字解析与递归类型切换默认值**

实现 JSON 数字正则、安全整数判断、有限性与序列化往返检查；实现 `newNode(type)` 和 `changeNodeType(node, type)`，对象/数组默认值为 `[]` children，标量默认 raw 分别为 `""`、`"0"`、`"true"`、`""`。

- [ ] **步骤 8：增加递归数组/对象和深度边界测试并通过**

覆盖混合数组、嵌套对象、上移/下移、删除、8 层展开边界只影响 UI 展开而不改变值。

- [ ] **步骤 9：Commit**

```bash
git add src/react-app/features/bins/json-form-model.ts tests/json-form-model.test.mjs
git commit -m "fix(表单): 保证 JSON 值无损往返"
```

---

### 任务 2：实现递归对象与数组行内编辑器

**文件：**
- 创建：`src/react-app/features/bins/JsonValueField.tsx`
- 修改：`src/react-app/features/bins/JsonFormEditor.tsx`
- 修改：`src/react-app/styles.css`
- 测试：`tests/browser/bin-details.spec.ts`

- [ ] **步骤 1：编写失败浏览器测试：空数组和混合类型**

新增测试创建：

```json
{"prices":[]}
```

操作并断言：展开 `prices`，依次添加数字 `19.9`、文本 `会员价`、布尔 `false`、null、对象和数组；对象内添加 `currency="CNY"`，嵌套数组添加数字 `1`；保存后 Worker 值严格相等。

- [ ] **步骤 2：运行 RED**

```bash
npx playwright test tests/browser/bin-details.spec.ts --grep "表单数组支持混合类型"
```

预期：FAIL，页面没有展开和添加数组项控件。

- [ ] **步骤 3：实现 `JsonValueField` 最小递归编辑**

组件接口：

```ts
type Props = {
  node: JsonNode;
  depth: number;
  pathLabel: string;
  readOnly: boolean;
  onChange: (node: JsonNode) => void;
  onDelete?: () => void;
  onMove?: (direction: -1 | 1) => void;
  moveUpDisabled?: boolean;
  moveDownDisabled?: boolean;
};
```

标量渲染 input/textarea/select/static null；结构值渲染带 `aria-expanded` 的摘要按钮和行内 children。depth >= 8 时只显示完整摘要和切换编辑器提示，不删除 children。

- [ ] **步骤 4：运行 GREEN**

运行步骤 2；预期保存值完全匹配。

- [ ] **步骤 5：编写失败测试：排序、删除和 JSON 双向同步**

断言数组 `["a","b","c"]` 将第三项上移两次得到 `["c","a","b"]`，删除 `a` 得到 `["c","b"]`；切至编辑器显示相同值；编辑器改成嵌套值后返回表单显示更新。

- [ ] **步骤 6：实现稳定 ID、排序、删除与同步并通过**

节点 ID 只用于 UI，不进入 JSON；每次外部合法 `sourceText` 变化重建节点。自发合法输出用 emission token 避免无意义重建，但不能跳过不同内容。

- [ ] **步骤 7：实现样式与 720px/200% 回归**

新增 `.json-value-children`、`.json-value-row`、`.json-form-multiline`、`.json-form-readonly`。在容器宽度不足时切单列；不依赖仅 `max-width:700px` 的 viewport 媒体查询。浏览器测试把视口设为 720px，断言所有删除/排序按钮 box 均在 panel 边界内；再用 CDP 或 CSS 模拟 200% 缩放验证无裁切。

- [ ] **步骤 8：Commit**

```bash
git add src/react-app/features/bins/JsonValueField.tsx src/react-app/features/bins/JsonFormEditor.tsx src/react-app/styles.css tests/browser/bin-details.spec.ts
git commit -m "feat(表单): 支持递归数组与对象编辑"
```

---

### 任务 3：保护非法表单草稿

**文件：**
- 修改：`src/react-app/features/bins/JsonFormEditor.tsx`
- 修改：`src/react-app/features/bins/BinDetailPage.tsx`
- 测试：`tests/browser/bin-details.spec.ts`

- [ ] **步骤 1：编写失败测试：非法行仍触发未保存保护**

场景：添加空键行、制造重复键和非法数字。分别点击返回、切到编辑器、重新加载、退出登录；断言出现站内确认且取消后行内容、错误和焦点仍在。

- [ ] **步骤 2：运行 RED**

预期：当前空键行切 Tab 后直接消失，离页没有确认。

- [ ] **步骤 3：提升表单状态边界**

将 `JsonFormEditor` 改为显式回调：

```ts
onStateChange({
  text: valid ? JSON.stringify(value, null, 2) : null,
  dirty: boolean,
  valid: boolean,
  issues: FormIssue[],
});
```

父级保存 `formSession`，`dirty` 合并 JSON text、metadata 和表单行 dirty。合法时同步 `draft.text`；非法时保留上一份合法 `draft.text`，但页面级 dirty 为真。

- [ ] **步骤 4：实现 Tab 切换策略**

点击其他 Tab 时，若表单 session dirty 且 invalid，弹窗提供：

- `继续修正`：留在表单；
- `放弃并切换`：丢弃表单 session，以 `draft.text` 重建并切换。

合法草稿直接同步后切换，不弹窗。

- [ ] **步骤 5：运行 GREEN 并覆盖自动刷新**

注入慢/迟到 GET，断言合法和非法表单 session 均不被替换。

- [ ] **步骤 6：Commit**

```bash
git add src/react-app/features/bins/JsonFormEditor.tsx src/react-app/features/bins/BinDetailPage.tsx tests/browser/bin-details.spec.ts
git commit -m "fix(表单): 保护无效状态下的未保存输入"
```

---

### 任务 4：补齐表单焦点、语义和只读模式

**文件：**
- 修改：`src/react-app/features/bins/JsonValueField.tsx`
- 修改：`src/react-app/features/bins/JsonFormEditor.tsx`
- 修改：`src/react-app/styles.css`
- 测试：`tests/browser/bin-details.spec.ts`

- [ ] **步骤 1：编写失败测试：新增/删除焦点**

断言新增根字段或数组项后 `document.activeElement` 是新项第一个输入；删除中间项后聚焦下一项；删除末项后聚焦上一项；删除唯一项后聚焦添加按钮。

- [ ] **步骤 2：运行 RED**

预期：当前实现焦点落在原按钮或 `<body>`。

- [ ] **步骤 3：实现请求式焦点恢复**

用 `pendingFocusId` ref/state，在 DOM 提交后的 layout effect 中聚焦目标；不要依赖数组索引。删除前计算下一稳定节点 ID。

- [ ] **步骤 4：编写失败测试：行语义与错误关联**

断言每行/项有唯一 group name；重复键、非法数字输入设置 `aria-invalid=true`，其 `aria-errormessage` 指向可见错误；无效修正后移除属性。

- [ ] **步骤 5：实现语义和错误映射并通过**

`FormIssue` 包含 `nodeId`、`field`、`message`。错误 ID 由组件实例 + node ID + field 组成。顶层与嵌套控件名称包含路径，例如“价格 数组第 2 项 数字值”。

- [ ] **步骤 6：编写失败测试：锁定可检查**

锁定后断言值仍可通过 Tab 聚焦、选择和复制；修改/删除/排序/新增不可执行；表单存在 `role=status` 的只读说明。

- [ ] **步骤 7：实现只读呈现并通过**

文本 input/textarea 使用 `readOnly`；select 改为带标签的静态文本；操作按钮 disabled。不得让只读值从可访问树消失。

- [ ] **步骤 8：Commit**

```bash
git add src/react-app/features/bins/JsonValueField.tsx src/react-app/features/bins/JsonFormEditor.tsx src/react-app/styles.css tests/browser/bin-details.spec.ts
git commit -m "fix(表单): 完善焦点错误语义和只读状态"
```

---

### 任务 5：修复批量添加保真与焦点

**文件：**
- 修改：`src/react-app/features/bins/JsonFormEditor.tsx`
- 测试：`tests/browser/bin-details.spec.ts`

- [ ] **步骤 1：编写失败测试**

输入：

```text
space=␠␠保留两端空格␠␠
equals=a=b
␠padded key␠=value
```

其中 `␠` 表示一个普通空格。断言值分别为 `"  保留两端空格  "`、`"a=b"`，键保留原始空白；失败行不添加任何字段。打开后 textarea 获得焦点，取消后焦点回到“批量添加”。

- [ ] **步骤 2：运行 RED**

预期：当前 `trim()` 删除空白，按钮没有展开状态，焦点不移动。

- [ ] **步骤 3：实现批量解析器**

仅用 trim 判断整行是否为空；使用第一个 tab，否则第一个 `=` 作为分隔符；键和值都保留原始切片。先解析全部行、检查原始键重复，再一次提交。按钮设置 `aria-expanded`、`aria-controls`，通过 effect 管理打开/关闭焦点。

- [ ] **步骤 4：运行 GREEN 并回归现有 Excel 两列场景**

确保 `地方\tdf` 仍生成预期字段。

- [ ] **步骤 5：Commit**

```bash
git add src/react-app/features/bins/JsonFormEditor.tsx tests/browser/bin-details.spec.ts
git commit -m "fix(表单): 保留批量输入的原始文本"
```

---

### 任务 6：修复创建弹窗和认证缓存状态

**文件：**
- 修改：`src/react-app/App.tsx`
- 测试：`tests/browser/bin-details.spec.ts`
- 测试：`tests/browser/dialogs.spec.ts`

- [ ] **步骤 1：编写失败测试：创建 pending 时不能关闭**

拦截 POST `/api/v1/bins`，提交后断言右上关闭、取消、Escape、遮罩均不能关闭；迟到响应在组件卸载/退出后不得跳转。

- [ ] **步骤 2：运行 RED**

预期：当前取消按钮启用，迟到成功改变 hash。

- [ ] **步骤 3：实现保存期控制和 generation**

显式关闭/取消按钮使用 `disabled={saving}`；提交捕获 generation，`onCreated` 前检查 mounted、generation 和未取消状态。取消只在请求尚未提交时中止等待；界面不声称撤销服务端写入。

- [ ] **步骤 4：编写并修复认证错误测试**

`/auth/me` 500/网络错误显示“无法检查登录状态”和重试，不显示登录表单；`/auth/config` 失败显示配置错误，不推断密码登录开启。

- [ ] **步骤 5：退出清空缓存测试与实现**

预加载 `bin-version` 等 Infinity 查询，退出后断言 `queryClient` 不含认证业务数据；实现取消所有查询后 `queryClient.clear()`。

- [ ] **步骤 6：Commit**

```bash
git add src/react-app/App.tsx tests/browser/bin-details.spec.ts tests/browser/dialogs.spec.ts
git commit -m "fix(网页): 阻止创建迟到响应污染导航"
```

---

### 任务 7：修复导入草稿保护

**文件：**
- 修改：`src/react-app/features/settings/ImportPanel.tsx`
- 修改：`src/react-app/features/settings/SettingsPage.tsx`
- 测试：`tests/browser/settings.spec.ts`

- [ ] **步骤 1：编写失败测试**

选择普通 JSON，等待预览完成并修改目标名称；导航、退出和刷新均应确认。显式 reset 或成功完成后不再确认。备份预览执行相同测试。

- [ ] **步骤 2：运行 RED**

预期：当前 `busy=false` 后可直接离开。

- [ ] **步骤 3：拆分 `onBusyChange` 与 `onDirtyChange`**

`dirty = items.length > 0 || backup !== null`，读取/传输另用 busy。`SettingsPage.guarded` 合并 defaults dirty、import dirty/busy、export busy 和 index busy。

- [ ] **步骤 4：明确完成和重置语义并通过**

普通导入完成后保留结果但清除输入草稿；恢复完成或停止等待时，若仍可续作的 backup 保持 dirty，只有显式重置/改选或全部结果终态后清除。

- [ ] **步骤 5：Commit**

```bash
git add src/react-app/features/settings/ImportPanel.tsx src/react-app/features/settings/SettingsPage.tsx tests/browser/settings.spec.ts
git commit -m "fix(设置): 保护已准备的导入草稿"
```

---

### 任务 8：修复浏览器历史与标准 Tabs

**文件：**
- 修改：`src/react-app/App.tsx`
- 修改：`src/react-app/features/bins/BinDetailPage.tsx`
- 测试：`tests/browser/bin-details.spec.ts`

- [ ] **步骤 1：编写失败测试：取消 Back 后不丢列表历史**

列表 → 详情 → 制造草稿 → Back → 继续编辑 → Back → 放弃并离开，最终 URL 必须是 `#/bins`，不能回到概览。

- [ ] **步骤 2：运行 RED**

预期：当前最终跳到概览。

- [ ] **步骤 3：实现受控 history entry 索引**

每个站内 push 写 `{jsonbinIndex}`；监听 pop 计算方向。取消时设置 suppress 标记并 `history.go(-delta)` 回滚，回滚事件只恢复 route，不再次弹窗。删除成功等替换保持当前索引。

- [ ] **步骤 4：编写失败测试：WAI-ARIA Tabs 键盘模式**

断言 Tab 只停靠选中标签；ArrowRight/Left 循环切换并聚焦，Home/End 跳首尾；tab 的 `aria-controls` 指向 panel，panel 的 `aria-labelledby` 指向选中 tab。

- [ ] **步骤 5：实现 Tabs 并通过**

为每个 tab 生成稳定 DOM ID；键盘切换调用统一 `requestTabChange`，确保非法表单保护仍生效。

- [ ] **步骤 6：Commit**

```bash
git add src/react-app/App.tsx src/react-app/features/bins/BinDetailPage.tsx tests/browser/bin-details.spec.ts
git commit -m "fix(导航): 保留取消返回后的历史位置"
```

---

### 任务 9：拆分页面组件并设置入口包预算

**文件：**
- 创建：`src/react-app/shell/AuthenticatedShell.tsx`
- 创建：`src/react-app/features/overview/Overview.tsx`
- 创建：`src/react-app/features/bins/BinsPage.tsx`
- 创建：`src/react-app/features/bins/CreateBinDialog.tsx`
- 修改：`src/react-app/App.tsx`
- 修改：`vite.config.ts`
- 创建：`scripts/check-bundle-budget.mjs`
- 修改：`package.json`
- 测试：`tests/assets.test.mjs`

- [ ] **步骤 1：记录当前行为和入口包失败预算**

新增测试读取 manifest，要求初始入口 raw <= 450 KiB、gzip <= 140 KiB。当前 556 KiB / 166 KiB 应失败。

- [ ] **步骤 2：按职责移动现有组件，不改变行为**

先移动 `Overview`、`BinsPage`、`CreateBinDialog`，再移动 AuthenticatedShell。每次移动后运行 typecheck 和现有浏览器定向测试。

- [ ] **步骤 3：页面 lazy-load**

Settings、Docs、Activity、Keys、Trash、Schemas、Collections 和 Search 用 `React.lazy`；为页面区统一 Suspense fallback。保持当前 hash URL 和 dirty guard。

- [ ] **步骤 4：运行 bundle budget GREEN**

```bash
npm run build
npm run check:bundle
```

若仍超预算，只调整页面拆分边界，不把 Monaco 计入初始入口，也不做无关依赖替换。

- [ ] **步骤 5：Commit**

```bash
git add src/react-app App.tsx vite.config.ts scripts/check-bundle-budget.mjs package.json tests/assets.test.mjs
git commit -m "perf(网页): 按页面拆分初始前端包"
```

---

### 任务 10：桌面网页工作包完整验证与文档

**文件：**
- 修改：`docs/DEVELOPMENT.md`
- 可能修改：`.github/workflows/v3-ci.yml`（仅加入已存在的 bundle 命令）

- [ ] **步骤 1：运行静态检查**

```bash
npm run typecheck
npm run build
npm run check:bundle
git diff --check
```

预期全部 exit 0，构建无新的 warning。

- [ ] **步骤 2：运行 Node 测试**

```bash
node --test tests/json-form-model.test.mjs
npm test
```

预期 0 failed。若 Windows 仍因既有 python/curl 问题失败，不在本工作包掩盖；转入测试可移植性计划处理后再宣称全绿。

- [ ] **步骤 3：运行 Chromium 定向与全量验收**

```bash
npm run test:browser -- tests/browser/bin-details.spec.ts tests/browser/settings.spec.ts tests/browser/dialogs.spec.ts
npm run test:browser
```

预期所有用例通过、0 skip。

- [ ] **步骤 4：当前登录浏览器生产前只读复核**

在本地/预览环境验证创建迟到响应、表单数组、非法草稿、导入草稿和历史；不得在生产站点执行写入。生产仅在后续明确部署授权后验证。

- [ ] **步骤 5：更新 DEVELOPMENT**

记录每条修复、实际测试数量、尚未进入本工作包的后端计划，以及生产仍未部署这一事实。

- [ ] **步骤 6：请求独立代码审查**

重点审查数据无损、非法草稿状态、递归组件、键盘焦点和历史回滚；修复所有真实缺陷后重跑完整门禁。

- [ ] **步骤 7：Commit**

```bash
git add docs/DEVELOPMENT.md .github/workflows/v3-ci.yml
git commit -m "docs(v3.1): 记录桌面网页加固验收"
```
