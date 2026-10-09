import { hmacSign } from "../lib/crypto";

/**
 * SEC-002: exact fixed-window rate limits are coordinated by a SQLite-backed
 * Durable Object per identity. KV's read/put sequence is not atomic and must
 * never be used as a security enforcement mechanism.
 */
export const DEFAULT_KEY_RATE_LIMIT = 120;
export const ANONYMOUS_RATE_LIMIT = 240;

type Verdict = { allowed: boolean; retryAfterSeconds: number };

export function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))),
      "Cache-Control": "no-store",
    },
  });
}

function unavailable(error = "rate_limit_unavailable"): Response {
  return new Response(JSON.stringify({ error }), {
    status: 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function consume(env: Env, identity: string, limit: number): Promise<Response | null> {
  if (!env.RATE_LIMITER || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) return unavailable();
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(identity));
    const response = await stub.fetch("https://rate-limit.internal/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit }),
    });
    if (!response.ok) return unavailable();
    const verdict = await response.json() as Verdict;
    if (typeof verdict?.allowed !== "boolean" || !Number.isInteger(verdict.retryAfterSeconds) ||
        verdict.retryAfterSeconds < 0 || verdict.retryAfterSeconds > 60) return unavailable();
    return verdict.allowed ? null : rateLimitResponse(verdict.retryAfterSeconds);
  } catch {
    // Explicit fail-closed: a missing/unavailable limiter may not grant
    // unlimited service to untrusted callers.
    return unavailable();
  }
}

/** Per-key setting is dynamic; an explicit null is the user's opt-out. */
export function limitKeyRequest(env: Env, keyId: string, limit: number): Promise<Response | null> {
  return consume(env, `key:${keyId}`, limit);
}

/**
 * Only Cloudflare's edge-assigned CF-Connecting-IP is accepted. Do not use
 * client-controlled X-Forwarded-For, query params or a shared "anonymous"
 * fallback bucket. Validate both IPv4 and IPv6 and normalize with URL.
 */
function trustedIp(request: Request): string | null {
  const input = request.headers.get("CF-Connecting-IP")?.trim();
  if (!input || input.length > 45 || !/^[0-9a-fA-F:.]+$/.test(input)) return null;
  try {
    const isV6 = input.includes(":");
    const url = new URL(isV6 ? `http://[${input}]/` : `http://${input}/`);
    if (!isV6 && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) return null;
    if (isV6 && !url.hostname.startsWith("[")) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Public reads without a trusted identity or limiter fail explicitly. */
export async function limitAnonymousRequest(env: Env, request: Request, limit = ANONYMOUS_RATE_LIMIT): Promise<Response | null> {
  const ip = trustedIp(request);
  if (!ip) return unavailable("anonymous_identity_unavailable");
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return unavailable();
  // Store HMAC only in the DO object's identifier, never the literal client IP.
  const digest = await hmacSign(env.SESSION_SECRET, `jsonbin/public/ip/v1:${ip}`);
  return consume(env, `anon:${digest}`, limit);
}
