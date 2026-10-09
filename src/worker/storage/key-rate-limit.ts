import { getJson, putJson, requireDataBucket } from "./r2";

/** Exact custom-key quota: one durable CAS object per API key, never a shared KV hotspot. */
const PREFIX = "auth/key-rate/";
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 20;
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Counter = { window: number; count: number };
export type ExactKeyLimitResult = { allowed: boolean; retryAfterSeconds: number };

function valid(value: unknown): value is Counter {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Number.isSafeInteger((value as Counter).window) && (value as Counter).window >= 0 &&
    Number.isSafeInteger((value as Counter).count) && (value as Counter).count >= 0 &&
    (value as Counter).count <= 10_000;
}

export async function checkExactKeyQuota(
  env: Env, keyId: string, limit: number, now = Date.now(),
): Promise<ExactKeyLimitResult> {
  if (!KEY_ID.test(keyId) || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("invalid_custom_key_quota");
  }
  const bucket = requireDataBucket(env);
  const window = Math.floor(now / WINDOW_MS);
  const path = `${PREFIX}${keyId}.json`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const loaded = await getJson<unknown>(bucket, path);
    if (loaded && !valid(loaded.value)) throw new Error("corrupt_custom_key_quota");
    const count = loaded && (loaded.value as Counter).window === window ? (loaded.value as Counter).count : 0;
    if (count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((((window + 1) * WINDOW_MS) - now) / 1000)) };
    }
    const onlyIf = loaded
      ? { etagMatches: loaded.etag.replace(/^"(.*)"$/, "$1") }
      : { etagDoesNotMatch: "*" };
    const result = await putJson(bucket, path, { window, count: count + 1 }, { onlyIf });
    if (result) return { allowed: true, retryAfterSeconds: 0 };
    // Concurrent caller claimed the ETag; reload the authoritative value.
  }
  // Under extreme contention deny instead of over-allowing.
  throw new Error("custom_key_quota_conflict");
}
