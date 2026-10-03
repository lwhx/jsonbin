import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
async function harness(t) {const h=await createSystemHarness('system-'+crypto.randomUUID()); t.after(()=>h.close()); return h;}
test('virtual settings read is read-only; first and later writes use CAS',async t=>{
 const h=await harness(t), r=await h.request('/system/settings'); assert.equal(r.status,200);
 const initial=await r.json(); assert.equal(initial.etag,'"settings-default-v1"'); assert.equal(initial.settings.updatedAt,null); assert.equal(await h.bucket.get('system/settings.json'),null);
 assert.equal((await h.request('/system/settings',{method:'PATCH',value:{defaultVisibility:'public'}})).status,428);
 const patch=()=>h.request('/system/settings',{method:'PATCH',headers:{'If-Match':initial.etag},value:{defaultVisibility:'public',defaultTtlSeconds:60}});
 assert.deepEqual((await Promise.all([patch(),patch()])).map(r=>r.status).sort(),[200,412]);
 const current=await (await h.request('/system/settings')).json(); assert.equal(current.settings.defaultVisibility,'public'); assert.ok(Date.parse(current.settings.updatedAt));
 for(const value of [{},{unknown:true},{defaultTtlSeconds:0},{defaultTtlSeconds:31536001},{defaultVisibility:'secret'}]) assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':current.etag},value})).status,422);
 assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':current.etag},value:{defaultTtlSeconds:null}})).status,200);
 const activity=await (await h.request('/activity?resourceType=system')).json(); assert.equal(activity.items.length,2); assert.ok(activity.items.every(x=>x.action==='system.settings_updated'&&x.resourceId===null));
});
test('creation defaults apply only to omitted fields and never rewrite existing Bins',async t=>{
 const h=await harness(t); const old=await (await h.request('/bins',{method:'POST',value:{name:'old',value:null}})).json();
 const initial=await (await h.request('/system/settings')).json(); assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':initial.etag},value:{defaultVisibility:'public',defaultTtlSeconds:60}})).status,200);
 const now=Date.now(); const created=await (await h.request('/bins',{method:'POST',value:{name:'defaults',value:false}})).json(); assert.equal(created.meta.visibility,'public'); assert.ok(Date.parse(created.meta.expiresAt)>=now+60000);
 const explicit=await (await h.request('/bins',{method:'POST',value:{name:'explicit',value:[],visibility:'private',expiresAt:null}})).json(); assert.equal(explicit.meta.visibility,'private'); assert.equal(explicit.meta.expiresAt,null);
 const previous=await (await h.request('/bins/'+old.meta.id)).json(); assert.equal(previous.meta.visibility,'private'); assert.equal(previous.meta.expiresAt,null);
 await h.bucket.put('system/settings.json','{"bad":true}'); assert.equal((await h.request('/system/settings')).status,503);
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'explicit',value:0,visibility:'private',expiresAt:null}})).status,201);
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'defaults',value:0}})).status,503);
});
test('management Session rejection is no-store and does not intercept public health',async t=>{
 const h=await harness(t); assert.equal((await h.request('/system/health',{headers:{Cookie:''}})).status,200);
 for(const path of ['/system/info','/system/settings']) for(const headers of [{Cookie:''},{Authorization:'Bearer nope'}]) {const r=await h.request(path,{headers}); assert.equal(r.status,401); assert.equal(r.headers.get('cache-control'),'no-store');}
 assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{Origin:'https://evil.test'},value:{defaultVisibility:'public'}})).status,403);
 const request=new Request('https://example.test/api/v1/system/settings',{method:'PATCH',headers:{Authorization:'Bearer nope'},body:'x'});
 Object.defineProperty(request,'body',{get(){throw new Error('body_must_not_be_read');}}); assert.equal((await h.worker.fetch(request,h.env)).status,401);
});
test('system info uses read probes and reports failures without secrets or partial counts',async t=>{
 const h=await harness(t); const r=await h.request('/system/info'); assert.equal(r.status,200); const info=await r.json(); assert.equal(info.storage.r2,'reachable'); assert.equal(info.storage.kv,'reachable'); assert.equal(info.statistics.data.activeBins,0);
 const canary='secret-canary', fault={...h.env,DATA:h.adapt({head:async()=>{throw Error(canary)},list:async()=>{throw Error(canary)}}),CACHE:{get:async()=>{throw Error(canary)}},GITHUB_CLIENT_ID:canary,GITHUB_CLIENT_SECRET:canary,GITHUB_ALLOWED_USER_ID:'1'};
 const failed=await (await h.request('/system/info',{},fault)).json(); assert.equal(failed.storage.r2,'unavailable'); assert.equal(failed.statistics.status,'unavailable'); assert.equal(failed.oauth.githubConfigured,true); assert.ok(!JSON.stringify(failed).includes(canary));
 for(const count of [501,10001]) {let reads=0; const records=Array.from({length:count},(_,i)=>({key:`bins/${String(i).padStart(36,'0')}/${count===501?'meta.json':'versions/000001.json'}`,size:1})); const env={...h.env,DATA:h.adapt({list:async()=>({objects:records,truncated:false}),get:async()=>{reads++;return {json:async()=>({})}}})}; const result=await (await h.request('/system/info',{},env)).json(); assert.equal(result.statistics.status,'unavailable'); assert.equal(result.statistics.error,'statistics_limit_exceeded'); assert.ok(!('data' in result.statistics)); assert.ok(reads<=500);}
});
test('bounded settings reads reject actual excess bytes and invalid UTF-8; audit failure preserves CAS success',async t=>{
 const h=await harness(t),etag='"settings-default-v1"';
 assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':etag,'Content-Length':'2'},body:' '.repeat(4097)})).status,413);
 assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':etag},body:Uint8Array.of(0xff)})).status,400);
 const diagnostics=[];t.mock.method(console,'error',(...args)=>diagnostics.push(args));
 const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{if(key.startsWith('activity/'))throw Error('audit-secret');return h.bucket.put(key,...args);}})};
 assert.equal((await h.request('/system/settings',{method:'PATCH',headers:{'If-Match':etag},value:{defaultVisibility:'public'}},env)).status,200);
 assert.equal((await (await h.request('/system/settings')).json()).settings.defaultVisibility,'public'); assert.ok(!JSON.stringify(diagnostics).includes('audit-secret'));
});
