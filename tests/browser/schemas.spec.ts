import { test, expect, type Page } from '@playwright/test';
const definition = { type: 'object', properties: { count: { type: 'integer', minimum: 0 } }, required: ['count'], additionalProperties: false };
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});
async function model(page: Page, name = '计数模型') {
  const response = await page.request.post('/api/v1/schemas', { data: { name, schema: definition } });
  expect(response.status()).toBe(201); return response.json();
}
async function bin(page: Page, value: unknown, schemaId?: string) {
  const response = await page.request.post('/api/v1/bins', { data: { name: '模型数据仓', value, schemaId } });
  expect(response.status()).toBe(201); return response.json();
}
async function edit(page: Page, text: string) {
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.getByRole('textbox', { name: 'JSON 编辑器', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('ControlOrMeta+v');
}

test('模型创建、编辑、刷新、样本字段校验与删除，支持移动端深色界面', async ({ page }) => {
  await page.goto('/#/schemas');
  await page.getByRole('button', { name: '新建数据模型', exact: true }).click();
  await page.getByLabel('模型名称', { exact: true }).fill('浏览器模型');
  await page.getByLabel('模型描述', { exact: true }).fill('字段校验');
  await page.getByLabel('模型定义', { exact: true }).fill(JSON.stringify(definition));
  await page.getByRole('button', { name: '创建模型', exact: true }).click();
  await expect(page).toHaveURL(/#\/schemas\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).hash.split('/').at(-1)!;
  await expect(page.getByRole('heading', { name: '浏览器模型', exact: true })).toBeVisible();
  await page.getByLabel('校验样本', { exact: true }).fill('{"count":"bad"}');
  await page.getByRole('button', { name: '校验样本', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('#/count');
  await page.getByLabel('校验样本', { exact: true }).fill('{"count":1}');
  await page.getByRole('button', { name: '校验样本', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('校验通过');
  await page.getByLabel('模型名称', { exact: true }).fill('新版模型');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新版模型', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('模型描述', { exact: true })).toHaveValue('字段校验');
  await expect(page.getByText('当前修订 r2', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '删除模型', exact: true }).click();
  await page.getByRole('dialog', { name: '删除数据模型？', exact: true }).getByRole('button', { name: '删除模型', exact: true }).click();
  await expect(page).toHaveURL(/#\/schemas$/);
  expect((await page.request.get(`/api/v1/schemas/${id}`)).status()).toBe(404);
});

test('Bin 设置校验已保存内容、锁定绑定、单独解锁并主动升级修订；编辑错误保留草稿', async ({ page }) => {
  const schema = await model(page), record = await bin(page, { count: 1 });
  await page.goto(`/#/bins/${record.meta.id}`);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('数据模型', { exact: true }).selectOption(schema.meta.id);
  await page.getByLabel('锁定模型绑定', { exact: true }).check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByLabel('数据模型', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('使用模型最新修订', { exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '编辑器', exact: true }).click();
  await edit(page, '{"count":"bad"}');
  await page.getByRole('button', { name: '保存 JSON', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('#/count');
  await expect(page.locator('.dirty-badge')).toBeVisible();
  expect((await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json()).meta.currentVersion).toBe(1);
  await edit(page, '{"count":10}');
  await page.getByRole('button', { name: '保存 JSON', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('保存成功');
  const strict = { ...definition, properties: { count: { type: 'integer', minimum: 5 } } };
  expect((await page.request.put(`/api/v1/schemas/${schema.meta.id}`, { headers: { 'If-Match': schema.etag }, data: { name: '更严格模型', schema: strict } })).status()).toBe(200);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('锁定模型绑定', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByLabel('数据模型', { exact: true })).toBeEnabled();
  await page.getByLabel('使用模型最新修订', { exact: true }).check();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('当前绑定修订 r2。新绑定与升级会先校验已保存的 JSON。', { exact: true })).toBeVisible();
  const upgraded = await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json();
  expect(upgraded.meta.schemaRevision).toBe(2); expect(upgraded.meta.currentVersion).toBe(2);
});

test('创建时模型失败可修正，历史恢复失败显示字段且不新增版本', async ({ page }) => {
  const schema = await model(page, '新建校验模型');
  await page.goto('/#/bins');
  await page.getByRole('button', { name: '新建数据仓', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建数据仓', exact: true });
  await dialog.getByLabel('名称', { exact: true }).fill('创建校验数据仓');
  await dialog.getByLabel('数据模型', { exact: true }).selectOption(schema.meta.id);
  await dialog.getByLabel('JSON', { exact: true }).fill('{"count":"bad"}');
  await dialog.getByRole('button', { name: '新建数据仓', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('#/count');
  await expect(dialog.getByLabel('JSON', { exact: true })).toHaveValue('{"count":"bad"}');
  await dialog.getByLabel('JSON', { exact: true }).fill('{"count":2}');
  await dialog.getByRole('button', { name: '新建数据仓', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创建校验数据仓', level: 1, exact: true })).toBeVisible();
  const createdId = new URL(page.url()).hash.split('/').at(-1)!;
  expect((await (await page.request.get(`/api/v1/bins/${createdId}`)).json()).meta.schemaId).toBe(schema.meta.id);
  const historical = await bin(page, { count: 'old' });
  const path = `/api/v1/bins/${historical.meta.id}`;
  const updated = await (await page.request.put(path, { headers: { 'If-Match': historical.etag }, data: { value: { count: 2 } } })).json();
  expect((await page.request.patch(path + '/meta', { headers: { 'If-Match': updated.etag }, data: { schemaId: schema.meta.id } })).status()).toBe(200);
  await page.goto(`/#/bins/${historical.meta.id}`);
  await page.getByRole('tab', { name: '历史版本', exact: true }).click();
  await page.getByRole('button', { name: '恢复 v1', exact: true }).click();
  await page.getByRole('dialog', { name: '恢复历史版本 v1？', exact: true }).getByRole('button', { name: '恢复版本', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('#/count');
  expect((await (await page.request.get(path)).json()).meta.currentVersion).toBe(2);
});

test('模型定义错误、冲突、网络和会话错误保留草稿，离开需要确认', async ({ page }) => {
  const schema = await model(page), path = `/api/v1/schemas/${schema.meta.id}`;
  await page.goto(`/#/schemas/${schema.meta.id}`);
  await page.getByLabel('模型定义', { exact: true }).fill('{"type":"not-a-type"}');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('#/type');
  await expect(page.getByLabel('模型定义', { exact: true })).toHaveValue('{"type":"not-a-type"}');
  await page.getByRole('button', { name: '返回数据模型', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(schema.meta.id));
  await page.getByLabel('模型定义', { exact: true }).fill(JSON.stringify(definition));
  await page.getByLabel('模型名称', { exact: true }).fill('本地模型草稿');
  expect((await page.request.put(path, { headers: { 'If-Match': schema.etag }, data: { name: '远程模型', schema: definition } })).status()).toBe(200);
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('其他请求修改');
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('本地模型草稿');
  await page.getByRole('button', { name: '重新加载模型', exact: true }).click();
  await page.getByRole('dialog', { name: '重新加载数据模型？', exact: true }).getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('远程模型');
  await page.getByLabel('模型名称', { exact: true }).fill('网络模型草稿');
  await page.route(`**${path}`, route => route.request().method() === 'PUT' ? route.abort('connectionfailed') : route.continue());
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('无法连接');
  await page.unroute(`**${path}`); await page.request.post('/api/v1/auth/logout');
  await page.getByRole('button', { name: '保存模型', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('登录已过期');
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveValue('网络模型草稿');
});
