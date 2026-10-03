import {test} from 'node:test';import assert from 'node:assert/strict';
import {createSystemHarness} from './support/system-harness.mjs';import {minimalBackup,richBackup} from './support/backup-fixtures.mjs';
import {fingerprintResource} from '../src/shared/backup.ts';
async function harness(t){const h=await createSystemHarness('restore-'+crypto.randomUUID());t.after(()=>h.close());return h;}
async function requests(p){const out=[];for(const [kind,items] of [['collection',p.collections],['schema',p.schemas],['bin',p.bins],['purged',p.purged]])for(const data of items){const dependencies=[];if(kind==='bin')for(const k of ['collection','schema']){const id=data.meta[k+'Id'];if(id){const dep=out.find(r=>r.resource.kind===k&&r.resource.data.meta.id===id);dependencies.push({kind:k,id,fingerprint:await fingerprintResource(dep.resource)});}}out.push({resource:{kind,data},dependencies});}return out;}
const restore=(h,input,env=h.env)=>h.request('/system/restore',{method:'POST',value:input},env);
test('restore preserves IDs, versions, pinned revisions and logical history timestamps; replay is unchanged',async t=>{
 const h=await harness(t),p=richBackup();for(const input of await requests(p)){const r=await restore(h,input);assert.equal(r.status,200);assert.equal((await r.json()).status,'created');assert.equal((await (await restore(h,input)).json()).status,'unchanged');}
 const id=p.bins[0].meta.id,current=await (await h.request('/bins/'+id)).json();assert.equal(current.value,false);assert.equal(current.meta.locked,true);assert.equal(current.meta.schemaRevision,1);
 const history=await (await h.request('/bins/'+id+'/versions')).json();assert.deepEqual(history.items.map(v=>v.version),[4,1]);assert.ok(history.items.every(v=>v.createdAt===p.exportedAt));
 const exported=await (await h.request('/system/export?scope=all&format=backup')).json();assert.deepEqual(exported.bins,p.bins);assert.deepEqual(exported.schemas,p.schemas);assert.deepEqual(exported.purged,p.purged);
 assert.equal((await (await h.request('/system/settings')).json()).settings.updatedAt,null);
 const events=await (await h.request('/activity?action=bin.imported')).json();assert.equal(events.items.length,2);
});
test('pending markers are hidden from all normal entrypoints and untouched by Cron',async t=>{
 const h=await harness(t),id=crypto.randomUUID();for(const [kind,ns] of [['bin','bins'],['collection','collections'],['schema','schemas']])await h.bucket.put(`${ns}/${id}/meta.json`,JSON.stringify({importState:'pending',kind,id,fingerprint:'0'.repeat(64),startedAt:'2000-01-01T00:00:00.000Z'}));
 for(const ns of ['bins','collections','schemas']){assert.equal((await h.request(`/${ns}/${id}`)).status,404);assert.equal((await (await h.request('/'+ns)).json()).items.length,0);assert.equal((await h.request(`/${ns}/${id}`,{method:'DELETE',headers:{'If-Match':'"x"'}})).status,404);}
 assert.equal((await h.request(`/bins/${id}/versions`)).status,404);assert.equal((await h.request(`/bins/${id}`,{headers:{Cookie:''}})).status,401);assert.equal((await (await h.request('/trash/bins')).json()).items.length,0);
 await h.worker.scheduled({},h.env);for(const ns of ['bins','collections','schemas'])assert.equal((await (await h.bucket.get(`${ns}/${id}/meta.json`)).json()).importState,'pending');
 assert.equal((await (await h.request('/system/info')).json()).statistics.data.pendingImports,3);
});
test('restore never overwrites existing normal, archived, terminal, legacy or orphan objects',async t=>{
 const h=await harness(t);for(const kind of ['active','deleted','purged','legacy','orphan']){const p=minimalBackup(),id=crypto.randomUUID();p.bins[0].meta.id=id;const input=(await requests(p))[0];const key=kind==='legacy'?`trash/bins/${id}/meta.json`:kind==='orphan'?`bins/${id}/versions/000001.json`:`bins/${id}/meta.json`;const value=kind==='purged'?{id,purgeState:'purged',deletedAt:p.exportedAt}:{...p.bins[0].meta,...kind==='deleted'?{deletedAt:p.exportedAt}:{}};await h.bucket.put(key,JSON.stringify(value));const before=await (await h.bucket.get(key)).text();const result=await (await restore(h,input)).json();assert.equal(result.status,'skipped');assert.equal(await (await h.bucket.get(key)).text(),before);}
});
test('interrupted conditional restore stays hidden, resumes same content and rejects foreign files',async t=>{
 const h=await harness(t),p=richBackup();p.bins[0].meta.collectionId=null;p.bins[0].meta.schemaId=null;p.bins[0].meta.schemaRevision=null;p.bins[0].meta.schemaLocked=false;const input={resource:{kind:'bin',data:p.bins[0]},dependencies:[]},id=p.bins[0].meta.id;
 let failed=false;const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{if(key.endsWith('/versions/000004.json')&&!failed){failed=true;throw Error('private-failure');}return h.bucket.put(key,...args);}})};
 const r=await restore(h,input,env);assert.equal(r.status,503);assert.ok(!(await r.text()).includes('private-failure'));assert.equal((await h.request('/bins/'+id)).status,404);await h.worker.scheduled({},h.env);assert.equal((await (await h.bucket.get(`bins/${id}/meta.json`)).json()).importState,'pending');
 const other=structuredClone(input);other.resource.data.meta.name='other';assert.equal((await (await restore(h,other)).json()).status,'skipped');
 const key=`bins/${id}/versions/000001.json`,before=await (await h.bucket.get(key)).text();assert.equal((await (await restore(h,input)).json()).status,'created');assert.equal(await (await h.bucket.get(key)).text(),before);
 const second=minimalBackup();second.bins[0].meta.id=crypto.randomUUID();const req={resource:{kind:'bin',data:second.bins[0]},dependencies:[]},sid=second.bins[0].meta.id;
 await h.bucket.put(`bins/${sid}/meta.json`,JSON.stringify({importState:'pending',kind:'bin',id:sid,fingerprint:await fingerprintResource(req.resource),startedAt:p.exportedAt}));await h.bucket.put(`bins/${sid}/versions/999999.json`,'null');assert.equal((await restore(h,req)).status,409);assert.equal((await h.request('/bins/'+sid)).status,404);
});
test('concurrent identical restore has one publication; modified dependency receipts block association',async t=>{
 const h=await harness(t),p=minimalBackup(),input=(await requests(p))[0];const results=await Promise.all([restore(h,input),restore(h,input)]);assert.ok(results.every(r=>r.status===200));assert.deepEqual((await Promise.all(results.map(r=>r.json()))).map(r=>r.status).sort(),['created','unchanged']);
 const id=p.bins[0].meta.id,current=await (await h.request('/bins/'+id)).json();assert.equal((await h.request('/bins/'+id,{method:'PUT',headers:{'If-Match':current.etag},value:{value:'edited'}})).status,200);assert.equal((await (await restore(h,input)).json()).status,'skipped');
 const rich=richBackup();rich.bins[0].meta.id=crypto.randomUUID();const reqs=await requests(rich);await restore(h,reqs[0]);await restore(h,reqs[1]);const cid=rich.collections[0].meta.id,c=await (await h.request('/collections/'+cid)).json();await h.request('/collections/'+cid,{method:'PATCH',headers:{'If-Match':c.etag},value:{name:'modified'}});const blocked=await restore(h,reqs[2]);assert.equal(blocked.status,409);assert.equal((await blocked.json()).error,'restore_dependency_conflict');
});
test('expired restore enters trash immediately; post-publication cleanup failure still reports created and can retry',async t=>{
 const h=await harness(t),expired=minimalBackup();expired.bins[0].meta.expiresAt='2000-01-01T00:00:00.000Z';const input=(await requests(expired))[0];assert.equal((await (await restore(h,input)).json()).status,'created');assert.equal((await h.request('/bins/'+expired.bins[0].meta.id)).status,404);assert.equal((await (await h.request('/trash/bins')).json()).items.length,1);
 const p=richBackup();p.bins[0].meta.id=crypto.randomUUID();const reqs=await requests(p);await restore(h,reqs[0]);await restore(h,reqs[1]);const id=p.bins[0].meta.id,cid=p.collections[0].meta.id;let published=false;
 const env={...h.env,DATA:h.adapt({put:async(key,value,options)=>{if(published&&key===`bins/${id}/meta.json`)throw Error('detach-fault');const result=await h.bucket.put(key,value,options);if(key===`bins/${id}/meta.json`&&!JSON.parse(value).importState){published=true;await h.bucket.put(`collections/${cid}/meta.json`,JSON.stringify({...p.collections[0].meta,status:'deleted'}));}return result;}})};
 const r=await restore(h,reqs[2],env);assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'created');assert.deepEqual(result.warnings,['collection_cleanup_failed']);assert.equal((await h.request('/bins/'+id)).status,200);
 const replay=await (await restore(h,reqs[2])).json();assert.equal(replay.status,'unchanged');assert.deepEqual(replay.warnings,['collection_detached']);assert.equal((await (await h.request('/bins/'+id)).json()).meta.collectionId,null);
});
test('valid backup revision order does not prevent dependency restoration',async t=>{
 const h=await harness(t),p=richBackup();p.schemas[0].revisions.reverse();const reqs=await requests(p);for(const input of reqs){const r=await restore(h,input);assert.equal(r.status,200);assert.equal((await r.json()).status,'created');}
});
test('pending dependency changes, malformed markers and mismatching owned history refuse publication',async t=>{
 const h=await harness(t),p=richBackup(),reqs=await requests(p);await restore(h,reqs[0]);await restore(h,reqs[1]);const input=reqs[2],id=p.bins[0].meta.id,cid=p.collections[0].meta.id;
 let fail=true;const env={...h.env,DATA:h.adapt({put:async(key,...args)=>{if(fail&&key.endsWith('/versions/000004.json')){fail=false;throw Error('interrupted');}return h.bucket.put(key,...args);}})};assert.equal((await restore(h,input,env)).status,503);
 const c=await (await h.request('/collections/'+cid)).json();assert.equal((await h.request('/collections/'+cid,{method:'PATCH',headers:{'If-Match':c.etag},value:{name:'changed'}})).status,200);assert.equal((await restore(h,input)).status,409);assert.equal((await h.request('/bins/'+id)).status,404);
 const solo=minimalBackup(),sid=crypto.randomUUID();solo.bins[0].meta.id=sid;const single=(await requests(solo))[0];await h.bucket.put(`bins/${sid}/meta.json`,JSON.stringify({importState:'pending'}));assert.equal((await restore(h,single)).status,409);
 await h.bucket.put(`bins/${sid}/meta.json`,JSON.stringify({importState:'pending',kind:'bin',id:sid,fingerprint:await fingerprintResource(single.resource),startedAt:p.exportedAt}));await h.bucket.put(`bins/${sid}/versions/000001.json`,'false',{customMetadata:{originalUploadedAt:p.exportedAt}});assert.equal((await restore(h,single)).status,409);assert.equal(await (await h.bucket.get(`bins/${sid}/versions/000001.json`)).text(),'false');
});
test('statistics distinguish stored orphan bytes from available history and pending resources',async t=>{
 const h=await harness(t),id=crypto.randomUUID();await h.bucket.put(`bins/${id}/versions/000001.json`,'null');
 let stats=(await (await h.request('/system/info')).json()).statistics.data;assert.equal(stats.storedBytes,4);assert.equal(stats.versions,0);
 const marker={importState:'pending',kind:'bin',id,fingerprint:'0'.repeat(64),startedAt:'2000-01-01T00:00:00.000Z'};await h.bucket.put(`bins/${id}/meta.json`,JSON.stringify(marker));stats=(await (await h.request('/system/info')).json()).statistics.data;assert.equal(stats.pendingImports,1);assert.equal(stats.versions,0);assert.equal(stats.storedBytes,4+JSON.stringify(marker).length);
});
