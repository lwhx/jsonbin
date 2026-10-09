import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSystemHarness} from './support/system-harness.mjs';
import {minimalBackup,when} from './support/backup-fixtures.mjs';
import {fingerprintResource,validateBackup,MAX_BACKUP_BYTES} from '../src/shared/backup.ts';
async function harness(t){const h=await createSystemHarness('boundaries-'+crypto.randomUUID());t.after(()=>h.close());return h;}
function deepValue(){let value=Array(90000).fill(null);value[0]={text:'保留 空格\t\n"\\', '':false};for(let i=0;i<60;i++)value={a:value};return value;}
function binRequest(value=null){const p=minimalBackup(value);p.bins[0].meta.id=crypto.randomUUID();validateBackup(p);return {resource:{kind:'bin',data:p.bins[0]},dependencies:[]};}
const restore=(h,input,env=h.env)=>h.request('/system/restore',{method:'POST',value:input},env);
test('legal deep backup restores compactly and resumes an existing pretty pending file without overwrite',async t=>{
 const h=await harness(t),value=deepValue(),input=binRequest(value),id=input.resource.data.meta.id;
 assert.ok(JSON.stringify(value,null,2).length>MAX_BACKUP_BYTES);
 let r=await restore(h,input);assert.equal(r.status,200);assert.equal((await r.json()).status,'created');
 assert.deepEqual((await (await h.request('/bins/'+id)).json()).value,value);
 assert.ok((await h.bucket.head(`bins/${id}/versions/000001.json`)).size<MAX_BACKUP_BYTES);
 assert.equal((await (await restore(h,input)).json()).status,'unchanged');
 const resumed=binRequest(value),rid=resumed.resource.data.meta.id,key=`bins/${rid}/versions/000001.json`;
 await h.bucket.put(`bins/${rid}/meta.json`,JSON.stringify({importState:'pending',kind:'bin',id:rid,fingerprint:await fingerprintResource(resumed.resource),startedAt:when}));
 await h.bucket.put(key,JSON.stringify(value,null,2),{customMetadata:{originalUploadedAt:when,restoreOrder:'0'}});const before=(await h.bucket.head(key)).etag;
 r=await restore(h,resumed);assert.equal(r.status,200);assert.equal((await r.json()).status,'created');assert.equal((await h.bucket.head(key)).etag,before);
 assert.deepEqual((await (await h.request('/system/export?scope=all&format=backup')).json()).bins.find(b=>b.meta.id===rid).versions[0].value,value);
});
test('backup export budgets business JSON instead of legacy storage indentation',async t=>{
 const h=await harness(t),value=deepValue();const created=await h.request('/bins',{method:'POST',value:{name:'深层值',value}});assert.equal(created.status,201);const id=(await created.json()).meta.id;
 assert.ok((await h.bucket.head(`bins/${id}/versions/000001.json`)).size>MAX_BACKUP_BYTES);
 const r=await h.request(`/system/export?scope=bin&id=${id}&format=backup`);assert.equal(r.status,200);const bytes=await r.arrayBuffer();assert.ok(bytes.byteLength<MAX_BACKUP_BYTES);assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)).bins[0].versions[0].value,value);
});
test('saved current JSON export ignores unrelated history defaults and dependencies but rechecks its snapshot',async t=>{
 const h=await harness(t),input=binRequest(false),id=input.resource.data.meta.id;assert.equal((await restore(h,input)).status,200);
 for(let v=2;v<=249;v++)await h.bucket.put(`bins/${id}/versions/${String(v).padStart(6,'0')}.json`,'false');
 const url=`/system/export?scope=bin&id=${id}&format=value`;let r=await h.request(url);assert.equal(r.status,200);assert.equal(await r.json(),false);
 await h.bucket.put('system/settings.json','{}');await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify({...input.resource.data.meta,collectionId:crypto.randomUUID(),schemaId:crypto.randomUUID(),schemaRevision:1}));
 r=await h.request(url);assert.equal(r.status,200);assert.equal(await r.json(),false);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-disposition'),/attachment/);
 let changed=false;const env={...h.env,DATA:h.adapt({get:async(key,...args)=>{const stored=await h.bucket.get(key,...args);if(!changed&&key.endsWith('/versions/000001.json')){changed=true;await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify({...input.resource.data.meta,name:'并发修改'}));}return stored;}})};
 r=await h.request(url,{},env);assert.equal(r.status,409);assert.equal((await r.json()).error,'backup_changed');
 await h.bucket.delete(`bins/${id}/versions/000001.json`);assert.equal((await h.request(url)).status,409);
 const failed=await h.request(url,{}, {...h.env,DATA:h.adapt({get:async(key,...args)=>{if(key==='system/auth/sessions.json')return h.bucket.get(key,...args);throw Error('storage-fault-canary');}})});assert.equal(failed.status,503);assert.equal((await failed.json()).error,'storage_unavailable');
});
test('restored safe counter exhaustion rejects Bin and Schema writes without changing history or metadata',async t=>{
 const h=await harness(t),max=Number.MAX_SAFE_INTEGER;
 for(const kind of ['bin','schema'])for(const orphan of [false,true]){
  let input;
  if(kind==='bin'){input=binRequest(false);const b=input.resource.data;b.meta.currentVersion=orphan?1:max;b.versions[0].version=b.meta.currentVersion;if(orphan)b.versions.push({version:max,uploadedAt:when,value:null});}
  else {const id=crypto.randomUUID();input={resource:{kind:'schema',data:{meta:{id,name:'边界模型',description:'',status:'active',currentRevision:orphan?1:max,createdAt:when,updatedAt:when},revisions:[{revision:orphan?1:max,uploadedAt:when,schema:true},...(orphan?[{revision:max,uploadedAt:when,schema:false}]:[])]}},dependencies:[]};}
  assert.equal((await restore(h,input)).status,200);const id=input.resource.data.meta.id,ns=kind==='bin'?'bins':'schemas',prefix=`${ns}/${id}/`,key=prefix+'meta.json';const before=await (await h.bucket.get(key)).text(),files=(await h.bucket.list({prefix})).objects.map(o=>[o.key,o.etag]);
  const current=await (await h.request(`/${ns}/${id}`)).json();const r=await h.request(`/${ns}/${id}`,{method:'PUT',headers:{'If-Match':current.etag},value:kind==='bin'?{value:true}:{name:'新模型',schema:true}});
  assert.equal(r.status,409);assert.equal((await r.json()).error,kind==='bin'?'version_limit_reached':'revision_limit_reached');assert.equal(await (await h.bucket.get(key)).text(),before);assert.deepEqual((await h.bucket.list({prefix})).objects.map(o=>[o.key,o.etag]),files);
  assert.equal((await h.request('/system/export?scope=all&format=backup')).status,200);
 }
});
test('counter reservation competition cannot advance beyond the maximum safe integer',async t=>{
 const h=await harness(t),max=Number.MAX_SAFE_INTEGER;
 for(const kind of ['bin','schema']){
  let input;if(kind==='bin'){input=binRequest(false);input.resource.data.meta.currentVersion=max-1;input.resource.data.versions[0].version=max-1;}
  else input={resource:{kind:'schema',data:{meta:{id:crypto.randomUUID(),name:'竞争模型',description:'',status:'active',currentRevision:max-1,createdAt:when,updatedAt:when},revisions:[{revision:max-1,uploadedAt:when,schema:true}]}},dependencies:[]};
  assert.equal((await restore(h,input)).status,200);const id=input.resource.data.meta.id,ns=kind==='bin'?'bins':'schemas',prefix=`${ns}/${id}/`,current=await (await h.request(`/${ns}/${id}`)).json();let competed=false;
  const env={...h.env,DATA:h.adapt({put:async(key,value,options)=>{if(!competed&&key.endsWith('/'+max+'.json')){competed=true;await h.bucket.put(key,value,options);return null;}return h.bucket.put(key,value,options);}})};
  const r=await h.request(`/${ns}/${id}`,{method:'PUT',headers:{'If-Match':current.etag},value:kind==='bin'?{value:true}:{name:'新模型',schema:true}},env);assert.equal(r.status,409);assert.equal((await r.json()).error,kind==='bin'?'version_limit_reached':'revision_limit_reached');assert.ok(competed);
  const meta=(await (await h.bucket.get(prefix+'meta.json')).json());assert.equal(meta[kind==='bin'?'currentVersion':'currentRevision'],max-1);assert.ok((await h.bucket.list({prefix})).objects.filter(o=>!o.key.endsWith('meta.json')).every(o=>Number.isSafeInteger(Number(o.key.split('/').at(-1).slice(0,-5)))));
 }
});

test('stored JSON normalization rejects separated primitive tokens instead of repairing them',async t=>{
 const h=await harness(t),input=binRequest(false),id=input.resource.data.meta.id;assert.equal((await restore(h,input)).status,200);
 for(const malformed of ['f alse','1 2','"a" "b"']){
  await h.bucket.put(`bins/${id}/versions/000001.json`,malformed);
  assert.equal((await h.request(`/system/export?scope=bin&id=${id}&format=value`)).status,409);
  assert.equal((await h.request('/system/export?scope=all&format=backup')).status,409);
 }
});
