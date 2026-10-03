import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/v1/auth/login", { data: { username: "browser-test", password: process.env.JSONBIN_TEST_PASSWORD } });
  expect(response.status()).toBe(200);
});
async function create(page: Page, name: string, extras = {}) {
  const response = await page.request.post("/api/v1/bins", { data: { name, value: { retained: true }, ...extras } });
  expect(response.status()).toBe(201); return response.json();
}
async function deleted(page: Page, name: string) {
  const bin = await create(page, name);
  expect((await page.request.delete(`/api/v1/bins/${bin.meta.id}`, { headers: { "If-Match": bin.etag } })).status()).toBe(200);
  return bin;
}
async function item(page: Page, id: string) {
  return (await (await page.request.get("/api/v1/trash/bins")).json()).items.find((entry: { meta: { id: string } }) => entry.meta.id === id);
}

test("创建与设置支持 TTL、剩余时间、清除期限和过期时间校验", async ({ page }) => {
  await page.goto("/#/bins");
  await page.getByRole("button", { name: "新建数据仓", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "新建数据仓" });
  await dialog.getByLabel("名称", { exact: true }).fill("TTL 创建验收");
  await dialog.getByLabel("到期时间", { exact: true }).fill("2099-01-01T12:00");
  await dialog.getByRole("button", { name: "新建数据仓", exact: true }).click();
  await expect(page.getByRole("heading", { name: "TTL 创建验收", exact: true })).toBeVisible();
  await expect(page.locator(".detail-info")).toContainText("剩余");
  const id = new URL(page.url()).hash.split("/").at(-1)!;
  const original = await (await page.request.get(`/api/v1/bins/${id}`)).json();
  expect(original.meta.expiresAt).toBe(await page.evaluate(() => new Date("2099-01-01T12:00:00").toISOString()));
  await page.reload();
  await page.getByRole("tab", { name: "设置", exact: true }).click();
  await expect(page.getByLabel("到期时间", { exact: true })).toHaveValue("2099-01-01T12:00");
  await page.getByLabel("到期时间", { exact: true }).fill("2000-01-01T12:00");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".detail-error[role=alert]")).toContainText("到期时间必须晚于当前时间");
  expect((await (await page.request.get(`/api/v1/bins/${id}`)).json()).etag).toBe(original.etag);
  await page.getByLabel("到期时间", { exact: true }).fill("");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("设置保存成功");
  await expect(page.locator(".detail-info")).toContainText("永不过期");
  const current = await (await page.request.get(`/api/v1/bins/${id}`)).json();
  expect(current.meta.expiresAt).toBeNull(); expect(current.meta.currentVersion).toBe(1);
  await page.getByRole("button", { name: "返回数据仓", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开数据仓 TTL 创建验收", exact: true })).toContainText("永不过期");
});

test("到期后停止读取，回收站可恢复为私有且永不过期并保留历史", async ({ page }) => {
  const bin = await create(page, "TTL 到期恢复", { visibility: "public" });
  await page.goto(`/#/bins/${bin.meta.id}`);
  await expect(page.getByRole("heading", { name: "TTL 到期恢复", exact: true })).toBeVisible();
  const changed = await page.request.patch(`/api/v1/bins/${bin.meta.id}/meta`, {
    headers: { "If-Match": bin.etag }, data: { expiresAt: new Date(Date.now() + 3000).toISOString() },
  }); expect(changed.status()).toBe(200);
  await expect.poll(async () => (await page.request.get(`/api/v1/bins/${bin.meta.id}`)).status(), { timeout: 10000 }).toBe(404);
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const card = page.getByRole("article", { name: "TTL 到期恢复", exact: true });
  await expect(card).toContainText("到期时间");
  await card.getByRole("button", { name: "恢复数据仓", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("已恢复为私有数据仓");
  await expect(card).not.toBeVisible();
  await page.getByRole("button", { name: "打开恢复的数据仓", exact: true }).click();
  await expect(page.locator(".detail-badges")).toContainText("私有");
  await expect(page.locator(".detail-info")).toContainText("永不过期");
  const restored = await (await page.request.get(`/api/v1/bins/${bin.meta.id}`)).json();
  expect(restored.value).toEqual(bin.value); expect(restored.meta.currentVersion).toBe(1);
  expect((await page.request.get(`/api/v1/bins/${bin.meta.id}/versions/1`)).status()).toBe(200);
});

test("永久删除需确认，过期快照不能删掉新一轮回收记录，支持手机深色界面", async ({ page }) => {
  const bin = await deleted(page, "永久删除验收");
  await page.goto("/#/trash");
  const card = page.getByRole("article", { name: "永久删除验收", exact: true });
  await expect(card).toContainText("删除时间");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", dialog => dialog.dismiss());
  await card.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(card).toBeVisible();
  const old = await item(page, bin.meta.id);
  const restored = await (await page.request.post(`/api/v1/trash/bins/${bin.meta.id}/restore`, { headers: { "If-Match": old.etag } })).json();
  expect((await page.request.delete(`/api/v1/bins/${bin.meta.id}`, { headers: { "If-Match": restored.etag } })).status()).toBe(200);
  page.once("dialog", async dialog => { expect(dialog.message()).toContain("全部历史版本"); await dialog.accept(); });
  await card.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("记录已被其他请求修改");
  await expect(card).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await card.getByRole("button", { name: "永久删除", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("全部历史版本已永久删除");
  await expect(card).not.toBeVisible();
  await page.reload(); await expect(card).not.toBeVisible();
  expect((await page.request.post(`/api/v1/trash/bins/${bin.meta.id}/restore`, { headers: { "If-Match": old.etag } })).status()).toBe(404);
});

test("回收站列表、恢复网络错误和登录过期均有可重试状态", async ({ page }) => {
  const bin = await deleted(page, "回收站错误验收");
  await page.route("**/api/v1/trash/bins", route => route.abort("failed"));
  await page.goto("/#/trash");
  await expect(page.getByRole("alert")).toContainText("无法连接回收站 API");
  await page.unroute("**/api/v1/trash/bins");
  await page.getByRole("button", { name: "重试回收站列表", exact: true }).click();
  const card = page.getByRole("article", { name: "回收站错误验收", exact: true });
  await expect(card).toBeVisible();
  const endpoint = `**/api/v1/trash/bins/${bin.meta.id}/restore`;
  await page.route(endpoint, route => route.abort("failed"));
  await card.getByRole("button", { name: "恢复数据仓", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("无法连接回收站 API");
  await expect(card).toBeVisible();
  await page.unroute(endpoint);
  await page.route(endpoint, route => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
  await card.getByRole("button", { name: "恢复数据仓", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("登录已过期");
  await page.unroute(endpoint);
  await card.getByRole("button", { name: "恢复数据仓", exact: true }).click();
  await expect(page.locator(".detail-notice[role=status]")).toContainText("已恢复为私有数据仓");
  await expect(card).not.toBeVisible();
});

test("清空回收站按确认快照执行并显示部分失败，重试可进入空状态", async ({ page }) => {
  const first = await deleted(page, "批量保留新快照"), second = await deleted(page, "批量删除验收");
  await page.goto("/#/trash");
  await expect(page.getByRole("article", { name: "批量删除验收", exact: true })).toBeVisible();
  page.once("dialog", async dialog => {
    const old = await item(page, first.meta.id);
    const response = await page.request.post(`/api/v1/trash/bins/${first.meta.id}/restore`, { headers: { "If-Match": old.etag } });
    expect(response.status()).toBe(200); const restored = await response.json();
    await page.request.delete(`/api/v1/bins/${first.meta.id}`, { headers: { "If-Match": restored.etag } });
    await dialog.accept();
  });
  await page.getByRole("button", { name: "清空回收站", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("1 项未删除");
  await expect(page.getByRole("article", { name: "批量保留新快照", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "批量删除验收", exact: true })).not.toBeVisible();
  expect(await item(page, second.meta.id)).toBeUndefined();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "清空回收站", exact: true }).click();
  await expect(page.getByRole("heading", { name: "回收站为空", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "清空回收站", exact: true })).toBeDisabled();
});
