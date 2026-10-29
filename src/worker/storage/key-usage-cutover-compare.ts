/**
 * Manager-only diagnostic for a potential production API-Key usage migration.
 *
 * This deliberately NEVER changes the authoritative source, R2 daily
 * settlement, or any business response. One Key + UTC day per request bounds
 * the cost. A matching KV/DO count is NOT evidence of complete Queue delivery.
 */
import { readDailyKeyUsage } from "./key-usage-read.ts";
import { readKeyUsageShadow } from "./key-usage-do-shadow.ts";

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_DAYS = 34;
const DAY_MS = 86_400_000;

type ComparisonEnv = Env & {
  KEY_USAGE_CUTOVER_COMPARE?: string;
  KEY_USAGE_QUEUE_SHADOW?: string;
  KEY_USAGE_CONSUMER_ENABLED?: string;
  KEY_USAGE_EVENTS_QUEUE?: Queue;
  KEY_USAGE_DLQ_ARCHIVE?: R2Bucket;
  KEY_USAGE_COUNTER?: DurableObjectNamespace;
};

export function keyUsageCutoverComparisonEnabled(env: ComparisonEnv): boolean {
  return env.KEY_USAGE_CUTOVER_COMPARE === "1" && Boolean(env.CACHE && env.KEY_USAGE_COUNTER);
}

export function validComparisonTarget(keyId: string, day: string, nowMs = Date.now()): boolean {
  if (!KEY_ID.test(keyId) || !DAY.test(day) || !Number.isFinite(nowMs)) return false;
  const dayMs = Date.parse(day + "T00:00:00.000Z");
  if (!Number.isFinite(dayMs) || new Date(dayMs).toISOString().slice(0, 10) !== day) return false;
  const todayMs = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z");
  return dayMs <= todayMs && dayMs >= todayMs - MAX_HISTORY_DAYS * DAY_MS;
}

export async function compareProductionKeyUsage(
  env: ComparisonEnv, keyId: string, day: string, nowMs = Date.now(),
) {
  if (!keyUsageCutoverComparisonEnabled(env) || !validComparisonTarget(keyId, day, nowMs)) return null;
  const [legacy, shadow] = await Promise.all([
    readDailyKeyUsage(env, day, nowMs),
    // The read helper is gated by the optional shadow flag. Its override here
    // is only used inside a manager-only diagnostic, never in the public API.
    readKeyUsageShadow({ ...env, KEY_USAGE_DO_SHADOW: "1" }, keyId, day),
  ]);
  const legacyAvailable = legacy.status === "ok";
  const legacyKey = legacyAvailable ? legacy.byKey[keyId.toLowerCase()] : null;
  const legacyCount = legacyAvailable ? (legacyKey?.count ?? 0) : null;
  const durableCount = shadow?.count ?? null;

  // Source coverage cannot be established from two counters alone: Queue may
  // still contain retries/late events and KV may have lost concurrent writes.
  const missing: string[] = [];
  if (!legacyAvailable) missing.push("legacy_kv_unavailable");
  if (!shadow) missing.push("durable_counter_unavailable");
  if (env.KEY_USAGE_QUEUE_SHADOW !== "1" || !env.KEY_USAGE_EVENTS_QUEUE) missing.push("queue_producer_not_active");
  if (env.KEY_USAGE_CONSUMER_ENABLED !== "1") missing.push("queue_consumer_not_active");
  if (!env.KEY_USAGE_DLQ_ARCHIVE) missing.push("dead_letter_archive_not_bound");
  missing.push("queue_backlog_not_verified");
  missing.push("historical_migration_not_implemented");
  missing.push("late_event_settlement_not_implemented");

  return {
    day,
    keyId: keyId.toLowerCase(),
    asOf: new Date(nowMs).toISOString(),
    legacy: {
      available: legacyAvailable,
      count: legacyCount,
      lastUsedAt: legacyAvailable ? (legacyKey?.lastUsedAt ?? null) : null,
      approximate: true as const,
    },
    durable: {
      available: shadow !== null,
      count: durableCount,
      lastUsedAt: shadow?.lastUsedAt ?? null,
    },
    observedDifference: legacyCount !== null && durableCount !== null
      ? durableCount - legacyCount : null,
    comparable: false as const,
    safeToCutover: false as const,
    blockers: missing,
  };
}
