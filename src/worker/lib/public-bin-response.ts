import type { BinMeta } from "../storage/bins";
import { requireDataBucket } from "../storage/r2";

/**
 * Anonymous public-current reads only. Call this AFTER the authoritative R2
 * metadata check and the SQLite DO quota verdict. A cached response must never
 * bypass current visibility/TTL/deletion checks or anonymous rate limits.
 */
type Snapshot = { value: BinMeta; etag: string };
const CACHE_TTL_SECONDS = 60;
const encoder = new TextEncoder();

function jsonEnvelopeStream(
  source: ReadableStream<Uint8Array>,
  meta: BinMeta,
  etag: string,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const prefix = encoder.encode('{"meta":' + JSON.stringify(meta) + ',"value":');
  const suffix = encoder.encode(',"etag":' + JSON.stringify(etag) + '}');
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(prefix); },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.enqueue(suffix);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

/** Keep Cache API entries distinct from publicly addressable CDN paths. */
async function cacheForPublicReads(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined"
      ? null
      : await caches.open("jsonbin-public-current-v1");
  } catch {
    // A cache outage must not deny access to authoritative public data.
    return null;
  }
}

function cacheRequestFor(request: Request, snapshot: Snapshot): Request {
  const url = new URL(request.url);
  url.pathname = "/__jsonbin_internal_cache/v1/" +
    encodeURIComponent(snapshot.value.id) + "/" + encodeURIComponent(snapshot.etag);
  url.search = "";
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

function uncacheableClientResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  // A Bin may be made private/deleted/expired at any instant. Only the internal
  // versioned Cache API copy is cacheable; browsers never retain public data.
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: 200, headers });
}

export async function publicCurrentJsonResponse(
  env: Env,
  request: Request,
  snapshot: Snapshot,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const cache = await cacheForPublicReads();
  const cacheRequest = cacheRequestFor(request, snapshot);
  if (cache) {
    try {
      const found = await cache.match(cacheRequest);
      if (found) return uncacheableClientResponse(found);
    } catch {
      // Cache misses and cache errors both fall back to R2.
    }
  }

  // Versions are immutable; meta ETag is the cache version, not the value ETag.
  const versionKey = "bins/" + snapshot.value.id + "/versions/" +
    String(snapshot.value.currentVersion).padStart(6, "0") + ".json";
  const object = await requireDataBucket(env).get(versionKey);
  if (!object) {
    throw new Error("Bin " + snapshot.value.id +
      " is missing version " + snapshot.value.currentVersion);
  }

  const response = new Response(
    jsonEnvelopeStream(object.body, snapshot.value, snapshot.etag),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "ETag": snapshot.etag,
        "X-JSONBin-Version": String(snapshot.value.currentVersion),
        "Cache-Control": "no-store",
      },
    },
  );

  if (cache && waitUntil) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "public, max-age=" + CACHE_TTL_SECONDS);
    // Store only the canonical JSON envelope and stable metadata headers. In
    // particular, no session, Origin, Set-Cookie, or request-ID is cached.
    const cachedCopy = new Response(response.clone().body, { status: 200, headers });
    waitUntil(cache.put(cacheRequest, cachedCopy).catch(() => {}));
  }
  return response;
}
