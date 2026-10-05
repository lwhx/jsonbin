import {test} from 'node:test';import assert from 'node:assert/strict';
import {minimalBackup,richBackup} from './support/backup-fixtures.mjs';
const api=await import('../src/shared/backup.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('backup validates ordinary JSON without altering keys or scalars',()=>{
 assert.equal(typeof api.validateBackup,'function');
 for(const value of [null,false,[],0,'中文',JSON.parse('{"__proto__":{"x":1},"":"空","format":"jsonbin-backup"}')]) assert.deepEqual(api.validateBackup(minimalBackup(value)).bins[0].versions[0].value,value);
 // v1 input normalizes with an empty template list; v1→v2 semantic equivalence.
 assert.deepEqual(api.validateBackup(richBackup()),{...richBackup(),templates:[]});
 const v2=richBackup();v2.schemaVersion=2;v2.templates=[];
 {const tid=crypto.randomUUID(),sid=v2.schemas[0].meta.id;v2.templates.push({meta:{id:tid,name:'备份模板',description:'',currentVersion:2,tags:['t'],schemaId:sid,schemaRevision:3,createdAt:v2.exportedAt,updatedAt:v2.exportedAt},versions:[{version:1,uploadedAt:v2.exportedAt,value:true},{version:2,uploadedAt:v2.exportedAt,value:'当前'}]});assert.deepEqual(api.validateBackup(v2).templates.length,1);}
 {const bad=structuredClone(v2);bad.templates[0].meta.schemaRevision=9;assert.throws(()=>api.validateBackup(bad));}
});
test('backup rejects unknown management fields, absent current files, invalid graph and unsafe values',()=>{
 assert.equal(typeof api.validateBackup,'function');
 for(const change of [p=>p.secret='x',p=>p.schemaVersion=3,p=>{p.templates=[{meta:{id:crypto.randomUUID()},versions:[]}]},p=>p.bins[0].meta.etag='x',p=>p.bins[0].versions=[],p=>p.bins.push(p.bins[0]),p=>p.bins[0].meta.collectionId=crypto.randomUUID(),p=>p.bins[0].versions[0].value=Infinity,p=>p.bins[0].versions.push(p.bins[0].versions[0]),p=>p.bins[0].meta.currentVersion=2,p=>p.bins[0].meta.schemaLocked=true,p=>p.scope={kind:'config'}]) {const p=minimalBackup();change(p);assert.throws(()=>api.validateBackup(p));}
 const p=richBackup();p.bins[0].versions[0].value=5;assert.throws(()=>api.validateBackup(p));
});
test('backup enforces resource/object/byte and business depth budgets independently of wrappers',()=>{
 assert.equal(typeof api.validateBackup,'function');
 let value=0;for(let i=0;i<64;i++)value={child:value};assert.doesNotThrow(()=>api.validateBackup(minimalBackup(value)));assert.throws(()=>api.validateBackup(minimalBackup({child:value})));
 const p=minimalBackup();p.purged=Array.from({length:100},()=>({id:crypto.randomUUID(),deletedAt:p.exportedAt}));assert.throws(()=>api.validateBackup(p),e=>e.status===413);
 const q=minimalBackup();q.bins[0].versions=Array.from({length:249},(_,i)=>({version:i+1,uploadedAt:q.exportedAt,value:null}));assert.throws(()=>api.validateBackup(q),e=>e.status===413);
 assert.throws(()=>api.validateBackup(minimalBackup('x'.repeat(10*1024*1024))),e=>e.status===413);
});
test('restore requests validate dependencies and canonical fingerprints keep arrays ordered',async()=>{
 assert.equal(typeof api.fingerprintResource,'function'); const p=minimalBackup({b:1,a:2}),r={kind:'bin',data:p.bins[0]};
 assert.deepEqual(api.validateRestoreRequest({resource:r,dependencies:[]}).resource,r);
 const reordered=structuredClone(r);reordered.data.versions[0].value={a:2,b:1};assert.equal(await api.fingerprintResource(r),await api.fingerprintResource(reordered));
 const a={kind:'bin',data:minimalBackup([1,2]).bins[0]},b={kind:'bin',data:minimalBackup([2,1]).bins[0]};assert.notEqual(await api.fingerprintResource(a),await api.fingerprintResource(b));
 assert.throws(()=>api.validateRestoreRequest({resource:r,dependencies:[{kind:'collection',id:crypto.randomUUID(),fingerprint:'0'.repeat(64)}]}));
 assert.equal(api.isImportMarker({importState:'pending'}),true);
});
