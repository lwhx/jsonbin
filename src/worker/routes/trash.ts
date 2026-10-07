import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import { checkResourceAccess, type ApiKey } from "../storage/keys";
import { listTrash, purgeTrashBin, readTrash, restoreTrashBin } from "../storage/trash";
import { SchemaError } from "../validation/schema";

const app = new Hono<{ Bindings: Env; Variables: { apiKey?: ApiKey } }>();
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
app.onError((error, c) => {
  if (error.message === "etag_conflict") return c.json({ error: error.message }, 412);
  if (["bin_purging", "version_missing", "schema_revision_missing"].includes(error.message)) return c.json({ error: error.message }, 409);
  if (error instanceof SchemaError) return c.json({ error: error.message, issues: error.issues }, 422);
  throw error;
});

/**
 * Restricted keys authorize the exact trash snapshot the client's If-Match
 * targets; the storage CAS then guarantees that snapshot is also the one being
 * restored or purged. Unrestricted keys and sessions skip the extra read.
 * "missing" maps to 404 so restricted keys cannot probe purged-vs-absent ids
 * through the unpreconditioned purge idempotency path.
 */
async function trashAccessVerdict(env: Env, key: ApiKey | undefined, id: string): Promise<"ok" | "missing" | "forbidden"> {
  if (!key || key.resourceAccess?.mode !== "restricted") return "ok";
  const record = await readTrash(env, id);
  if (!record) return "missing";
  return checkResourceAccess(key, { type: "bin", id: record.meta.id, collectionId: record.meta.collectionId }) ? "ok" : "forbidden";
}

app.get("/bins", requireAccess("bin:read"), async c => {
  const items = await listTrash(c.env);
  const key = c.get("apiKey");
  // Scope the listing itself: out-of-range entries must not leak ids or ETags.
  const visible = key
    ? items.filter(item => checkResourceAccess(key, { type: "bin", id: item.meta.id, collectionId: item.meta.collectionId }))
    : items;
  return c.json({ items: visible, total: visible.length });
});
app.post("/bins/:id/restore", requireAccess(["bin:update", "history:read"]), async c => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const verdict = await trashAccessVerdict(c.env, c.get("apiKey"), c.req.param("id")!);
  if (verdict === "missing") return c.json({ error: "not_found" }, 404);
  if (verdict === "forbidden") return c.json({ error: "resource_forbidden" }, 403);
  const record = await restoreTrashBin(c.env, c.req.param("id"), etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag); c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  await auditRequest(c, "bin.restored", record.meta.id);
  return c.json(record);
});
app.delete("/bins/:id", requireAccess("bin:delete"), async c => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const verdict = await trashAccessVerdict(c.env, c.get("apiKey"), c.req.param("id")!);
  if (verdict === "missing") return c.json({ error: "not_found" }, 404);
  if (verdict === "forbidden") return c.json({ error: "resource_forbidden" }, 403);
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
  const key = c.get("apiKey");
  const results = [];
  // Delete only the snapshots explicitly approved by the client, never a fresh server-side list.
  for (const item of parsed.data.items) {
    try {
      const verdict = await trashAccessVerdict(c.env, key, item.id);
      if (verdict !== "ok") { results.push({ id: item.id, status: verdict === "missing" ? 404 : 403 }); continue; }
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
