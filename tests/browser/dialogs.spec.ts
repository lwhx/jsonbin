import { test, expect } from '@playwright/test';

async function login(page) {
  expect((await page.request.post('/api/v1/auth/login', {
    data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD },
  })).status()).toBe(200);
}

test.beforeEach(async ({ page }) => { await login(page); });

test('危险操作使用站内确认弹窗，支持 Esc、遮罩取消和确认', async ({ page }) => {
  const response = await page.request.post('/api/v1/keys', { data: { name: '统一弹窗密钥', scopes: ['bin:read'] } });
  expect(response.status()).toBe(201);
  const created = await response.json();

  await page.goto('/#/keys');
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '统一弹窗密钥', exact: true }) });

  await page.getByRole('button', { name: '删除密钥 统一弹窗密钥', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '永久删除 API 密钥', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('删除后记录和保存的完整密钥都无法恢复');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(card).toHaveCount(1);

  await page.getByRole('button', { name: '删除密钥 统一弹窗密钥', exact: true }).click();
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).not.toBeVisible();
  await expect(card).toHaveCount(1);

  await page.getByRole('button', { name: '删除密钥 统一弹窗密钥', exact: true }).click();
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(card).toHaveCount(0);
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(401);
});

test('未保存内容离开页面使用站内确认弹窗', async ({ page }) => {
  const response = await page.request.post('/api/v1/bins', { data: { name: '统一离页弹窗', value: { a: 1 } } });
  expect(response.status()).toBe(201);
  const record = await response.json();

  await page.goto('/#/bins/' + record.meta.id);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('尚未保存的新名称');
  await page.getByRole('button', { name: 'API 密钥', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(record.meta.id));

  await page.getByRole('button', { name: 'API 密钥', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/#\/keys$/);
});

test('创建提交中禁止关闭且退出后忽略迟到成功', async ({ page }) => {
  await page.goto('/#/bins');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted!: () => void;
  const pending = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route('**/api/v1/bins', async route => {
    const request = route.request();
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/bins') {
      await route.continue();
      return;
    }
    intercepted();
    await gate;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ meta: { id: 'late-created-bin' } }),
    }).catch(() => {});
  });

  await page.getByRole('button', { name: '新建数据仓', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建数据仓', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('迟到创建');
  await dialog.getByRole('button', { name: '新建数据仓', exact: true }).click();
  await pending;
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(dialog.locator('.dialog-heading').getByRole('button')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.locator('.dialog-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();

  await page.getByRole('button', { name: '退出登录', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
  const urlAfterLogout = page.url();
  release();
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(urlAfterLogout);
  await expect(page).not.toHaveURL(/late-created-bin/);
});

test('认证状态和登录配置错误显示可重试错误而不是登录表单', async ({ page }) => {
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"internal"}' }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法检查登录状态');
  await expect(page.getByRole('button', { name: '重试登录状态', exact: true })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);

  await page.unroute('**/api/v1/auth/me');
  await page.request.post('/api/v1/auth/logout');
  await page.route('**/api/v1/auth/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }));
  await page.route('**/api/v1/auth/config', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('无法加载登录配置');
  await expect(page.getByRole('button', { name: '重试登录配置', exact: true })).toBeVisible();
  await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
});

test('退出登录清空无限缓存的历史版本数据', async ({ page }) => {
  const response = await page.request.post('/api/v1/bins', { data: { name: '缓存隔离', value: { secret: 'cached-version' } } });
  const record = await response.json();
  await page.goto('/#/bins/' + record.meta.id);
  await page.getByRole('tab', { name: '历史版本', exact: true }).click();
  await page.getByText('查看 v1 的 JSON 内容', { exact: true }).click();
  await expect(page.getByLabel('历史版本内容', { exact: true })).toContainText('cached-version');

  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来', exact: true })).toBeVisible();
  await page.route(`**/api/v1/bins/${record.meta.id}/versions/1`, route => route.abort('connectionfailed'));
  await page.getByLabel('用户名', { exact: true }).fill('browser-test');
  await page.getByLabel('密码', { exact: true }).fill(process.env.JSONBIN_TEST_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('tab', { name: '历史版本', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '历史版本' }).getByRole('alert')).toContainText('无法连接');
  await expect(page.getByLabel('历史版本内容', { exact: true })).toHaveCount(0);
});
