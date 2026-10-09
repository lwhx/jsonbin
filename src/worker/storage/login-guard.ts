/**
 * Authoritative per-IP password-login guard.
 *
 * Brute-force controls must not share the eventually-consistent KV counter
 * path: consecutive and concurrent failures use R2 conditional writes (CAS).
 * A hashed IP, never the literal CF-Connecting-IP, is stored in the object key.
 * This guard is deliberately used ONLY by POST /auth/login; GitHub OAuth,
 * existing sessions, and scoped API keys never consult it.
 */
import { hmacSign } from "../lib/crypto";
import { getJson, putJson, requireDataBucket } from "./r2";

const PREFIX = "auth/login-guard/";
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const BAN_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_THRESHOLD = 3;
const BAN_THRESHOLD = 6;
const MAX_CAS_RETRIES = 16;

type StoredLoginGuard = {
  failures: number;
  windowStartedAt: number;
  cooldownUntil: number | null;
  bannedUntil: number | null;
  expiresAt: number;
};

type StoredVersion = Awaited<ReturnType<typeof getJson<StoredLoginGuard>>>;
export type LoginGuardLock = { error: "login_cooldown" | "login_ip_banned"; retryAfterSeconds: number };
export type LoginGuardCheck = { key: string; current: StoredVersion; lock: LoginGuardLock | null };

function etag(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function activeLock(value: StoredLoginGuard | null | undefined, now: number): LoginGuardLock | null {
  if (!value || value.expiresAt <= now) return null;
  if (value.bannedUntil && value.bannedUntil > now) {
    return { error: "login_ip_banned", retryAfterSeconds: Math.max(1, Math.ceil((value.bannedUntil - now) / 1000)) };
  }
  if (value.cooldownUntil && value.cooldownUntil > now) {
    return { error: "login_cooldown", retryAfterSeconds: Math.max(1, Math.ceil((value.cooldownUntil - now) / 1000)) };
  }
  return null;
}

async function keyForIp(env: Env, request: Request): Promise<string> {
  // Cloudflare supplies this edge header. Never trust caller-provided
  // X-Forwarded-For or X-Real-IP for account lockouts.
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const digest = await hmacSign(env.SESSION_SECRET!, `password-login/ip/v1\0${ip}`);
  return `${PREFIX}${digest}.json`;
}

export async function checkPasswordLoginGuard(env: Env, request: Request, now = Date.now()): Promise<LoginGuardCheck> {
  const key = await keyForIp(env, request);
  const current = await getJson<StoredLoginGuard>(requireDataBucket(env), key);
  return { key, current, lock: activeLock(current?.value, now) };
}

/**
 * Charge only a WRONG, syntactically valid credential verification.
 * CAS retries ensure concurrent submissions cannot overwrite earlier failures.
 * Once another request has already locked the IP, retries are blocked without
 * consuming a new failure.
 */
export async function recordPasswordLoginFailure(env: Env, check: LoginGuardCheck, now = Date.now()): Promise<LoginGuardLock | null> {
  const bucket = requireDataBucket(env);
  let current = check.current;
  for (let i = 0; i < MAX_CAS_RETRIES; i++) {
    const blocked = activeLock(current?.value, now);
    if (blocked) return blocked;

    const recent = current?.value && current.value.expiresAt > now ? current.value : null;
    const failures = Math.min(BAN_THRESHOLD, (recent?.failures ?? 0) + 1);
    const windowStartedAt = recent?.windowStartedAt ?? now;
    const bannedUntil = failures >= BAN_THRESHOLD ? now + BAN_MS : null;
    const cooldownUntil = failures === COOLDOWN_THRESHOLD ? now + COOLDOWN_MS : null;
    const next: StoredLoginGuard = {
      failures,
      windowStartedAt,
      cooldownUntil,
      bannedUntil,
      expiresAt: bannedUntil ?? (windowStartedAt + FAILURE_WINDOW_MS),
    };
    const onlyIf = current
      ? { etagMatches: etag(current.etag) }
      : { etagDoesNotMatch: "*" };
    if (await putJson(bucket, check.key, next, { onlyIf })) return activeLock(next, now);
    current = await getJson<StoredLoginGuard>(bucket, check.key);
  }
  throw new Error("password_login_guard_conflict");
}

/**
 * A valid password clears previous failures, but does not bypass a ban that
 * another parallel request committed after the initial pre-check.
 */
export async function clearPasswordLoginFailures(env: Env, check: LoginGuardCheck, now = Date.now()): Promise<LoginGuardLock | null> {
  const bucket = requireDataBucket(env);
  let current = await getJson<StoredLoginGuard>(bucket, check.key);
  for (let i = 0; i < MAX_CAS_RETRIES; i++) {
    const blocked = activeLock(current?.value, now);
    if (blocked) return blocked;
    if (!current || current.value.failures === 0) return null;
    const cleared: StoredLoginGuard = {
      failures: 0, windowStartedAt: now, cooldownUntil: null, bannedUntil: null, expiresAt: now,
    };
    if (await putJson(bucket, check.key, cleared, { onlyIf: { etagMatches: etag(current.etag) } })) return null;
    current = await getJson<StoredLoginGuard>(bucket, check.key);
  }
  throw new Error("password_login_guard_conflict");
}

/**
 * Bounded R2 cleanup: called by the existing 15-minute Cron once daily.
 * Objects need to be both long-idle and logically expired. No IP is logged.
 */
export async function pruneExpiredPasswordGuards(env: Env, now = Date.now()): Promise<number> {
  if (!env.DATA) return 0;
  const bucket = env.DATA;
  const page = await bucket.list({ prefix: PREFIX, limit: 1000 });
  let pruned = 0;
  for (const object of page.objects) {
    if (object.uploaded.getTime() > now - 2 * FAILURE_WINDOW_MS) continue;
    const latest = await getJson<StoredLoginGuard>(bucket, object.key);
    if (!latest || latest.value.expiresAt > now || latest.uploaded.getTime() > now - 2 * FAILURE_WINDOW_MS) continue;
    if (etag(latest.etag) !== object.etag) continue;
    await bucket.delete(object.key);
    if (++pruned >= 100) break;
  }
  return pruned;
}
