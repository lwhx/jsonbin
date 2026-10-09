import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireSession } from "../middleware/auth";
import { listKeysWithEstimatedUsage } from "../storage/key-usage";
import { API_SCOPES, createKey, purgeKey, revealKey, revokeKey, updateKey } from "../storage/keys";
const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  if (c.req.raw.headers.has("Authorization")) return c.json({ error: "session_required" }, 401);
  await next();
});
app.use("*", requireSession);
const resourceAccessSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z.object({
    mode: z.literal("restricted"),
    binIds: z.array(z.string().uuid()),
    collectionIds: z.array(z.string().uuid()),
  }).strict(),
]);

const input = z.object({
  name: z.string().trim().min(1).max(160),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length).refine(scopes => new Set(scopes).size === scopes.length),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional().refine(value => !value || Date.parse(value) > Date.now()),
  resourceAccess: resourceAccessSchema.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).nullable().optional(),
}).strict();
const updateInput = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length).refine(scopes => new Set(scopes).size === scopes.length).optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional().refine(value => value === undefined || value === null || Date.parse(value) > Date.now()),
  resourceAccess: resourceAccessSchema.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

app.onError((error, c) => {
  if (error.message === "token_pepper_invalid" || error.message === "token_encryption_unavailable") return c.json({ error: "key_service_unavailable" }, 503);
  if (error.message === "key_update_conflict") return c.json({ error: "key_update_conflict" }, 409);
  if (error.message === "key_revoked") return c.json({ error: "key_revoked" }, 409);
  throw error;
});
app.get("/", async c => { const items = await listKeysWithEstimatedUsage(c.env); return c.json({ items, total: items.length }); });
app.post("/", async c => {
  const parsed = input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const created = await createKey(c.env, parsed.data);
  await auditRequest(c, "key.created", created.key.id);
  return c.json(created, 201);
});
app.get("/:id/token", async c => {
  if (!z.string().uuid().safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404);
  const result = await revealKey(c.env, c.req.param("id"));
  if (result.status === "not_found") return c.json({ error: "not_found" }, 404);
  if (result.status === "unavailable") return c.json({ error: "key_token_unavailable" }, 409);
  return c.json({ token: result.token });
});
app.delete("/:id/purge", async c => {
  if (!z.string().uuid().safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404);
  const id = c.req.param("id");
  if (!await purgeKey(c.env, id)) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "key.deleted", id);
  return c.json({ ok: true, id });
});
app.patch("/:id", async c => {
  if (!z.string().uuid().safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404);
  const parsed = updateInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  try {
    const updated = await updateKey(c.env, c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "not_found" }, 404);
    await auditRequest(c, "key.updated", updated.id);
    return c.json({ key: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "key_revoked") return c.json({ error: "key_revoked" }, 409);
    throw error;
  }
});
app.delete("/:id", async c => {
  if (!z.string().uuid().safeParse(c.req.param("id")).success) return c.json({ error: "not_found" }, 404);
  const key = await revokeKey(c.env, c.req.param("id"));
  if (!key) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "key.revoked", key.id);
  return c.json({ key });
});
export default app;
