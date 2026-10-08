import type { MiddlewareHandler } from "hono";
import { normalizeEtag } from "../storage/bin-state";

/** ETag comparisons shared by the ordinary conditional middleware and the meta-only fast path. */
export function matchesIfNoneMatch(ifNoneMatch: string, etag: string): boolean {
  const current = normalizeEtag(etag);
  return ifNoneMatch.split(",").some(candidate => {
    const trimmed = candidate.trim();
    return trimmed === "*" || normalizeEtag(trimmed) === current;
  });
}

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

  const matched = matchesIfNoneMatch(ifNoneMatch, etag);
  if (!matched) return;

  const headers = new Headers();
  headers.set("ETag", etag);
  const cacheControl = c.res.headers.get("Cache-Control");
  if (cacheControl) headers.set("Cache-Control", cacheControl);
  c.res = new Response(null, { status: 304, headers });
};
