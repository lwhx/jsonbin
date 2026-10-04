import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  const login = await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } });
  expect(login.status()).toBe(200);
});
async function collection(page: Page, name: string) {
  const response = await page.request.post('/api/v1/collections', { data: { name, description: '集合描述' } });
  expect(response.status()).toBe(201); return response.json();
}
async function member(page: Page, collectionId: string, name = '集合成员') {
  const response = await page.request.post('/api/v1/bins', { data: { name, value: { kept: true }, collectionId } });
  expect(response.status()).toBe(201); return response.json();
}

test('集合列表、新建、编辑、详情刷新与删除保留成员数据', async ({ page }) => {
  await page.goto('/#/collections');
  await page.getByRole('button', { name: '新建集合', exact: true }).click();
  await page.getByLabel('集合名称', { exact: true }).fill('浏览器集合');
  await page.getByLabel('集合描述', { exact: true }).fill('配置分组');
  await page.getByRole('button', { name: '创建集合', exact: true }).click();
  await expect(page).toHaveURL(/#\/collections\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: '浏览器集合', exact: true })).toBeVisible();
  const id = new URL(page.url()).hash.split('/').at(-1)!;
  await page.getByLabel('集合名称', { exact: true }).fill('已改名集合');
  await page.getByLabel('集合描述', { exact: true }).fill('已改描述');
  await page.getByRole('button', { name: '保存集合', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已改名集合', exact: true })).toBeVisible();
  const first = await member(page, id);
  await page.reload();
  await expect(page.getByRole('heading', { name: '集合内数据仓 · 1 个', exact: true })).toBeVisible();
  await expect(page.getByLabel('集合描述', { exact: true })).toHaveValue('已改描述');
  await page.getByRole('button', { name: '返回集合', exact: true }).click();
  const card = page.getByRole('button', { name: '打开集合 已改名集合', exact: true });
  await expect(card).toContainText('1 个数据仓');
  await card.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(id));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '删除集合', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: '删除集合？', exact: true });
  await expect(deleteDialog).toContainText('所有 JSON 和历史版本都会保留');
  await deleteDialog.getByRole('button', { name: '删除集合', exact: true }).click();
  await expect(page).toHaveURL(/#\/collections$/);
  await expect(card).not.toBeVisible();
  const retained = await page.request.get(`/api/v1/bins/${first.meta.id}`);
  expect(retained.status()).toBe(200); const record = await retained.json();
  expect(record.value).toEqual(first.value); expect(record.meta.currentVersion).toBe(1); expect(record.meta.collectionId).toBeNull();
  expect((await page.request.get(`/api/v1/bins/${first.meta.id}/versions/1`)).status()).toBe(200);
});

test('数据仓设置可移入、切换与移出集合，创建时也能选择集合', async ({ page }) => {
  const first = await collection(page, '集合甲'); const second = await collection(page, '集合乙');
  const bin = await member(page, first.meta.id, '迁移成员');
  await page.goto(`/#/bins/${bin.meta.id}`);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('集合', { exact: true })).toHaveValue(first.meta.id);
  await page.getByLabel('集合', { exact: true }).selectOption(second.meta.id);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('JSON 版本保持不变');
  const moved = await (await page.request.get(`/api/v1/bins/${bin.meta.id}`)).json();
  expect(moved.meta.collectionId).toBe(second.meta.id); expect(moved.meta.currentVersion).toBe(1); expect(moved.value).toEqual(bin.value);
  await page.getByRole('button', { name: '集合', exact: true }).click();
  const secondCard = page.getByRole('button', { name: '打开集合 集合乙', exact: true });
  await expect(secondCard).toContainText('1 个数据仓');
  await page.getByRole('button', { name: '打开集合 集合甲', exact: true }).click();
  await expect(page.getByRole('heading', { name: '集合内数据仓 · 0 个', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回集合', exact: true }).click();
  await secondCard.click();
  await page.getByRole('button', { name: '移出 迁移成员', exact: true }).click();
  await expect(page.getByRole('heading', { name: '集合内数据仓 · 0 个', exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/v1/bins/${bin.meta.id}`)).json()).meta.collectionId).toBeNull();
  await page.getByRole('button', { name: '数据仓', exact: true }).click();
  await page.getByRole('button', { name: '新建数据仓', exact: true }).first().click();
  await page.getByLabel('名称', { exact: true }).fill('直接分组成员');
  await page.getByLabel('集合', { exact: true }).selectOption(first.meta.id);
  await page.getByRole('button', { name: '新建数据仓', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: '直接分组成员', level: 1, exact: true })).toBeVisible();
  const createdId = new URL(page.url()).hash.split('/').at(-1)!;
  expect((await (await page.request.get(`/api/v1/bins/${createdId}`)).json()).meta.collectionId).toBe(first.meta.id);
});

test('集合冲突、取消删除和网络失败保留未保存内容，离开需要确认', async ({ page }) => {
  const initial = await collection(page, '冲突集合');
  const path = `/api/v1/collections/${initial.meta.id}`;
  await page.goto(`/#/collections/${initial.meta.id}`);
  await page.getByLabel('集合名称', { exact: true }).fill('本地草稿');
  expect((await page.request.patch(path, { headers: { 'If-Match': initial.etag }, data: { name: '远程名称' } })).status()).toBe(200);
  await page.getByRole('button', { name: '保存集合', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('其他请求修改');
  await expect(page.getByLabel('集合名称', { exact: true })).toHaveValue('本地草稿');
  await page.getByRole('button', { name: '返回集合', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(initial.meta.id));
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除集合', exact: true }).click();
  expect((await page.request.get(path)).status()).toBe(200);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '重新加载集合', exact: true }).click();
  await expect(page.getByLabel('集合名称', { exact: true })).toHaveValue('远程名称');
  await page.getByLabel('集合名称', { exact: true }).fill('网络草稿');
  await page.route(`**${path}`, route => route.request().method() === 'PATCH' ? route.abort('connectionfailed') : route.continue());
  await page.getByRole('button', { name: '保存集合', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('无法连接');
  await expect(page.getByLabel('集合名称', { exact: true })).toHaveValue('网络草稿');
  await page.unroute(`**${path}`);
  await page.request.post('/api/v1/auth/logout');
  await page.getByRole('button', { name: '保存集合', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('登录已过期');
  await expect(page.getByLabel('集合名称', { exact: true })).toHaveValue('网络草稿');
});
