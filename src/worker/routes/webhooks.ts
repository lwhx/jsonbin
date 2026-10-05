import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { managementSession } from "../lib/system-http";
import {
  WEBHOOK_EVENT_ACTIONS,
  WEBHOOK_EVENT_PATTERNS,
  isSelectableEvent,
  createWebhook,
  deleteWebhook,
  dispatchWebhooks,
  getWebhook,
  listDeliveries,
  listWebhooks,
  updateWebhook,
} from "../storage/webhooks";

const app = new Hono<{ Bindings: Env; Variables: { user?: { id: string } } }>();
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.use("*", managementSession);

const urlSchema = z.string().trim().url().max(2000).refine(value => /^https?:\/\//.test(value), "http(s) URL required");
const eventsSchema = z.array(z.string()).min(1).max(WEBHOOK_EVENT_PATTERNS.length + WEBHOOK_EVENT_ACTIONS.length)
  .refine(events => new Set(events).size === events.length && events.every(isSelectableEvent));

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  url: urlSchema,
  secret: z.string().min(16).max(256),
  events: eventsSchema,
  active: z.boolean().optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  url: urlSchema.optional(),
  secret: z.string().min(16).max(256).optional(),
  events: eventsSchema.optional(),
  active: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

app.onError((error, c) => {
  if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
  if (error.message === "webhook_conflict") return c.json({ error: "webhook_conflict" }, 409);
  throw error;
});

app.get("/", async (c) => {
  const items = await listWebhooks(c.env);
  return c.json({ items, total: items.length, eventPatterns: WEBHOOK_EVENT_PATTERNS, eventActions: WEBHOOK_EVENT_ACTIONS });
});

app.post("/", async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const webhook = await createWebhook(c.env, parsed.data);
  await auditRequest(c, "webhook.created", webhook.id);
  return c.json({ webhook }, 201);
});

app.get("/:id", async (c) => {
  const record = await getWebhook(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  return c.json({ webhook: record.webhook });
});

app.patch("/:id", async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  try {
    const webhook = await updateWebhook(c.env, c.req.param("id"), parsed.data, etag);
    if (!webhook) return c.json({ error: "not_found" }, 404);
    await auditRequest(c, "webhook.updated", webhook.id);
    const fresh = await getWebhook(c.env, webhook.id);
    if (fresh) c.header("ETag", fresh.etag);
    return c.json({ webhook });
  } catch (error) {
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

app.delete("/:id", async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  try {
    const deleted = await deleteWebhook(c.env, c.req.param("id"), etag);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    await auditRequest(c, "webhook.deleted", c.req.param("id"));
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

app.get("/:id/deliveries", async (c) => {
  const record = await getWebhook(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  const items = await listDeliveries(c.env, record.webhook.id);
  return c.json({ items, total: items.length });
});

/** Fire a synthetic webhook.test delivery so admins can verify receivers end to end. */
app.post("/:id/test", async (c) => {
  const record = await getWebhook(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  await dispatchWebhooks(c.env, {
    action: "webhook.test",
    resourceId: record.webhook.id,
    actor: { type: "session", id: c.get("user")?.id ?? null },
    requestId: c.get("requestId"),
    test: { webhookId: record.webhook.id },
  });
  const [latest] = await listDeliveries(c.env, record.webhook.id, 1);
  return c.json({ delivery: latest ?? null });
});

export default app;
