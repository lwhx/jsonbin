/** Deterministic isolated Worker workload. Run after `npm run build`.
 * Usage: node scripts/bench-key-usage.mjs [request-count]
 * Never hits the production deployment. Counts calls, not Cloudflare invoices. */
import { performance } from 'node:perf_hooks';
import { createSystemHarness } from '../tests/support/system-harness.mjs';

const count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 2000) {
  console.error('usage: node scripts/bench-key-usage.mjs [1..2000]');
  process.exitCode = 2;
} else {
  const h = await createSystemHarness('usage-bench-' + crypto.randomUUID());
  try {
    const createdRes = await h.request('/keys', { method: 'POST', value: {
      name: 'benchmark-only-key', scopes: ['bin:read'], rateLimitPerMinute: null,
    }});
    if (createdRes.status !== 201) throw new Error(`key create failed HTTP ${createdRes.status}`);
    const { key, token } = await createdRes.json();
    const keyPath = `keys/${key.id}/meta.json`;
    const counts = { r2KeyGets: 0, r2KeyPuts: 0, kvGets: 0, kvPuts: 0 };
    const data = h.adapt({
      get: async (path, ...args) => {
        if (path === keyPath) counts.r2KeyGets++;
        return h.bucket.get(path, ...args);
      },
      put: async (path, ...args) => {
        if (path === keyPath) counts.r2KeyPuts++;
        return h.bucket.put(path, ...args);
      },
    });
    const cache = new Proxy(h.env.CACHE, { get(target, prop) {
      if (prop === 'put') return async (...args) => { counts.kvPuts++; return target.put(...args); };
      if (prop === 'get') return async (...args) => { counts.kvGets++; return target.get(...args); };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const env = { ...h.env, DATA: data, CACHE: cache };
    const samples = [];
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const res = await h.worker.fetch(new Request('https://example.test/api/v1/bins', {
        headers: { Authorization: `Bearer ${token}` },
      }), env);
      samples.push(performance.now() - t0);
      if (res.status !== 200) throw new Error(`unexpected request ${i}: HTTP ${res.status}`);
    }
    samples.sort((a, b) => a - b);
    const at = p => Number(samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)].toFixed(2));
    console.log(JSON.stringify({
      target: 'local Miniflare Worker only',
      version: 'candidate',
      requests: count,
      latencyMs: { p50: at(.5), p95: at(.95) },
      operationCounts: counts,
      expected: { r2KeyPuts: 0, authorizedR2ReadsAtLeast: count, extraKVPutPerUsage: 0 },
      caveat: 'synthetic serial workload, not a production latency benchmark or accurate KV usage counter',
    }, null, 2));
    if (counts.r2KeyPuts !== 0 || counts.r2KeyGets < count || counts.kvPuts !== count) process.exitCode = 1;
  } finally {
    await h.close();
  }
}
