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
