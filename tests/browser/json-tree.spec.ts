import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});
async function create(page: Page, value: unknown) {
  const response = await page.request.post('/api/v1/bins', { data: { name: '树形视图验收', value } });
  expect(response.status()).toBe(201);
  const record = await response.json();
  await page.goto(`/#/bins/${record.meta.id}`);
  await expect(page.getByRole('heading', { name: '树形视图验收', exact: true })).toBeVisible();
  return record;
}
async function edit(page: Page, text: string) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(value => navigator.clipboard.writeText(value), text);
  await page.getByRole('textbox', { name: 'JSON 编辑器', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
}

test('树形视图可展开对象和数组，键盘浏览、复制节点并安全显示特殊字段', async ({ page }) => {
  await create(page, { settings: { enabled: false, note: null }, items: [0, '', {}], 'a/b': { '~key': '<img src=x onerror=alert(1)>' } });
  const tab = page.getByRole('tab', { name: '树形视图', exact: true });
  await expect(tab).toBeEnabled(); await tab.click();
  const tree = page.getByRole('tree', { name: 'JSON 树形视图' });
  const settings = tree.locator('[data-pointer="/settings"]');
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  await settings.focus(); await page.keyboard.press('ArrowRight');
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  const enabled = tree.locator('[data-pointer="/settings/enabled"]');
  await expect(enabled).toBeFocused(); await expect(enabled).toContainText('false');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制节点 JSON', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('false');
  await enabled.focus(); await page.keyboard.press('ArrowLeft');
  await expect(settings).toBeFocused(); await page.keyboard.press('ArrowLeft');
  await expect(enabled).toHaveCount(0);
  await tree.locator('[data-pointer="/items"]').click();
  await expect(tree.locator('[data-pointer="/items/0"]')).toContainText('0');
  await expect(tree.locator('[data-pointer="/items/1"]')).toContainText('""');
  await expect(tree.locator('[data-pointer="/items/2"]')).toContainText('{}');
  await tree.locator('[data-pointer="/a~1b"]').click();
  await expect(tree.locator('[data-pointer="/a~1b/~0key"]')).toContainText('<img src=x onerror=alert(1)>');
  await expect(tree.locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: '折叠全部', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  const root = tree.locator('[data-pointer=""]');
  await root.focus(); await page.keyboard.press('Enter');
  await expect(tree.getByRole('treeitem')).toHaveCount(4);
});

test('树形视图显示未保存草稿，切换保留内容，非法 JSON 提示修正且不展示旧值', async ({ page }) => {
  const record = await create(page, { original: true });
  await edit(page, '{"draft":{"hello":"未保存内容"}}');
  await expect(page.getByText('未保存', { exact: true })).toBeVisible();
  const writes: string[] = [];
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && request.url().includes('/api/v1/')) writes.push(request.method()); });
  await page.getByRole('tab', { name: '树形视图', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'JSON 树形视图' });
  await expect(page.getByRole('tabpanel')).toContainText('当前显示未保存的 JSON 草稿');
  await tree.locator('[data-pointer="/draft"]').click();
  await expect(tree.locator('[data-pointer="/draft/hello"]')).toContainText('未保存内容');
  await expect(tree.locator('[data-pointer="/original"]')).toHaveCount(0);
  expect(writes).toEqual([]);
  await page.getByRole('tab', { name: '编辑器', exact: true }).click();
  await page.getByRole('button', { name: '保存 JSON', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('保存成功');
  const stored = await (await page.request.get(`/api/v1/bins/${record.meta.id}`)).json();
  expect(stored.value).toEqual({ draft: { hello: '未保存内容' } }); expect(stored.meta.currentVersion).toBe(2);
  await edit(page, '{bad');
  await page.getByRole('tab', { name: '树形视图', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('JSON 语法不正确');
  await expect(tree).toHaveCount(0);
  await page.getByRole('button', { name: '返回编辑器', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存 JSON', exact: true })).toBeDisabled();
  await expect(page.locator('.monaco-editor')).toContainText('{bad');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '返回数据仓', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(record.meta.id));
});

test('顶层空值、布尔、数字、空文本和空容器可查看，锁定数据仓仍可读树形视图', async ({ page }) => {
  for (const value of [null, false, 0, '', [], {}]) {
    const record = await create(page, value);
    if (value === false) {
      expect((await page.request.patch(`/api/v1/bins/${record.meta.id}/meta`, { headers: { 'If-Match': record.etag }, data: { locked: true } })).status()).toBe(200);
      await page.reload(); await expect(page.locator('.detail-badges')).toContainText('已锁定');
    }
    await page.getByRole('tab', { name: '树形视图', exact: true }).click();
    const root = page.getByRole('tree', { name: 'JSON 树形视图' }).getByRole('treeitem');
    await expect(root).toHaveCount(1); await expect(root).toContainText(JSON.stringify(value));
  }
});

test('大对象分批显示，长文本预览可复制完整值，手机深色无横向溢出', async ({ page }) => {
  const text = '中文'.repeat(2000);
  const value = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`field${i}`, i === 0 ? text : i]));
  await create(page, value);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('tab', { name: '树形视图', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'JSON 树形视图' });
  await expect(tree.getByRole('treeitem')).toHaveCount(200);
  await expect(tree.locator('[data-pointer="/field499"]')).toHaveCount(0);
  await tree.locator('[data-pointer="/field0"]').click();
  await expect(tree.locator('[data-pointer="/field0"]')).toContainText('4000 字符');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制节点 JSON', exact: true }).click();
  await expect(page.locator('.detail-notice[role=status]')).toContainText('已复制');
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toBe(text);
  await page.getByRole('button', { name: '显示更多节点', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(400);
  await page.getByRole('button', { name: '显示更多节点', exact: true }).click();
  await expect(tree.getByRole('treeitem')).toHaveCount(501);
  await expect(tree.locator('[data-pointer="/field499"]')).toContainText('499');
  await expect(page.getByRole('button', { name: '显示更多节点', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
