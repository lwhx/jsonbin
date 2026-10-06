import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{
  expect((await page.request.post('/api/v1/auth/login',{data:{username:'browser-test',password:process.env.JSONBIN_TEST_PASSWORD}})).status()).toBe(200);
});
test('MCP 接入页导航、端点片段渲染与复制不发起请求',async({page})=>{
  const requests:string[]=[];
  page.on('request',req=>{ if(req.url().includes('/api/v1/mcp')) requests.push(req.url()); });
  await page.goto('/');
  const nav=page.getByRole('button',{name:'MCP 接入',exact:true});
  await expect(nav).toBeEnabled();await nav.click();
  await expect(page).toHaveURL(/#\/mcp$/);
  const view=page.locator('.mcp-page');
  await expect(view).toContainText('Model Context Protocol');
  await expect(view).toContainText('bin:read');
  await expect(view).toContainText('json_patch_bin');
  await expect(view).toContainText('前往 API 密钥');
  // Snippets use the current deployment origin and streamable endpoint.
  await expect(view.locator('pre code').first()).toContainText('127.0.0.1:5174/api/v1/mcp');
  // Copy works and matches the visible code exactly.
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  const block=view.locator('.code-example').first();const code=await block.locator('code').innerText();
  await block.getByRole('button',{name:'复制代码',exact:true}).click();
  await expect(block.getByRole('status')).toHaveText('已复制。');
  expect((await page.evaluate(()=>navigator.clipboard.readText())).split(/\r?\n/).join('\n')).toBe(code.split(/\r?\n/).join('\n'));
  // Viewing this page performs no MCP or business requests.
  expect(requests).toEqual([]);
});
test('令牌只驻留页面内存并即时反映到片段，清空即回落占位符',async({page})=>{
  await page.goto('/#/mcp');
  const input=page.getByLabel('API 令牌',{exact:true});
  await input.fill('jb_live_browser_test_token');
  await expect(page.locator('.code-example code').first()).toContainText('jb_live_browser_test_token');
  await expect(page.locator('.code-example code').nth(3)).toContainText('jb_live_browser_test_token');
  // 显示/隐藏明文切换
  await page.getByRole('button',{name:'显示或隐藏令牌',exact:true}).click();
  await expect(input).toHaveAttribute('type','text');
  await input.fill('');
  await expect(page.locator('.code-example code').first()).not.toContainText('jb_live_browser_test_token');
  // 刷新后令牌不残留
  await input.fill('jb_live_browser_test_token');
  await page.reload();
  await expect(page.locator('.mcp-page')).toBeVisible();
  await expect(page.locator('.code-example code').first()).not.toContainText('jb_live_browser_test_token');
});
test('密钥页跳转与移动端深色无横向溢出',async({page})=>{
  await page.goto('/#/mcp');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'切换明暗主题'}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'前往 API 密钥',exact:true}).click();
  await expect(page).toHaveURL(/#\/keys$/);
});
