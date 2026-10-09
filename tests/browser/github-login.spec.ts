import { test, expect } from "@playwright/test";

test("GitHub OAuth 登录入口展示品牌图标和精致按钮样式", async ({ page }) => {
  // Enable GitHub for the UI only; no real OAuth credentials or redirects.
  await page.route("**/api/v1/auth/config", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ passwordEnabled: true, githubEnabled: true }),
  }));
  await page.goto("/");

  const link = page.getByRole("link", { name: "使用 GitHub 登录", exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/api/v1/auth/github");

  const mark = link.locator("svg.github-mark");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("viewBox", "0 0 24 24");
  await expect(mark).toHaveAttribute("aria-hidden", "true");
  await expect(mark.locator("path")).toHaveAttribute("fill", "currentColor");

  const style = await link.evaluate(element => {
    const css = getComputedStyle(element);
    const logo = element.querySelector("svg")!.getBoundingClientRect();
    return {
      radius: parseFloat(css.borderRadius),
      shadow: css.boxShadow,
      paddingInline: parseFloat(css.paddingLeft),
      logoWidth: logo.width,
    };
  });
  expect(style.radius).toBeGreaterThanOrEqual(10);
  expect(style.shadow).not.toBe("none");
  expect(style.paddingInline).toBeGreaterThanOrEqual(14);
  expect(style.logoWidth).toBeGreaterThanOrEqual(20);

  await page.getByRole("button", { name: "切换明暗主题" }).click();
  await expect(link).toBeVisible();
  await expect(mark).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test("密码登录不展示默认用户名，错误提示统一且 IP 冷却与封禁不影响 GitHub 入口", async ({ page }) => {
  await page.route("**/api/v1/auth/config", route => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ passwordEnabled: true, githubEnabled: true }),
  }));
  let tries = 0;
  await page.route("**/api/v1/auth/login", route => {
    tries++;
    const response = tries === 1
      ? { status: 401, body: { error: "invalid_credentials" }, retry: null }
      : tries === 2
        ? { status: 429, body: { error: "login_cooldown" }, retry: "60" }
        : { status: 429, body: { error: "login_ip_banned" }, retry: "86400" };
    return route.fulfill({
      status: response.status, contentType: "application/json",
      headers: response.retry ? { "Retry-After": response.retry } : {},
      body: JSON.stringify(response.body),
    });
  });

  await page.goto("/");
  const user = page.getByLabel("用户名", { exact: true });
  await expect(user).not.toHaveAttribute("placeholder", /admin/i);
  await expect(user).toHaveValue("");
  await user.fill("unknown-account");
  await page.getByLabel("密码", { exact: true }).fill("not-the-password");

  const github = page.getByRole("link", { name: "使用 GitHub 登录", exact: true });
  const submit = page.getByRole("button", { name: "登录", exact: true });
  const message = page.locator(".login-error");
  await submit.click();
  await expect(message).toHaveText("用户名或密码不正确。");
  await submit.click();
  await expect(message).toContainText("1 分钟");
  await expect(github).toBeVisible();
  await submit.click();
  await expect(message).toContainText("24 小时");
  await expect(github).toHaveAttribute("href", "/api/v1/auth/github");
});
