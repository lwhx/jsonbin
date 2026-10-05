import type { MiddlewareHandler } from "hono";
import { normalizeEtag } from "../storage/bin-state";

/**
 * RFC 9110 conditional GET: when the client's If-None-Match still matches the
 * ETag the handler produced, replace the 200 with an empty 304 so pollers
 * only transfer bytes when the resource actually changed. Weak comparison,
 * `*` and comma-separated lists are accepted.
 */
export const conditionalGet: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.req.method !== "GET" || c.res.status !== 200) return;
  const etag = c.res.headers.get("ETag");
  const ifNoneMatch = c.req.header("If-None-Match");
  if (!etag || !ifNoneMatch) return;

  const current = normalizeEtag(etag);
  const matched = ifNoneMatch.split(",").some(candidate => {
    const trimmed = candidate.trim();
    if (trimmed === "*") return true;
    return normalizeEtag(trimmed) === current;
  });
  if (!matched) return;

  const headers = new Headers();
  headers.set("ETag", etag);
  const cacheControl = c.res.headers.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  c.res = new Response(null, { status: 304, headers });
};
