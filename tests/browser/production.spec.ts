import { test, expect } from '@playwright/test';
import { createAssetsHarness } from '../support/assets-harness.mjs';
import { readFile } from 'node:fs/promises';
import { decodeBackupZip } from '../../src/shared/zip.ts';

test('生产构建 CSP 下中文登录、Monaco 保存、刷新和手机深色模式可用', async ({ page }) => {
  const h = await createAssetsHarness();
  const violations: { directive: string; blocked: string; source: string; line: number; column: number; sample: string }[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('recordCspViolation', (violation: typeof violations[number]) => violations.push(violation));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', event => {
      (window as unknown as { recordCspViolation(violation: typeof violations[number]): void }).recordCspViolation({ directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile, line: event.lineNumber, column: event.columnNumber, sample: event.sample });
    });
  });
  try {
    const document = await page.goto(h.origin);
    expect(document?.headers()['content-security-policy']).toContain("script-src 'self'");
    await page.getByLabel('用户名', { exact: true }).fill('assets-test');
    await page.getByLabel('密码', { exact: true }).fill(h.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
    const response = await page.request.post(h.origin + '/api/v1/bins', { data: { name: '生产构建验收', value: { message: '中文' } } });
    expect(response.status()).toBe(201);
    const record = await response.json();
    await page.goto(`${h.origin}/#/bins/${record.meta.id}`);
    await expect(page.getByRole('heading', { name: '生产构建验收', exact: true })).toBeVisible();
    const editor = page.getByRole('textbox', { name: 'JSON 编辑器', exact: true });
    await expect(editor).toBeVisible();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(value => navigator.clipboard.writeText(value), '{"message":"已保存中文","enabled":false}');
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+v');
    await page.getByRole('button', { name: '保存 JSON', exact: true }).click();
    await expect(page.locator('.detail-notice[role=status]')).toContainText('保存成功');
    const saved = await (await page.request.get(h.origin + `/api/v1/bins/${record.meta.id}`)).json();
    expect(saved.value).toEqual({ message: '已保存中文', enabled: false });
    expect(saved.meta.currentVersion).toBe(2);
    await page.reload();
    await expect(editor).toBeVisible();
    await page.getByRole('tab', { name: '树形视图', exact: true }).click();
    const tree = page.getByRole('tree', { name: 'JSON 树形视图' });
    await expect(tree.locator('[data-pointer="/message"]')).toContainText('已保存中文');
    await expect(tree.locator('[data-pointer="/enabled"]')).toContainText('false');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '系统信息', exact: true })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出全部业务 ZIP', exact: true }).click();
    const file = await (await download).path();
    expect(file).not.toBeNull();
    const backup = await decodeBackupZip(await readFile(file!));
    expect(backup.bins.find(bin => bin.meta.id === record.meta.id)?.versions.at(-1)?.value).toEqual(saved.value);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '切换明暗主题', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('用户名', { exact: true })).toBeVisible();
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await h.close(); }
});
