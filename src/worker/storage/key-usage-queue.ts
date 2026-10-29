/**
 * P24b (dormant): optional, acknowledged API Key usage Queue transport.
 *
 * The primary API must not acquire a mandatory external Queue dependency.
 * A successful awaited send() confirms Queue persistence before the HTTP
 * response leaves the Worker, but enqueue failure still preserves the
 * original business response and cannot promise zero-loss accounting.
 *
 * Configure isolated Queues + R2 DLQ archive ONLY after Preview validation.
 * Production KV analytics, R2 settlement and default direct-DO shadow stay
 * unchanged when KEY_USAGE_QUEUE_SHADOW is not "1".
 */
import type { AnalyticsDataPoint } from "./analytics";
import { deliverKeyUsageEvent } from "./key-usage-do-shadow.ts";

export type QueuedKeyUsageEvent = {
  version: 1;
  keyId: string;
  eventId: string;
  timestamp: string;
};

type QueueUsageEnv = Env & {
  KEY_USAGE_QUEUE_SHADOW?: string;
  KEY_USAGE_EVENTS_QUEUE?: Queue<QueuedKeyUsageEvent>;
  KEY_USAGE_DLQ_ARCHIVE?: R2Bucket;
};

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ARCHIVE_PREFIX = "internal/key-usage-dlq/v1";
const EVENT_QUEUES = new Set(["jsonbin-key-usage-events-preview", "jsonbin-key-usage-events-prod", "jsonbin-key-usage-events-staging"]);
const DEAD_LETTER_QUEUES = new Set(["jsonbin-key-usage-dlq-preview", "jsonbin-key-usage-dlq-prod", "jsonbin-key-usage-dlq-staging"]);

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Treat Queue bodies as untrusted, even though the current producer is internal. */
export function parseQueuedKeyUsageEvent(body: unknown): QueuedKeyUsageEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || value.version !== 1 ||
      typeof value.keyId !== "string" || !KEY_ID.test(value.keyId) ||
      typeof value.eventId !== "string" || !EVENT_ID.test(value.eventId) ||
      !canonicalTimestamp(value.timestamp)) return null;
  return {
    version: 1,
    keyId: value.keyId.toLowerCase(),
    eventId: value.eventId.toLowerCase(),
    timestamp: value.timestamp,
  };
}

/**
 * Called and awaited AFTER business routing but BEFORE the Worker returns an
 * HTTP response. No waitUntil(): confirmed sends survive request teardown.
 * Uses the server-only X-Request-ID so Queue retries retain the DO event ID.
 */
export async function enqueueKeyUsageShadow(
  env: QueueUsageEnv, point: AnalyticsDataPoint, requestEventId: string,
): Promise<boolean> {
  if (env.KEY_USAGE_QUEUE_SHADOW !== "1" || point.authType !== "api_key" ||
      point.qualifiedKeyUse !== true || [401, 403, 429].includes(point.status) ||
      !point.keyId || !KEY_ID.test(point.keyId) ||
      !EVENT_ID.test(requestEventId) || !canonicalTimestamp(point.timestamp)) return false;
  if (!env.KEY_USAGE_EVENTS_QUEUE) {
    console.warn("key_usage_queue_enqueue_failed", { reason: "binding_unavailable" });
    return false;
  }

  // Never include a token, raw IP, URL, Cookie, body or user-supplied labels.
  const body: QueuedKeyUsageEvent = {
    version: 1,
    keyId: point.keyId.toLowerCase(),
    eventId: requestEventId.toLowerCase(),
    timestamp: point.timestamp,
  };
  try {
    await env.KEY_USAGE_EVENTS_QUEUE.send(body);
    return true;
  } catch {
    // Do not log exception text or identifiers; callers can fall back to the
    // existing direct shadow if independently enabled.
    console.warn("key_usage_queue_enqueue_failed", { reason: "queue_unavailable" });
    return false;
  }
}

/** Explicit per-message ACK prevents a failed event from replaying its peers. */
export async function consumeKeyUsageEvents(
  batch: MessageBatch<unknown>, env: QueueUsageEnv,
): Promise<void> {
  if (!EVENT_QUEUES.has(batch.queue)) throw new Error("unsupported_usage_queue");
  for (const message of batch.messages) {
    const event = parseQueuedKeyUsageEvent(message.body);
    if (!event) {
      console.warn("key_usage_queue_delivery_failed", { reason: "invalid_payload" });
      message.retry({ delaySeconds: 60 });
      continue;
    }
    let delivered = false;
    try {
      delivered = await deliverKeyUsageEvent(env, event);
    } catch {
      // A transient DO error must never ACK and discard a queued event.
    }
    if (delivered) message.ack();
    else {
      console.warn("key_usage_queue_delivery_failed", { reason: "counter_unavailable" });
      message.retry({ delaySeconds: 30 });
    }
  }
}

/**
 * DLQ archiver: separate private R2 bucket, not the user-facing DATA bucket.
 * A persisted archive supports an explicitly authorized manual replay later.
 * Missing R2 binding or failed writes are retried, never silently ACKed.
 */
/** Internal invalid-message quarantine: record a sanitized tombstone, NEVER the raw payload. */
async function archiveInvalidMessage(
  bucket: R2Bucket, queue: string, message: Message<unknown>,
): Promise<void> {
  // Hash the system-generated message ID for a deterministic private object path.
  const input = new TextEncoder().encode(message.id);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  const day = new Date().toISOString().slice(0, 10);
  await bucket.put(
    `internal/key-usage-quarantine/v1/${day}/${hex}.json`,
    JSON.stringify({ version: 1, category: "invalid_usage_event", sourceQueue: queue }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/**
 * Persist validated events for manual replay. Malformed events have no safe
 * replay semantics: preserve only a fixed-category quarantine marker, never
 * arbitrary raw payloads, tokens or user-controlled labels.
 */
export async function archiveKeyUsageDeadLetters(
  batch: MessageBatch<unknown>, env: QueueUsageEnv,
): Promise<void> {
  if (!DEAD_LETTER_QUEUES.has(batch.queue)) throw new Error("unsupported_usage_dlq");
  for (const message of batch.messages) {
    if (!env.KEY_USAGE_DLQ_ARCHIVE) {
      console.warn("key_usage_dlq_archive_failed", { reason: "binding_unavailable" });
      message.retry({ delaySeconds: 60 });
      continue;
    }
    const event = parseQueuedKeyUsageEvent(message.body);
    try {
      if (event) {
        await env.KEY_USAGE_DLQ_ARCHIVE.put(
          archiveKeyForEvent(event),
          JSON.stringify(event),
          { httpMetadata: { contentType: "application/json" } },
        );
      } else {
        await archiveInvalidMessage(env.KEY_USAGE_DLQ_ARCHIVE, batch.queue, message);
      }
      message.ack();
    } catch {
      console.warn("key_usage_dlq_archive_failed", { reason: "storage_unavailable" });
      message.retry({ delaySeconds: 60 });
    }
  }
}

export function archiveKeyForEvent(event: QueuedKeyUsageEvent): string {
  // A distinct Key namespace avoids collisions across different Key UUIDs.
  return `${ARCHIVE_PREFIX}/${event.timestamp.slice(0, 10)}/${event.keyId}/${event.eventId}.json`;
}

/**
 * Internal operator helper; intentionally NOT exposed as an HTTP route or
 * Cron task. Confirm business intent and snapshot before replay; replay
 * preserves event UUID so committed events can be safely retried.
 */
export async function replayArchivedKeyUsageEvent(
  env: QueueUsageEnv, key: string,
): Promise<boolean> {
  if (!env.KEY_USAGE_DLQ_ARCHIVE ||
      !/^internal\/key-usage-dlq\/v1\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json$/.test(key)) return false;
  try {
    const archived = await env.KEY_USAGE_DLQ_ARCHIVE.get(key);
    if (!archived) return false;
    const event = parseQueuedKeyUsageEvent(JSON.parse(await archived.text()));
    if (!event || archiveKeyForEvent(event) !== key) return false;
    return await deliverKeyUsageEvent(env, event);
  } catch {
    return false;
  }
}
