import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {minimalBackup,richBackup} from './support/backup-fixtures.mjs';import {encodeBackupZip} from '../src/shared/zip.ts';
const api=await import('../src/react-app/features/settings/api.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const files=await import('../src/react-app/features/settings/files.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const transfer=await import('../src/react-app/features/settings/transfer.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('system client sends actual HTTP contracts once and preserves raw UTF-8 bytes',async t=>{
 assert.equal(typeof api.createSystemClient,'function');const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({url:req.url,method:req.method,etag:req.headers['if-match'],body});res.setHeader('Content-Type','application/json');if(req.url.includes('/export'))res.end('"中文"');else if(req.url.includes('/import')){res.statusCode=503;res.end('{"error":"storage_unavailable","secret":"canary"}');}else res.end('{"settings":{},"etag":"next"}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const observed=[],original=globalThis.fetch;t.mock.method(globalThis,'fetch',(url,init)=>{observed.push(init);return original(url,init);});const client=api.createSystemClient(`http://127.0.0.1:${server.address().port}/api/v1/system`);
 await client.patchSettings({defaultVisibility:'public'},'"etag"');assert.equal(requests[0].etag,'"etag"');assert.equal(observed[0].credentials,'include');assert.equal(observed[0].cache,'no-store');
 const bytes=await client.exportData({scope:'bin',id:minimalBackup().bins[0].meta.id,format:'value'});assert.equal(new TextDecoder().decode(bytes),'"中文"');assert.ok(requests[1].url.includes('format=value'));
 await assert.rejects(client.importJson([{name:'item',value:null}]),e=>e.status===503&&!e.message.includes('canary'));assert.equal(requests.filter(r=>r.url.endsWith('/import')).length,1);
 const controller=new AbortController();controller.abort();await assert.rejects(client.getInfo(controller.signal),e=>e.name==='AbortError');
});
test('file parsing accepts BOM scalar arrays and explicit raw format fields; rejects invalid encoding and limits before reading',async()=>{
 assert.equal(typeof files.parseStandardFiles,'function');const parsed=await files.parseStandardFiles([new File(['\ufeffnull'],'空值.json'),new File(['[1,2]'],'array.json'),new File(['{"format":"jsonbin-backup"}'],'raw.json')]);assert.deepEqual(parsed.map(p=>p.value),[null,[1,2],{format:'jsonbin-backup'}]);assert.equal(parsed[0].name,'空值');
 for(const file of [new File([Uint8Array.of(255)],'bad.json'),new File([''],'empty.json'),new File(['1e999'],'infinity.json')])await assert.rejects(files.parseStandardFiles([file]));
 let reads=0;const huge={size:1024*1024+1,name:'huge.json',arrayBuffer:async()=>{reads++;return new ArrayBuffer(0)}};await assert.rejects(files.parseStandardFiles([huge]));assert.equal(reads,0);
 await assert.rejects(files.parseStandardFiles(Array.from({length:101},()=>new File(['null'],'x.json'))));
 const p=richBackup();assert.deepEqual(await files.readBackupFile(new File([JSON.stringify(p)],'backup.json')),p);assert.deepEqual(await files.readBackupFile(new File([await encodeBackupZip(p)],'backup.zip')),p);
});
test('restore orchestrator orders dependencies, skips their conflicts, continues independent resources and leaves settings unapplied',async()=>{
 assert.equal(typeof transfer.buildRestoreRequests,'function');const p=richBackup(),inputs=await transfer.buildRestoreRequests(p);assert.deepEqual(inputs.map(i=>i.resource.kind),['collection','schema','bin','purged']);
 const calls=[],reported=[];const client={restoreResource:async input=>{calls.push(input.resource.kind);const r=input.resource;return {kind:r.kind,id:r.kind==='purged'?r.data.id:r.data.meta.id,status:r.kind==='collection'?'skipped':'created'}},patchSettings:()=>{throw Error('must_not_apply_settings')}};
 const results=await transfer.runRestore(p,client,r=>reported.push(r));assert.deepEqual(calls,['collection','schema','purged']);assert.equal(results.find(r=>r.kind==='bin').status,'dependency_skipped');assert.equal(reported.length,4);
});
test('cancellation retains committed results and sends no later restore request',async()=>{
 assert.equal(typeof transfer.runRestore,'function');const p=richBackup(),controller=new AbortController();let calls=0;const result=await transfer.runRestore(p,{restoreResource:async input=>{calls++;return {kind:input.resource.kind,id:input.resource.data.meta.id,status:'created'}}},()=>controller.abort(),controller.signal);assert.equal(calls,1);assert.equal(result.length,1);assert.equal(result[0].status,'created');
});
