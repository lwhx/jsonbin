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
