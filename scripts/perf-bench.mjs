/**
 * Reproducible storage/API benchmark for JSONBin on miniflare.
 *
 * Measures per-scenario wall-clock latency percentiles and the exact number of
 * R2 / KV binding operations, by wrapping the real workerd bindings in
 * counting proxies (the same dispatch style the unit tests use).
 *
 * Usage: node scripts/perf-bench.mjs <label>   → writes bench-results/<label>.json
 * Requires a fresh build first: npm run build
 */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const label = process.argv[2] ?? 'run';
const PASSWORD = randomBytes(32).toString('hex');
const SESSION_SECRET = randomBytes(32).toString('hex');

const mf = new Miniflare(convertV4MiniflareOptions({
  cf: false,
  workers: [{
    name: 'jsonbin-bench', modules: true, scriptPath: 'dist/jsonbin/index.js',
    compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], kvNamespaces: ['CACHE'],
    bindings: { ADMIN_USERNAME: 'bench', ADMIN_PASSWORD: PASSWORD, SESSION_SECRET },
  }],
}));
const worker = (await import('../dist/jsonbin/index.js')).default;

// ---- counting wrappers ----------------------------------------------------
const ops = { r2: { get: 0, put: 0, head: 0, delete: 0, list: 0 }, kv: { get: 0, put: 0, delete: 0, list: 0 } };
const snapshot = () => JSON.parse(JSON.stringify(ops));
const diff = (a, b) => {
  const d = {};
  for (const store of ['r2', 'kv']) for (const op of Object.keys(ops[store])) {
    const n = b[store][op] - a[store][op];
    if (n) d[`${store}.${op}`] = n;
  }
  return d;
};
const wrap = (target, counter) => new Proxy(target, {
  get(t, prop) {
    const value = Reflect.get(t, prop, t);
    if (typeof value !== 'function') return value;
    if (prop in counter) counter[prop]++;
    return value.bind(t);
  },
});
const env = {
  DATA: wrap(await mf.getR2Bucket('DATA', 'jsonbin-bench'), ops.r2),
  CACHE: wrap(await mf.getKVNamespace('CACHE', 'jsonbin-bench'), ops.kv),
  ADMIN_USERNAME: 'bench', ADMIN_PASSWORD: PASSWORD, SESSION_SECRET,
};

// ---- helpers ---------------------------------------------------------------
const ORIGIN = 'https://bench.test';
let cookie = '';
async function call0(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (cookie) headers.set('Cookie', cookie);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return worker.fetch(new Request(ORIGIN + '/api/v1' + path, { ...init, headers }), env);
}
async function call(path, init = {}) {
  const response = await call0(path, init);
  await response.arrayBuffer().catch(() => {});
  return response;
}
async function callJson(path, init = {}) {
  const response = await call0(path, init);
  return response.json();
}
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { n: sorted.length, mean: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length), p50: at(0.5), p95: at(0.95) };
};
const results = {};
async function scenario(name, requests, { iterations = 30, warmup = 3 } = {}) {
  for (let i = 0; i < warmup; i++) await requests(i, true);
  const before = snapshot();
  const latencies = [];
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const response = await requests(i, false);
    latencies.push(performance.now() - start);
    if (response && response.status >= 500) throw new Error(`${name}: unexpected ${response.status}`);
  }
  results[name] = { latencyMs: percentiles(latencies), wallMs: Math.round(performance.now() - t0), ops: diff(before, snapshot()) };
}

// ---- seed ------------------------------------------------------------------
{
  const login = await call0('/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bench', password: PASSWORD }) });
  if (login.status !== 200) throw new Error('login failed: ' + login.status);
  cookie = login.headers.get('set-cookie').split(';')[0];
}
const smallValue = (i) => ({ name: `item-${i}`, flags: [true, false], nested: { depth: 2, values: Array.from({ length: 12 }, (_, k) => i * 100 + k) }, text: 'x'.repeat(200) });
const bins = [];
{
  const before = snapshot();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) {
    const created = await callJson('/bins', { method: 'POST', body: JSON.stringify({ name: `bench-bin-${i}`, value: smallValue(i) }) });
    bins.push(created.meta);
  }
  // One bin with many historical versions (write-path scaling) and a large-value bin.
  for (let i = 0; i < 120; i++) {
    const record = await callJson('/bins/' + bins[0].id);
    const put = await callJson('/bins/' + bins[0].id, { method: 'PUT', headers: { 'If-Match': record.etag }, body: JSON.stringify({ value: smallValue(i) }) });
    if (!put.meta) throw new Error('seed version append failed');
  }
  const large = Array.from({ length: 1800 }, (_, k) => ({ id: k, label: 'entry-' + k, payload: 'y'.repeat(64) }));
  bins.push((await callJson('/bins', { method: 'POST', body: JSON.stringify({ name: 'bench-large', value: large }) })).meta);
  results.seed = { bins: bins.length, wallMs: Math.round(performance.now() - t0), ops: diff(before, snapshot()) };
}

// ---- scenarios -------------------------------------------------------------
await scenario('list_bins', async () => call('/bins'));
await scenario('get_bin', async () => call('/bins/' + bins[3].id), { iterations: 60 });
await scenario('get_bin_large', async () => call('/bins/' + bins[40].id), { iterations: 20 });
{
  let current = await callJson('/bins/' + bins[7].id);
  await scenario('put_write', async (i) => {
    const put = await callJson('/bins/' + bins[7].id, { method: 'PUT', headers: { 'If-Match': current.etag }, body: JSON.stringify({ value: smallValue(1000 + i) }) });
    if (put.meta) current = put;
    return put;
  }, { iterations: 50 });
  let hot = await callJson('/bins/' + bins[0].id);
  await scenario('put_write_many_versions', async (i) => {
    const put = await callJson('/bins/' + bins[0].id, { method: 'PUT', headers: { 'If-Match': hot.etag }, body: JSON.stringify({ value: smallValue(2000 + i) }) });
    if (put.meta) hot = put;
    return put;
  }, { iterations: 20 });
  await scenario('patch_merge', async (i) => {
    const fresh = await callJson('/bins/' + bins[8].id);
    return call('/bins/' + bins[8].id, { method: 'PATCH', headers: { 'If-Match': fresh.etag, 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify({ patched: i }) });
  }, { iterations: 30 });
}
await scenario('list_versions', async () => call('/bins/' + bins[0].id + '/versions'), { iterations: 20 });
await scenario('search', async () => call('/search?q=bench&type=bin'), { iterations: 10 });
await scenario('options_preflight', async () => call('/bins', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } }), { iterations: 30, warmup: 1 });
await scenario('health', async () => call('/system/health'), { iterations: 30 });
{
  const before = snapshot();
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) await call('/bins/' + bins[3].id);
  results.analytics_mixed = { wallMs: Math.round(performance.now() - t0), ops: diff(before, snapshot()) };
}
{
  // Webhook dispatch cost on the write path: two active hooks, local receiver.
  const received = [];
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { received.push(1); res.writeHead(200); res.end('ok'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${server.address().port}/hook`;
  for (let i = 0; i < 2; i++) {
    const created = await call0('/webhooks', { method: 'POST', body: JSON.stringify({ name: `bench-hook-${i}`, url: hookUrl, secret: 'bench-secret-0000000000000001', events: ['bin.*'] }) });
    if (created.status !== 201) throw new Error('webhook seed failed: ' + created.status);
    await created.arrayBuffer().catch(() => {});
  }
  let current = await callJson('/bins/' + bins[11].id);
  const before = snapshot();
  const t0 = performance.now();
  for (let i = 0; i < 15; i++) {
    const put = await callJson('/bins/' + bins[11].id, { method: 'PUT', headers: { 'If-Match': current.etag }, body: JSON.stringify({ value: smallValue(4000 + i) }) });
    if (put.meta) current = put;
  }
  const writeWallMs = Math.round(performance.now() - t0);
  // Dispatch runs in waitUntil/background: settle deliveries before the op window closes.
  const settleStart = Date.now();
  while (received.length < 30 && Date.now() - settleStart < 15000) await new Promise(r => setTimeout(r, 50));
  results.webhook_dispatch = { writes: 15, deliveries: received.length, writeWallMs, ops: diff(before, snapshot()) };
  server.close();
}
{
  // Cron: full scheduled maintenance sweep.
  const controller = { cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const before = snapshot();
    const t0 = performance.now();
    await worker.scheduled(controller, env, ctx);
    runs.push({ wallMs: Math.round(performance.now() - t0), ops: diff(before, snapshot()) });
  }
  results.cron_sweep = { runs };
}

// ---- output ----------------------------------------------------------------
mkdirSync('bench-results', { recursive: true });
const report = { label, node: process.version, bins: bins.length, generatedAt: new Date().toISOString(), results };
writeFileSync(`bench-results/${label}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ label, scenarios: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.latencyMs ?? v.wallMs ?? k])), ops: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ops ?? {}])) }, null, 2));
await mf.dispose();
