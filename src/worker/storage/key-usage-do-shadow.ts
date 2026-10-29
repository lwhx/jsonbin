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

function scopedStub(env: UsageShadowEnv, keyId: string) {
  return env.KEY_USAGE_COUNTER!.get(
    env.KEY_USAGE_COUNTER!.idFromName(`jsonbin:key-usage:v1:${keyId.toLowerCase()}`),
  );
}

export async function recordKeyUsageShadow(env: UsageShadowEnv, point: AnalyticsDataPoint): Promise<boolean> {
  if (env.KEY_USAGE_DO_SHADOW !== "1" || !env.KEY_USAGE_COUNTER ||
      point.authType !== "api_key" || point.qualifiedKeyUse !== true ||
      !point.keyId || !KEY_ID.test(point.keyId) ||
      !Number.isInteger(point.status) || point.status < 100 || point.status > 599 ||
      [401, 403, 429].includes(point.status) ||
      typeof point.timestamp !== "string" || !UTC_TIMESTAMP.test(point.timestamp) ||
      !Number.isFinite(Date.parse(point.timestamp))) return false;

  try {
    const response = await scopedStub(env, point.keyId).fetch("https://key-usage.internal/usage/increment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Do not send the API Key selector, token or arbitrary resource data.
      body: JSON.stringify({ timestamp: point.timestamp }),
    });
    return response.ok;
  } catch {
    // A shadow counter outage must never break API responses, rate limits or
    // the original KV-based dashboard and Key settlement paths.
    return false;
  }
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
