/**
 * Best-effort fixed-window rate limiting on the disposable CACHE KV binding.
 * Counters are rebuildable derived data (架构约定：KV 只存可重建数据)：
 * eventual consistency may under-count briefly, which is acceptable for
 * protecting the platform from runaway clients, not for exact billing.
 */
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
  const current = Number((await cache.get(key)) ?? "0");
  if (Number.isFinite(current) && current >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((((window + 1) * WINDOW_MS) - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  await cache.put(key, String(current + 1), { expirationTtl: Math.ceil(WINDOW_MS / 1000) * 2 });
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 429 response shared by the Bearer and anonymous limiters. */
export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
    status: 429,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
  });
}

/** Per-IP limiter for anonymous public reads; no CACHE binding means unlimited. */
export async function limitAnonymousRequest(env: Env, request: Request, limit = ANONYMOUS_RATE_LIMIT): Promise<Response | null> {
  if (!env.CACHE) return null;
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "anonymous";
  const verdict = await checkRateLimit(env.CACHE, `a:${ip}`, limit).catch(() => null);
  if (!verdict || verdict.allowed) return null;
  return rateLimitResponse(verdict.retryAfterSeconds);
}
