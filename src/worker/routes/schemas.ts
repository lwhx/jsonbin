import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import { createSchema, getSchema, listSchemas, updateSchema, deleteSchema } from "../storage/schemas";
import { SchemaError, validateSchemaValue, type JsonSchema } from "../validation/schema";

import { conditionalGet } from "../middleware/conditional";
const app = new Hono<{ Bindings: Env }>();
app.use("*", conditionalGet);
const input = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(1000).optional(),
  schema: z.union([z.boolean(), z.record(z.string(), z.unknown())]) }).strict();
app.onError((error, c) => {
  if (error.message === "revision_limit_reached") return c.json({ error: "revision_limit_reached" }, 409);
  if (error instanceof SchemaError) return c.json({ error: error.message, issues: error.issues }, 422);
  if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
  throw error;
});
app.get("/", requireAccess("schema:read"), async c => { const items = await listSchemas(c.env); return c.json({ items, total: items.length }); });
app.post("/", requireAccess("schema:write"), async c => {
  const parsed = input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const record = await createSchema(c.env, { ...parsed.data, schema: parsed.data.schema as JsonSchema });
  c.header("ETag", record.etag); await auditRequest(c, "schema.created", record.meta.id); return c.json(record, 201);
});
app.get("/:id", requireAccess("schema:read"), async c => {
  const record = await getSchema(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag); return c.json(record);
});
app.put("/:id", requireAccess("schema:write"), async c => {
  const etag = c.req.header("If-Match"); if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const parsed = input.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const record = await updateSchema(c.env, c.req.param("id"), { ...parsed.data, schema: parsed.data.schema as JsonSchema }, etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag); await auditRequest(c, "schema.updated", record.meta.id); return c.json(record);
});
app.delete("/:id", requireAccess("schema:write"), async c => {
  const etag = c.req.header("If-Match"); if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  if (!await deleteSchema(c.env, c.req.param("id"), etag)) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "schema.deleted", c.req.param("id")); return c.json({ ok: true });
});
app.post("/:id/validate", requireAccess("schema:read"), async c => {
  const parsed = z.object({ value: z.unknown() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const record = await getSchema(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  return c.json({ ...validateSchemaValue(record.schema, parsed.data.value), revision: record.meta.currentRevision });
});
export default app;
