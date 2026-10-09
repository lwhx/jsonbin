/**
 * Baseline/candidate same-load rate limiting microbenchmark (100 below baseline 120/min budget) for Workers.
 * Prints limiter-only KV and R2 call counts, and response p50/p95.
 * Run in GitHub Actions against both main and this feature branch.
 */
import { performance } from "node:perf_hooks";
import { createSystemHarness } from "../tests/support/system-harness.mjs";

const h = await createSystemHarness("rate-bench-" + crypto.randomUUID());
const observations = { limiterKvGet: 0, limiterKvPut: 0, limiterR2Get: 0, limiterR2Put: 0, nativeCalls: 0 };
try {
  const generated = await (await h.request("/keys", { method: "POST",
    value: { name: "benchmark-default-rate", scopes: ["bin:read"] } })).json();
  const cache = new Proxy(h.env.CACHE, { get(target, property) {
    if (property === "get") return async (...args) => {
      if (String(args[0]).startsWith("rl:")) observations.limiterKvGet++;
      return target.get(...args);
    };
    if (property === "put") return async (...args) => {
      if (String(args[0]).startsWith("rl:")) observations.limiterKvPut++;
      return target.put(...args);
    };
    const value = target[property];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const bucket = h.adapt({
    get: (key, ...args) => {
      if (String(key).startsWith("auth/key-rate/")) observations.limiterR2Get++;
      return h.bucket.get(key, ...args);
    },
    put: (key, ...args) => {
      if (String(key).startsWith("auth/key-rate/")) observations.limiterR2Put++;
      return h.bucket.put(key, ...args);
    },
  });
  const env = { ...h.env, CACHE: cache, DATA: bucket,
    JSONBIN_KEY_RATE: { limit: async () => { observations.nativeCalls++; return { success: true }; } },
  };
  const durations = [];
  for (let i = 0; i < 100; i++) {
    const request = new Request("https://example.test/api/v1/bins", {
      headers: { Authorization: "Bearer " + generated.token },
    });
    const t = performance.now();
    const response = await h.worker.fetch(request, env);
    if (response.status !== 200) throw new Error("benchmark failed at " + i + ": " + response.status);
    durations.push(performance.now() - t);
  }
  const sorted = durations.toSorted((a,b) => a - b);
  const pct = p => Math.round(sorted[Math.ceil(sorted.length * p / 100) - 1] * 100) / 100;
  console.log(JSON.stringify({ requests: durations.length, operations: observations, p50ms: pct(50), p95ms: pct(95) }));
} finally {
  await h.close();
}
