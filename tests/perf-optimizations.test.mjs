import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { getBinIfChanged } from '../src/react-app/features/bins/api.ts';
import { normalizeRoute, recordAnalytics, queryAnalytics } from '../src/worker/storage/analytics.ts';

const cached = { meta: { id: 'demo', currentVersion: 1 }, value: { enabled: true }, etag: '"cached-v1"' };

test('conditional client reuses saved Bin after 304 but never hides authentication errors', async () => {
  let status = 304;
  const headersSeen = [];
  const server = createServer((req, res) => {
    headersSeen.push(req.headers['if-none-match']);
    res.setHeader('ETag', cached.etag);
    res.statusCode = status;
    res.end(status === 200 ? JSON.stringify({ ...cached, value: { enabled: false } }) : status === 401 ? JSON.stringify({ error: 'unauthorized' }) : '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/v1/bins';
  try {
    assert.strictEqual(await getBinIfChanged('demo', cached, base), cached, '304 should reuse the identical cached object');
    assert.equal(headersSeen.at(-1), cached.etag);
    status = 200;
    const updated = await getBinIfChanged('demo', cached, base);
    assert.deepEqual(updated.value, { enabled: false });
    assert.equal(updated.etag, cached.etag);
    status = 401;
    await assert.rejects(getBinIfChanged('demo', cached, base), err => err.status === 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('detail views do not keep requesting the full Bin list', () => {
  const source = readFileSync(new URL('../src/react-app/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /const binsVisible\s*=\s*section\s*===\s*"Overview"\s*\|\|\s*\(section\s*===\s*"Bins"\s*&&\s*!binId\)/);
  assert.match(source, /enabled:\s*binsVisible/);
});

test('analytics route classification cannot generate unbounded keys from arbitrary paths', () => {
  assert.equal(normalizeRoute('/api/v1/auth/login'), '/api/v1/auth/login');
  assert.equal(normalizeRoute('/api/v1/bins/00000000-0000-0000-0000-000000000001/value/a/b'), '/api/v1/bins/:id/value/*');
  const unknown = new Set(Array.from({ length: 1000 }, (_, i) => normalizeRoute('/api/v1/auth/nonce-' + i)));
  assert.deepEqual([...unknown], ['/api/v1/unmatched']);
});

function fakeKv() {
  const values = new Map();
  return {
    async get(key, type) { const raw = values.get(key) ?? null; return type === 'json' && raw ? JSON.parse(raw) : raw; },
    async put(key, value) { values.set(key, value); },
  };
}

test('analytics P95 includes late slow requests rather than only the first 500 samples', async () => {
  const env = { CACHE: fakeKv() };
  const time = new Date().toISOString();
  for (let i = 0; i < 2300; i++) await recordAnalytics(env, {timestamp:time,method:'GET',route:'/api/v1/bins/:id',status:200,durationMs:1,authType:'session'});
  for (let i = 0; i < 2300; i++) await recordAnalytics(env, {timestamp:time,method:'GET',route:'/api/v1/bins/:id',status:200,durationMs:1000,authType:'session'});
  const result = await queryAnalytics(env, 1);
  assert.equal(result.overview.totalRequests, 4600);
  assert.equal(result.overview.p95DurationMs, 1000);
  assert.equal(result.endpoints.find(ep => ep.route === '/api/v1/bins/:id').p95DurationMs, 1000);
});
