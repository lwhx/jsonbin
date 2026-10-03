import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import { createCollection, deleteCollection, getCollection, listCollectionBins, listCollections, updateCollection } from "../storage/collections";

const app = new Hono<{ Bindings: Env }>();
const createSchema = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(1000).optional() }).strict();
const updateSchema = createSchema.partial().refine(input => Object.keys(input).length > 0);
app.onError((error, c) => {
  if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
  if (error.message === "collection_deleting" || error.message === "collection_delete_conflict") return c.json({ error: error.message }, 409);
  throw error;
});
app.get("/", requireAccess("collection:read"), async c => { const items = await listCollections(c.env); return c.json({ items, total: items.length }); });
app.post("/", requireAccess("collection:write"), async c => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const record = await createCollection(c.env, parsed.data); c.header("ETag", record.etag);
  await auditRequest(c, "collection.created", record.meta.id); return c.json(record, 201);
});
app.get("/:id/bins", requireAccess(["collection:read", "bin:read"]), async c => {
  const items = await listCollectionBins(c.env, c.req.param("id"));
  if (!items) return c.json({ error: "not_found" }, 404);
  return c.json({ items, total: items.length });
});
app.get("/:id", requireAccess("collection:read"), async c => {
  const record = await getCollection(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  const members = await listCollectionBins(c.env, record.meta.id);
  c.header("ETag", record.etag);
  return c.json({ ...record, binCount: members?.length ?? 0 });
});
app.patch("/:id", requireAccess("collection:write"), async c => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const record = await updateCollection(c.env, c.req.param("id"), parsed.data, etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag); await auditRequest(c, "collection.updated", record.meta.id); return c.json(record);
});
app.delete("/:id", requireAccess("collection:write"), async c => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const result = await deleteCollection(c.env, c.req.param("id"), etag);
  if (!result) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "collection.deleted", c.req.param("id")); return c.json(result);
});
export default app;
