/**
 * SEC-002: Native Cloudflare Rate Limit bindings remove the shared-key KV
 * write hotspot for normal traffic. Native quota is per-PoP, approximate,
 * not a globally exact billing/security counter. R2 CAS handles custom key
 * quotas which must respect the exact configured number (1..10000).
 *
 * If a non-production/miniflare runtime is missing native bindings, retain
 * the old KV-based fallback but FAIL CLOSED if it cannot enforce the budget.
 */
import { hmacSign, sha256Hex } from "../lib/crypto";
import { checkExactKeyQuota } from "./key-rate-limit";

const WINDOW_MS = 60_000;

/** Default per-key limit for Bearer requests; `null` opts out entirely. */
export const DEFAULT_KEY_RATE_LIMIT = 120;
/** Fixed per-IP limit for anonymous public reads. */
export const ANONYMOUS_RATE_LIMIT = 240;

export type RateLimitVerdict = { allowed: boolean; retryAfterSeconds: number };

export async function checkRateLimit(
  cache: KVNamespace,
  scope: string,
  limit: number,
  now = Date.now(),
): Promise<RateLimitVerdict> {
  const window = Math.floor(now / WINDOW_MS);
  const key = `rl:${scope}:${window}`;
  const raw = await cache.get(key);
  const current = raw === null ? 0 : Number(raw);
  if (!Number.isSafeInteger(current) || current < 0) {
    // Malformed counters must not disable limiting by storing NaN.
    throw new Error("invalid_legacy_rate_limit_counter");
  }
  if (current >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((((window + 1) * WINDOW_MS) - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  await cache.put(key, String(current + 1), { expirationTtl: 120 });
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 429 response shared by Bearer and anonymous limiters. */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
    status: 429,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
  });
}

export function rateLimitUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limit_unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "60", "Cache-Control": "no-store" },
  });
}

async function nativeVerdict(
  limiter: { limit(input: { key: string }): Promise<{ success: boolean }> }, key: string,
): Promise<RateLimitVerdict> {
  const result = await limiter.limit({ key });
  if (!result || typeof result.success !== "boolean") throw new Error("invalid_native_rate_limit_response");
  // The native API does not return an exact reset timestamp. Sixty seconds
  // is a conservative Retry-After for the configured 60-second period.
  return { allowed: result.success, retryAfterSeconds: result.success ? 0 : 60 };
}

async function anonymousIdentity(env: Env, request: Request): Promise<string> {
  // The platform supplies CF-Connecting-IP. Never trust X-Forwarded-For.
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const namespace = `public-rate/v1\0${ip}`;
  return env.SESSION_SECRET
    ? await hmacSign(env.SESSION_SECRET, namespace)
    : await sha256Hex(namespace);
}

/** Default key: fast native limiter, custom numeric key: authoritative R2 CAS. */
export async function enforceApiKeyRateLimit(
  env: Env, keyId: string, limit: number | null,
): Promise<Response | null> {
  if (limit === null) return null;
  try {
    let verdict: RateLimitVerdict;
    if (limit !== DEFAULT_KEY_RATE_LIMIT) {
      verdict = await checkExactKeyQuota(env, keyId, limit);
    } else if (env.JSONBIN_KEY_RATE) {
      verdict = await nativeVerdict(env.JSONBIN_KEY_RATE, `k:${keyId}`);
    } else if (env.CACHE) {
      verdict = await checkRateLimit(env.CACHE, `k:${keyId}`, limit);
    } else {
      return rateLimitUnavailableResponse();
    }
    return verdict.allowed ? null : rateLimitResponse(verdict.retryAfterSeconds);
  } catch {
    return rateLimitUnavailableResponse();
  }
}

/** Public-only IP limiter. No limiter + no CACHE is denial, not unlimited. */
export async function limitAnonymousRequest(env: Env, request: Request, limit = ANONYMOUS_RATE_LIMIT): Promise<Response | null> {
  try {
    const id = await anonymousIdentity(env, request);
    let verdict: RateLimitVerdict;
    if (limit === ANONYMOUS_RATE_LIMIT && env.JSONBIN_ANON_RATE) {
      verdict = await nativeVerdict(env.JSONBIN_ANON_RATE, `a:${id}`);
    } else if (env.CACHE) {
      verdict = await checkRateLimit(env.CACHE, `a:${id}`, limit);
    } else {
      return rateLimitUnavailableResponse();
    }
    return verdict.allowed ? null : rateLimitResponse(verdict.retryAfterSeconds);
  } catch {
    return rateLimitUnavailableResponse();
  }
}
