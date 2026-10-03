import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});
const fixture = (summary: string, type = 'bin') => ({ id: randomUUID(), action: type === 'key' ? 'key.created' : 'bin.created', resourceType: type,
  resourceId: randomUUID(), actor: { type: 'session', id: 'local-admin' }, provider: 'password', timestamp: new Date().toISOString(), summary, requestId: randomUUID() });
const body = (items: ReturnType<typeof fixture>[], nextCursor: string | null = null) => ({ items, nextCursor, retentionLimit: 2000 });
test('活动入口显示真实持久记录，支持刷新与手机深色布局', async ({ page }) => {
  const bin = await (await page.request.post('/api/v1/bins', { data: { name: '活动验收', value: { secret: '不要展示' } } })).json();
  await page.goto('/#/bins');
  const nav = page.getByRole('button', { name: '活动记录', exact: true }); await expect(nav).toBeEnabled({ timeout: 3000 }); await nav.click();
  await expect(page).toHaveURL(/#\/activity$/); await expect(page.getByRole('heading', { name: '活动记录', exact: true })).toBeVisible();
  await expect(page.locator('.activity-page')).toContainText(bin.meta.id); await expect(page.locator('.activity-page')).toContainText('创建数据仓');
  await expect(page.locator('.activity-page')).not.toContainText('不要展示');
  await page.reload(); await expect(page.locator('.activity-page')).toContainText(bin.meta.id);
  await page.getByRole('button', { name: '刷新活动', exact: true }).click(); await expect(page.locator('.activity-page')).toContainText(bin.meta.id);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '切换明暗主题' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('活动分页支持稀疏空页、过滤和刷新重置', async ({ page }) => {
  const first = fixture('第一页活动'), last = fixture('第三页活动'); let revision = 0;
  await page.route('**/api/v1/activity?**', route => {
    const p = new URL(route.request().url()).searchParams;
    const data = p.get('resourceType') === 'key' ? body([fixture('仅密钥活动', 'key')])
      : p.get('cursor') === 'middle' ? body([], 'last') : p.get('cursor') === 'last' ? body([last]) : body([revision ? fixture('刷新后活动') : first], 'middle');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto('/#/activity'); await expect(page.locator('.activity-page')).toContainText('第一页活动');
  await page.getByRole('button', { name: '加载更多活动' }).click(); await expect(page.getByRole('button', { name: '加载更多活动' })).toBeEnabled();
  await page.getByRole('button', { name: '加载更多活动' }).click(); await expect(page.locator('.activity-page')).toContainText('第三页活动');
  await expect(page.getByRole('button', { name: '加载更多活动' })).toBeHidden(); revision++;
  await page.getByRole('button', { name: '刷新活动' }).click(); await expect(page.locator('.activity-page')).toContainText('刷新后活动');
  await expect(page.locator('.activity-page')).not.toContainText('第三页活动');
  await page.getByLabel('资源类型', { exact: true }).selectOption('key'); await expect(page.locator('.activity-page')).toContainText('仅密钥活动');
  await expect(page.locator('.activity-page')).not.toContainText('刷新后活动');
});
test('空活动与加载失败可重试，过期登录保留已加载记录', async ({ page }) => {
  let mode = 'error';
  await page.route('**/api/v1/activity?**', route => route.fulfill({ status: mode === 'error' ? 500 : mode === 'expired' ? 401 : 200,
    contentType: 'application/json', body: JSON.stringify(mode === 'empty' ? body([]) : body([fixture('保留已加载活动')])) }));
  await page.goto('/#/activity'); await expect(page.locator('.activity-page [role=alert]')).toBeVisible();
  mode = 'empty'; await page.getByRole('button', { name: '重试活动' }).click(); await expect(page.locator('.activity-page')).toContainText('暂无活动记录');
  mode = 'loaded'; await page.getByRole('button', { name: '刷新活动' }).click(); await expect(page.locator('.activity-page')).toContainText('保留已加载活动');
  mode = 'expired'; await page.getByRole('button', { name: '刷新活动' }).click(); await expect(page.locator('.activity-page [role=alert]')).toContainText('登录已过期');
  await expect(page.locator('.activity-page')).toContainText('保留已加载活动');
});
test('慢分页不能拼入切换过滤后的活动', async ({ page }) => {
  let release!: () => void; let intercepted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route('**/api/v1/activity?**', async route => {
    const p = new URL(route.request().url()).searchParams;
    if (p.get('cursor')) { intercepted(); await gate; await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body([fixture('过期的 Bin 分页内容')])) }).catch(() => {}); }
    else await route.fulfill({ contentType: 'application/json', body: JSON.stringify(p.get('resourceType') === 'key' ? body([fixture('新过滤结果', 'key')]) : body([fixture('第一页')], 'slow')) });
  });
  await page.goto('/#/activity'); await page.getByRole('button', { name: '加载更多活动' }).click(); await pending;
  await page.getByLabel('资源类型', { exact: true }).selectOption('key'); await expect(page.locator('.activity-page')).toContainText('新过滤结果'); release();
  await expect(page.locator('.activity-page')).not.toContainText('过期的 Bin 分页内容');
});
test('有未保存设置时进入活动页仍要求离页确认', async ({ page }) => {
  const bin = await (await page.request.post('/api/v1/bins', { data: { name: '草稿保护', value: null } })).json();
  await page.goto('/#/bins/' + bin.meta.id); await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('未保存的设置'); page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '活动记录', exact: true }).click(); await expect(page).toHaveURL(new RegExp(bin.meta.id));
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未保存的设置');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '活动记录', exact: true }).click();
  await expect(page).toHaveURL(/#\/activity$/);
});
