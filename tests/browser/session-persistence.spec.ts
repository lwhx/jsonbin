import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real Chromium userDataDir reused across TWO independent browser processes.
 * Reloading a tab is not a sufficient test of 14-day persistent login.
 */
test("14 天持久 Cookie 在完全关闭并重启浏览器后仍有效，后台不闪登录页", async ({ baseURL }) => {
  test.setTimeout(90_000);
  const dir = await mkdtemp(join(tmpdir(), "jsonbin-session-profile-"));
  const launch = () => chromium.launchPersistentContext(dir, {
    headless: true,
    ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] } : {}),
  });
  let context: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    context = await launch();
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(baseURL ?? "http://127.0.0.1:5174");
    await page.getByLabel("用户名", { exact: true }).fill("browser-test");
    await page.getByLabel("密码", { exact: true }).fill(process.env.JSONBIN_TEST_PASSWORD!);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();

    const cookies = await context.cookies();
    const signed = cookies.find(cookie => cookie.name === "jsonbin_session");
    expect(signed).toBeTruthy();
    expect(signed!.httpOnly).toBe(true);
    expect(signed!.sameSite).toBe("Lax");
    expect(signed!.expires).toBeGreaterThan(Date.now() / 1000 + 13 * 86400);

    await context.close();
    context = undefined; // The entire Chromium process is now terminated.
    context = await launch(); // Start a new Chromium process using persisted profile.
    const reopened = context.pages()[0] ?? await context.newPage();
    let sawLogin = false;
    reopened.on("domcontentloaded", async () => {
      if (await reopened.getByRole("heading", { name: "欢迎回来", exact: true }).count()) sawLogin = true;
    });
    await reopened.goto(baseURL ?? "http://127.0.0.1:5174");
    await expect(reopened.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    expect(sawLogin).toBe(false);
    await reopened.reload();
    await expect(reopened.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
    await reopened.getByRole("button", { name: "设置", exact: true }).click();
    await expect(reopened.getByRole("heading", { name: "登录设备", exact: true })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "退出所有设备", exact: true })).toBeVisible();
    const current = reopened.locator(".session-management-panel").getByText("当前设备", { exact: false });
    await expect(current).toBeVisible();

    // Network/storage failure when checking current session must show retry,
    // not destroy an otherwise valid persistent Cookie.
    await reopened.route("**/api/v1/auth/me", route => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: "session_state_unavailable" }),
    }));
    await reopened.reload();
    await expect(reopened.getByText("无法检查登录状态。", { exact: true })).toBeVisible();
    await expect(reopened.getByLabel("用户名", { exact: true })).toHaveCount(0);
    await reopened.unroute("**/api/v1/auth/me");
    await reopened.getByRole("button", { name: "重试登录状态" }).click();
    await expect(reopened.getByRole("button", { name: "退出登录", exact: true })).toBeVisible();
  } finally {
    await context?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
