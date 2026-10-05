import "../activity";
import { readApiKey, useApiKey, type ApiKey, type ApiScope } from "../storage/keys";
import type { MiddlewareHandler } from "hono";
import { readSession, type SessionUser } from "../auth/session";
import { allowedRequestOrigin } from "../auth/origin";

type Variables = {
  user?: SessionUser;
  apiKey?: ApiKey;
};

export const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const user = await readSession(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  // Browser writes with ambient cookies must originate from this application.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !allowedRequestOrigin(c.req.raw, c.env)) {
    return c.json({ error: "origin_not_allowed" }, 403);
  }

  c.set("user", user);
  c.set("activityIdentity", { actor: { type: "session", id: user.id }, provider: user.provider });
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
    const used = await useApiKey(c.env, token, current, required);
    if (used === "insufficient_scope") {
      c.header("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${required.join(" ")}"`);
      return c.json({ error: "insufficient_scope", requiredScopes: required }, 403);
    }
    if (used === "busy") return c.json({ error: "key_service_unavailable" }, 503);
    if (used !== "ok") {
      c.header("WWW-Authenticate", 'Bearer realm="JSONBin", error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("apiKey", current.key);
    c.set("activityIdentity", { actor: { type: "api_key", id: current.key.id }, provider: "api_key" });
    await next();
  };
}
