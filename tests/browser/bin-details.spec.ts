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
