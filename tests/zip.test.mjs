import {test} from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {minimalBackup,richBackup} from './support/backup-fixtures.mjs';
const api=await import('../src/shared/zip.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('STORE ZIP roundtrips and Python independently verifies contents CRC and manifest SHA',async()=>{
 assert.equal(typeof api.encodeBackupZip,'function'); const p=richBackup(),bytes=await api.encodeBackupZip(p);assert.deepEqual(await api.decodeBackupZip(bytes),{...p,templates:[]}); // v1 fixture normalizes to v2 with empty templates
 const python=spawnSync('python3',['-c',`import sys,io,zipfile,json,hashlib
raw=sys.stdin.buffer.read()
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 assert z.namelist()==['manifest.json','backup.json']
 assert z.testzip() is None
 assert all(i.compress_type==0 for i in z.infolist())
 b=z.read('backup.json'); m=json.loads(z.read('manifest.json'))
 assert m['bytes']==len(b) and m['sha256']==hashlib.sha256(b).hexdigest()
 p=json.loads(b); assert p['bins'][0]['meta']['name']=='中文' and p['bins'][0]['versions'][0]['value'] is False
print('ok')`],{input:Buffer.from(bytes)});assert.equal(python.status,0,python.stderr.toString());assert.equal(python.stdout.toString().trim(),'ok');
});
test('ZIP rejects modified headers, offsets, content, duplicate names, truncation and unsupported formats',async()=>{
 assert.equal(typeof api.encodeBackupZip,'function');const good=await api.encodeBackupZip(minimalBackup(null));
 const end=good.length-22,central=new DataView(good.buffer,good.byteOffset).getUint32(end+16,true);
 for(const [offset,size,value] of [[0,4,0],[6,2,1],[6,2,8],[8,2,8],[18,4,0xffffffff],[26,2,0],[28,2,1],[central+8,2,1],[central+10,2,8],[central+20,4,0xffffffff],[central+42,4,1],[end+10,2,3],[end+16,4,central-1],[end+20,2,1]]) {const b=good.slice(),v=new DataView(b.buffer);size===4?v.setUint32(offset,value,true):v.setUint16(offset,value,true);await assert.rejects(api.decodeBackupZip(b));}
 const corrupt=good.slice();corrupt[45]^=1;await assert.rejects(api.decodeBackupZip(corrupt));
 await assert.rejects(api.decodeBackupZip(good.slice(0,-1)));await assert.rejects(api.decodeBackupZip(new Uint8Array(10*1024*1024+65537)));
 // Independent Python writer exercises extra/path/duplicate entries and wrong manifest digest.
 for(const mode of ['extra','path','duplicate','deflate','sha','length']){
 const py=spawnSync('python3',['-c',`import sys,io,zipfile,json
p=json.loads(sys.stdin.read()); mode=sys.argv[1]; o=io.BytesIO()
with zipfile.ZipFile(o,'w',compression=zipfile.ZIP_DEFLATED if mode=='deflate' else zipfile.ZIP_STORED) as z:
 m={'format':'jsonbin-backup-zip','schemaVersion':1,'file':'backup.json','bytes':999 if mode=='length' else len(json.dumps(p).encode()),'sha256':'0'*64}
 z.writestr('manifest.json',json.dumps(m)); z.writestr('../backup.json' if mode=='path' else 'backup.json',json.dumps(p))
 if mode=='extra':z.writestr('extra.json','{}')
 if mode=='duplicate':z.writestr('backup.json','{}')
sys.stdout.buffer.write(o.getvalue())`,mode],{input:JSON.stringify(minimalBackup())});assert.equal(py.status,0);await assert.rejects(api.decodeBackupZip(new Uint8Array(py.stdout)));
 }
});
