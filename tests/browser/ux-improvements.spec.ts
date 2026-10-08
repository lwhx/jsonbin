import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  expect((await page.request.post('/api/v1/auth/login', { data: { username: 'browser-test', password: process.env.JSONBIN_TEST_PASSWORD } })).status()).toBe(200);
});

test('Webhook 静默进入与离开不再误报未保存修改', async ({ page }) => {
  await page.goto('/#/webhooks');
  await expect(page.getByRole('heading', { name: 'Webhook', exact: true })).toBeVisible();
  // The untouched create form (default bin.* selection) is NOT dirty: leaving
  // must navigate straight away without the discard-confirmation dialog.
  await page.getByRole('button', { name: '数据仓', exact: true }).click();
  await expect(page).toHaveURL(/#\/bins$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('? 键和顶栏按钮打开快捷键帮助，Esc 关闭', async ({ page }) => {
  await page.goto('/#/bins');
  // Wait for the app shell so the global keydown listener is mounted.
  await expect(page.getByRole('button', { name: '键盘快捷键', exact: true })).toBeVisible();
  // Real '?' keystrokes are layout-dependent in headless browsers; dispatch the
  // exact event the window listener consumes instead.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
  const help = page.getByRole('dialog', { name: '键盘快捷键' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('打开全局搜索');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // The shortcut must stay inert while typing in an input.
  const searchBox = page.getByPlaceholder('搜索名称、Slug、标签或 ID…');
  await searchBox.fill('什么?');
  await searchBox.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true })));
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '键盘快捷键', exact: true }).click();
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: '知道了' }).click();
  await expect(help).toBeHidden();
});

test('新建弹窗初始焦点在名称输入框，创建成功后出现全局 toast', async ({ page }) => {
  await page.goto('/#/bins');
  // Ctrl/Cmd+N is a reserved browser shortcut Playwright cannot dispatch; open
  // through the hero button, which invokes the same dialog.
  await page.getByRole('button', { name: '新建数据仓', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建数据仓' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toBeFocused();

  await page.getByLabel('名称', { exact: true }).fill('UX 验收数据仓');
  await dialog.getByRole('button', { name: '新建数据仓', exact: true }).click();
  // The toast outlives the immediate navigation to the new bin.
  await expect(page.getByRole('region', { name: '通知' })).toContainText('UX 验收数据仓”已创建');
  await expect(page).toHaveURL(/#\/bins\/[0-9a-f-]{36}$/);
});

test('批量移入回收站需要确认，完成后 toast 汇总结果', async ({ page }) => {
  const created = [];
  for (const name of ['批量验收 A', '批量验收 B']) {
    const response = await page.request.post('/api/v1/bins', { data: { name, value: { batch: true } } });
    created.push((await response.json()).meta.id);
  }
  await page.goto('/#/bins');
  for (const name of ['批量验收 A', '批量验收 B']) {
    await page.getByRole('checkbox', { name: `选择数据仓 ${name}` }).check();
  }
  await page.getByLabel('批量操作').selectOption('trash');
  await page.getByRole('button', { name: '应用操作', exact: true }).click();

  // Cancel keeps everything in place.
  const confirm = page.getByRole('dialog', { name: '移入回收站' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('button', { name: '打开数据仓 批量验收 A', exact: true })).toBeVisible();

  // Confirm runs the batch and reports through a toast.
  await page.getByRole('button', { name: '应用操作', exact: true }).click();
  await confirm.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.getByRole('region', { name: '通知' })).toContainText('2 个数据仓已更新');
  await expect(page.getByRole('button', { name: '打开数据仓 批量验收 A', exact: true })).toHaveCount(0);

  const trash = await (await page.request.get('/api/v1/trash/bins')).json();
  expect(trash.items.filter((item: { meta: { id: string } }) => created.includes(item.meta.id)).length).toBe(2);
});

test('详情页复制按钮在按钮上给出已复制反馈并写入剪贴板', async ({ page }) => {
  const bin = (await (await page.request.post('/api/v1/bins', { data: { name: '复制反馈验收', value: { copy: true } } })).json()).meta;
  await page.goto(`/#/bins/${bin.id}`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  const copyId = page.getByRole('button', { name: '复制 Bin ID', exact: true });
  await copyId.click();
  await expect(copyId).toContainText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(bin.id);
});
