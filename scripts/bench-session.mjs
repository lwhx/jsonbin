/** Isolated Miniflare microbenchmark: one authenticated /auth/me request 300x. */
import { performance } from "node:perf_hooks";
import { createSystemHarness } from "../tests/support/system-harness.mjs";

const h = await createSystemHarness("session-bench-" + crypto.randomUUID());
try {
  const op = { get: 0, put: 0, head: 0, list: 0 };
  const bucket = h.adapt({
    get: (...args) => { op.get++; return h.bucket.get(...args); },
    put: (...args) => { op.put++; return h.bucket.put(...args); },
    head: (...args) => { op.head++; return h.bucket.head(...args); },
    list: (...args) => { op.list++; return h.bucket.list(...args); },
  });
  const env = { ...h.env, DATA: bucket };
  const durations = [];
  for (let i = 0; i < 300; i++) {
    const request = new Request("https://example.test/api/v1/auth/me", { headers: { Cookie: h.cookie } });
    const start = performance.now();
    const response = await h.worker.fetch(request, env);
    if (response.status !== 200) throw new Error("session bench received " + response.status);
    durations.push(performance.now() - start);
  }
  const sorted = durations.toSorted((a, b) => a - b);
  const at = percentile => Math.round(sorted[Math.ceil(percentile / 100 * sorted.length) - 1] * 100) / 100;
  console.log(JSON.stringify({ iterationCount: durations.length, r2: op, p50ms: at(50), p95ms: at(95), p99ms: at(99) }));
} finally {
  await h.close();
}
