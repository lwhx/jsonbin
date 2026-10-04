import { test, expect } from '@playwright/test';
const login = async (page: any) => { expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200); };
async function create(page: any, path: string, data: unknown) { const response = await page.request.post('/api/v1/' + path, { data }); expect(response.status()).toBe(201); return response.json(); }
test('顶部全局搜索可按集合查找、过滤、刷新并进入三个资源详情', async ({ page }) => {
  await login(page);
  const tag = crypto.randomUUID(), collectionName = 'P11浏览器集合' + tag, schemaName = 'P11浏览器模型' + tag, description = 'P11集合描述' + tag;
  const collection = await create(page, 'collections', { name: collectionName, description });
  const schema = await create(page, 'schemas', { name: schemaName, schema: true });
  const bin = await create(page, 'bins', { name: 'P11浏览器数据' + tag, description: 'P11数据描述', collectionId: collection.meta.id, value: { secret: 'P11正文不可检索' }, expiresAt: null });
  await page.goto('/'); await page.getByRole('button', { name: '搜索数据仓、集合、数据模型…' }).click();
  await expect(page.getByLabel('搜索内容')).toBeFocused(); await page.getByLabel('搜索内容').fill(collectionName); await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page.locator('.search-result')).toHaveCount(2); await expect(page.locator('.search-result').filter({ hasText: bin.meta.id })).toContainText('集合：' + collectionName);
  await page.getByLabel('搜索范围').selectOption('bin'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.locator('.search-result')).toHaveCount(1);
  await page.reload(); await expect(page.getByLabel('搜索内容')).toHaveValue(collectionName); await expect(page.getByLabel('搜索范围')).toHaveValue('bin');
  await page.locator('.search-result').click(); await expect(page).toHaveURL(new RegExp('#/bins/' + bin.meta.id + '$')); await expect(page.getByRole('heading', { name: bin.meta.name, exact: true })).toBeVisible();
  for (const [q, id, path, name] of [[description, collection.meta.id, 'collections', collectionName], [schemaName, schema.meta.id, 'schemas', schemaName]]) {
    await page.keyboard.press('ControlOrMeta+k'); await expect(page).toHaveURL(/#\/search$/); await expect(page.getByLabel('搜索内容')).toHaveValue(''); await page.getByLabel('搜索内容').fill(q); await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.locator('.search-result').filter({ hasText: id }).click(); await expect(page).toHaveURL(new RegExp('#/' + path + '/' + id + '$')); await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
});
test('空结果、错误重试和迟到请求不会覆盖最新搜索', async ({ page }) => {
  await login(page); let release: () => void = () => {}; let failing = true;
  await page.route('**/api/v1/search?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === '慢检索') { await new Promise<void>(resolve => { release = resolve; }); try { await route.fulfill({ json: { items: [{ type: 'bin', id: 'old', name: '过期结果', description: '', updatedAt: '' }], nextCursor: null, source: 'r2' } }); } catch { /* canceled */ } }
    else if (q === '错误检索' && failing) { await route.fulfill({ status: 503, json: { error: 'search_unavailable' } }); }
    else await route.fulfill({ json: { items: [], nextCursor: null, source: 'r2' } });
  });
  await page.goto('/#/search'); await page.getByLabel('搜索内容').fill('慢检索'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByRole('status')).toContainText('正在搜索');
  await page.getByLabel('搜索内容').fill('快检索'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByRole('status')).toContainText('没有找到'); release(); await expect(page.locator('.search-page')).not.toContainText('过期结果');
  await page.getByLabel('搜索内容').fill('错误检索'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('暂不可用'); failing = false; await page.getByRole('button', { name: '重新搜索' }).click(); await expect(page.getByRole('status')).toContainText('没有找到');
});
test('真实搜索分页及手机深色布局', async ({ page }) => {
  await login(page); const name = 'P11分页浏览器' + crypto.randomUUID(); for (let i = 0; i < 21; i++) await create(page, 'bins', { name: name + i, value: null, expiresAt: null });
  await page.goto('/#/search?' + new URLSearchParams({ q: name, type: 'bin' })); await expect(page.locator('.search-result')).toHaveCount(20); await page.getByRole('button', { name: '加载更多结果' }).click(); await expect(page.locator('.search-result')).toHaveCount(21); await expect(page.getByRole('button', { name: '加载更多结果' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '切换明暗主题' }).click(); await expect(page.locator('html')).toHaveClass(/dark/); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('索引重建状态、失败反馈和操作中离页保护', async ({ page }) => {
  await login(page); await page.goto('/#/settings'); const panel = page.locator('.search-index-panel'); await expect(panel.getByRole('button', { name: '从 R2 重建索引' })).toBeEnabled();
  await panel.getByRole('button', { name: '从 R2 重建索引' }).click(); await expect(panel.getByRole('status')).toContainText('已重建'); await panel.getByRole('button', { name: '刷新索引状态' }).click(); await expect(panel).toContainText('可用');
  let release: () => void = () => {}; await page.route('**/api/v1/search/rebuild', async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ status: 409, json: { error: 'search_changed' } }); });
  await panel.getByRole('button', { name: '从 R2 重建索引' }).click(); await expect(panel.getByRole('button', { name: '正在重建…' })).toBeDisabled(); page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '搜索数据仓、集合、数据模型…' }).click(); await expect(page).toHaveURL(/#\/settings$/); release(); await expect(panel.getByRole('alert')).toContainText('数据已发生变化');
  await page.getByRole('button', { name: '搜索数据仓、集合、数据模型…' }).click(); await expect(page).toHaveURL(/#\/search$/);
});
