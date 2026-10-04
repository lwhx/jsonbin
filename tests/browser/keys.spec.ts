import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});

test('API 密钥创建、复制、刷新后再次显示、权限/期限、最后使用时间和撤销', async ({ page }) => {
  await page.goto('/#/keys');
  await page.getByLabel('密钥名称', { exact: true }).fill('浏览器自动化密钥');
  await page.getByLabel('bin:update', { exact: true }).check();
  await page.getByLabel('过期时间', { exact: true }).fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: '创建密钥', exact: true }).click();
  const disclosure = page.getByRole('region', { name: '新密钥明文', exact: true });
  await expect(disclosure).toBeVisible();
  const token = await page.getByLabel('新 API 密钥', { exact: true }).inputValue();
  expect(token).toMatch(/^jb_live_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(value => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value), token)).toBe(false);
  const keys = await (await page.request.get('/api/v1/keys')).json();
  const key = keys.items.find((item: { name: string }) => item.name === '浏览器自动化密钥');
  expect(key.scopes).toEqual(['bin:read', 'bin:update']); expect(key.expiresAt).not.toBeNull();
  expect(JSON.stringify(keys)).not.toContain(token); expect(key.digest).toBeUndefined();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '复制密钥', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(disclosure).not.toBeVisible();
  await page.getByRole('button', { name: '数据仓', exact: true }).click();
  await expect(page).toHaveURL(/#\/bins$/);
  await page.goto('/#/keys');
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '浏览器自动化密钥', exact: true }) });
  await expect(card).toContainText('尚未使用');
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  expect((await page.request.post('/api/v1/bins', { headers: { Authorization: `Bearer ${token}` }, data: { name: '禁止创建', value: null } })).status()).toBe(403);
  await page.getByRole('button', { name: '刷新密钥列表', exact: true }).click();
  await expect(card).not.toContainText('尚未使用');
  await page.reload(); await expect(page.getByLabel('新 API 密钥', { exact: true })).not.toBeVisible();
  await expect(card).toContainText(key.prefix);
  await page.getByRole('button', { name: '显示密钥 浏览器自动化密钥', exact: true }).click();
  const revealed = page.getByLabel('API 密钥 浏览器自动化密钥', { exact: true });
  await expect(revealed).toHaveValue(token);
  await page.getByRole('button', { name: '复制密钥 浏览器自动化密钥', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await page.getByRole('button', { name: '隐藏密钥 浏览器自动化密钥', exact: true }).click();
  await expect(revealed).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '撤销密钥 浏览器自动化密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销 API 密钥', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(200);
  await page.getByRole('button', { name: '撤销密钥 浏览器自动化密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销 API 密钥', exact: true }).getByRole('button', { name: '撤销密钥', exact: true }).click();
  await expect(card).toContainText('已撤销');
  await expect(page.getByRole('button', { name: '撤销密钥 浏览器自动化密钥', exact: true })).toBeDisabled();
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);

  await page.getByRole('button', { name: '删除密钥 浏览器自动化密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '永久删除 API 密钥', exact: true }).getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('密钥过期后外部认证失效，刷新列表显示已过期', async ({ page }) => {
  const response = await page.request.post('/api/v1/keys', { data: { name: '短期密钥', scopes: ['bin:read'], expiresAt: new Date(Date.now() + 1500).toISOString() } });
  expect(response.status()).toBe(201); const created = await response.json();
  await page.goto('/#/keys');
  await expect.poll(async () => (await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(401);
  await page.getByRole('button', { name: '刷新密钥列表', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '短期密钥' })).toContainText('已过期');
});

test('创建失败、过去的期限、网络和登录过期保留权限草稿，离开需要确认', async ({ page }) => {
  await page.goto('/#/keys');
  await page.getByLabel('密钥名称', { exact: true }).fill('权限草稿');
  await page.getByLabel('schema:read', { exact: true }).check();
  await page.getByLabel('过期时间', { exact: true }).fill('2000-01-01T00:00');
  await page.getByRole('button', { name: '创建密钥', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('必须在未来');
  await page.getByRole('button', { name: '数据模型', exact: true }).click();
  await page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page).toHaveURL(/#\/keys$/);
  await page.getByLabel('过期时间', { exact: true }).fill('');
  await page.route('**/api/v1/keys', route => route.request().method() === 'POST' ? route.abort('connectionfailed') : route.continue());
  await page.getByRole('button', { name: '创建密钥', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('无法连接');
  await expect(page.getByLabel('密钥名称', { exact: true })).toHaveValue('权限草稿');
  await expect(page.getByLabel('schema:read', { exact: true })).toBeChecked();
  await page.unroute('**/api/v1/keys'); await page.request.post('/api/v1/auth/logout');
  await page.getByRole('button', { name: '创建密钥', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('登录已过期');
  await expect(page.getByLabel('密钥名称', { exact: true })).toHaveValue('权限草稿');
});

test('列表加载和撤销网络失败可重试，失败不会清除密钥记录', async ({ page }) => {
  const response = await page.request.post('/api/v1/keys', { data: { name: '重试密钥', scopes: ['history:read'] } });
  expect(response.status()).toBe(201); const created = await response.json();
  await page.route('**/api/v1/keys', route => route.abort('connectionfailed'));
  await page.goto('/#/keys');
  await expect(page.getByRole('alert')).toContainText('无法连接');
  await page.unroute('**/api/v1/keys');
  await page.getByRole('button', { name: '重试密钥列表', exact: true }).click();
  const card = page.getByRole('listitem').filter({ hasText: '重试密钥' });
  await expect(card).toContainText('history:read');
  await page.route(`**/api/v1/keys/${created.key.id}`, route => route.abort('connectionfailed'));
  await page.getByRole('button', { name: '撤销密钥 重试密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销 API 密钥', exact: true }).getByRole('button', { name: '撤销密钥', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('无法连接');
  await expect(card).toContainText('状态：有效');
  await page.unroute(`**/api/v1/keys/${created.key.id}`);
  await page.getByRole('button', { name: '撤销密钥 重试密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销 API 密钥', exact: true }).getByRole('button', { name: '撤销密钥', exact: true }).click();
  await expect(card).toContainText('已撤销');
});


test('有效密钥可以直接永久删除，网络失败不会从列表移除记录', async ({ page }) => {
  const response = await page.request.post('/api/v1/keys', { data: { name: '永久删除密钥', scopes: ['bin:read'] } });
  expect(response.status()).toBe(201);
  const created = await response.json();

  await page.goto('/#/keys');
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '永久删除密钥', exact: true }) });
  await expect(card).toContainText('状态：有效');

  await page.route(`**/api/v1/keys/${created.key.id}/purge`, route => route.abort('connectionfailed'));
  await page.getByRole('button', { name: '删除密钥 永久删除密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '永久删除 API 密钥', exact: true }).getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(page.locator('.detail-error[role=alert]')).toContainText('无法连接');
  await expect(card).toHaveCount(1);
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(200);

  await page.unroute(`**/api/v1/keys/${created.key.id}/purge`);
  await page.getByRole('button', { name: '删除密钥 永久删除密钥', exact: true }).click();
  await page.getByRole('dialog', { name: '永久删除 API 密钥', exact: true }).getByRole('button', { name: '永久删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await page.request.get('/api/v1/bins', { headers: { Authorization: `Bearer ${created.token}` } })).status()).toBe(401);
});
