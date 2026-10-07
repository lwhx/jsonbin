/**
 * Request Analytics and Metrics Collector for JSONBin v3.2.
 * Adheres strictly to the privacy and security rules:
 * NEVER records auth tokens, cookies, request/response bodies, or raw query secrets.
 * Writes are best-effort and NEVER fail the business request.
 */

export type AnalyticsDataPoint = {
  timestamp: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  authType: "session" | "api_key" | "anonymous" | "system";
  keyId?: string | null;
  resourceType?: string;
  error?: string | null;
};

export type AnalyticsOverview = {
  totalRequests: number;
  successRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
  count4xx: number;
  count5xx: number;
  count429: number;
};

export type EndpointStat = {
  route: string;
  method: string;
  requests: number;
  avgDurationMs: number;
  p95DurationMs: number;
  errorRate: number;
};

export type StatusStat = {
  status: number;
  count: number;
};

export type ErrorStat = {
  error: string;
  count: number;
};

export type KeyStat = {
  keyId: string;
  requests: number;
  count4xx: number;
  count429: number;
};

/**
 * First path segment vocabulary of the mounted API: a route whose root is not
 * one of these is an unmatched/extraneous path and collapses into a single
 * bucket, bounding endpoint cardinality no matter what a client sends.
 */
const KNOWN_ROUTE_ROOTS = new Set([
  "b", "bins", "collections", "schemas", "templates", "keys", "webhooks",
  "trash", "search", "mcp", "system", "activity", "analytics", "auth",
]);
const UUID_ROUTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes a URL path into a bounded route template. Deep JSON-path tails
 * (`/value/<arbitrary tokens>`), version numbers and unknown roots collapse
 * into fixed placeholders: request paths must never leak resource content or
 * explode KV cardinality (F08).
 */
export function normalizeRoute(pathname: string): string {
  let route = pathname.replace(/^\/api\/v1/, "");
  if (!route || route === "/") return "/api/v1/";

  const segments = route.slice(1).split("/");
  // /b/:slug and every UUID-rooted namespace collapse to their template form.
  if (segments[0] === "b") segments[1] = ":slug";
  for (const [index, segment] of segments.entries()) {
    if (UUID_ROUTE.test(segment)) segments[index] = ":id";
  }

  route = "/" + segments.join("/");
  // Deep JSON paths carry attacker-controlled tokens: collapse the tail.
  route = route.replace(/^(\/(?:b\/:slug|bins\/:id)(?:\/published)?)\/value\/.+$/, "$1/value/*");
  // Numeric version segments are per-bin unbounded: collapse to a placeholder.
  route = route.replace(/^(\/bins\/:id\/versions)\/\d+(\/restore)?$/, "$1/:version$2");

  // Unknown roots or leftover exotic segments cannot be a real endpoint.
  const finalSegments = route.slice(1).split("/");
  const bounded = KNOWN_ROUTE_ROOTS.has(finalSegments[0])
    && finalSegments.length <= 8
    && finalSegments.every(segment => /^[a-z0-9:_.@*-]+$/i.test(segment));
  return bounded ? `/api/v1${route}` : "/api/v1/unmatched";
}

const ANALYTICS_PREFIX = "analytics:agg:";
const SHARDS_COUNT = 4;

/**
 * Record a single request metrics data point in KV.
 */
export async function recordAnalytics(env: Env, dp: AnalyticsDataPoint): Promise<void> {
  if (!env.CACHE) return;
  try {
    const hourBucket = dp.timestamp.slice(0, 13); // e.g. "2026-10-06T04"
    const shardId = Math.floor(Math.random() * SHARDS_COUNT);
    const key = `${ANALYTICS_PREFIX}${hourBucket}:${shardId}`;

    // Read or init bucket
    const existing = await env.CACHE.get<string>(key, "json").catch(() => null) as any;
    const bucket = existing || {
      requests: 0,
      totalDuration: 0,
      durations: [] as number[],
      statuses: {} as Record<string, number>,
      endpoints: {} as Record<string, { requests: number; totalDuration: number; errors: number; durations: number[] }>,
      keys: {} as Record<string, { requests: number; count4xx: number; count429: number }>,
      errors: {} as Record<string, number>,
    };

    bucket.requests += 1;
    bucket.totalDuration += dp.durationMs;
    // Keep a bounded sample of durations for P95 calculation
    if (bucket.durations.length < 500) {
      bucket.durations.push(dp.durationMs);
    }

    const statusStr = String(dp.status);
    bucket.statuses[statusStr] = (bucket.statuses[statusStr] || 0) + 1;

    const epKey = `${dp.method} ${dp.route}`;
    if (!bucket.endpoints[epKey]) {
      bucket.endpoints[epKey] = { requests: 0, totalDuration: 0, errors: 0, durations: [] };
    }
    const ep = bucket.endpoints[epKey];
    ep.requests += 1;
    ep.totalDuration += dp.durationMs;
    if (dp.status >= 400) ep.errors += 1;
    if (ep.durations.length < 200) ep.durations.push(dp.durationMs);

    if (dp.keyId) {
      if (!bucket.keys[dp.keyId]) {
        bucket.keys[dp.keyId] = { requests: 0, count4xx: 0, count429: 0 };
      }
      const kStat = bucket.keys[dp.keyId];
      kStat.requests += 1;
      if (dp.status >= 400 && dp.status < 500) kStat.count4xx += 1;
      if (dp.status === 429) kStat.count429 += 1;
    }

    if (dp.error) {
      bucket.errors[dp.error] = (bucket.errors[dp.error] || 0) + 1;
    }

    // Retain for 35 days (TTL in seconds)
    await env.CACHE.put(key, JSON.stringify(bucket), { expirationTtl: 35 * 86400 });
  } catch {
    // Best-effort: ignore errors
  }
}

/**
 * Fetch and aggregate analytics across the requested time range.
 */
export async function queryAnalytics(env: Env, hours = 24) {
  const cache = env.CACHE;
  if (!cache) {
    return {
      overview: { totalRequests: 0, successRate: 1, avgDurationMs: 0, p95DurationMs: 0, count4xx: 0, count5xx: 0, count429: 0 },
      endpoints: [],
      statuses: [],
      keys: [],
      errors: [],
    };
  }

  const now = Date.now();
  const bucketKeys: string[] = [];
  for (let i = 0; i < hours; i++) {
    const d = new Date(now - i * 3600000);
    const hourBucket = d.toISOString().slice(0, 13);
    // Include both sharded keys and legacy non-sharded keys
    bucketKeys.push(`${ANALYTICS_PREFIX}${hourBucket}`);
    for (let s = 0; s < SHARDS_COUNT; s++) {
      bucketKeys.push(`${ANALYTICS_PREFIX}${hourBucket}:${s}`);
    }
  }

  const buckets = await Promise.all(
    bucketKeys.map(async (k) => {
      try {
        const str = await cache.get(k);
        return str ? JSON.parse(str) : null;
      } catch {
        return null;
      }
    }),
  );

  let totalRequests = 0;
  let totalDuration = 0;
  let allDurations: number[] = [];
  const statusMap: Record<string, number> = {};
  const endpointMap: Record<string, { requests: number; totalDuration: number; errors: number; durations: number[] }> = {};
  const keyMap: Record<string, { requests: number; count4xx: number; count429: number }> = {};
  const errorMap: Record<string, number> = {};

  for (const b of buckets) {
    if (!b) continue;
    totalRequests += b.requests || 0;
    totalDuration += b.totalDuration || 0;
    if (Array.isArray(b.durations)) allDurations.push(...b.durations);

    for (const [st, cnt] of Object.entries(b.statuses || {})) {
      statusMap[st] = (statusMap[st] || 0) + (cnt as number);
    }
    for (const [ep, data] of Object.entries(b.endpoints || {})) {
      const d = data as any;
      if (!endpointMap[ep]) endpointMap[ep] = { requests: 0, totalDuration: 0, errors: 0, durations: [] };
      endpointMap[ep].requests += d.requests;
      endpointMap[ep].totalDuration += d.totalDuration;
      endpointMap[ep].errors += d.errors;
      if (Array.isArray(d.durations)) endpointMap[ep].durations.push(...d.durations);
    }
    for (const [kId, data] of Object.entries(b.keys || {})) {
      const d = data as any;
      if (!keyMap[kId]) keyMap[kId] = { requests: 0, count4xx: 0, count429: 0 };
      keyMap[kId].requests += d.requests;
      keyMap[kId].count4xx += d.count4xx;
      keyMap[kId].count429 += d.count429;
    }
    for (const [err, cnt] of Object.entries(b.errors || {})) {
      errorMap[err] = (errorMap[err] || 0) + (cnt as number);
    }
  }

  allDurations.sort((a, b) => a - b);
  const p95 = allDurations.length ? allDurations[Math.floor(allDurations.length * 0.95)] : 0;
  const avgDuration = totalRequests ? Math.round(totalDuration / totalRequests) : 0;

  let count4xx = 0;
  let count5xx = 0;
  let count2xx = 0;
  for (const [code, count] of Object.entries(statusMap)) {
    const num = Number(code);
    if (num >= 200 && num < 400) count2xx += count;
    if (num >= 400 && num < 500) count4xx += count;
    if (num >= 500) count5xx += count;
  }
  const count429 = statusMap["429"] || 0;
  const successRate = totalRequests ? Number(((count2xx / totalRequests) * 100).toFixed(2)) : 100;

  const endpoints: EndpointStat[] = Object.entries(endpointMap)
    .map(([key, d]) => {
      const [method, ...routeParts] = key.split(" ");
      const epDurations = d.durations.sort((a: number, b: number) => a - b);
      const epP95 = epDurations.length ? epDurations[Math.floor(epDurations.length * 0.95)] : 0;
      return {
        method,
        route: routeParts.join(" "),
        requests: d.requests,
        avgDurationMs: Math.round(d.totalDuration / d.requests),
        p95DurationMs: epP95,
        errorRate: Number(((d.errors / d.requests) * 100).toFixed(2)),
      };
    })
    .sort((a, b) => b.requests - a.requests);

  const statuses: StatusStat[] = Object.entries(statusMap)
    .map(([st, cnt]) => ({ status: Number(st), count: cnt }))
    .sort((a, b) => b.count - a.count);

  const keys: KeyStat[] = Object.entries(keyMap)
    .map(([keyId, d]) => ({ keyId, requests: d.requests, count4xx: d.count4xx, count429: d.count429 }))
    .sort((a, b) => b.requests - a.requests);

  const errors: ErrorStat[] = Object.entries(errorMap)
    .map(([error, count]) => ({ error, count }))
    .sort((a, b) => b.count - a.count);

  return {
    overview: {
      totalRequests,
      successRate,
      avgDurationMs: avgDuration,
      p95DurationMs: p95,
      count4xx,
      count5xx,
      count429,
    },
    endpoints,
    statuses,
    keys,
    errors,
  };
}
