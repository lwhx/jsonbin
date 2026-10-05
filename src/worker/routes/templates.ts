import { auditRequest } from "../activity";
import { Hono } from "hono";
import { z } from "zod";
import { requireSession } from "../middleware/auth";
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from "../storage/templates";
import { createBin, getBin } from "../storage/bins";
import { SchemaError } from "../validation/schema";

const app = new Hono<{ Bindings: Env }>();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    value: z.unknown(),
    schemaId: z.string().uuid().nullable().optional(),
    schemaRevision: z.number().int().positive().nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().max(1000).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    value: z.unknown().optional(),
    schemaId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0);

app.get("/", requireSession, async (c) => {
  const items = await listTemplates(c.env);
  return c.json({ items, total: items.length });
});

app.post("/", requireSession, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }

  try {
    const record = await createTemplate(c.env, parsed.data);
    c.header("ETag", record.etag);
    await auditRequest(c, "template.created", record.meta.id);
    return c.json(record, 201);
  } catch (error: any) {
    if (error instanceof SchemaError || error.message?.startsWith("schema_")) {
      return c.json({ error: error.message }, 422);
    }
    throw error;
  }
});

app.get("/:id", requireSession, async (c) => {
  const record = await getTemplate(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  return c.json(record);
});

app.patch("/:id", requireSession, async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }

  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) return c.json({ error: "precondition_required" }, 428);

  try {
    const record = await updateTemplate(c.env, c.req.param("id"), parsed.data, ifMatch);
    c.header("ETag", record.etag);
    await auditRequest(c, "template.updated", record.meta.id);
    return c.json(record);
  } catch (error: any) {
    if (error.message === "not_found") return c.json({ error: "not_found" }, 404);
    if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    if (error instanceof SchemaError || error.message?.startsWith("schema_")) {
      return c.json({ error: error.message }, 422);
    }
    throw error;
  }
});

app.delete("/:id", requireSession, async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) return c.json({ error: "precondition_required" }, 428);

  try {
    const result = await deleteTemplate(c.env, c.req.param("id"), ifMatch);
    await auditRequest(c, "template.deleted", c.req.param("id"));
    return c.json(result);
  } catch (error: any) {
    if (error.message === "not_found") return c.json({ error: "not_found" }, 404);
    if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

app.post("/:id/create-bin", requireSession, async (c) => {
  const template = await getTemplate(c.env, c.req.param("id"));
  if (!template) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) || {};
  const name = body.name?.trim() || `${template.meta.name} - 副本`;
  const collectionId = body.collectionId || null;

  try {
    const bin = await createBin(c.env, {
      name,
      value: template.value,
      tags: [...template.meta.tags],
      collectionId,
      schemaId: template.meta.schemaId,
      // Bind the revision the template captured, not the schema's latest.
      schemaRevision: template.meta.schemaRevision,
    });
    c.header("ETag", bin.etag);
    c.header("X-JSONBin-Version", String(bin.meta.currentVersion));
    await auditRequest(c, "bin.created", bin.meta.id);
    return c.json(bin, 201);
  } catch (error: any) {
    if (error instanceof SchemaError || error.message?.startsWith("schema_")) {
      return c.json({ error: error.message }, 422);
    }
    throw error;
  }
});

export default app;
