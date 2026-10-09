import { test, expect } from "@playwright/test";

test("Session R2 failure during password login explains retry instead of claiming login is unconfigured", async ({ page }) => {
  await page.route("**/api/v1/auth/login", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "session_state_unavailable" }),
  }));
  await page.goto("/");
  await page.getByLabel("用户名", { exact: true }).fill("browser-test");
  await page.getByLabel("密码", { exact: true }).fill("test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator(".login-error")).toHaveText("会话服务暂时不可用，请稍后重试。");
  await expect(page.getByLabel("用户名", { exact: true })).toBeVisible();
});

test("failed server-side logout preserves an otherwise valid Cookie and authenticated UI", async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "browser-test", password: process.env.JSONBIN_TEST_PASSWORD },
  });
  expect(login.status()).toBe(200);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
  const cookieBefore = (await page.context().cookies()).find(c => c.name === "jsonbin_session")?.value;
  expect(cookieBefore).toBeTruthy();
  await page.route("**/api/v1/auth/logout", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "session_state_unavailable" }),
  }));
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
  await expect(page.getByText(/退出登录失败，服务器尚未确认撤销/)).toBeVisible();
  const cookieAfter = (await page.context().cookies()).find(c => c.name === "jsonbin_session")?.value;
  expect(cookieAfter).toBe(cookieBefore);
});


test("failed logout after confirmation keeps prepared import draft; only transient exports are cancelled", async ({ page }) => {
  const login = await page.request.post("/api/v1/auth/login", {
    data: { username: "browser-test", password: process.env.JSONBIN_TEST_PASSWORD },
  });
  expect(login.status()).toBe(200);
  await page.goto("/#/settings");
  const panel = page.locator(".import-panel");
  await panel.getByLabel("选择导入文件").setInputFiles({
    name: "unsubmitted-import.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"pending":true}'),
  });
  await expect(panel).toContainText("unsubmitted-import.json");

  await page.route("**/api/v1/auth/logout", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "session_state_unavailable" }),
  }));
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.getByRole("dialog", { name: "退出登录？", exact: true })
    .getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
  await expect(panel).toContainText("unsubmitted-import.json");
});
