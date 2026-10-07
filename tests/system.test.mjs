import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';import { minimalBackup } from './support/backup-fixtures.mjs';
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
test('unpreconditioned restricted writes commit against the authorized snapshot, not a newer one (F03)',async t=>{
 const h=await harness(t);
 const colA=await (await h.request('/collections',{method:'POST',value:{name:'Scope A'}})).json();
 const colB=await (await h.request('/collections',{method:'POST',value:{name:'Scope B'}})).json();
 const key=await (await h.request('/keys',{method:'POST',value:{name:'f03-snapshot',scopes:['bin:update','bin:delete'],resourceAccess:{mode:'restricted',binIds:[],collectionIds:[colA.meta.id]}}})).json();
 const auth={Authorization:`Bearer ${key.token}`};
 // Fire the out-of-scope collection move exactly on the storage commit read
 // (read #2 for restricted keys: #1 is the middleware's authorization read).
 const movedBeforeCommit=(binId,targetId,onRead=2)=>{let metaReads=0;return {...h.env,DATA:h.adapt({get:async(k,...args)=>{
  if(k===`bins/${binId}/meta.json`&&++metaReads===onRead){const stored=await (await h.bucket.get(k)).json();await h.bucket.put(k,JSON.stringify({...stored,collectionId:targetId}));}
  return h.bucket.get(k,...args);}})};};
 // PUT without If-Match: the restricted key must not write the moved, out-of-scope snapshot.
 const putBin=await (await h.request('/bins',{method:'POST',value:{name:'F03 PUT',collectionId:colA.meta.id,value:{secret:false}}})).json();
 assert.equal((await h.request(`/bins/${putBin.meta.id}`,{method:'PUT',headers:auth,value:{value:{hijacked:true}}},movedBeforeCommit(putBin.meta.id,colB.meta.id))).status,412);
 const afterPut=await (await h.request(`/bins/${putBin.meta.id}`)).json();
 assert.deepEqual(afterPut.value,{secret:false},'the out-of-scope write must not land');assert.equal(afterPut.meta.collectionId,colB.meta.id);
 // A retry now authorizes against the moved Bin and is refused outright.
 assert.equal((await h.request(`/bins/${putBin.meta.id}`,{method:'PUT',headers:auth,value:{value:{hijacked:true}}})).status,403);
 // DELETE without If-Match: same binding, the soft delete must not land.
 const delBin=await (await h.request('/bins',{method:'POST',value:{name:'F03 DELETE',collectionId:colA.meta.id,value:{keep:1}}})).json();
 assert.equal((await h.request(`/bins/${delBin.meta.id}`,{method:'DELETE',headers:auth},movedBeforeCommit(delBin.meta.id,colB.meta.id))).status,412);
 assert.equal((await h.request(`/bins/${delBin.meta.id}`)).status,200,'denied delete must not trash the Bin');
 // The same interleave stays legal for the admin session (overwrite-latest semantics).
 const adminBin=await (await h.request('/bins',{method:'POST',value:{name:'F03 admin',collectionId:colA.meta.id,value:{a:1}}})).json();
 assert.equal((await h.request(`/bins/${adminBin.meta.id}`,{method:'PUT',value:{value:{a:2}}},movedBeforeCommit(adminBin.meta.id,colB.meta.id,1))).status,200);
 // Unchanged in-scope snapshot: PUT without If-Match still succeeds for the restricted key.
 const stableBin=await (await h.request('/bins',{method:'POST',value:{name:'F03 stable',collectionId:colA.meta.id,value:{ok:1}}})).json();
 assert.equal((await h.request(`/bins/${stableBin.meta.id}`,{method:'PUT',headers:auth,value:{value:{ok:2}}})).status,200);
});
test('a trash restore that loses the metadata CAS converges its alias side effect to the winner (F04)',async t=>{
 const h=await harness(t);
 const bin=await (await h.request('/bins',{method:'POST',value:{name:'F04 race',slug:'f04-race-slug',value:{v:1}}})).json();
 assert.equal((await h.request(`/bins/${bin.meta.id}`,{method:'DELETE'})).status,200);
 const entry=(await (await h.request('/trash/bins')).json()).items.find(i=>i.meta.id===bin.meta.id);
 const winnerLifecycle=crypto.randomUUID();
 // The concurrent winner commits its restore right before our metadata CAS runs.
 let metaPuts=0;const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{
  if(key===`bins/${bin.meta.id}/meta.json`&&++metaPuts===1)await h.bucket.put(key,JSON.stringify({...bin.meta,lifecycleId:winnerLifecycle}));
  return h.bucket.put(key,...args);}})};
 const res=await h.request(`/trash/bins/${bin.meta.id}/restore`,{method:'POST',headers:{'If-Match':entry.etag}},env);
 assert.equal(res.status,412);
 const alias=await (await h.bucket.get('aliases/bins/f04-race-slug.json')).json();
 assert.equal(alias.lifecycleId,winnerLifecycle,'the loser must not leave its alias pinned to a dead lifecycle');
 assert.equal((await (await h.request(`/bins/${bin.meta.id}`)).json()).meta.lifecycleId,winnerLifecycle);
 assert.equal((await h.request('/b/f04-race-slug')).status,200);
});
test('slug reads heal an alias pinned to a stale lifecycle instead of serving a permanent 404 (F04)',async t=>{
 const h=await harness(t);
 const bin=await (await h.request('/bins',{method:'POST',value:{name:'F04 heal',slug:'f04-heal-slug',value:{v:1}}})).json();
 const stored=await (await h.bucket.get(`bins/${bin.meta.id}/meta.json`)).json();
 // Simulate a lost race whose alias write outlived its rejected lifecycle.
 await h.bucket.put('aliases/bins/f04-heal-slug.json',JSON.stringify({slug:'f04-heal-slug',binId:bin.meta.id,lifecycleId:crypto.randomUUID(),createdAt:new Date().toISOString()}));
 assert.equal((await h.request('/b/f04-heal-slug')).status,200);
 assert.equal((await (await h.bucket.get('aliases/bins/f04-heal-slug.json')).json()).lifecycleId,stored.lifecycleId);
});
test('an interrupted bin restore retries without losing its slug alias (F05)',async t=>{
 const h=await harness(t);
 const p=minimalBackup({keep:true}),id=crypto.randomUUID();p.bins[0].meta.id=id;p.bins[0].meta.slug='f05-resume-slug';
 const input={resource:{kind:'bin',data:p.bins[0]},dependencies:[]};
 // Crash between the alias claim and the final metadata publish (put #2 on the meta key).
 let metaPuts=0;const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{
  if(key===`bins/${id}/meta.json`&&++metaPuts===2)throw Error('interrupted');
  return h.bucket.put(key,...args);}})};
 assert.equal((await h.request('/system/restore',{method:'POST',value:input},env)).status,503);
 assert.ok(await h.bucket.get('aliases/bins/f05-resume-slug.json'),'the first attempt already claimed the alias');
 const retry=await (await h.request('/system/restore',{method:'POST',value:input})).json();
 assert.equal(retry.status,'created');
 assert.equal((retry.warnings??[]).includes('slug_conflict_detached'),false,'own pending claim must not count as a conflict');
 const current=await (await h.request('/bins/'+id)).json();
 assert.equal(current.meta.slug,'f05-resume-slug');
 const alias=await (await h.bucket.get('aliases/bins/f05-resume-slug.json')).json();
 assert.equal(alias.binId,id);assert.equal(alias.lifecycleId,current.meta.lifecycleId);
 assert.equal((await h.request('/b/f05-resume-slug')).status,200);
});
test('normal writes share the business JSON budget: depth, bytes and patch amplification (F11)',async t=>{
 const h=await harness(t);
 const nest=d=>{let v=0;for(let i=0;i<d;i++)v={child:v};return v;};
 // Depth 64 round-trips; 65 is rejected before anything is stored.
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'depth64',value:nest(64)}})).status,201);
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'depth65',value:nest(65)}})).status,422);
 assert.equal((await (await h.request('/bins')).json()).items.filter(b=>b.name==='depth65').length,0);
 // Bytes: a value just under 1MiB is accepted, just over is rejected with 413.
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'big-ok',value:'x'.repeat(1024*1024-100)}})).status,201);
 assert.equal((await h.request('/bins',{method:'POST',value:{name:'big-bad',value:'x'.repeat(1024*1024)}})).status,413);
 const bin=await (await h.request('/bins',{method:'POST',value:{name:'budget',value:{keep:true}}})).json();
 const oversized=await h.request(`/bins/${bin.meta.id}`,{method:'PUT',headers:{'If-Match':bin.etag},value:{value:'y'.repeat(1024*1024)}});
 assert.equal(oversized.status,413);
 assert.equal((await (await h.request(`/bins/${bin.meta.id}/versions`)).json()).total,1,'a rejected overwrite must not append a version');
 // Patch amplification: copying a ~600KB field twice exceeds the result budget.
 const fat=await (await h.request('/bins',{method:'POST',value:{name:'fat',value:{data:'z'.repeat(600*1000)}}})).json();
 const amplified=await h.request(`/bins/${fat.meta.id}`,{method:'PATCH',headers:{'If-Match':fat.etag,'Content-Type':'application/json-patch+json'},body:JSON.stringify([{op:'copy',from:'/data',path:'/a'},{op:'copy',from:'/data',path:'/b'}])});
 assert.equal(amplified.status,413);
 assert.equal((await (await h.request(`/bins/${fat.meta.id}/versions`)).json()).total,1);
 // Legal patches keep working, including root-null merge patch semantics.
 assert.equal((await h.request(`/bins/${bin.meta.id}`,{method:'PATCH',headers:{'If-Match':bin.etag},body:'{"keep":false}'})).status,200);
 const after=await (await h.request(`/bins/${bin.meta.id}`)).json();
 assert.deepEqual(after.value,{keep:false});
 // Oversized raw bodies are cut by the streaming bound before parsing.
 assert.equal((await h.request('/bins',{method:'POST',body:'"'+('x'.repeat(2*1024*1024))+'"'})).status,413);
});
test('content search reserves its read budget from metadata before fetching any value body (F11)',async t=>{
 const h=await harness(t);
 const bin=await (await h.request('/bins',{method:'POST',value:{name:'searchable',value:{needle:'here'}}})).json();
 assert.equal((await h.request(`/bins/${bin.meta.id}/meta`,{method:'PATCH',headers:{'If-Match':bin.etag},value:{contentSearchMode:'all'}})).status,200);
 // Inflate the canonical size so the corpus budget trips; the real value stays tiny.
 const stored=await (await h.bucket.get(`bins/${bin.meta.id}/meta.json`)).json();
 await h.bucket.put(`bins/${bin.meta.id}/meta.json`,JSON.stringify({...stored,size:21*1024*1024}));
 let valueReads=0;const env={...h.env,DATA:h.adapt({get:async(key,...args)=>{
  if(key.startsWith(`bins/${bin.meta.id}/versions/`))valueReads++;
  return h.bucket.get(key,...args);}})};
 const res=await h.request('/search/content?q=needle',{},env);
 assert.equal(res.status,503);assert.equal((await res.json()).error,'content_search_limit_exceeded');
 assert.equal(valueReads,0,'the budget must trip before any value body is read');
});
