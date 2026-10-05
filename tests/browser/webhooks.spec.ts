import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});

/** Local receiver standing in for the admin's external endpoint. */
async function startReceiver() {
  const received: { body: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { received.push({ body, headers: req.headers }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { received, url: `http://127.0.0.1:${server.address().port}/hook`, close: () => new Promise<void>(r => server.close(() => r())) };
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

test('Webhook 创建、编辑、测试投递、停用与事件触发全流程', async ({ page }) => {
  const sink = await startReceiver();
  await page.goto('/#/webhooks');

  await page.getByLabel('Webhook 名称', { exact: true }).fill('浏览器自动化钩子');
  await page.getByLabel('接收端 URL', { exact: true }).fill(sink.url);
  await page.getByLabel('签名密钥', { exact: true }).fill('browser-test-secret-000001');
  await page.getByRole('button', { name: '随机生成', exact: true }).click();
  const generated = await page.getByLabel('签名密钥', { exact: true }).inputValue();
  expect(generated).toMatch(/^[0-9a-f]{48}$/);
  await page.getByLabel('签名密钥', { exact: true }).fill('browser-test-secret-000001');
  await page.getByLabel('创建事件 bin.*', { exact: true }).check();
  await page.getByRole('button', { name: '创建 Webhook', exact: true }).click();

  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: '浏览器自动化钩子' }) });
  await expect(card).toContainText('启用');
  await expect(card).toContainText('bin.*');

  // Send a test delivery and inspect it from the deliveries panel.
  await page.getByRole('button', { name: '发送测试 浏览器自动化钩子', exact: true }).click();
  await expect(card.getByLabel('最近投递记录')).toContainText('webhook.test');
  await expect(card.getByLabel('最近投递记录')).toContainText('已送达');
  expect(sink.received.length).toBe(1);
  expect(JSON.parse(sink.received[0].body).event).toBe('webhook.test');
  expect(sink.received[0].headers['x-jsonbin-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

  // A real bin mutation delivers through the UI-created webhook.
  await page.request.post('/api/v1/bins', { data: { name: '触发 Webhook', value: { hello: true } } });
  await expect.poll(async () => sink.received.length).toBe(2);
  expect(JSON.parse(sink.received[1].body).event).toBe('bin.created');

  // Edit the webhook: rename and narrow to bin.updated only via precise actions.
  await page.getByRole('button', { name: '编辑 浏览器自动化钩子', exact: true }).click();
  await card.getByLabel(`编辑名称 浏览器自动化钩子`).fill('已编辑钩子');
  await card.getByLabel('编辑事件 浏览器自动化钩子 bin.*', { exact: true }).uncheck();
  await card.getByLabel(`编辑精确动作 浏览器自动化钩子`).fill('bin.updated');
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '已编辑钩子' })).toContainText('bin.updated');

  const before = sink.received.length;
  await page.request.post('/api/v1/bins', { data: { name: '不应投递', value: null } });
  await wait(400);
  expect(sink.received.length).toBe(before, 'bin.created is no longer subscribed');

  // Disabling stops all deliveries; the toggle is reflected in the card.
  await page.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '已编辑钩子' })).toContainText('停用');
  await page.request.post('/api/v1/bins', { data: { name: '停用后创建', value: null } });
  await wait(400);
  expect(sink.received.length).toBe(before);

  // Deletion requires confirmation.
  await page.getByRole('button', { name: '删除 已编辑钩子', exact: true }).click();
  await page.getByRole('dialog', { name: '删除 Webhook', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '已编辑钩子' })).toHaveCount(1);
  await page.getByRole('button', { name: '删除 已编辑钩子', exact: true }).click();
  await page.getByRole('dialog', { name: '删除 Webhook', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('listitem').filter({ hasText: '已编辑钩子' })).toHaveCount(0);

  // Mobile dark layout has no horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await sink.close();
});
