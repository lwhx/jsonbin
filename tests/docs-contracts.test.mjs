import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DOC_OPERATIONS, DOC_SCOPES } from '../src/react-app/features/docs/catalog.ts';
import * as examples from '../src/react-app/features/docs/examples.ts';
let mf, app, env, cookie, token, server, origin;
const writeEtags = [];
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ cf:false, workers:[{name:'docs-tests',modules:true,scriptPath:'dist/jsonbin/index.js',compatibilityDate:'2026-10-03',r2Buckets:['DATA']}] }));
  app = (await import('../dist/jsonbin/index.js')).default;
  env = { DATA:await mf.getR2Bucket('DATA','docs-tests'), ADMIN_USERNAME:'docs-test',ADMIN_PASSWORD:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('hex') };
  const login = await app.fetch(new Request('https://example.test/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD})}),env);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const key = await app.fetch(new Request('https://example.test/api/v1/keys',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name:'all scopes',scopes:DOC_SCOPES})}),env);
  token = (await key.json()).token; assert.equal(typeof token,'string');
  server = createServer(async (req,res) => {
    try {
      let body='';for await(const chunk of req) body += chunk;
      if (['PUT','PATCH'].includes(req.method)) writeEtags.push(req.headers['if-match']);
      const response = await app.fetch(new Request(origin+req.url,{method:req.method,headers:req.headers,...(body ? {body}: {})}),env);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    } catch { res.writeHead(500);res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
});
after(async () => { if(server)await new Promise(resolve=>server.close(resolve));await mf?.dispose(); });
function op(id){return DOC_OPERATIONS.find(o=>o.id===id);}
async function send(id,context={},body,headers={}) {
  const operation = body === undefined ? op(id) : {...op(id),body};
  const request = examples.buildRequest(operation,{origin,...context});
  const response = await app.fetch(new Request(request.url,{method:request.method,
    headers:{...request.headers,...(request.credentials ? {Cookie:cookie}:request.headers.Authorization ? {Authorization:'Bearer '+token}:{}),...headers},
    ...(Object.hasOwn(request,'body') ? {body:JSON.stringify(request.body)}:{})}),env);
  return {response,data:await response.json()};
}
function run(command,input,args=['-s']) { return new Promise((resolve,reject)=> {
  const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let output='',error='';
  child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>error+=c);
  child.on('error',reject);child.on('exit',code=>code===0?resolve(output):reject(new Error('sample exit '+code+': '+error.replaceAll(token,'[redacted]'))));child.stdin.end(input);
}); }
test('sequential JavaScript and curl examples use fresh ETags on the real Worker',async()=>{
  assert.equal(typeof examples.buildQuickStart,'function');
  for(const language of ['javascript','curl','python']) {
    writeEtags.length=0;
    const code=examples.buildQuickStart(language,origin).replaceAll('<API_TOKEN>',token);
    let result;
    if(language==='javascript') {
      await new(Object.getPrototypeOf(async function(){}).constructor)('fetch','console',code)(fetch,{log(value){result=value;}});
    }else if(language==='curl') result=JSON.parse((await run('bash',code)).trim());
    else {
      const stub = `import ast,json,sys,types,urllib.request\ncode=sys.stdin.read()\nast.parse(code)\nclass Value(dict):\n def __repr__(self): return json.dumps(self)\nclass Response:\n def __init__(self,response): self.headers=response.headers; self.body=response.read()\n def raise_for_status(self): pass\n def json(self): return Value(json.loads(self.body))\ndef call(method,url,headers,data=None,timeout=30):\n return Response(urllib.request.urlopen(urllib.request.Request(url,method=method,headers=headers,data=None if data is None else data.encode()),timeout=timeout))\nsys.modules['requests']=types.SimpleNamespace(request=call)\nexec(code)\n`;
      result=JSON.parse((await run('python3',code,['-c',stub])).trim());
    }
    assert.equal(result.value.settings.theme,'light');assert.equal(result.meta.currentVersion,3);
    assert.equal(writeEtags.length,2);assert.notEqual(writeEtags[0],writeEtags[1]);
  }
});
test('generated requests honor real resource schemas versions paths and ETag conflicts',async()=>{
  const created=await send('bin-create');assert.equal(created.response.status,201);let ctx={binId:created.data.meta.id,etag:created.response.headers.get('ETag')};
  const read=await send('bin-get',ctx);assert.deepEqual(read.data.value,{settings:{theme:'light'},enabled:false,note:null});
  const patched=await send('bin-patch',ctx);assert.equal(patched.data.meta.currentVersion,2);
  assert.equal((await send('bin-path-put',ctx)).response.status,412);
  ctx.etag=patched.response.headers.get('ETag');
  const missing=examples.buildRequest(op('bin-path-put'),{origin,...ctx});delete missing.headers['If-Match'];missing.headers.Authorization='Bearer '+token;
  assert.equal((await app.fetch(new Request(missing.url,{method:'PUT',headers:missing.headers,body:JSON.stringify(missing.body)}),env)).status,428);
  let record=(await send('bin-put',ctx,{value:{'a/b':{'x~y':{'中文 %':null}},settings:{theme:'light'}}})).data;
  for(const value of [false,[null,false],null]) {
    const special={...ctx,etag:record.etag,pathSegments:['a/b','x~y','中文 %']};
    record=(await send('bin-path-put',special,{value})).data;
    assert.deepEqual((await send('bin-path-get',special)).data.value,value);
  }
  const history=await send('history-get',{...ctx,version:1});assert.equal(history.data.version,1);assert.ok(history.data.createdAt);assert.equal(history.data.id,ctx.binId);
  assert.ok((await send('history-list',ctx)).data.currentVersion>1);
  const restored=await send('history-restore',{...ctx,etag:record.etag,version:1});assert.deepEqual(restored.data.value,created.data.value);
  const collection=await send('collection-create');let cc={collectionId:collection.data.meta.id,etag:collection.data.etag};
  assert.equal((await send('collection-get',cc)).data.binCount,0);
  const updated=await send('collection-update',cc);cc.etag=updated.data.etag;
  assert.equal((await send('collection-bins',cc)).response.status,200);assert.equal((await send('collection-delete',cc)).response.status,200);
  const schema=await send('schema-create');let sc={schemaId:schema.data.meta.id,etag:schema.data.etag};
  const invalid=await send('schema-validate',sc);assert.equal(invalid.response.status,200);assert.equal(invalid.data.valid,false);assert.ok(invalid.data.issues.length);
  const su=await send('schema-update',sc);sc.etag=su.data.etag;assert.equal((await send('schema-delete',sc)).response.status,200);
  assert.equal((await send('bin-delete',{...ctx,etag:restored.data.etag})).response.status,200);
  let trash=(await send('trash-list')).data.items.find(i=>i.meta.id===ctx.binId);
  const back=await send('trash-restore',{...ctx,etag:trash.etag});assert.equal(back.data.meta.visibility,'private');assert.equal(back.data.meta.expiresAt,null);
  await send('bin-delete',{...ctx,etag:back.data.etag});trash=(await send('trash-list')).data.items.find(i=>i.meta.id===ctx.binId);
  const batch=await send('trash-batch',{...ctx,etag:trash.etag});assert.equal(batch.data.results[0].status,200);
  assert.equal((await send('bin-get',ctx)).response.status,404);
  const activity=await send('activity-list');assert.ok(activity.data.items.length);assert.equal(activity.data.retentionLimit,2000);
  const query=examples.buildRequest(op('activity-list'),{origin});query.url+='&limit=1';
  assert.equal((await app.fetch(new Request(query.url,{headers:{Cookie:cookie}}),env)).status,400);
  const first=await (await app.fetch(new Request(origin+'/api/v1/activity?limit=1',{headers:{Cookie:cookie}}),env)).json();assert.ok(first.nextCursor);
  const second=await(await app.fetch(new Request(origin+'/api/v1/activity?limit=1&cursor='+first.nextCursor,{headers:{Cookie:cookie}}),env)).json();assert.notEqual(first.items[0].id,second.items[0].id);
});
test('documentation auth matches public reads Session-only management and combined scopes',async()=>{
  const created=await send('bin-create',{}, {name:'public',visibility:'public',value:null});const ctx={binId:created.data.meta.id};
  assert.equal((await send('bin-get',{...ctx,anonymous:true})).response.status,200);
  assert.equal((await send('bin-get',{...ctx,anonymous:true},undefined,{Authorization:'Bearer invalid'})).response.status,401);
  for(const id of ['keys-list','activity-list'])assert.equal((await send(id,{},undefined,{Authorization:'Bearer '+token})).response.status,401);
  for(const id of ['bin-list','history-get']) {
    const req=examples.buildRequest(op(id),{origin,...ctx});assert.equal((await app.fetch(new Request(req.url),env)).status,401);
  }
  const only=await send('keys-create',{}, {name:'one scope',scopes:['collection:read']});
  const collection=await send('collection-create');
  const denied=await send('collection-bins',{collectionId:collection.data.meta.id},undefined,{Authorization:'Bearer '+only.data.token});
  assert.equal(denied.response.status,403);assert.deepEqual(denied.data.requiredScopes,['collection:read','bin:read']);
  const revoked=await send('keys-revoke',{keyId:only.data.key.id});assert.ok(revoked.data.key.revokedAt);assert.equal(revoked.data.ok,undefined);
});
