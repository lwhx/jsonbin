import { Hono, type MiddlewareHandler } from "hono";
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
  transformBin,
  type BinRecord,
} from "../storage/bins";
import { mergePatch, readValue, valuePath, writeValue } from "../validation/json-operations";

import { SchemaError } from "../validation/schema";

type Variables = {
  bin?: BinRecord | null;
  user: {
    id: string;
    username: string;
    provider: "password" | "github";
  };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Visibility can change; do not retain an anonymous response in browser/CDN caches.
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

const readCurrent: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const load = async () => { c.set("bin", await getBin(c.env, c.req.param("id")!)); await next(); };
  // Explicit credentials keep their authentication and scope semantics on public Bins.
  if (c.req.raw.headers.has("Authorization")) return requireAccess("bin:read")(c, load);
  const record = await getBin(c.env, c.req.param("id")!);
  c.set("bin", record);
  if (record?.meta.visibility === "public") return next();
  // The handler uses this exact snapshot, including its visibility and immutable value.
  return requireAccess("bin:read")(c, next);
};

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
  locked: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0);

app.onError((error, c) => {
  if (error.message === "bin_locked") return c.json({ error: "bin_locked" }, 423);
  if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
  if (error.message === "path_not_found") return c.json({ error: "path_not_found" }, 404);
  if (["invalid_path", "patch_too_deep"].includes(error.message)) return c.json({ error: error.message }, 422);
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

app.get("/:id", readCurrent, async (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);

  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json(record);
});

app.on("GET", ["/:id/value", "/:id/value/*"], readCurrent, (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  const path = valuePath(c.req.url);
  const value = readValue(record.value, path);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json({ id: record.meta.id, path, value, etag: record.etag, version: record.meta.currentVersion });
});

app.patch("/:id", requireAccess("bin:update"), async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  let patch: unknown;
  try { patch = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 422); }
  const record = await transformBin(c.env, c.req.param("id"), value => mergePatch(value, patch), etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json(record);
});

app.on("PUT", ["/:id/value", "/:id/value/*"], requireAccess("bin:update"), async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const parsed = updateSchema.strict().safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const path = valuePath(c.req.url);
  const record = await transformBin(c.env, c.req.param("id"), value => writeValue(value, path, parsed.data.value), etag);
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
  const deleted = await deleteBin(c.env, c.req.param("id"), c.req.header("If-Match"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

app.patch("/:id/meta", requireAccess("bin:update"), async (c) => {
  const parsed = metadataSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }
  if (parsed.data.locked !== undefined && !c.req.header("If-Match")?.trim()) return c.json({ error: "precondition_required" }, 428);
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
