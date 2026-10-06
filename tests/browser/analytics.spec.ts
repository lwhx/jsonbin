import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});

const overview = {
  overview: { totalRequests: 12345, successRate: 98.5, avgDurationMs: 42, p95DurationMs: 118, count4xx: 196, count5xx: 3, count429: 74 },
  endpoints: [
    { method: 'GET', route: '/api/v1/bins/:id', requests: 9231, avgDurationMs: 24, p95DurationMs: 62, errorRate: 0.2 },
    { method: 'PATCH', route: '/api/v1/bins/:id', requests: 1104, avgDurationMs: 43, p95DurationMs: 130, errorRate: 8.1 },
  ],
  statuses: [ { status: 200, count: 12121 }, { status: 412, count: 93 }, { status: 429, count: 74 }, { status: 503, count: 3 } ],
  keys: [ { keyId: 'abcdef0123456789', requests: 4310, count429: 3 } ],
  errors: [ { error: 'rate_limit_exceeded', count: 74 } ],
};

test('API 分析页展示真实聚合指标，支持时间范围切换与手机深色布局', async ({ page }) => {
  // Real traffic so the page renders genuine server-side aggregates.
  const bin = await (await page.request.post('/api/v1/bins', { data: { name: '分析验收', value: { secret: '不要展示' } } })).json();
  await page.request.get(`/api/v1/bins/${bin.meta.id}`);
  await page.request.get('/api/v1/bins/00000000-0000-0000-0000-000000000000');

  await page.goto('/#/bins');
  const nav = page.getByRole('button', { name: 'API 分析', exact: true });
  await expect(nav).toBeEnabled({ timeout: 3000 });
  await nav.click();

  await expect(page).toHaveURL(/#\/analytics$/);
  await expect(page.getByRole('heading', { name: 'API 请求分析', exact: true })).toBeVisible();
  const shell = page.locator('.analytics-page');
  await expect(shell).toContainText('总请求量');
  await expect(shell).toContainText('成功率');
  await expect(shell).toContainText('接口调用排行');

  // Read-only observability: no request bodies or secrets may surface.
  await expect(shell).not.toContainText('不要展示');
  await expect(shell).not.toContainText('Authorization');

  await page.getByRole('button', { name: '最近 7 天', exact: true }).click();
  await expect(shell).toContainText('总请求量');
  await page.reload();
  await expect(page).toHaveURL(/#\/analytics$/);
  await expect(shell).toContainText('总请求量');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('API 分析页渲染端点排行与状态码分布，失败可重试且不泄露凭据', async ({ page }) => {
  let mode: 'ok' | 'error' = 'error';
  let range: string | null = null;
  await page.route('**/api/v1/analytics/overview**', route => {
    range = new URL(route.request().url()).searchParams.get('range');
    if (mode === 'error') return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'internal_error' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(overview) });
  });

  await page.goto('/#/analytics');
  const shell = page.locator('.analytics-page');
  await expect(shell).toContainText('无法加载分析数据');
  expect(range).toBe('24h');

  mode = 'ok';
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(shell).toContainText('12,345');
  await expect(shell).toContainText('98.5%');
  await expect(shell).toContainText('P95: 118 ms');
  await expect(shell).toContainText('74');

  // Endpoint ranking must show normalized routes, never raw UUIDs.
  await expect(shell).toContainText('/api/v1/bins/:id');
  await expect(shell).toContainText('GET');
  await expect(shell).toContainText('PATCH');

  // Status distribution highlights conflict / rate limit / server errors.
  await expect(shell).toContainText('HTTP 412');
  await expect(shell).toContainText('HTTP 429');
  await expect(shell).toContainText('HTTP 503');

  // Key ranking shows an id prefix only, never a full token.
  await expect(shell).toContainText('abcdef01');
  await expect(shell).not.toContainText('abcdef0123456789');

  await page.getByRole('button', { name: '最近 1 小时', exact: true }).click();
  await expect(shell).toContainText('12,345');
  expect(range).toBe('1h');
});
