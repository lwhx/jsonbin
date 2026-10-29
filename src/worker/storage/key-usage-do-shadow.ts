/**
 * Optional P22 API Key usage shadow writer and internal snapshot reader.
 *
 * No production flag is enabled. This intentionally does NOT replace legacy
 * KV analytics, readDailyKeyUsage(), or R2 UTC-day usage settlement.
 * DO RPC failures are best effort, and cannot affect successful API replies.
 */
import type { AnalyticsDataPoint } from "./analytics";

type UsageShadowEnv = Env & {
  KEY_USAGE_DO_SHADOW?: string;
  KEY_USAGE_COUNTER?: DurableObjectNamespace;
};

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRY_BACKOFF_MS = [0, 30, 120] as const; // bounded well inside waitUntil's grace period


function scopedStub(env: UsageShadowEnv, keyId: string) {
  return env.KEY_USAGE_COUNTER!.get(
    env.KEY_USAGE_COUNTER!.idFromName(`jsonbin:key-usage:v1:${keyId.toLowerCase()}`),
  );
}

/**
 * Retry only uncertain delivery failures with ONE stable event ID. The per-Key
 * SQLite DO transaction deduplicates replays after an ambiguous commit.
 *
 * This is best-effort within waitUntil, NOT a durable queue. A Worker that is
 * terminated before the first RPC may still lose an event. No automatic retry
 * of 4xx validation/conflict errors, and never change a business response.
 */
export async function recordKeyUsageShadow(
  env: UsageShadowEnv, point: AnalyticsDataPoint, requestEventId?: string,
): Promise<boolean> {
  if (env.KEY_USAGE_DO_SHADOW !== "1" || !env.KEY_USAGE_COUNTER ||
      point.authType !== "api_key" || point.qualifiedKeyUse !== true ||
      !point.keyId || !KEY_ID.test(point.keyId) ||
      !Number.isInteger(point.status) || point.status < 100 || point.status > 599 ||
      [401, 403, 429].includes(point.status) ||
      typeof point.timestamp !== "string" || !UTC_TIMESTAMP.test(point.timestamp) ||
      !Number.isFinite(Date.parse(point.timestamp))) return false;

  // Hono's requestId is generated on the server (not from incoming headers).
  // Direct shadow callers get one generated UUID, reused for all retry attempts.
  const eventId = requestEventId === undefined ? crypto.randomUUID() : requestEventId;
  if (!EVENT_ID_PATTERN.test(eventId)) return false;
  const body = JSON.stringify({ timestamp: point.timestamp, eventId });

  let stub: DurableObjectStub;
  try { stub = scopedStub(env, point.keyId); }
  catch {
    console.warn("key_usage_shadow_delivery_failed", { reason: "binding_unavailable", attempts: 0 });
    return false;
  }

  let reason = "unknown";
  let attemptsUsed = 0;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    attemptsUsed = attempt + 1;
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
    }
    try {
      const response = await stub.fetch("https://key-usage.internal/usage/increment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Never send the Key ID, full token, IP, resource or request body.
        body,
      });
      if (response.ok) return true; // includes idempotent duplicate acceptance
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        reason = "invalid_or_conflicting_event";
        break;
      }
      reason = "retryable_response";
    } catch {
      reason = "transport_error";
    }
  }
  // Deliberately no Key ID, token, event ID or raw exception text in logs.
  console.warn("key_usage_shadow_delivery_failed", {
    reason, attempts: attemptsUsed,
  });
  return false;
}

export type ShadowDailyUsage = { day: string; count: number; lastUsedAt: string | null };

export async function readKeyUsageShadow(
  env: UsageShadowEnv, keyId: string, day: string,
): Promise<ShadowDailyUsage | null> {
  if (env.KEY_USAGE_DO_SHADOW !== "1" || !env.KEY_USAGE_COUNTER ||
      !KEY_ID.test(keyId) || !UTC_DAY.test(day) ||
      Number.isNaN(Date.parse(day + "T00:00:00.000Z")) ||
      new Date(day + "T00:00:00.000Z").toISOString().slice(0, 10) !== day) return null;

  try {
    const response = await scopedStub(env, keyId).fetch(
      `https://key-usage.internal/usage/day/${day}`,
      { method: "GET" },
    );
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    if (value.day !== day || !Number.isSafeInteger(value.count) ||
        (value.count as number) < 0 ||
        (value.lastUsedAt !== null && (typeof value.lastUsedAt !== "string" ||
          !UTC_TIMESTAMP.test(value.lastUsedAt) || !value.lastUsedAt.startsWith(day)))) return null;
    return { day, count: value.count as number, lastUsedAt: value.lastUsedAt as string | null };
  } catch {
    return null;
  }
}
