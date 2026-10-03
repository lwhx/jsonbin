import { Hono } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import {
  createBin,
  deleteBin,
  getBin,
  listBins,
  updateBin,
  updateBinMetadata,
  listBinVersions,
  getBinVersion,
  restoreBinVersion,
} from "../storage/bins";

import { SchemaError } from "../validation/schema";

type Variables = {
  user: {
    id: string;
    username: string;
    provider: "password" | "github";
  };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  collectionId: z.string().uuid().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  schemaLocked: z.boolean().optional(),
  value: z.unknown(),
}).strict();

const updateSchema = z.object({
  value: z.unknown(),
});

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().max(1000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  collectionId: z.string().uuid().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  schemaLocked: z.boolean().optional(),
  refreshSchema: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0);

app.onError((error, c) => {
  if (error instanceof SchemaError) {
    const status = error.message === "schema_locked" ? 423 : error.message === "schema_unavailable" ? 409 : 422;
    return c.json({ error: error.message, issues: error.issues }, status);
  }
  if (error.message === "collection_unavailable") return c.json({ error: "collection_unavailable" }, 409);
  if (error.message === "collection_delete_conflict") return c.json({ error: "collection_delete_conflict" }, 409);
  throw error;
});

function parseVersion(value: string) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

app.get("/:id/versions", requireAccess("history:read"), async (c) => {
  const versions = await listBinVersions(c.env, c.req.param("id"));
  if (!versions) return c.json({ error: "not_found" }, 404);
  return c.json(versions);
});

app.get("/:id/versions/:version", requireAccess("history:read"), async (c) => {
  const version = parseVersion(c.req.param("version"));
  if (version === null) return c.json({ error: "invalid_version" }, 422);
  const record = await getBinVersion(c.env, c.req.param("id"), version);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(version));
  return c.json(record);
});

app.post("/:id/versions/:version/restore", requireAccess(["bin:update", "history:read"]), async (c) => {
  const version = parseVersion(c.req.param("version"));
  if (version === null) return c.json({ error: "invalid_version" }, 422);
  const expectedEtag = c.req.header("If-Match");
  if (!expectedEtag?.trim()) return c.json({ error: "precondition_required" }, 428);
  try {
    const record = await restoreBinVersion(c.env, c.req.param("id"), version, expectedEtag);
    if (!record) return c.json({ error: "not_found" }, 404);
    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") return c.json({ error: "bin_locked" }, 423);
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

app.get("/", requireAccess("bin:read"), async (c) => {
  const items = await listBins(c.env);
  return c.json({
    items,
    total: items.length,
  });
});

app.post("/", requireAccess("bin:create"), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      422,
    );
  }

  const created = await createBin(c.env, parsed.data);

  c.header("ETag", created.etag);
  c.header("X-JSONBin-Version", String(created.meta.currentVersion));
  return c.json(created, 201);
});

app.get("/:id", requireAccess("bin:read"), async (c) => {
  const record = await getBin(c.env, c.req.param("id"));
  if (!record) return c.json({ error: "not_found" }, 404);

  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json(record);
});

app.put("/:id", requireAccess("bin:update"), async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      422,
    );
  }

  try {
    const record = await updateBin(
      c.env,
      c.req.param("id"),
      parsed.data.value,
      c.req.header("If-Match"),
    );

    if (!record) return c.json({ error: "not_found" }, 404);

    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") {
      return c.json({ error: "bin_locked" }, 423);
    }

    if (error instanceof Error && error.message === "etag_conflict") {
      return c.json({ error: "etag_conflict" }, 412);
    }

    throw error;
  }
});

app.delete("/:id", requireAccess("bin:delete"), async (c) => {
  const deleted = await deleteBin(c.env, c.req.param("id"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

app.patch("/:id/meta", requireAccess("bin:update"), async (c) => {
  const parsed = metadataSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }
  try {
    const record = await updateBinMetadata(c.env, c.req.param("id"), parsed.data, c.req.header("If-Match"));
    if (!record) return c.json({ error: "not_found" }, 404);
    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") return c.json({ error: "bin_locked" }, 423);
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

export default app;
