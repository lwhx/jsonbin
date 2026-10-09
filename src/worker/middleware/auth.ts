import "../activity";
import { authorizeApiKey, readApiKey, type ApiKey, type ApiScope } from "../storage/keys";
import { DEFAULT_KEY_RATE_LIMIT, checkRateLimit, rateLimitResponse } from "../storage/rate-limit";
import type { MiddlewareHandler } from "hono";
import { readSessionContext, type SessionUser } from "../auth/session";
import type { SessionPrincipal } from "../storage/sessions";
import { allowedRequestOrigin } from "../auth/origin";

type Variables = {
  user?: SessionUser;
  sessionPrincipal?: SessionPrincipal;
  apiKey?: ApiKey;
};

export const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  let current: Awaited<ReturnType<typeof readSessionContext>>;
  try {
    current = await readSessionContext(c);
  } catch {
    // An unavailable R2 revocation record is not a missing/invalid Cookie.
    // Fail closed and let the browser retry without clearing its session.
    return c.json({ error: "session_state_unavailable" }, 503);
  }
  if (!current) return c.json({ error: "unauthorized" }, 401);
  // Browser writes with ambient cookies must originate from this application.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !allowedRequestOrigin(c.req.raw, c.env)) {
    return c.json({ error: "origin_not_allowed" }, 403);
  }

  c.set("user", current.user);
  c.set("sessionPrincipal", current.principal);
  c.set("activityIdentity", { actor: { type: "session", id: current.user.id }, provider: current.user.provider });
  await next();
};

/** An explicitly supplied Authorization header never falls back to a session. */
export function requireAccess(scopes: ApiScope | ApiScope[]): typeof requireSession {
  const required = Array.isArray(scopes) ? scopes : [scopes];
  return async (c, next) => {
    if (!c.req.raw.headers.has("Authorization")) return requireSession(c, next);
    const authorization = c.req.raw.headers.get("Authorization") ?? "";
    const token = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
    const current = token ? await readApiKey(c.env, token) : null;
    if (!current || !token) {
      c.header("WWW-Authenticate", 'Bearer realm="JSONBin", error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    // Usage is not counted here: resource-level rejections (403) happen inside
    // the route, and P18 keeps them out of the counters. Commit after the fact.
    const verdict = authorizeApiKey(current, required);
    if (verdict === "insufficient_scope") {
      c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${required.join(" ")}"`);
      return c.json({ error: "insufficient_scope", requiredScopes: required }, 403);
    }
    if (verdict !== "ok") {
      c.header("WWW-Authenticate", 'Bearer realm="JSONBin", error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("apiKeyId" as any, current.key.id);
    // Best-effort per-key rate limit; unlimited only via an explicit null override.
    // ?? would swallow that null into the default (F16): only an absent setting falls back.
    const limit = current.key.rateLimitPerMinute === undefined ? DEFAULT_KEY_RATE_LIMIT : current.key.rateLimitPerMinute;
    if (limit !== null && c.env.CACHE) {
      const verdict = await checkRateLimit(c.env.CACHE, `k:${current.key.id}`, limit).catch(() => null);
      if (verdict && !verdict.allowed) return rateLimitResponse(verdict.retryAfterSeconds);
    }
    c.set("apiKey", current.key);
    c.set("activityIdentity", { actor: { type: "api_key", id: current.key.id }, provider: "api_key" });
    await next();
  };
}
