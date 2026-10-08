import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createSystemHarness } from './support/system-harness.mjs';

async function withHarness(t) {
  const h = await createSystemHarness('webhooks-' + crypto.randomUUID());
  t.after(() => h.close());
  return h;
}
/** Local webhook receiver capturing requests; responder controls the status code. */
function receiver(t) {
  const received = [];
  let responder = () => 200;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url, at: Date.now() });
      res.writeHead(responder(received.length - 1)); res.end('ok');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    received, url: `http://127.0.0.1:${server.address().port}/hook`,
    respond: fn => { responder = fn; },
    waitUntil: async (count, timeout = 5000) => {
      const start = Date.now();
      while (received.length < count && Date.now() - start < timeout) await new Promise(r => setTimeout(r, 25));
      return received.length >= count;
    },
    close: () => new Promise(r => server.close(r)),
  }))).then(r => { t.after(() => r.close()); return r; });
}
const validInput = url => ({ name: '集成钩子', url, secret: 'unit-test-secret-0123456789', events: ['bin.*'] });

test('webhook CRUD is Session-only and validates URL, secret, events and preconditions', async t => {
  const h = await withHarness(t);
  assert.equal((await h.request('/webhooks')).status, 200);
  assert.equal((await h.request('/webhooks', { headers: { Authorization: 'Bearer x' } })).status, 401);

  for (const bad of [{ ...validInput('http://x'), url: 'ftp://nope' }, { ...validInput('http://x'), secret: 'short' },
    { ...validInput('http://x'), events: [] }, { ...validInput('http://x'), events: ['bin.*', 'bin.*'] },
    { ...validInput('http://x'), events: ['auth.*'] }, { ...validInput('http://x'), extra: 1 }]) {
    assert.equal((await h.request('/webhooks', { method: 'POST', value: bad })).status, 422, JSON.stringify(bad));
  }
  const created = await h.request('/webhooks', { method: 'POST', value: validInput('https://example.test/hook') });
  assert.equal(created.status, 201);
  const { webhook } = await created.json();
  assert.equal(webhook.active, true);
  assert.equal((await h.request(`/webhooks/${webhook.id}`, { method: 'PATCH', value: { name: 'x' } })).status, 428);
  const current = await h.request(`/webhooks/${webhook.id}`);
  const etag = current.headers.get('etag');
  assert.equal((await h.request(`/webhooks/${webhook.id}`, { method: 'PATCH', headers: { 'If-Match': '"stale"' }, value: { name: 'x' } })).status, 412);
  const patched = await h.request(`/webhooks/${webhook.id}`, { method: 'PATCH', headers: { 'If-Match': etag }, value: { name: '改名', events: ['template.*'], active: false } });
  assert.equal(patched.status, 200);
  const updated = (await patched.json()).webhook;
  assert.equal(updated.name, '改名'); assert.deepEqual(updated.events, ['template.*']); assert.equal(updated.active, false);
  assert.equal((await h.request(`/webhooks/${webhook.id}`, { method: 'DELETE', headers: { 'If-Match': '"stale"' } })).status, 412);
  const fresh = (await h.request(`/webhooks/${webhook.id}`)).headers.get('etag');
  assert.equal((await h.request(`/webhooks/${webhook.id}`, { method: 'DELETE', headers: { 'If-Match': fresh } })).status, 200);
  assert.equal((await h.request(`/webhooks/${webhook.id}`)).status, 404);
});

test('resource mutations deliver signed payloads and event filters apply', async t => {
  const h = await withHarness(t), sink = await receiver(t);
  const secret = 'receiver-verify-secret-0000000001';
  await h.request('/webhooks', { method: 'POST', value: { name: '全部 Bin 事件', url: sink.url, secret, events: ['bin.*'] } });
  await h.request('/webhooks', { method: 'POST', value: { name: '仅更新', url: sink.url, secret, events: ['bin.updated'] } });

  const bin = await (await h.request('/bins', { method: 'POST', value: { name: '触发器', value: { v: 1 } } })).json();
  assert.ok(await sink.waitUntil(1), 'bin.created delivers to the bin.* subscriber only');
  const first = sink.received[0];
  const payload = JSON.parse(first.body);
  assert.equal(payload.event, 'bin.created');
  assert.equal(payload.resourceId, bin.meta.id);
  assert.equal(first.headers['x-jsonbin-event'], 'bin.created');
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8');

  // GitHub-style signature: sha256=hex(HMAC(secret, "<timestamp>.<body>")).
  const timestamp = first.headers['x-jsonbin-timestamp'];
  const expected = createHmac('sha256', secret).update(`${timestamp}.${first.body}`).digest('hex');
  assert.equal(first.headers['x-jsonbin-signature'], `sha256=${expected}`);

  await h.request(`/bins/${bin.meta.id}`, { method: 'PUT', headers: { 'If-Match': bin.etag.replace(/"/g, '') }, value: { value: { v: 2 } } });
  assert.ok(await sink.waitUntil(3), 'bin.updated delivers to both subscribers');
  assert.deepEqual(sink.received.slice(1).map(r => JSON.parse(r.body).event), ['bin.updated', 'bin.updated']);

  // Unsubscribed actions never deliver.
  const before = sink.received.length;
  await h.request('/collections', { method: 'POST', value: { name: '无订阅集合' } });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sink.received.length, before);
});

test('inactive webhooks stay silent while the test endpoint delivers synthetic events', async t => {
  const h = await withHarness(t), sink = await receiver(t);
  const secret = 'inactive-secret-0000000000000001';
  const created = await (await h.request('/webhooks', { method: 'POST', value: { name: '停用钩子', url: sink.url, secret, events: ['bin.*'], active: false } })).json();
  await h.request('/bins', { method: 'POST', value: { name: '不应投递', value: null } });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sink.received.length, 0, 'inactive webhooks receive nothing');

  // The test endpoint delivers a synthetic webhook.test event even while inactive.
  const test = await h.request(`/webhooks/${created.webhook.id}/test`, { method: 'POST' });
  assert.equal(test.status, 200);
  assert.ok(await sink.waitUntil(1));
  assert.equal(JSON.parse(sink.received[0].body).event, 'webhook.test');
  assert.equal(JSON.parse(sink.received[0].body).test, true);
});

test('failed deliveries retry via Cron with backoff and prune after resolution', async t => {
  const h = await withHarness(t), sink = await receiver(t);
  const secret = 'retry-secret-000000000000000001';
  const created = await (await h.request('/webhooks', { method: 'POST', value: { name: '重试钩子', url: sink.url, secret, events: ['bin.*'] } })).json();

  sink.respond(() => 500);
  await h.request('/bins', { method: 'POST', value: { name: '首次失败', value: null } });
  assert.ok(await sink.waitUntil(1));
  let deliveries = await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
  assert.equal(deliveries.items.length, 1);
  assert.equal(deliveries.items[0].status, 'pending');
  assert.equal(deliveries.items[0].attempts, 1);
  assert.equal(deliveries.items[0].lastError, 'http_500');

  // Force the retry due date into the past, then let Cron retry against a healthy receiver.
  const key = `webhooks/${created.webhook.id}/deliveries/${deliveries.items[0].id}.json`;
  const record = JSON.parse(await (await h.bucket.get(key)).text());
  await h.bucket.put(key, JSON.stringify({ ...record, nextRetryAt: new Date(Date.now() - 1000).toISOString() }));
  sink.respond(() => 200);
  await h.worker.scheduled({}, h.env);
  assert.ok(await sink.waitUntil(2));
  deliveries = await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
  assert.equal(deliveries.items[0].status, 'delivered');
  assert.equal(deliveries.items[0].attempts, 2);

  // Resolved records older than 24h are pruned by the sweep.
  await h.bucket.put(key, JSON.stringify({ ...deliveries.items[0], createdAt: new Date(Date.now() - 25 * 3600000).toISOString() }));
  await h.worker.scheduled({}, h.env);
  deliveries = await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
  assert.equal(deliveries.items.length, 0);
});
test('delivery lists expose the newest records even beyond the read window (F23)',async t=>{
 const h=await withHarness(t),sink=await receiver(t);
 const created=await (await h.request('/webhooks',{method:'POST',value:{...validInput(sink.url),events:['bin.*']}})).json();
 // Real dispatches must generate newest-first sortable ids (each /test call
 // includes a receiver round trip, so the timestamps differ by >1ms).
 const ids=[];
 for(let i=0;i<3;i++){const r=await (await h.request('/webhooks/'+created.webhook.id+'/test',{method:'POST'})).json();
  assert.ok(r.delivery,'test dispatch must return its delivery');ids.push(r.delivery.id);}
 assert.ok(await sink.waitUntil(3));
 assert.ok(ids[1]<ids[0]&&ids[2]<ids[1],'newer delivery ids must sort lexically first, got '+JSON.stringify(ids));
 // With such ids the list window returns the newest records, newest first.
 // Seed timestamps sit in the future so the three real dispatches above never
 // interleave with the seeded window.
 const hookId=created.webhook.id,base=Date.now()+3600_000;
 for(let i=0;i<600;i++){const ts=base-i*1000,id=`${String(99999999999999-ts).padStart(14,'0')}-${String(i).padStart(4,'0')}`,createdAt=new Date(ts).toISOString();
  await h.bucket.put(`webhooks/${hookId}/deliveries/${id}.json`,JSON.stringify({id,webhookId:hookId,event:'bin.created',
   payload:{event:'bin.created',resourceId:null,actor:null,dispatchedAt:createdAt},attempts:1,maxAttempts:6,nextRetryAt:createdAt,status:'delivered',createdAt}));}
 const deliveries=await (await h.request('/webhooks/'+hookId+'/deliveries')).json();
 assert.equal(deliveries.items.length,20);
 for(let i=0;i<20;i++)assert.equal(new Date(deliveries.items[i].createdAt).getTime(),base-i*1000,'item '+i+' must be the '+(i+1)+'-th newest');
});
test('a paused webhook silences Cron retries and resumes where it left off (F23)',async t=>{
 const h=await withHarness(t),sink=await receiver(t);
 const created=await (await h.request('/webhooks',{method:'POST',value:{...validInput(sink.url),secret:'pause-secret-000000000000001'},events:['bin.*']})).json();
 sink.respond(()=>500);
 await h.request('/bins',{method:'POST',value:{name:'暂停前',value:null}});
 assert.ok(await sink.waitUntil(1));
 let deliveries=await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
 const key=`webhooks/${created.webhook.id}/deliveries/${deliveries.items[0].id}.json`;
 const record=JSON.parse(await (await h.bucket.get(key)).text());
 await h.bucket.put(key,JSON.stringify({...record,nextRetryAt:new Date(Date.now()-1000).toISOString()}));
 // Pause: the due retry must not fire.
 const current=await h.request(`/webhooks/${created.webhook.id}`);
 assert.equal((await h.request(`/webhooks/${created.webhook.id}`,{method:'PATCH',headers:{'If-Match':current.headers.get('etag')},value:{active:false}})).status,200);
 await h.worker.scheduled({},h.env);
 await new Promise(r=>setTimeout(r,300));
 assert.equal(sink.received.length,1,'paused hooks fire no retries');
 deliveries=await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
 assert.equal(deliveries.items[0].status,'pending');assert.equal(deliveries.items[0].attempts,1);
 // Resume: the pending delivery continues its schedule.
 const paused=await h.request(`/webhooks/${created.webhook.id}`);
 assert.equal((await h.request(`/webhooks/${created.webhook.id}`,{method:'PATCH',headers:{'If-Match':paused.headers.get('etag')},value:{active:true}})).status,200);
 sink.respond(()=>200);
 await h.worker.scheduled({},h.env);
 assert.ok(await sink.waitUntil(2));
 deliveries=await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
 assert.equal(deliveries.items[0].status,'delivered');assert.equal(deliveries.items[0].attempts,2);
});
test('a losing concurrent attempt never rolls back newer delivery state (F23)',async t=>{
 const h=await withHarness(t),sink=await receiver(t);
 const created=await (await h.request('/webhooks',{method:'POST',value:{name:'竞态钩子',url:sink.url,secret:'race-secret-0000000000000001',events:['bin.*']}})).json();
 sink.respond(()=>200);
 await h.request('/bins',{method:'POST',value:{name:'竞态源',value:null}});
 assert.ok(await sink.waitUntil(1));
 // Build a due pending snapshot that a second attempt will race against.
 const deliveries=await (await h.request(`/webhooks/${created.webhook.id}/deliveries`)).json();
 const key=`webhooks/${created.webhook.id}/deliveries/${deliveries.items[0].id}.json`;
 await h.bucket.put(key,JSON.stringify({...deliveries.items[0],status:'pending',nextRetryAt:new Date(Date.now()-1000).toISOString()}));
 // Between the sweep's read and its write-back a concurrent winner records
 // attempts=5 delivered; the stale write-back must lose its CAS and adopt it.
 let injected=false;const env={...h.env,DATA:h.adapt({put:async(k,value,options)=>{
  if(k===key&&!injected){injected=true;const current=JSON.parse(await (await h.bucket.get(key)).text());
   await h.bucket.put(key,JSON.stringify({...current,attempts:5,status:'delivered',deliveredAt:new Date().toISOString()}));}
  return h.bucket.put(k,value,options);}})};
 await h.worker.scheduled({},env);
 const final=JSON.parse(await (await h.bucket.get(key)).text());
 assert.equal(final.attempts,5,'a stale attempt must not reset the counter');
 assert.equal(final.status,'delivered');
});

test('dispatch reads the KV roster, rebuilds it when absent and management refreshes it', async t => {
 const h=await withHarness(t),sink=await receiver(t);
 const created=await (await h.request('/webhooks',{method:'POST',value:validInput(sink.url)})).json();
 // The management write refreshed the derived roster in KV.
 const index1=JSON.parse(await h.env.CACHE.get('idx:webhooks'));
 assert.equal(index1.filter(hook=>hook.id===created.webhook.id).length,1);

 // A deleted roster is rebuilt from R2 on the next dispatch, and delivery works.
 await h.env.CACHE.delete('idx:webhooks');
 const bin=await (await h.request('/bins',{method:'POST',value:{name:'缓存重建',value:{k:1}}})).json();
 assert.ok(await sink.waitUntil(1),'dispatch after cache deletion still delivers');
 const index2=JSON.parse(await h.env.CACHE.get('idx:webhooks'));
 assert.equal(index2.filter(hook=>hook.id===created.webhook.id).length,1);

 // A corrupt cache entry is a miss, never a delivery failure.
 await h.env.CACHE.put('idx:webhooks','{"not":"an array"}');
 const updated=await (await h.request(`/bins/${bin.meta.id}`,{method:'PUT',headers:{'If-Match':bin.etag},value:{value:{k:2}}})).json();
 assert.ok(await sink.waitUntil(2),'corrupt cache rebuilds and delivers');
 const index3=JSON.parse(await h.env.CACHE.get('idx:webhooks'));
 assert.equal(index3.filter(hook=>hook.id===created.webhook.id).length,1);

 // Deleting the webhook removes it from the roster: no further deliveries.
 const fresh=(await h.request(`/webhooks/${created.webhook.id}`)).headers.get('etag');
 assert.equal((await h.request(`/webhooks/${created.webhook.id}`,{method:'DELETE',headers:{'If-Match':fresh}})).status,200);
 const index4=JSON.parse(await h.env.CACHE.get('idx:webhooks'));
 assert.equal(index4.filter(hook=>hook.id===created.webhook.id).length,0);
 await h.request(`/bins/${bin.meta.id}`,{method:'PUT',headers:{'If-Match':updated.etag},value:{value:{k:3}}});
 await new Promise(r=>setTimeout(r,300));
 assert.equal(sink.received.length,2,'a deleted webhook receives nothing even from a cached roster path');
});
