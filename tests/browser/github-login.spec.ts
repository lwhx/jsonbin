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
