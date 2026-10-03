import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import { listTrash, purgeTrashBin, restoreTrashBin } from "../storage/trash";
import { SchemaError } from "../validation/schema";

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.onError((error, c) => {
  if (error.message === "etag_conflict") return c.json({ error: error.message }, 412);
  if (["bin_purging", "version_missing", "schema_revision_missing"].includes(error.message)) return c.json({ error: error.message }, 409);
  if (error instanceof SchemaError) return c.json({ error: error.message, issues: error.issues }, 422);
  throw error;
});
app.get("/bins", requireAccess("bin:read"), async c => {
  const items = await listTrash(c.env); return c.json({ items, total: items.length });
});
app.post("/bins/:id/restore", requireAccess(["bin:update", "history:read"]), async c => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const record = await restoreTrashBin(c.env, c.req.param("id"), etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag); c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  await auditRequest(c, "bin.restored", record.meta.id);
  return c.json(record);
});
app.delete("/bins/:id", requireAccess("bin:delete"), async c => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const result = await purgeTrashBin(c.env, c.req.param("id"), etag);
  if (!result) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "bin.purged", c.req.param("id"));
  return c.json(result);
});
const batchSchema = z.object({ items: z.array(z.object({ id: z.string().uuid(), etag: z.string().trim().min(1) }).strict()).min(1).max(100) }).strict()
  .refine(value => new Set(value.items.map(item => item.id)).size === value.items.length);
app.post("/bins/purge", requireAccess("bin:delete"), async c => {
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const results = [];
  // Delete only the snapshots explicitly approved by the client, never a fresh server-side list.
  for (const item of parsed.data.items) {
    try {
      const result = await purgeTrashBin(c.env, item.id, item.etag);
      if (result) await auditRequest(c, "bin.purged", item.id);
      results.push({ id: item.id, status: result ? 200 : 404 });
    } catch (error) {
      results.push({ id: item.id, status: error instanceof Error && error.message === "etag_conflict" ? 412 : 500 });
    }
  }
  return c.json({ results });
});
export default app;
