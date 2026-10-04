import { test, expect } from '@playwright/test';

async function login(page: any) {
  expect((await page.request.post('/api/v1/auth/login', {
    data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD },
  })).status()).toBe(200);
}

test('危险确认使用站内弹窗，并支持 Esc、遮罩、取消和确认', async ({ page }) => {
  await login(page);
  const created = await (await page.request.post('/api/v1/keys', {
    data: { name: '统一弹窗密钥', scopes: ['bin:read'] },
  })).json();
  await page.goto('/#/keys');

  const remove = page.getByRole('button', { name: '删除密钥 统一弹窗密钥', exact: true });
  await remove.click();
  const dialog = page.getByRole('dialog', { name: '永久删除 API 密钥', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('保存的完整密钥无法恢复');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();

  await remove.click();
  await expect(dialog).toBeVisible();
  await page.locator('.dialog-backdrop').click({ position: { x: 8, y: 8 } });
  await expect(dialog).not.toBeVisible();

  await remove.click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await page.request.get('/api/v1/keys')).status()).toBe(200);

  await remove.click();
  await dialog.getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '统一弹窗密钥', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(401);
});

test('未保存内容离页使用统一确认弹窗', async ({ page }) => {
  await login(page);
  const bin = await (await page.request.post('/api/v1/bins', {
    data: { name: '弹窗草稿', value: { ok: true } },
  })).json();
  await page.goto('/#/bins/' + bin.meta.id);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('未保存草稿');

  await page.getByRole('button', { name: '活动记录', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(bin.meta.id));
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未保存草稿');

  await page.getByRole('button', { name: '活动记录', exact: true }).click();
  await dialog.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(/#\/activity$/);
});
