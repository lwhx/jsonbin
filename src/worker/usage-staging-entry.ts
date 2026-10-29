/**
 * Standalone P24b staging Worker. Never import the production API router.
 * This Worker accepts only authenticated synthetic usage probes, and runs the
 * exact same Queue consumer / SQLite DO implementation as production.
 *
 * All test events use synthetic Key UUIDs. No production KV, DATA R2,
 * credentials or external business routes are bound to this Worker.
 */
import { parseQueuedKeyUsageEvent, consumeKeyUsageEvents, archiveKeyUsageDeadLetters } from "./storage/key-usage-queue";
import { readKeyUsageShadow } from "./storage/key-usage-do-shadow";

export { ApiKeyUsageCounter } from "./storage/key-usage-do";

type StagingEnv = Env & {
  KEY_USAGE_STAGING_MODE?: string;
  STAGING_PROBE_TOKEN?: string;
};

const PREFIX = "/__staging/usage/";
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_QUEUE = "jsonbin-key-usage-events-staging";
const DLQ = "jsonbin-key-usage-dlq-staging";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}

async function acceptedToken(request: Request, env: StagingEnv): Promise<boolean> {
  const expected = env.STAGING_PROBE_TOKEN;
  if (typeof expected !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(expected)) return false;
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.length > 140) return false;
  const supplied = auth.slice(7);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(supplied)) return false;
  // Avoid timing differences from early-character comparisons.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(supplied)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let differences = 0;
  for (let i = 0; i < x.length; i++) differences |= x[i] ^ y[i];
  return differences === 0;
}

async function handleStagingRequest(request: Request, env: StagingEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(PREFIX)) return json({ error: "not_found" }, 404);
  if (env.KEY_USAGE_STAGING_MODE !== "1" ||
      typeof env.STAGING_PROBE_TOKEN !== "string" ||
      env.STAGING_PROBE_TOKEN.length < 43) return json({ error: "not_found" }, 404);
  if (!await acceptedToken(request, env)) return json({ error: "unauthorized" }, 401);

  if (request.method === "GET" && url.pathname === PREFIX + "status") {
    if (url.search) return json({ error: "invalid_query" }, 400);
    return json({
      staging: true,
      producerEnabled: env.KEY_USAGE_QUEUE_SHADOW === "1",
      consumerEnabled: env.KEY_USAGE_CONSUMER_ENABLED === "1",
      queueBound: Boolean(env.KEY_USAGE_EVENTS_QUEUE),
      doBound: Boolean(env.KEY_USAGE_COUNTER),
      archiveBound: Boolean(env.KEY_USAGE_DLQ_ARCHIVE),
    });
  }

  if (request.method === "GET" && url.pathname === PREFIX + "day") {
    if (url.searchParams.size !== 2 ||
        url.searchParams.getAll("keyId").length !== 1 ||
        url.searchParams.getAll("day").length !== 1) {
      return json({ error: "invalid_query" }, 400);
    }
    const keyId = url.searchParams.get("keyId");
    const day = url.searchParams.get("day");
    if (!keyId || !KEY_ID.test(keyId) ||
        !day || !DAY.test(day) ||
        Number.isNaN(Date.parse(day + "T00:00:00.000Z")) ||
        new Date(day + "T00:00:00.000Z").toISOString().slice(0, 10) !== day) {
      return json({ error: "invalid_query" }, 400);
    }
    // The read-only DO snapshot requires the original P22 shadow read gate;
    // override it only inside this separate staging-only entrypoint.
    const snapshot = await readKeyUsageShadow(
      { ...env, KEY_USAGE_DO_SHADOW: "1" }, keyId, day,
    );
    return snapshot ? json(snapshot) : json({ error: "counter_unavailable" }, 503);
  }

  if (request.method === "POST" && url.pathname === PREFIX + "emit") {
    if (url.search) return json({ error: "invalid_query" }, 400);
    if (env.KEY_USAGE_QUEUE_SHADOW !== "1" || !env.KEY_USAGE_EVENTS_QUEUE) {
      return json({ error: "producer_disabled" }, 503);
    }
    // Limit the *actual* bytes read, not a caller-controlled Content-Length.
    const length = Number(request.headers.get("Content-Length") ?? "0");
    if (!Number.isFinite(length) || length > 256) return json({ error: "invalid_event" }, 400);
    let payload: unknown;
    try {
      const raw = await request.text();
      if (raw.length > 256) return json({ error: "invalid_event" }, 400);
      payload = JSON.parse(raw);
    } catch { return json({ error: "invalid_event" }, 400); }

    const event = parseQueuedKeyUsageEvent(payload);
    if (!event) return json({ error: "invalid_event" }, 400);
    const time = Date.parse(event.timestamp);
    if (time < Date.now() - 34 * 86_400_000 || time > Date.now() + 5 * 60_000) {
      return json({ error: "out_of_window" }, 422);
    }

    try {
      await env.KEY_USAGE_EVENTS_QUEUE.send(event);
      return json({ queued: true }, 202);
    } catch {
      return json({ error: "queue_unavailable" }, 503);
    }
  }
  return json({ error: "not_found" }, 404);
}

export { handleStagingRequest };

export default {
  fetch: (request: Request, env: StagingEnv) => handleStagingRequest(request, env),
  async queue(batch: MessageBatch<unknown>, env: StagingEnv): Promise<void> {
    if (env.KEY_USAGE_STAGING_MODE !== "1" || env.KEY_USAGE_CONSUMER_ENABLED !== "1") {
      throw new Error("usage_staging_consumer_disabled");
    }
    if (batch.queue === EVENT_QUEUE) await consumeKeyUsageEvents(batch, env);
    else if (batch.queue === DLQ) await archiveKeyUsageDeadLetters(batch, env);
    else throw new Error("unsupported_usage_staging_queue");
  },
};
