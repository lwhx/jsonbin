import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{
  expect((await page.request.post('/api/v1/auth/login',{data:{username:'browser-test',password:process.env.JSONBIN_TEST_PASSWORD}})).status()).toBe(200);
});
test('文档导航刷新三语言复制与移动端深色',async({page})=>{
  await page.goto('/'); const nav=page.getByRole('button',{name:'API 文档',exact:true});await expect(nav).toBeEnabled();await nav.click();await expect(page).toHaveURL(/#\/docs$/);
  await expect(page.locator('.docs-page')).toContainText('ETag 与并发更新');await expect(page.locator('.docs-page')).toContainText('Schema API');
  await expect(page.locator('.docs-page')).toContainText('/value/a~1b/x~0y/');
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  for(const language of ['curl','javascript','python']){
    await page.getByLabel('示例语言',{exact:true}).selectOption(language);
        const block=page.locator('.code-example').first();const code=await block.locator('code').innerText();
    await block.getByRole('button',{name:'复制代码',exact:true}).click();await expect(block.getByRole('status')).toHaveText('已复制。');
    const copied = await page.evaluate(()=>navigator.clipboard.readText());
    expect(copied.split(/\r?\n/).join('\n')).toBe(code.split(/\r?\n/).join('\n'));
  }
  await page.getByRole('navigation',{name:'文档目录'}).getByRole('button',{name:'错误码与恢复',exact:true}).click();await expect(page).toHaveURL(/#\/docs$/);
  await page.reload();await expect(page.locator('.docs-page')).toBeVisible();await expect(page.getByLabel('示例语言',{exact:true})).toHaveValue('curl');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'切换明暗主题'}).click();await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('剪贴板拒绝保留代码，旧复制结果不污染切换语言后的反馈',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).releaseCopy=undefined;(window as any).copyMode='fail';
    Object.defineProperty(navigator,'clipboard',{value:{writeText:()=> (window as any).copyMode==='fail'?Promise.reject(new Error('blocked')):new Promise<void>(resolve=>{(window as any).releaseCopy=resolve;})}});
  });
  await page.goto('/#/docs');const block=page.locator('.code-example').first();await expect(block).toBeVisible();const code=await block.locator('code').innerText();
  await block.getByRole('button',{name:'复制代码',exact:true}).click();await expect(block.getByRole('alert')).toContainText('手动');await expect(block.locator('code')).toHaveText(code);
  await page.evaluate(()=>{(window as any).copyMode='slow';});await block.getByRole('button',{name:'复制代码',exact:true}).click();
  await page.getByLabel('示例语言',{exact:true}).selectOption('javascript');await page.evaluate(()=>{(window as any).releaseCopy();});await expect(block.getByRole('status')).toBeHidden();
  await block.getByRole('button',{name:'复制代码',exact:true}).click();await page.getByRole('button',{name:'概览',exact:true}).click();await page.evaluate(()=>{(window as any).releaseCopy();});await expect(page.locator('.docs-page')).toBeHidden();
});
test('Bin API 只展示演示 JSON，动态状态刷新并保留草稿和离页确认',async({page})=>{
  const marker='private-canary-'+crypto.randomUUID();
  const record=await(await page.request.post('/api/v1/bins',{data:{name:'文档验收',value:{secret:marker}}})).json();const path='/api/v1/bins/'+record.meta.id;
  await page.goto('/#/bins/'+record.meta.id);await page.getByRole('tab',{name:'API',exact:true}).click();const panel=page.getByRole('tabpanel');
  await expect(panel).not.toContainText(marker);await expect(panel).toContainText(record.meta.id);await expect(panel).toContainText(record.etag);
  const writes:string[]=[];page.on('request',req=>{if(['POST','PUT','PATCH','DELETE'].includes(req.method())&&req.url().includes('/api/'))writes.push(req.url());});
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);await panel.getByLabel('示例语言',{exact:true}).selectOption('javascript');
  const first=panel.locator('.code-example').first();await first.getByRole('button',{name:'复制代码',exact:true}).click();expect(await page.evaluate(()=>navigator.clipboard.readText())).not.toContain(marker);
  await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('未保存-'+marker);await page.getByLabel('可见性',{exact:true}).selectOption('public');
  await page.getByRole('tab',{name:'API',exact:true}).click();await expect(panel).toContainText('此数据仓为私有');await expect(panel).not.toContainText(marker);
  await page.getByRole('tab',{name:'设置',exact:true}).click();await expect(page.getByLabel('名称',{exact:true})).toHaveValue('未保存-'+marker);
  await page.getByRole('tab',{name:'API',exact:true}).click();await page.getByRole('button',{name:'API 文档',exact:true}).click();await page.getByRole('dialog',{name:'放弃未保存的修改？',exact:true}).getByRole('button',{name:'继续编辑',exact:true}).click();await expect(page).toHaveURL(new RegExp(record.meta.id));expect(writes).toEqual([]);
  await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'保存设置',exact:true}).click();await expect(page.locator('.detail-notice')).toContainText('设置保存成功');
  const saved=await(await page.request.get(path)).json();await page.getByRole('tab',{name:'API',exact:true}).click();await expect(panel).toContainText('此数据仓已公开');await expect(panel).toContainText(saved.etag);
  const remote=await page.request.put(path,{headers:{'If-Match':saved.etag},data:{value:{other:marker}}});expect(remote.status()).toBe(200);const changed=await remote.json();
  await page.getByRole('button',{name:'重新加载',exact:true}).click();await expect(panel).toContainText(changed.etag);await expect(panel).not.toContainText(marker);
  await page.getByRole('tab',{name:'设置',exact:true}).click();await page.getByLabel('名称',{exact:true}).fill('新草稿');await page.getByRole('button',{name:'API 文档',exact:true}).click();await page.getByRole('dialog',{name:'放弃未保存的修改？',exact:true}).getByRole('button',{name:'放弃并离开',exact:true}).click();await expect(page).toHaveURL(/#\/docs$/);
});
test('JSON 草稿在 API 页签往返保持，移动端示例和复制不泄露内容',async({page})=>{
  const saved='stored-'+crypto.randomUUID(),draft='draft-'+crypto.randomUUID();
  const bin=await(await page.request.post('/api/v1/bins',{data:{name:'JSON 草稿',value:{secret:saved}}})).json();
  await page.goto('/#/bins/'+bin.meta.id);await expect(page.locator('.monaco-editor')).toBeVisible();
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);await page.evaluate(text=>navigator.clipboard.writeText(text),JSON.stringify({secret:draft}));
  await page.getByRole('textbox',{name:'JSON 编辑器',exact:true}).focus();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.dirty-badge')).toBeVisible();await page.getByRole('tab',{name:'API',exact:true}).click();const panel=page.getByRole('tabpanel');
  await expect(panel).not.toContainText(saved);await expect(panel).not.toContainText(draft);await panel.locator('.code-example').first().getByRole('button',{name:'复制代码',exact:true}).click();
  const code=await page.evaluate(()=>navigator.clipboard.readText());expect(code).not.toContain(saved);expect(code).not.toContain(draft);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'切换明暗主题'}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('tab',{name:'编辑器',exact:true}).click();await expect(page.locator('.monaco-editor')).toContainText(draft);await expect(page.getByRole('button',{name:'保存 JSON',exact:true})).toBeEnabled();
});
