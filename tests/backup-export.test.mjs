import {test} from 'node:test';import assert from 'node:assert/strict';
import {createSystemHarness} from './support/system-harness.mjs';import {richBackup} from './support/backup-fixtures.mjs';
async function harness(t){const h=await createSystemHarness('export-'+crypto.randomUUID());t.after(()=>h.close());return h;}
export async function seed(h,p=richBackup()){
 for(const c of p.collections)await h.bucket.put(`collections/${c.meta.id}/meta.json`,JSON.stringify(c.meta));
 for(const s of p.schemas){await h.bucket.put(`schemas/${s.meta.id}/meta.json`,JSON.stringify(s.meta));for(const v of s.revisions)await h.bucket.put(`schemas/${s.meta.id}/revisions/${String(v.revision).padStart(6,'0')}.json`,JSON.stringify(v.schema),{customMetadata:{originalUploadedAt:v.uploadedAt}});}
 for(const b of p.bins){await h.bucket.put(`bins/${b.meta.id}/meta.json`,JSON.stringify({...b.meta,lifecycleId:crypto.randomUUID()}),{customMetadata:{restoreFingerprint:'private-receipt'}});for(const v of b.versions)await h.bucket.put(`bins/${b.meta.id}/versions/${String(v.version).padStart(6,'0')}.json`,JSON.stringify(v.value),{customMetadata:{originalUploadedAt:v.uploadedAt}});}
 for(const b of p.purged)await h.bucket.put(`bins/${b.id}/meta.json`,JSON.stringify({...b,purgeState:'purged'}));return p;
}
test('export preserves history and pinned archived models, canonical precedence and terminal privacy',async t=>{
 const h=await harness(t),p=await seed(h),id=p.bins[0].meta.id;
 await h.bucket.put(`trash/bins/${id}/meta.json`,JSON.stringify({...p.bins[0].meta,name:'stale',deletedAt:p.exportedAt}));
 for(const key of ['keys/private.json','system/auth/config.json','unknown/data.json',`bins/${p.purged[0].id}/versions/999999.json`])await h.bucket.put(key,'"secret-canary"');
 const response=await h.request('/system/export?scope=all&format=backup');assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.deepEqual(result.bins,p.bins);assert.deepEqual(result.schemas,p.schemas);assert.deepEqual(result.purged,p.purged);assert.ok(!JSON.stringify(result).includes('secret-canary'));assert.ok(!JSON.stringify(result).includes('private-receipt'));
 const single=await (await h.request(`/system/export?scope=bin&id=${id}&format=backup`)).json();assert.equal(single.schemas.length,1);assert.equal(single.collections.length,1);assert.equal(single.bins.length,1);assert.equal(single.purged.length,0);
 const raw=await h.request(`/system/export?scope=bin&id=${id}&format=value`);assert.equal(await raw.json(),false);
 const config=await (await h.request('/system/export?scope=config&format=backup')).json();assert.equal(config.bins.length,0);assert.equal(config.schemas.length,0);
});
test('export accepts legacy optional defaults and retains user JSON canaries without automatic redaction',async t=>{
 const h=await harness(t),p=richBackup();p.bins[0].meta.collectionId=null;p.bins[0].meta.schemaId=null;p.bins[0].meta.schemaRevision=null;p.bins[0].meta.schemaLocked=false;p.bins[0].versions[0].value={secret:'business-canary',format:'jsonbin-backup'};p.bins[0].meta.size=JSON.stringify(p.bins[0].versions[0].value).length;await seed(h,p);
 const id=p.bins[0].meta.id,meta={...p.bins[0].meta,deletedAt:p.exportedAt};for(const key of ['collectionId','schemaId','schemaRevision','schemaLocked','locked','expiresAt'])delete meta[key];await h.bucket.delete(`bins/${id}/meta.json`);await h.bucket.put(`trash/bins/${id}/meta.json`,JSON.stringify(meta));
 const r=await h.request('/system/export?scope=all&format=backup');assert.equal(r.status,200);const b=(await r.json()).bins[0];assert.equal(b.meta.expiresAt,null);assert.equal(b.meta.deletionReason,'manual');assert.equal(b.versions[0].value.secret,'business-canary');
});
test('export rejects ambiguous queries and incomplete or changing snapshots',async t=>{
 const h=await harness(t),p=await seed(h),id=p.bins[0].meta.id;
 for(const query of ['','scope=all&format=value','scope=all&format=backup&scope=all','scope=all&format=backup&x=1','scope=bin&id=no&format=backup'])assert.equal((await h.request('/system/export?'+query)).status,400);
 for(const transition of [{importState:'pending'},{purgeState:'purging'}]){await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify({...p.bins[0].meta,...transition}));assert.equal((await h.request('/system/export?scope=all&format=backup')).status,409);}await seed(h,p);
 await h.bucket.delete(`bins/${id}/versions/000001.json`);assert.equal((await h.request('/system/export?scope=all&format=backup')).status,409);await seed(h,p);
 let changed=false;const bindings={...h.env,DATA:h.adapt({get:async(key,...args)=>{const result=await h.bucket.get(key,...args);if(!changed&&key.endsWith('/versions/000001.json')){changed=true;await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify({...p.bins[0].meta,name:'changed'}));}return result;}})};
 const r=await h.request('/system/export?scope=all&format=backup',{},bindings);assert.equal(r.status,409);assert.equal((await r.json()).error,'backup_changed');
});
test('export catches late directory changes and fails closed at package resource limits',async t=>{
 const h=await harness(t),p=await seed(h),id=p.bins[0].meta.id;let changed=false;
 const env={...h.env,DATA:h.adapt({get:async(key,...args)=>{const result=await h.bucket.get(key,...args);if(!changed&&key.endsWith('/versions/000004.json')){changed=true;await h.bucket.put(`bins/${id}/versions/000005.json`,'null');}return result;}})};
 const r=await h.request('/system/export?scope=all&format=backup',{},env);assert.equal(r.status,409);assert.equal((await r.json()).error,'backup_changed');
 for(let i=0;i<101;i++){const id=crypto.randomUUID();await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify({id,deletedAt:p.exportedAt,purgeState:'purged'}));}assert.equal((await h.request('/system/export?scope=all&format=backup')).status,413);
});

test('audit: v2 export includes templates with history and round-trips through restore',async t=>{
 const h=await harness(t);
 // Build a schema + template with two versions through the live APIs.
 const schema=await (await h.request('/schemas',{method:'POST',value:{name:'备份模型',schema:{type:'boolean'}}})).json();
 const tpl=await (await h.request('/templates',{method:'POST',value:{name:'备份模板',value:true,schemaId:schema.meta.id}})).json();
 const updated=await h.request(`/templates/${tpl.meta.id}`,{method:'PATCH',headers:{'If-Match':tpl.etag},value:{value:false}});
 assert.equal(updated.status,200);

 const exported=await (await h.request('/system/export?scope=all&format=backup')).json();
 assert.equal(exported.schemaVersion,2);
 assert.equal(exported.templates.length,1);
 const backupTemplate=exported.templates[0];
 assert.equal(backupTemplate.meta.id,tpl.meta.id);
 assert.deepEqual(backupTemplate.meta.tags,[]);
 assert.equal(backupTemplate.meta.schemaId,schema.meta.id);
 assert.equal(backupTemplate.meta.schemaRevision,1);
 assert.deepEqual(backupTemplate.versions.map(v=>v.value),[true,false]);

 // Restore into a clean bucket and re-export: the template history must be identical.
 const other=await harness(t);
 const fingerprintInput={kind:'schema',data:exported.schemas.find(s=>s.meta.id===schema.meta.id)};
 const {fingerprintResource}=await import('../src/shared/backup.ts');
 const restoreRes=await other.request('/system/restore',{method:'POST',value:{resource:fingerprintInput,dependencies:[]}});
 assert.equal((await restoreRes.json()).status,'created');
 const tplInput={kind:'template',data:backupTemplate};
 const tplRestore=await other.request('/system/restore',{method:'POST',value:{resource:tplInput,dependencies:[{kind:'schema',id:schema.meta.id,fingerprint:await fingerprintResource(fingerprintInput)}]}});
 assert.equal(tplRestore.status,200);
 assert.equal((await tplRestore.json()).status,'created');
 const list=await (await other.request('/templates')).json();
 assert.equal(list.items.length,1);
 assert.deepEqual(list.items[0],{...backupTemplate.meta});
 const fetched=await (await other.request(`/templates/${tpl.meta.id}`)).json();
 assert.deepEqual(fetched.value,false);
 const reExported=await (await other.request('/system/export?scope=all&format=backup')).json();
 assert.deepEqual(reExported.templates,exported.templates);
});
