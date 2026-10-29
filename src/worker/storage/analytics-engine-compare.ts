/**
 * Read-only, opt-in KV vs Analytics Engine diagnostics.
 * Never used for authentication, rate limits, billing, API Key usage settlement
 * or the management dashboard's normal /overview response.
 */
import { normalizeRoute, queryAnalytics } from "./analytics.ts";

type QueryRow = Record<string, unknown>;
type SqlResult = { data: QueryRow[]; rows: number; statistics?: { elapsed_ms?: number; rows_read?: number; bytes_read?: number } };
type ReadOnlySql = { query(input: { query: string; params: { start: string; end: string } }): Promise<SqlResult> };
export type ShadowCompareEnv = Env & {
  ANALYTICS_SQL?: ReadOnlySql;
  ANALYTICS_SHADOW_COMPARE?: string;
  ANALYTICS_SHADOW_DATASET?: string;
  ANALYTICS_SHADOW_STARTED_AT?: string;
  ANALYTICS_EVENTS_SHADOW?: string;
};

const ALLOWED_DATASETS: Record<string, string> = {
  "jsonbin-api-shadow-preview": 'events.analyticsEngine."jsonbin-api-shadow-preview"',
  "jsonbin-api-shadow-prod": 'events.analyticsEngine."jsonbin-api-shadow-prod"',
};
const RANGES: Record<string, number> = { "1h": 1, "24h": 24, "7d": 168, "30d": 720 };
const ENDPOINT_LIMIT = 150;
const METHOD_SET = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const asNumber = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1e15) throw new Error("invalid_shadow_metric");
  return n;
};
const asCount = (value: unknown): number => {
  const n = asNumber(value);
  if (!Number.isSafeInteger(n)) throw new Error("invalid_shadow_count");
  return n;
};
const asRows = (value: SqlResult): QueryRow[] => {
  if (!value || !Array.isArray(value.data)) throw new Error("invalid_shadow_result");
  return value.data;
};

export function shadowComparisonEnabled(env: ShadowCompareEnv): boolean {
  return env.ANALYTICS_SHADOW_COMPARE === "1" &&
    env.ANALYTICS_EVENTS_SHADOW === "1" &&
    Boolean(env.ANALYTICS_SQL) &&
    Object.hasOwn(ALLOWED_DATASETS, env.ANALYTICS_SHADOW_DATASET ?? "");
}

export function shadowComparisonRange(range: string): number | null {
  return Object.hasOwn(RANGES, range) ? RANGES[range] : null;
}

function utcWindowStart(hours: number, nowMs: number): number {
  const date = new Date(nowMs);
  date.setUTCMinutes(0, 0, 0);
  return date.getTime() - (hours - 1) * 3600_000;
}

function sanitizedEndpoint(row: QueryRow) {
  const method = row.method;
  const route = row.route;
  if (typeof method !== "string" || !METHOD_SET.has(method) ||
      typeof route !== "string" || route.length > 160 || normalizeRoute(route) !== route) return null;
  const requests = asCount(row.requests);
  const totalDuration = asNumber(row.totalDurationMs);
  const errors = asCount(row.errors);
  if (!requests || errors > requests) return null;
  return {
    method,
    route,
    requests,
    avgDurationMs: Math.round(totalDuration / requests),
    p95DurationMs: asNumber(row.p95DurationMs),
    errorRate: Number(((errors / requests) * 100).toFixed(2)),
  };
}

export async function compareShadowAnalytics(
  env: ShadowCompareEnv,
  range: string,
  nowMs = Date.now(),
) {
  const hours = shadowComparisonRange(range);
  if (!hours || !shadowComparisonEnabled(env) || !Number.isFinite(nowMs)) {
    throw new Error("shadow_compare_not_configured");
  }
  const startMs = utcWindowStart(hours, nowMs);
  const start = new Date(startMs).toISOString();
  const end = new Date(nowMs).toISOString();
  const dataset = ALLOWED_DATASETS[env.ANALYTICS_SHADOW_DATASET!];
  const params = { start, end };
  // Identifiers come ONLY from the literal whitelist. Never interpolate any
  // request input or arbitrary config values into SQL.
  const clause = `FROM ${dataset} WHERE timestamp >= $start AND timestamp < $end AND index1 = 'jsonbin'`;
  const queries = {
    overview: `SELECT SUM(_sample_interval) AS totalRequests,
      SUM(_sample_interval * double2) AS totalDurationMs,
      quantileExactWeighted(0.95)(double2, _sample_interval) AS p95DurationMs
      ${clause}`,
    statuses: `SELECT blob3 AS status, SUM(_sample_interval) AS requests
      ${clause} GROUP BY blob3 ORDER BY requests DESC LIMIT 600`,
    endpoints: `SELECT blob1 AS method, blob2 AS route,
      SUM(_sample_interval) AS requests,
      SUM(_sample_interval * double2) AS totalDurationMs,
      sumIf(_sample_interval, toUInt32(blob3) >= 400) AS errors,
      quantileExactWeighted(0.95)(double2, _sample_interval) AS p95DurationMs
      ${clause} GROUP BY blob1, blob2 ORDER BY requests DESC LIMIT ${ENDPOINT_LIMIT + 1}`,
  };
  const sql = env.ANALYTICS_SQL!;
  // Independently read the existing KV aggregate. A failed SQL read cannot
  // replace, corrupt, or hide the legacy dashboard's historical values.
  const [legacyResult, sqlResult] = await Promise.allSettled([
    queryAnalytics(env, hours),
    Promise.all([
      sql.query({ query: queries.overview, params }),
      sql.query({ query: queries.statuses, params }),
      sql.query({ query: queries.endpoints, params }),
    ]),
  ]);
  if (legacyResult.status !== "fulfilled") throw new Error("legacy_analytics_unavailable");
  const legacy = legacyResult.value;

  const startedMs = typeof env.ANALYTICS_SHADOW_STARTED_AT === "string"
    ? Date.parse(env.ANALYTICS_SHADOW_STARTED_AT) : NaN;
  // An explicit start timestamp is mandatory before a full-window comparison
  // can be considered meaningful. Shadow ingestion can still lag behind KV.
  const coverage = !Number.isFinite(startedMs) || startedMs > nowMs
    ? "unknown" : startedMs <= startMs ? "full_window" : "partial_window";
  const baseline = {
    range, start, end, legacy,
    coverage,
    comparable: false,
    deltas: null as null | { requestDifference: number; requestDifferencePercent: number | null },
  };
  if (sqlResult.status !== "fulfilled") {
    return {
      ...baseline,
      shadow: { available: false, reason: "sql_unavailable" as const },
    };
  }

  try {
    const [overviewResult, statusResult, endpointResult] = sqlResult.value;
    const overviewRow = asRows(overviewResult)[0];
    const totalRequests = overviewRow ? asCount(overviewRow.totalRequests ?? 0) : 0;
    const totalDuration = overviewRow ? asNumber(overviewRow.totalDurationMs ?? 0) : 0;
    const p95Duration = totalRequests
      ? asNumber(overviewRow.p95DurationMs) : 0;
    const statuses = asRows(statusResult).map(row => ({
      status: Number(row.status),
      count: asCount(row.requests),
    })).filter(row => Number.isInteger(row.status) && row.status >= 100 && row.status <= 599);
    const counts = {
      count4xx: statuses.filter(s => s.status >= 400 && s.status < 500).reduce((sum, s) => sum + s.count, 0),
      count5xx: statuses.filter(s => s.status >= 500).reduce((sum, s) => sum + s.count, 0),
      count429: statuses.find(s => s.status === 429)?.count ?? 0,
    };
    const endpointsRaw = asRows(endpointResult);
    const truncated = endpointsRaw.length > ENDPOINT_LIMIT;
    const endpoints = endpointsRaw.slice(0, ENDPOINT_LIMIT)
      .map(row => sanitizedEndpoint(row))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const totalCompleted = statuses.filter(s => s.status >= 200 && s.status < 400)
      .reduce((sum, s) => sum + s.count, 0);
    const shadow = {
      available: true as const,
      sampled: true as const,
      truncated,
      overview: {
        totalRequests,
        avgDurationMs: totalRequests ? Math.round(totalDuration / totalRequests) : 0,
        p95DurationMs: p95Duration,
        successRate: totalRequests ? Number(((totalCompleted / totalRequests) * 100).toFixed(2)) : 100,
        ...counts,
      },
      statuses,
      endpoints,
    };
    // Historical KV buckets and AE events can only be sensibly compared after
    // the configured start of shadow ingestion. It is still an approximate
    // operational comparison, never an exact accounting reconciliation.
    const comparable = coverage === "full_window" && !legacy.partial &&
      statuses.reduce((sum, s) => sum + s.count, 0) === totalRequests;
    const requestDifference = totalRequests - legacy.overview.totalRequests;
    const deltas = comparable ? {
      requestDifference,
      requestDifferencePercent: legacy.overview.totalRequests
        ? Number(((requestDifference / legacy.overview.totalRequests) * 100).toFixed(2)) : null,
    } : null;
    return { ...baseline, shadow, comparable, deltas };
  } catch {
    return { ...baseline, shadow: { available: false, reason: "invalid_sql_result" as const } };
  }
}
