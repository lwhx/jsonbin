import {test} from 'node:test';import assert from 'node:assert/strict';import {createSystemHarness} from './support/system-harness.mjs';
async function harness(t){const h=await createSystemHarness('import-'+crypto.randomUUID());t.after(()=>h.close());return h;}
test('ordinary import creates one Bin per value and uses server defaults',async t=>{
 const h=await harness(t);await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':'"settings-default-v1"'},value:{defaultVisibility:'public',defaultTtlSeconds:60}});
 const values=[null,false,[1,2],'中文',0,{format:'jsonbin-backup',secret:'business'}];const r=await h.request('/system/import',{method:'POST',value:{items:values.map((value,i)=>({name:'文件'+i,value}))}});assert.equal(r.status,200);const data=await r.json();assert.equal(data.results.length,values.length);
 for(const item of data.results){assert.equal(item.status,'created');const bin=await (await h.request('/bins/'+item.id)).json();assert.deepEqual(bin.value,values[item.index]);assert.equal(bin.meta.visibility,'public');assert.ok(bin.meta.expiresAt);assert.equal(bin.meta.currentVersion,1);}
});
test('invalid batch structure or value limits create no business objects',async t=>{
 const h=await harness(t);let deep=null;for(let i=0;i<65;i++)deep={child:deep};
 for(const value of [{items:[]},{items:[{name:'missing'}]},{items:[{name:'valid',value:null},{name:'',value:1}]},{items:Array.from({length:101},()=>({name:'x',value:null}))},{items:[{name:'x',value:deep}]},{items:[{name:'x',value:null,secret:true}]}])assert.equal((await h.request('/system/import',{method:'POST',value})).status,422);
 assert.equal((await h.request('/system/import',{method:'POST',body:'{"items":[{"name":"overflow","value":1e999}]}'})).status,422);
 assert.equal((await h.request('/system/import',{method:'POST',value:{items:[{name:'large',value:'x'.repeat(1024*1024)}]}})).status,413);
 assert.equal((await h.request('/system/import',{method:'POST',headers:{'Content-Length':'1'},body:' '.repeat(10*1024*1024+1)})).status,413);
 assert.equal((await h.request('/system/import',{method:'POST',body:Uint8Array.of(0xff)})).status,400);assert.equal((await (await h.request('/bins')).json()).items.length,0);
});
test('partial storage failure continues independent items and reports success individually',async t=>{
 const h=await harness(t);let metas=0;const diagnostics=[];t.mock.method(console,'error',(...args)=>diagnostics.push(args));const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{if(key.startsWith('bins/')&&key.endsWith('/meta.json')&&++metas===2)throw Error('private-storage-canary');if(key.startsWith('activity/'))throw Error('private-audit-canary');return h.bucket.put(key,...args);}})};
 const r=await h.request('/system/import',{method:'POST',value:{items:[1,2,3].map(value=>({name:'item',value}))}},env);assert.equal(r.status,200);const result=await r.json();assert.deepEqual(result.results.map(r=>r.status),['created','failed','created']);assert.equal(result.results[1].error,'storage_unavailable');assert.equal((await (await h.request('/bins')).json()).items.length,2);assert.ok(!JSON.stringify(diagnostics).includes('canary'));
});
test('ordinary import accepts batch and value depth boundaries, and rejects Bearer plus Cookie',async t=>{
 const h=await harness(t);let value=0;for(let i=0;i<64;i++)value={child:value};const items=Array.from({length:100},(_,i)=>({name:'item'+i,value:i===0?value:null}));const r=await h.request('/system/import',{method:'POST',value:{items}});assert.equal(r.status,200);assert.equal((await r.json()).results.filter(x=>x.status==='created').length,100);
 assert.equal((await h.request('/system/import',{method:'POST',headers:{Authorization:'Bearer x'},value:{items}})).status,401);assert.equal((await h.request('/system/import',{method:'POST',headers:{Origin:'https://evil.test'},value:{items}})).status,403);
});
