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
  qualifiedKeyUse?: boolean;
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

/** Only actual API templates are allowed as analytics dimensions. Arbitrary request
 * paths must never leak resource names or create unbounded KV maps. */
const KNOWN_ROUTES = new Set([
  "/",
  "/activity",
  "/analytics/overview",
  "/analytics/shadow-compare",
  "/auth/config",
  "/auth/github",
  "/auth/github/callback",
  "/auth/login",
  "/auth/logout",
  "/auth/me",
  "/b/:slug",
  "/b/:slug/published",
  "/b/:slug/published/value",
  "/b/:slug/published/value/*",
  "/b/:slug/value",
  "/b/:slug/value/*",
  "/bins",
  "/bins/:id",
  "/bins/:id/clone",
  "/bins/:id/meta",
  "/bins/:id/publish",
  "/bins/:id/published",
  "/bins/:id/published/value",
  "/bins/:id/published/value/*",
  "/bins/:id/rollback",
  "/bins/:id/save-as-template",
  "/bins/:id/value",
  "/bins/:id/value/*",
  "/bins/:id/versions",
  "/bins/:id/versions/:version",
  "/bins/:id/versions/:version/restore",
  "/bins/batch",
  "/collections",
  "/collections/:id",
  "/collections/:id/bins",
  "/keys",
  "/keys/:id",
  "/keys/:id/purge",
  "/keys/:id/token",
  "/mcp",
  "/mcp/message",
  "/mcp/sse",
  "/openapi.json",
  "/schemas",
  "/schemas/:id",
  "/schemas/:id/validate",
  "/search",
  "/search/content",
  "/search/index",
  "/search/rebuild",
  "/system/export",
  "/system/health",
  "/system/import",
  "/system/info",
  "/system/restore",
  "/system/settings",
  "/templates",
  "/templates/:id",
  "/templates/:id/create-bin",
  "/trash/bins",
  "/trash/bins/:id",
  "/trash/bins/:id/restore",
  "/trash/bins/purge",
  "/webhooks",
  "/webhooks/:id",
  "/webhooks/:id/deliveries",
  "/webhooks/:id/test",
]);
const UUID_ROUTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeRoute(pathname: string): string {
  if (pathname === "/api/v1" || pathname === "/api/v1/") return "/api/v1/";
  if (!pathname.startsWith("/api/v1/")) return "/api/v1/unmatched";
  let route = pathname.slice("/api/v1".length).replace(/\/$/, "");
  const segments = route.slice(1).split("/");
  if (segments[0] === "b" && segments[1]) segments[1] = ":slug";
  for (let i = 0; i < segments.length; i++) {
    if (UUID_ROUTE.test(segments[i])) segments[i] = ":id";
  }
  route = "/" + segments.join("/");
  route = route.replace(/^(\/(?:b\/:slug|bins\/:id)(?:\/published)?)\/value\/.+$/, "$1/value/*");
  route = route.replace(/^(\/bins\/:id\/versions)\/\d+(\/restore)?$/, "$1/:version$2");
  return KNOWN_ROUTES.has(route) ? `/api/v1${route}` : "/api/v1/unmatched";
}

// Fixed width latency buckets produce bounded and mergeable percentile stats.
// Existing old-format buckets (first-N samples) remain readable until expiry.
const DURATION_BOUNDS = [0,1,2,3,5,8,10,20,30,50,75,100,150,200,300,500,750,1000,1500,2000,3000,5000,7500,10000,20000,30000,60000,120000,300000,600000];
type DurationHistogram = Record<string, number>;
function observeDuration(hist: DurationHistogram, duration: number) {
  const value = Number.isFinite(duration) ? Math.max(0, duration) : 600000;
  const bound = DURATION_BOUNDS.find(b => value <= b) ?? 600000;
  hist[String(bound)] = (hist[String(bound)] || 0) + 1;
}
function mergeDurationHist(target: DurationHistogram, source: DurationHistogram | undefined, legacy: number[] | undefined) {
  if (source && Object.keys(source).length) {
    for (const [key, count] of Object.entries(source)) {
      if (!DURATION_BOUNDS.includes(Number(key)) || !Number.isFinite(count) || count < 0) continue;
      target[key] = (target[key] || 0) + count;
    }
  } else if (Array.isArray(legacy)) {
    for (const value of legacy) if (typeof value === "number") observeDuration(target, value);
  }
}
function percentile95(hist: DurationHistogram): number {
  const counts = Object.entries(hist).sort(([a], [b]) => Number(a) - Number(b));
  const total = counts.reduce((n, [, count]) => n + count, 0);
  if (!total) return 0;
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (const [upper, count] of counts) {
    seen += count;
    if (seen >= target) return Number(upper);
  }
  return Number(counts[counts.length - 1][0]);
}

export const ANALYTICS_PREFIX = "analytics:agg:";
export const ANALYTICS_SHARDS_COUNT = 4;
const SHARDS_COUNT = ANALYTICS_SHARDS_COUNT;
// Cloudflare KV bulk reads support up to 100 keys per call. Bound concurrency
// and process one window at a time so 30-day queries do not retain 3,600
// parsed records in Worker memory or exhaust the 1,000-operations limit.
const QUERY_BATCH_SIZE = 100;
const QUERY_BATCH_CONCURRENCY = 6;

/**
 * Infrastructure-only success responses have no API Key usage to settle.
 * Do not spend a KV read + put on every probe or login-page configuration
 * check. Failures, non-GET methods and ANY authenticated/credential-bearing
 * request are still recorded; this must never skip a qualified Key use.
 *
 * The opt-in Analytics Engine shadow observer runs independently in index.ts,
 * so it can still capture all of these events when enabled.
 */
export function shouldRecordKvAnalytics(dp: AnalyticsDataPoint): boolean {
  if (dp.method !== "GET" || dp.status !== 200 || dp.authType !== "anonymous" ||
      dp.keyId != null || dp.qualifiedKeyUse) return true;
  return dp.route !== "/api/v1/system/health" && dp.route !== "/api/v1/auth/config";
}

/**
 * Record a single request metrics data point in KV.
 */
export async function recordAnalytics(env: Env, dp: AnalyticsDataPoint): Promise<void> {
  if (!env.CACHE || !shouldRecordKvAnalytics(dp)) return;
  try {
    const hourBucket = dp.timestamp.slice(0, 13); // e.g. "2026-10-06T04"
    const shardId = Math.floor(Math.random() * SHARDS_COUNT);
    const key = `${ANALYTICS_PREFIX}${hourBucket}:${shardId}`;

    // Read or init bucket
    const existing = await env.CACHE.get<string>(key, "json").catch(() => null) as any;
    const bucket = existing || {
      requests: 0,
      totalDuration: 0,
      durationHistogram: {} as DurationHistogram,
      statuses: {} as Record<string, number>,
      endpoints: {} as Record<string, { requests: number; totalDuration: number; errors: number; durationHistogram: DurationHistogram }>,
      keys: {} as Record<string, { requests: number; count4xx: number; count429: number }>,
      errors: {} as Record<string, number>,
    };

    bucket.requests += 1;
    bucket.totalDuration += dp.durationMs;
    // Histogram includes every processed request, not only the first N per hour.
    bucket.durationHistogram ??= {};
    observeDuration(bucket.durationHistogram, dp.durationMs);

    const statusStr = String(dp.status);
    bucket.statuses[statusStr] = (bucket.statuses[statusStr] || 0) + 1;

    const epKey = `${dp.method} ${dp.route}`;
    if (!bucket.endpoints[epKey]) {
      bucket.endpoints[epKey] = { requests: 0, totalDuration: 0, errors: 0, durationHistogram: {} };
    }
    const ep = bucket.endpoints[epKey];
    ep.requests += 1;
    ep.totalDuration += dp.durationMs;
    if (dp.status >= 400) ep.errors += 1;
    ep.durationHistogram ??= {};
    observeDuration(ep.durationHistogram, dp.durationMs);

    if (dp.keyId) {
      if (!bucket.keys[dp.keyId]) {
        bucket.keys[dp.keyId] = { requests: 0, count4xx: 0, count429: 0 };
      }
      const kStat = bucket.keys[dp.keyId];
      kStat.requests += 1;
      if (dp.status >= 400 && dp.status < 500) kStat.count4xx += 1;
      if (dp.status === 429) kStat.count429 += 1;
      if (dp.qualifiedKeyUse) {
        kStat.authorizedUses = (kStat.authorizedUses || 0) + 1;
        if (!kStat.lastAuthorizedAt || kStat.lastAuthorizedAt < dp.timestamp) {
          kStat.lastAuthorizedAt = dp.timestamp;
        }
      }
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
      partial: true,
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

  let totalRequests = 0;
  let totalDuration = 0;
  const durationsHistogram: DurationHistogram = {};
  const statusMap: Record<string, number> = {};
  const endpointMap: Record<string, { requests: number; totalDuration: number; errors: number; durationHistogram: DurationHistogram }> = {};
  const keyMap: Record<string, { requests: number; count4xx: number; count429: number }> = {};
  const errorMap: Record<string, number> = {};

  const mergeBucket = (b: any) => {
    totalRequests += b.requests || 0;
    totalDuration += b.totalDuration || 0;
    mergeDurationHist(durationsHistogram, b.durationHistogram, b.durations);

    for (const [st, cnt] of Object.entries(b.statuses || {})) {
      statusMap[st] = (statusMap[st] || 0) + (cnt as number);
    }
    for (const [ep, data] of Object.entries(b.endpoints || {})) {
      const d = data as any;
      if (!endpointMap[ep]) endpointMap[ep] = { requests: 0, totalDuration: 0, errors: 0, durationHistogram: {} };
      endpointMap[ep].requests += d.requests;
      endpointMap[ep].totalDuration += d.totalDuration;
      endpointMap[ep].errors += d.errors;
      mergeDurationHist(endpointMap[ep].durationHistogram, d.durationHistogram, d.durations);
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
  };
  // A 30-day query can address 720 hours * (4 shards + 1 legacy) = 3,600
  // keys. Fetching those individually exceeds Workers KV's 1,000 operation
  // limit. Bulk GET handles 100 keys per *operation* and returns a Map.
  // Process at most six bulk responses together to bound peak memory.
  let partial = false;
  for (let offset = 0; offset < bucketKeys.length; offset += QUERY_BATCH_SIZE * QUERY_BATCH_CONCURRENCY) {
    const chunks: string[][] = [];
    const limit = Math.min(bucketKeys.length, offset + QUERY_BATCH_SIZE * QUERY_BATCH_CONCURRENCY);
    for (let i = offset; i < limit; i += QUERY_BATCH_SIZE) {
      chunks.push(bucketKeys.slice(i, i + QUERY_BATCH_SIZE));
    }
    const results = await Promise.all(chunks.map(async chunk => {
      try { return await cache.get(chunk, "json"); }
      catch { return null; }
    }));
    for (let i = 0; i < chunks.length; i++) {
      const records = results[i];
      if (!(records instanceof Map)) {
        // Keep the successful metrics but flag incomplete results instead of
        // silently presenting a partial count as an authoritative total.
        partial = true;
        continue;
      }
      for (const key of chunks[i]) {
        const bucket = records.get(key);
        if (bucket) mergeBucket(bucket);
      }
    }
  }

  const p95 = percentile95(durationsHistogram);
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
      const epP95 = percentile95(d.durationHistogram);
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
    partial,
  };
}
