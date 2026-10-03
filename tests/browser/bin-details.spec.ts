import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "browser-test", password: process.env.JSONBIN_TEST_PASSWORD },
  });
  expect(login.status()).toBe(200);
});

async function create(page: Page) {
  const response = await page.request.post("/api/v1/bins", { data: { name: "浏览器验收", value: { initial: true } } });
  expect(response.status()).toBe(201);
  const record = await response.json();
  await page.goto(`/#/bins/${record.meta.id}`);
  await expect(page.getByRole("heading", { name: "浏览器验收", exact: true })).toBeVisible();
  return record;
}
async function edit(page: Page, text: string) {
  await expect(page.locator(".monaco-editor")).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.getByRole("textbox", { name: "JSON 编辑器", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+v");
}

test("数据锁持久化、禁止编辑与删除，单独解锁后可继续保存", async ({ page }) => {
  const record = await create(page), path = `/api/v1/bins/${record.meta.id}`;
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("未保存设置");
  await expect(page.getByRole("button", { name: "锁定数据仓", exact: true })).toBeDisabled();
  await page.getByLabel("名称", { exact: true }).fill("浏览器验收");
  await page.getByRole("button", { name: "锁定数据仓", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("数据仓已锁定");
  const locked = await (await page.request.get(path)).json();
  expect(locked.meta.locked).toBe(true); expect(locked.meta.currentVersion).toBe(1);
  await expect(page.getByLabel("名称", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "删除数据仓", exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.locator(".detail-badges")).toContainText("已锁定");
  await expect(page.getByRole("button", { name: "格式化", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存 JSON", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "解除数据锁", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("数据锁已解除");
  await expect(page.getByLabel("名称", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "删除数据仓", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "编辑器", exact: true }).click();
  await edit(page, '{"unlocked":true}');
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("保存成功");
  const saved = await (await page.request.get(path)).json();
  expect(saved.meta.currentVersion).toBe(2); expect(saved.value).toEqual({ unlocked: true });
});

test("公开设置开放匿名当前读取，切回私有立即收回，API 页提供局部更新说明", async ({ page, playwright }) => {
  const record = await create(page), path = `/api/v1/bins/${record.meta.id}`;
  const anonymous = await playwright.request.newContext({ baseURL: "http://127.0.0.1:5174" });
  try {
    expect((await anonymous.get(path)).status()).toBe(401);
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await page.getByLabel("可见性", { exact: true }).selectOption("public");
    await expect(page.getByRole("tabpanel")).toContainText("匿名读取当前 JSON 和元数据");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator(".detail-notice[role=status]")).toContainText("设置保存成功");
    const response = await anonymous.get(path);
    expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toBe("no-store");
    expect((await response.json()).value).toEqual({ initial: true });
    expect((await (await anonymous.get(path + "/value/initial")).json()).value).toBe(true);
    expect((await anonymous.get(path + "/versions/1")).status()).toBe(401);
    expect((await anonymous.patch(path, { data: { initial: false }, headers: { "If-Match": record.etag } })).status()).toBe(401);
    await page.getByRole("tab", { name: "API", exact: true }).click();
    await expect(page.getByRole("tabpanel")).toContainText("此数据仓已公开");
    await expect(page.getByRole("tabpanel")).toContainText("application/merge-patch+json");
    await expect(page.getByRole("tabpanel")).toContainText("/value/settings/theme");
    await page.getByRole("tab", { name: "设置", exact: true }).click();
    await page.getByLabel("可见性", { exact: true }).selectOption("private");
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存设置", exact: true })).toBeDisabled();
    expect((await anonymous.get(path)).status()).toBe(401);
    expect((await anonymous.get(path + "/value/initial")).status()).toBe(401);
    await page.reload();
    await expect(page.locator(".detail-badges")).toContainText("私有");
  } finally { await anonymous.dispose(); }
});

test("数据锁网络错误与过期 ETag 可重试，不会覆盖远端更新", async ({ page }) => {
  const record = await create(page), path = `/api/v1/bins/${record.meta.id}`;
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.route(`**${path}/meta`, route => route.abort("failed"));
  await page.getByRole("button", { name: "锁定数据仓", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("无法连接");
  await expect(page.getByRole("button", { name: "锁定数据仓", exact: true })).toBeEnabled();
  await page.unroute(`**${path}/meta`);
  expect((await page.request.put(path, { headers: { "If-Match": record.etag }, data: { value: { remote: true } } })).status()).toBe(200);
  await page.getByRole("button", { name: "锁定数据仓", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("数据已被其他请求修改");
  expect((await (await page.request.get(path)).json()).meta.locked).toBe(false);
  await page.getByRole("button", { name: "重新加载最新版本", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).not.toBeVisible();
  await page.getByRole("button", { name: "锁定数据仓", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("数据仓已锁定");
  const current = await (await page.request.get(path)).json();
  expect(current.value).toEqual({ remote: true }); expect(current.meta.currentVersion).toBe(2);
});

test("删除确认限制键盘焦点，取消后恢复焦点，删除中保持弹窗", async ({ page }) => {
  const record = await create(page);
  const trigger = page.getByRole("button", { name: "删除数据仓", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "删除数据仓？" });
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  const confirm = dialog.getByRole("button", { name: "确认删除", exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(confirm).toBeFocused();
  await page.getByRole("button", { name: "返回数据仓", exact: true }).evaluate(element => element.focus());
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await cancel.click();
  await expect(trigger).toBeFocused();

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/bins/${record.meta.id}`, async route => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    await gate;
    await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"internal_server_error"}' });
  });
  try {
    await trigger.click();
    await confirm.click();
    await expect(dialog.getByRole("button", { name: "正在删除…" })).toBeDisabled();
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally { release(); }
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".detail-error[role=alert]")).toBeVisible();
  await page.unroute(`**/api/v1/bins/${record.meta.id}`);
  expect((await page.request.delete(`/api/v1/bins/${record.meta.id}`)).status()).toBe(200);
});

test("详情页支持编辑、保存、刷新和元数据修改", async ({ page }) => {
  const record = await create(page);
  await edit(page, '{"saved":true}');
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("保存成功");
  await page.reload();
  await expect(page.getByRole("heading", { name: "浏览器验收", exact: true })).toBeVisible();
  const stored = await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json();
  expect(stored.value).toEqual({ saved: true }); expect(stored.meta.currentVersion).toBe(2);
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("已改名");
  await page.getByLabel("描述", { exact: true }).fill("详情页设置");
  await page.getByLabel("可见性", { exact: true }).selectOption("public");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已改名", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json()).meta.currentVersion).toBe(2);
  await page.getByRole("button", { name: "删除数据仓", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page).toHaveURL(/#\/bins$/);
  expect((await page.request.get(`/api/v1/bins/${record.meta.id}`)).status()).toBe(404);
});

test("非法 JSON 和旧 ETag 不会静默覆盖内容", async ({ page }) => {
  const record = await create(page);
  await edit(page, "{bad");
  await expect(page.getByRole("button", { name: "保存 JSON", exact: true })).toBeDisabled();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("JSON 语法");
  await edit(page, '{"local":true}');
  const response = await page.request.put(`/api/v1/bins/${record.meta.id}`, {
    headers: { "If-Match": record.etag }, data: { value: { remote: true } },
  });
  expect(response.status()).toBe(200);
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("其他请求修改");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json()).value).toEqual({ remote: true });
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "返回数据仓", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(record.meta.id));
});

test("列表创建后能打开详情，手机和深色界面可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/bins");
  await page.getByRole("button", { name: "新建数据仓", exact: true }).first().click();
  await page.getByLabel("名称", { exact: true }).fill("移动端数据仓");
  await page.getByRole("button", { name: "新建数据仓", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "移动端数据仓", exact: true, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#\/bins\/[^/]+$/);
  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "保存 JSON", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("锁定、网络中断和登录过期时保留草稿", async ({ page }) => {
  const record = await create(page);
  await edit(page, '{"draft":true}');
  const url = `**/api/v1/bins/${record.meta.id}`;
  await page.route(url, async route => {
    if (route.request().method() === "PUT") await route.fulfill({ status: 423, contentType: "application/json", body: '{"error":"bin_locked"}' });
    else await route.continue();
  });
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("已锁定");
  await page.unroute(url);
  await page.route(url, async route => {
    if (route.request().method() === "PUT") await route.abort("connectionfailed"); else await route.continue();
  });
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("无法连接");
  await page.unroute(url);
  await page.request.post("/api/v1/auth/logout");
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("登录已过期");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("draft");
});

test("格式化、复制、键盘打开卡片与前进后退", async ({ page }) => {
  const record = await create(page);
  await edit(page, '{"format":true}');
  await page.getByRole("button", { name: "格式化", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("format");
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("保存成功");
  await page.getByRole("button", { name: "复制 Bin ID", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(record.meta.id);
  await page.getByRole("button", { name: "复制 API 地址", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`/api/v1/bins/${record.meta.id}`);
  await page.getByRole("button", { name: "返回数据仓", exact: true }).click();
  const card = page.getByRole("button", { name: "打开数据仓 浏览器验收", exact: true }).filter({ hasText: record.meta.id });
  await card.focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(record.meta.id));
  await page.goBack(); await expect(page).toHaveURL(/#\/bins$/);
  await page.goForward(); await expect(page.getByRole("heading", { name: "浏览器验收", exact: true })).toBeVisible();
});

test("登录过期后网络重连不会丢弃未保存内容", async ({ page }) => {
  await page.clock.install();
  await create(page);
  await edit(page, '{"draft":true}');
  await page.request.post("/api/v1/auth/logout");
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.clock.fastForward(16_000);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "浏览器验收", exact: true })).toBeVisible();
  // Wait for any reconnect request to settle, then verify that the editor survived.
  await page.getByRole("button", { name: "保存 JSON", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("登录已过期");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("draft");
});

test("旧读取请求不能覆盖保存成功后的元数据", async ({ page }) => {
  await page.clock.install();
  const record = await create(page);
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>(resolve => { intercepted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/bins/${record.meta.id}`, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    intercepted(); await gate;
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: record.etag }, body: JSON.stringify(record) }).catch(() => {});
  });
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.clock.fastForward(16_000);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await pending;
  await page.getByLabel("名称", { exact: true }).fill("已保存的新名称");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已保存的新名称", exact: true })).toBeVisible();
  release();
  // Let a completed/aborted delayed response settle before checking the rendered baseline.
  await page.waitForTimeout(250);
  await expect(page.getByRole("heading", { name: "已保存的新名称", exact: true })).toBeVisible();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("已保存的新名称");
});

test("离开页面后完成的删除不能带走另一数据仓的草稿", async ({ page }) => {
  const first = await create(page);
  const second = await (await page.request.post("/api/v1/bins", { data: { name: "第二数据仓", value: {} } })).json();
  let release!: () => void;
  let intercepted!: () => void;
  const pending = new Promise<void>(resolve => { intercepted = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/v1/bins/${first.meta.id}`, async route => {
    if (route.request().method() !== "DELETE") { await route.continue(); return; }
    intercepted(); await gate; await route.continue();
  });
  await page.getByRole("button", { name: "删除数据仓", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await pending;
  page.once("dialog", dialog => dialog.accept());
  await page.evaluate(id => { location.hash = '#/bins/' + id; }, second.meta.id);
  await expect(page.getByRole("heading", { name: "第二数据仓", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill("保留第二份草稿");
  const deleted = page.waitForResponse(response => response.url().endsWith(first.meta.id) && response.request().method() === "DELETE");
  release(); await deleted;
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(new RegExp(second.meta.id));
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("保留第二份草稿");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
});

test("历史版本支持查看、任意两版 Diff 和追加式恢复", async ({ page }) => {
  const first = await create(page);
  const path = `/api/v1/bins/${first.meta.id}`;
  const secondResponse = await page.request.put(path, { headers: { "If-Match": first.etag }, data: { value: { changed: "second", added: true } } });
  expect(secondResponse.status()).toBe(200);
  const second = await secondResponse.json();
  expect((await page.request.put(path, { headers: { "If-Match": second.etag }, data: { value: 0 } })).status()).toBe(200);
  await page.reload();
  await page.getByRole("tab", { name: "历史版本", exact: true }).click();
  await expect(page.getByText("共 3 个版本 · 当前 v3", { exact: true })).toBeVisible();
  const table = page.getByRole("table", { name: "已保存的版本" });
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table).toContainText("B");
  await page.getByLabel("原始版本", { exact: true }).selectOption("1");
  await page.getByLabel("对比版本", { exact: true }).selectOption("2");
  await page.getByText("查看 v1 的 JSON 内容", { exact: true }).click();
  await expect(page.getByLabel("历史版本内容", { exact: true })).toContainText('"initial": true');
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await expect(page.locator(".monaco-diff-editor .view-lines")).toContainText(["initial", "changed"]);
  await expect(page.locator(".monaco-diff-editor .line-delete, .monaco-diff-editor .char-delete").first()).toBeVisible();
  await expect(page.locator(".monaco-diff-editor .line-insert, .monaco-diff-editor .char-insert").first()).toBeVisible();
  await page.getByLabel("原始版本", { exact: true }).selectOption("3");
  await expect(page.getByLabel("历史版本内容", { exact: true })).toHaveText("0");
  await page.getByLabel("原始版本", { exact: true }).selectOption("1");
  await page.getByLabel("对比版本", { exact: true }).selectOption("current");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "恢复 v1", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("生成新版本 v4");
  await expect(page.getByText("共 4 个版本 · 当前 v4", { exact: true })).toBeVisible();
  const restored = await (await page.request.get(path)).json();
  expect(restored.meta.currentVersion).toBe(4); expect(restored.value).toEqual(first.value);
  expect((await (await page.request.get(path + '/versions/1')).json()).value).toEqual(first.value);
  expect((await (await page.request.get(path + '/versions/2')).json()).value).toEqual(second.value);
  await page.reload();
  await page.getByRole("tab", { name: "历史版本", exact: true }).click();
  await expect(page.getByText("共 4 个版本 · 当前 v4", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await page.request.delete(path)).status()).toBe(200);
});

test("恢复取消和并发冲突保留草稿，确认后恢复为新版本", async ({ page }) => {
  const first = await create(page);
  const path = `/api/v1/bins/${first.meta.id}`;
  await edit(page, '{"draft":true}');
  await page.getByRole("tab", { name: "历史版本", exact: true }).click();
  const restore = page.getByRole("button", { name: "恢复 v1", exact: true });
  await expect(restore).toBeEnabled();
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("未保存"); await dialog.dismiss(); });
  await restore.click();
  expect((await (await page.request.get(path + '/versions')).json()).total).toBe(1);
  const remote = await page.request.put(path, { headers: { "If-Match": first.etag }, data: { value: { remote: true } } });
  expect(remote.status()).toBe(200);
  page.once("dialog", dialog => dialog.accept());
  await restore.click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("其他请求修改");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "编辑器", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("draft");
  expect((await (await page.request.get(path)).json()).value).toEqual({ remote: true });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(page.getByText("未保存", { exact: true })).not.toBeVisible();
  await edit(page, '{"discard":true}');
  await page.getByRole("tab", { name: "历史版本", exact: true }).click();
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("未保存"); await dialog.accept(); });
  await restore.click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("生成新版本 v3");
  await expect(page.getByText("未保存", { exact: true })).not.toBeVisible();
  await page.getByRole("tab", { name: "编辑器", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("initial");
  expect((await page.request.delete(path)).status()).toBe(200);
});

test("历史加载可重试，恢复网络失败、锁定和登录过期不丢弃草稿", async ({ page }) => {
  const first = await create(page);
  const path = `/api/v1/bins/${first.meta.id}`;
  await edit(page, '{"draft":true}');
  await page.route(`**${path}/versions`, route => route.abort("connectionfailed"));
  await page.getByRole("tab", { name: "历史版本", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "历史版本" }).getByRole("alert")).toContainText("无法连接");
  await page.unroute(`**${path}/versions`);
  await page.getByRole("button", { name: "重试版本历史", exact: true }).click();
  const restore = page.getByRole("button", { name: "恢复 v1", exact: true });
  await expect(restore).toBeEnabled();
  const restoreUrl = `**${path}/versions/1/restore`;
  await page.route(restoreUrl, route => route.abort("connectionfailed"));
  page.once("dialog", dialog => dialog.accept()); await restore.click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("无法连接");
  await page.unroute(restoreUrl);
  await page.route(restoreUrl, route => route.fulfill({ status: 423, contentType: "application/json", body: '{"error":"bin_locked"}' }));
  page.once("dialog", dialog => dialog.accept()); await restore.click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("已锁定");
  await page.unroute(restoreUrl);
  await page.request.post("/api/v1/auth/logout");
  page.once("dialog", dialog => dialog.accept()); await restore.click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("登录已过期");
  await expect(page.getByText("未保存", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "编辑器", exact: true }).click();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("draft");
});
