/**
 * Optional shadow telemetry for Analytics Engine.
 * This never replaces the legacy KV aggregates used by Dashboard and Key usage
 * reconciliation. Keep disabled until datasets, cost and SQL reads are verified.
 */
import type { AnalyticsDataPoint } from "./analytics";

type ShadowDataset = {
  writeDataPoint(data: { blobs: string[]; doubles: number[]; indexes: string[] }): void;
};
type ShadowEnv = Env & {
  ANALYTICS_EVENTS?: ShadowDataset;
  ANALYTICS_EVENTS_SHADOW?: string;
};

const SAFE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const SAFE_AUTH = new Set(["session", "api_key", "anonymous", "system"]);
const ROUTE_PATTERN = /^\/api\/v1\/(?:[a-z][a-z0-9-]*|:[a-z]+|\*)(?:\/(?:[a-z][a-z0-9-]*|:[a-z]+|\*))*$/;
const ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function shadowAnalyticsEvent(env: ShadowEnv, dp: AnalyticsDataPoint): boolean {
  if (env.ANALYTICS_EVENTS_SHADOW !== "1" || !env.ANALYTICS_EVENTS) return false;
  try {
    // Reject un-normalized or potentially sensitive caller-controlled labels.
    if (!SAFE_METHODS.has(dp.method) || !ROUTE_PATTERN.test(dp.route) ||
        !SAFE_AUTH.has(dp.authType) || !Number.isInteger(dp.status) ||
        dp.status < 100 || dp.status > 599 || !Number.isFinite(dp.durationMs)) return false;
    const timestamp = Date.parse(dp.timestamp);
    if (!Number.isFinite(timestamp)) return false;
    env.ANALYTICS_EVENTS.writeDataPoint({
      // Stable layout: blob1 method, blob2 route, blob3 status, blob4 auth,
      // blob5 safe error code, blob6 qualified key use. NEVER store Key ID,
      // IP, cookie, authorization, query, slug or Bin content.
      blobs: [
        dp.method,
        dp.route,
        String(dp.status),
        dp.authType,
        dp.error && ERROR_PATTERN.test(dp.error) ? dp.error : "",
        dp.qualifiedKeyUse ? "1" : "0",
      ],
      doubles: [1, Math.max(0, Math.min(dp.durationMs, 600000)), timestamp],
      // One constant sampling key: no user or credential identifiers.
      indexes: ["jsonbin"],
    });
    return true;
  } catch {
    // Metrics outages must not affect business responses or legacy KV.
    return false;
  }
}
