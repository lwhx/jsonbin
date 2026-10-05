import { getJson, putJson, listJsonObjects, requireDataBucket } from "./r2";
import { normalizeEtag } from "./bin-state";

export type Webhook = {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  event: string;
  payload: {
    event: string;
    resourceId: string | null;
    actor: { type: string; id: string | null } | null;
    requestId?: string;
    dispatchedAt: string;
    test?: boolean;
  };
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string;
  status: "pending" | "delivered" | "failed";
  lastError?: string;
  lastStatusCode?: number;
  deliveredAt?: string;
  createdAt: string;
};

const metaKey = (id: string) => `webhooks/${id}/meta.json`;
const deliveryKey = (webhookId: string, id: string) => `webhooks/${webhookId}/deliveries/${id}.json`;
/** Sortable delivery ids: time-ordered, collision-safe. */
function newDeliveryId(now = Date.now()) {
  return `${String(now).padStart(14, "0")}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Selectable event groups: every audited action except auth/key administration. */
export const WEBHOOK_EVENT_PATTERNS = [
  "bin.*", "collection.*", "schema.*", "template.*", "system.*",
] as const;

/** Concrete actions selectable in addition to the group wildcards. */
export const WEBHOOK_EVENT_ACTIONS = [
  "bin.created", "bin.updated", "bin.metadata_updated", "bin.version_restored",
  "bin.deleted", "bin.restored", "bin.purged", "bin.expired", "bin.exported", "bin.imported",
  "collection.created", "collection.updated", "collection.deleted", "collection.imported",
  "schema.created", "schema.updated", "schema.deleted", "schema.imported",
  "template.created", "template.updated", "template.deleted", "template.imported",
  "system.settings_updated", "system.exported",
] as const;

const SELECTABLE_EVENTS = new Set<string>([...WEBHOOK_EVENT_PATTERNS, ...WEBHOOK_EVENT_ACTIONS]);
export function isSelectableEvent(value: string): boolean {
  return SELECTABLE_EVENTS.has(value);
}

export function matchesEvent(patterns: string[], action: string): boolean {
  return patterns.some(pattern => pattern === action || pattern.endsWith(".*") && action.startsWith(pattern.slice(0, -1)));
}

export async function listWebhooks(env: Env): Promise<Webhook[]> {
  const items = await listJsonObjects<Webhook>(requireDataBucket(env), "webhooks/");
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWebhook(env: Env, id: string): Promise<{ webhook: Webhook; etag: string } | null> {
  const stored = await getJson<Webhook>(requireDataBucket(env), metaKey(id));
  if (!stored) return null;
  return { webhook: stored.value, etag: stored.etag };
}

export type WebhookInput = {
  name: string;
  url: string;
  secret: string;
  events: string[];
  active?: boolean;
};

export async function createWebhook(env: Env, input: WebhookInput): Promise<Webhook> {
  const bucket = requireDataBucket(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const webhook: Webhook = { id, name: input.name.trim(), url: input.url.trim(), secret: input.secret,
    events: Array.from(new Set(input.events)), active: input.active ?? true, createdAt: now, updatedAt: now };
  const created = await putJson(bucket, metaKey(id), webhook, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!created) throw new Error("webhook_conflict");
  return webhook;
}

export async function updateWebhook(env: Env, id: string, input: Partial<WebhookInput>, expectedEtag: string): Promise<Webhook | null> {
  const bucket = requireDataBucket(env);
  const current = await getWebhook(env, id);
  if (!current) return null;
  if (normalizeEtag(current.etag) !== normalizeEtag(expectedEtag)) throw new Error("etag_conflict");
  const next: Webhook = {
    ...current.webhook,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.url !== undefined ? { url: input.url.trim() } : {}),
    ...(input.secret !== undefined && input.secret !== "" ? { secret: input.secret } : {}),
    ...(input.events !== undefined ? { events: Array.from(new Set(input.events)) } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    updatedAt: new Date().toISOString(),
  };
  const written = await putJson(bucket, metaKey(id), next, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!written) throw new Error("etag_conflict");
  return next;
}

export async function deleteWebhook(env: Env, id: string, expectedEtag: string): Promise<boolean> {
  const bucket = requireDataBucket(env);
  const current = await getWebhook(env, id);
  if (!current) return false;
  if (normalizeEtag(current.etag) !== normalizeEtag(expectedEtag)) throw new Error("etag_conflict");
  // CAS tombstone claim first so a concurrent edit cannot resurrect the hook.
  const tombstoned = await putJson(bucket, metaKey(id), { ...current.webhook, active: false, deletedAt: new Date().toISOString() },
    { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!tombstoned) throw new Error("etag_conflict");
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `webhooks/${id}/deliveries/`, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await bucket.delete(metaKey(id));
  return true;
}

export async function listDeliveries(env: Env, webhookId: string, limit = 20): Promise<WebhookDelivery[]> {
  const bucket = requireDataBucket(env);
  const items: WebhookDelivery[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `webhooks/${webhookId}/deliveries/`, cursor, limit: 100 });
    for (const object of page.objects) {
      const stored = await getJson<WebhookDelivery>(bucket, object.key);
      if (stored) items.push(stored.value);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && items.length < 500);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Backoff schedule for retries; the first retry is soon enough for quick recovery. */
const RETRY_DELAYS_MS = [10_000, 60_000, 600_000, 3_600_000, 21_600_000];
const DELIVERY_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();

/** GitHub-style hex HMAC: receivers verify sha256=HMAC(secret, "<timestamp>.<body>"). */
async function signDelivery(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function attemptDelivery(env: Env, delivery: WebhookDelivery, webhook: Webhook): Promise<WebhookDelivery> {
  const bucket = requireDataBucket(env);
  const body = JSON.stringify({ ...delivery.payload, deliveryId: delivery.id, attempts: delivery.attempts + 1, webhook: { id: webhook.id, name: webhook.name } });
  const timestamp = new Date().toISOString();
  const signature = await signDelivery(webhook.secret, timestamp, body);
  let statusCode: number | null = null;
  let error: string | undefined;
  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "JSONBin-Webhook/1.0",
        "X-JSONBin-Event": delivery.event,
        "X-JSONBin-Delivery": delivery.id,
        "X-JSONBin-Timestamp": timestamp,
        "X-JSONBin-Signature": `sha256=${signature}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    statusCode = response.status;
    if (!response.ok) error = `http_${response.status}`;
  } catch (caught) {
    error = caught instanceof Error ? (caught.name === "TimeoutError" ? "timeout" : "network_error") : "network_error";
  }

  const attempts = delivery.attempts + 1;
  const next: WebhookDelivery = { ...delivery, attempts, lastStatusCode: statusCode ?? undefined, lastError: error };
  if (!error) {
    next.status = "delivered";
    next.deliveredAt = new Date().toISOString();
  } else if (attempts >= delivery.maxAttempts) {
    next.status = "failed";
  } else {
    next.nextRetryAt = new Date(Date.now() + RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]).toISOString();
  }
  await putJson(bucket, deliveryKey(delivery.webhookId, delivery.id), next);
  return next;
}

/** Queue and best-effort deliver an event to every matching active webhook. */
export async function dispatchWebhooks(env: Env, event: {
  action: string;
  resourceId: string | null;
  actor?: { type: string; id: string | null } | null;
  requestId?: string;
  test?: { webhookId: string };
}): Promise<void> {
  try {
    const webhooks = await listWebhooks(env);
    // Explicit test deliveries target one hook regardless of its active flag;
    // real events require an active hook with a matching subscription.
    const targets = webhooks.filter(hook => !("deletedAt" in hook) &&
      (event.test ? hook.id === event.test.webhookId : hook.active && matchesEvent(hook.events, event.action)));
    const bucket = requireDataBucket(env);
    const now = new Date();
    for (const hook of targets) {
      const delivery: WebhookDelivery = {
        id: newDeliveryId(now.getTime()),
        webhookId: hook.id,
        event: event.action,
        payload: {
          event: event.action,
          resourceId: event.resourceId,
          actor: event.actor ?? null,
          ...(event.requestId ? { requestId: event.requestId } : {}),
          dispatchedAt: now.toISOString(),
          ...(event.test ? { test: true } : {}),
        },
        attempts: 0,
        maxAttempts: RETRY_DELAYS_MS.length + 1,
        nextRetryAt: now.toISOString(),
        status: "pending",
        createdAt: now.toISOString(),
      };
      // Persist first: even if this isolate dies, Cron retries the delivery.
      await putJson(bucket, deliveryKey(hook.id, delivery.id), delivery);
      await attemptDelivery(env, delivery, hook).catch(() => {});
    }
  } catch {
    console.error("webhook_dispatch_failed");
  }
}

/** Cron sweep: retry due pending deliveries and prune resolved records. */
export async function sweepWebhookDeliveries(env: Env, now = Date.now()): Promise<{ retried: number; pruned: number }> {
  const bucket = requireDataBucket(env);
  const result = { retried: 0, pruned: 0 };
  const webhooks = new Map<string, Webhook>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "webhooks/", cursor, limit: 1000 });
    const metaKeys = page.objects.filter(o => o.key.endsWith("/meta.json"));
    for (const object of metaKeys) {
      const stored = await getJson<Webhook & { deletedAt?: string }>(bucket, object.key);
      if (stored && !stored.value.deletedAt) webhooks.set(stored.value.id, stored.value);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  for (const hook of webhooks.values()) {
    let deliveryCursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `webhooks/${hook.id}/deliveries/`, cursor: deliveryCursor, limit: 100 });
      for (const object of page.objects) {
        const stored = await getJson<WebhookDelivery>(bucket, object.key);
        if (!stored) continue;
        const delivery = stored.value;
        if (delivery.status === "pending" && Date.parse(delivery.nextRetryAt) <= now) {
          await attemptDelivery(env, delivery, hook).catch(() => {});
          result.retried++;
        } else if (delivery.status !== "pending" && Date.parse(delivery.createdAt) < now - 24 * 3600_000) {
          await bucket.delete(object.key);
          result.pruned++;
        }
      }
      deliveryCursor = page.truncated ? page.cursor : undefined;
    } while (deliveryCursor);
  }
  return result;
}
