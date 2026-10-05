import { auditRequest } from "../activity";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { requireAccess } from "../middleware/auth";
import { managementSession } from "../lib/system-http";
import {
  cloneBin,
  createBin,
  deleteBin,
  getBin,
  getBinBySlug,
  getBinVersion,
  listBins,
  listBinVersions,
  publishBinVersion,
  restoreBinVersion,
  transformBin,
  updateBin,
  updateBinMetadata,
  type BinRecord,
} from "../storage/bins";
import { createTemplate } from "../storage/templates";
import { mergePatch, readValue, valuePath, writeValue } from "../validation/json-operations";

import { SchemaError } from "../validation/schema";

import { checkResourceAccess, type ApiKey } from "../storage/keys";

type Variables = {
  bin?: BinRecord | null;
  user?: {
    id: string;
    username: string;
    provider: "password" | "github";
  };
  apiKey?: ApiKey;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const checkBinMutationAccess: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const key = c.get("apiKey");
  if (!key || key.resourceAccess?.mode !== "restricted") return next();

  const id = c.req.param("id");
  if (!id) return next();

  const current = await getBin(c.env, id);
  if (current && !checkResourceAccess(key, { type: "bin", id: current.meta.id, collectionId: current.meta.collectionId })) {
    return c.json({ error: "resource_forbidden" }, 403);
  }
  await next();
};
const expiresAtSchema = z.iso.datetime({ offset: true }).refine(value => Date.parse(value) > Date.now(), "expiresAt must be in the future")
  .transform(value => new Date(value).toISOString()).nullable().optional();

// Visibility can change; do not retain an anonymous response in browser/CDN caches.
app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });

const readCurrent: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const load = async (): Promise<void> => {
    const record = await getBin(c.env, c.req.param("id")!);
    c.set("bin", record);
    if (!record) {
      await next();
      return;
    }

    const key = c.get("apiKey");
    if (key && !checkResourceAccess(key, { type: "bin", id: record.meta.id, collectionId: record.meta.collectionId })) {
      c.res = c.json({ error: "resource_forbidden" }, 403);
      return;
    }
    await next();
  };
  // Explicit credentials keep their authentication and scope semantics on public Bins.
  if (c.req.raw.headers.has("Authorization")) return requireAccess("bin:read")(c, load);
  const record = await getBin(c.env, c.req.param("id")!);
  c.set("bin", record);
  if (record?.meta.visibility === "public") return next();
  // The handler uses this exact snapshot, including its visibility and immutable value.
  return requireAccess("bin:read")(c, next);
};

const slugSchema = z.string().trim().regex(/^[a-z0-9][a-z0-9-_]{1,62}[a-z0-9]$/i, "invalid_slug").transform(s => s.toLowerCase()).nullable().optional();
const tagsSchema = z.array(z.string().trim().min(1).max(32)).max(20).optional();

const createSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: slugSchema,
  tags: tagsSchema,
  favorite: z.boolean().optional(),
  pinned: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  collectionId: z.string().uuid().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  schemaRevision: z.number().int().positive().nullable().optional(),
  schemaLocked: z.boolean().optional(),
  expiresAt: expiresAtSchema,
  value: z.unknown(),
}).strict();

const updateSchema = z.object({
  value: z.unknown(),
});

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  slug: slugSchema,
  tags: tagsSchema,
  favorite: z.boolean().optional(),
  pinned: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  collectionId: z.string().uuid().nullable().optional(),
  schemaId: z.string().uuid().nullable().optional(),
  schemaLocked: z.boolean().optional(),
  refreshSchema: z.boolean().optional(),
  locked: z.boolean().optional(),
  contentSearchMode: z.enum(["off", "keys", "all"]).optional(),
  expiresAt: expiresAtSchema,
}).strict().refine((input) => Object.keys(input).length > 0);

app.onError((error, c) => {
  if (error.message === "slug_conflict") return c.json({ error: "slug_conflict" }, 409);
  if (error.message === "invalid_slug") return c.json({ error: "invalid_slug" }, 422);
  if (error.message === "invalid_tags" || error.message === "tags_limit_reached") return c.json({ error: error.message }, 422);
  if (error.message === "version_limit_reached") return c.json({ error: "version_limit_reached" }, 409);
  if (error.message === "settings_unavailable") return c.json({ error: "settings_unavailable" }, 503);
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

app.get("/:id/versions", requireAccess("history:read"), checkBinMutationAccess, async (c) => {
  const versions = await listBinVersions(c.env, c.req.param("id"));
  if (!versions) return c.json({ error: "not_found" }, 404);
  return c.json(versions);
});

app.get("/:id/versions/:version", requireAccess("history:read"), checkBinMutationAccess, async (c) => {
  const version = parseVersion(c.req.param("version"));
  if (version === null) return c.json({ error: "invalid_version" }, 422);
  const record = await getBinVersion(c.env, c.req.param("id"), version);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(version));
  return c.json(record);
});

app.post("/:id/versions/:version/restore", requireAccess(["bin:update", "history:read"]), checkBinMutationAccess, async (c) => {
  const version = parseVersion(c.req.param("version"));
  if (version === null) return c.json({ error: "invalid_version" }, 422);
  const expectedEtag = c.req.header("If-Match");
  if (!expectedEtag?.trim()) return c.json({ error: "precondition_required" }, 428);
  try {
    const record = await restoreBinVersion(c.env, c.req.param("id"), version, expectedEtag);
    if (!record) return c.json({ error: "not_found" }, 404);
    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    await auditRequest(c, "bin.version_restored", record.meta.id);
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") return c.json({ error: "bin_locked" }, 423);
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

app.get("/", requireAccess("bin:read"), async (c) => {
  const tag = c.req.query("tag")?.trim();
  const favoriteParam = c.req.query("favorite");
  const pinnedParam = c.req.query("pinned");

  const favorite = favoriteParam === "true" ? true : favoriteParam === "false" ? false : undefined;
  const pinned = pinnedParam === "true" ? true : pinnedParam === "false" ? false : undefined;

  let items = await listBins(c.env, { tag: tag || undefined, favorite, pinned });
  const key = c.get("apiKey");
  if (key && key.resourceAccess && key.resourceAccess.mode === "restricted") {
    items = items.filter(item => checkResourceAccess(key, { type: "bin", id: item.id, collectionId: item.collectionId }));
  }

  return c.json({
    items,
    total: items.length,
  });
});

const batchOperationSchema = z.object({
  operation: z.enum([
    "move_collection",
    "set_visibility",
    "add_tags",
    "remove_tags",
    "set_favorite",
    "unset_favorite",
    "set_pinned",
    "unset_pinned",
    "trash",
  ]),
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        etag: z.string().min(1),
      }),
    )
    .min(1)
    .max(100)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
      message: "duplicate_ids_in_batch",
    }),
  payload: z
    .object({
      collectionId: z.string().uuid().nullable().optional(),
      visibility: z.enum(["private", "public"]).optional(),
      tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
    })
    .optional(),
});

app.post("/batch", async (c) => {
  const parsed = batchOperationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }

  const { operation, items, payload } = parsed.data;
  const requiredScope = operation === "trash" ? "bin:delete" : "bin:update";

  // Check auth scope
  const authMiddleware = requireAccess(requiredScope);
  let authed = false;
  await authMiddleware(c, async () => {
    authed = true;
  });
  if (!authed) return c.res;

  const key = c.get("apiKey");
  const results: Array<{ id: string; status: "updated" | "etag_conflict" | "not_found" | "locked" | "forbidden" | "error" }> = [];

  for (const item of items) {
    try {
      const current = await getBin(c.env, item.id);
      if (!current) {
        results.push({ id: item.id, status: "not_found" });
        continue;
      }

      if (key && !checkResourceAccess(key, { type: "bin", id: current.meta.id, collectionId: current.meta.collectionId })) {
        results.push({ id: item.id, status: "forbidden" });
        continue;
      }

      if (current.meta.locked) {
        results.push({ id: item.id, status: "locked" });
        continue;
      }

      const match = current.etag === item.etag || `"${current.etag}"` === item.etag || current.etag === `"${item.etag}"`;
      if (!match) {
        results.push({ id: item.id, status: "etag_conflict" });
        continue;
      }

      if (operation === "trash") {
        const deleted = await deleteBin(c.env, item.id, item.etag);
        if (deleted) {
          await auditRequest(c, "bin.deleted", item.id);
          results.push({ id: item.id, status: "updated" });
        } else {
          results.push({ id: item.id, status: "error" });
        }
        continue;
      }

      let metaPatch: Parameters<typeof updateBinMetadata>[2] = {};
      if (operation === "move_collection") {
        const targetCollectionId = payload?.collectionId ?? null;
        if (key && targetCollectionId && !checkResourceAccess(key, { type: "collection", id: targetCollectionId })) {
          results.push({ id: item.id, status: "forbidden" });
          continue;
        }
        metaPatch.collectionId = targetCollectionId;
      } else if (operation === "set_visibility") {
        metaPatch.visibility = payload?.visibility ?? "private";
      } else if (operation === "add_tags") {
        const existing = new Set(current.meta.tags || []);
        for (const t of payload?.tags || []) existing.add(t);
        metaPatch.tags = Array.from(existing);
      } else if (operation === "remove_tags") {
        const toRemove = new Set(payload?.tags || []);
        metaPatch.tags = (current.meta.tags || []).filter((t) => !toRemove.has(t));
      } else if (operation === "set_favorite") {
        metaPatch.favorite = true;
      } else if (operation === "unset_favorite") {
        metaPatch.favorite = false;
      } else if (operation === "set_pinned") {
        metaPatch.pinned = true;
      } else if (operation === "unset_pinned") {
        metaPatch.pinned = false;
      }

      const updated = await updateBinMetadata(c.env, item.id, metaPatch, item.etag);
      if (updated) {
        await auditRequest(c, "bin.metadata_updated", item.id);
        results.push({ id: item.id, status: "updated" });
      } else {
        results.push({ id: item.id, status: "error" });
      }
    } catch (err: any) {
      if (err.message === "etag_conflict") results.push({ id: item.id, status: "etag_conflict" });
      else if (err.message === "not_found") results.push({ id: item.id, status: "not_found" });
      else if (err.message === "locked") results.push({ id: item.id, status: "locked" });
      else results.push({ id: item.id, status: "error" });
    }
  }

  return c.json({ results });
});

// Template management is Session-only (P15); bin:read must not imply template
// writes. An explicit Authorization header never falls back to the cookie.
app.post("/:id/save-as-template", managementSession, checkBinMutationAccess, async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) {
    return c.json({ error: "precondition_required" }, 428);
  }

  const id = c.req.param("id");
  const current = await getBin(c.env, id);
  if (!current) return c.json({ error: "not_found" }, 404);

  if (current.etag !== ifMatch && `"${current.etag}"` !== ifMatch && current.etag !== `"${ifMatch}"`) {
    return c.json({ error: "etag_conflict" }, 412);
  }

  const body = (await c.req.json().catch(() => ({}))) || {};
  const name = body.name?.trim() || `${current.meta.name} 模板`;
  const description = body.description !== undefined ? body.description.trim() : (current.meta.description || "");

  try {
    const template = await createTemplate(c.env, {
      name,
      description,
      tags: Array.isArray(current.meta.tags) ? [...current.meta.tags] : [],
      value: current.value,
      schemaId: current.meta.schemaId,
      // Inherit the source Bin's pinned revision, never the schema's latest.
      schemaRevision: current.meta.schemaRevision,
    });
    c.header("ETag", template.etag);
    await auditRequest(c, "template.created", template.meta.id);
    return c.json(template, 201);
  } catch (error: any) {
    if (error instanceof SchemaError || error.message?.startsWith("schema_")) {
      return c.json({ error: error.message }, 422);
    }
    throw error;
  }
});

app.post("/:id/publish", requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) return c.json({ error: "precondition_required" }, 428);

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) || {};
  const version = typeof body.version === "number" ? body.version : undefined;

  try {
    const updated = await publishBinVersion(c.env, id, version, ifMatch);
    if (!updated) return c.json({ error: "not_found" }, 404);

    c.header("ETag", updated.etag);
    c.header("X-JSONBin-Version", String(updated.meta.currentVersion));
    await auditRequest(c, "bin.metadata_updated", updated.meta.id);
    return c.json(updated);
  } catch (err: any) {
    if (err.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    if (err.message === "invalid_version" || err.message === "version_not_found") return c.json({ error: err.message }, 422);
    if (err instanceof SchemaError || err.message?.startsWith("schema_")) return c.json({ error: err.message }, 422);
    throw err;
  }
});

app.post("/:id/rollback", requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) return c.json({ error: "precondition_required" }, 428);

  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) || {};
  const version = typeof body.version === "number" ? body.version : undefined;
  if (!version) return c.json({ error: "invalid_version" }, 422);

  try {
    const updated = await publishBinVersion(c.env, id, version, ifMatch);
    if (!updated) return c.json({ error: "not_found" }, 404);

    c.header("ETag", updated.etag);
    c.header("X-JSONBin-Version", String(updated.meta.currentVersion));
    await auditRequest(c, "bin.metadata_updated", updated.meta.id);
    return c.json(updated);
  } catch (err: any) {
    if (err.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    if (err.message === "invalid_version" || err.message === "version_not_found") return c.json({ error: err.message }, 422);
    if (err instanceof SchemaError || err.message?.startsWith("schema_")) return c.json({ error: err.message }, 422);
    throw err;
  }
});

app.get("/:id/published", readCurrent, async (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  if (!record.meta.publishedVersion) return c.json({ error: "no_published_version" }, 404);

  const published = await getBinVersion(c.env, record.meta.id, record.meta.publishedVersion);
  if (!published) return c.json({ error: "published_version_missing" }, 404);

  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.publishedVersion));
  return c.json({
    meta: record.meta,
    value: published.value,
    etag: record.etag,
  });
});

app.on("GET", ["/:id/published/value", "/:id/published/value/*"], readCurrent, async (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  if (!record.meta.publishedVersion) return c.json({ error: "no_published_version" }, 404);

  const published = await getBinVersion(c.env, record.meta.id, record.meta.publishedVersion);
  if (!published) return c.json({ error: "published_version_missing" }, 404);

  const path = valuePath(c.req.url);
  const value = readValue(published.value, path);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.publishedVersion));
  return c.json({ id: record.meta.id, path, value, etag: record.etag, version: record.meta.publishedVersion });
});

app.post("/:id/clone", requireAccess(["bin:read", "bin:create"]), checkBinMutationAccess, async (c) => {
  const ifMatch = c.req.header("If-Match");
  if (!ifMatch?.trim()) {
    return c.json({ error: "precondition_required" }, 428);
  }

  const id = c.req.param("id");
  const key = c.get("apiKey");

  // Restricted keys authorize the clone target (the inherited collection)
  // before any R2 write: no permission failure may leave a new Bin behind.
  const source = await getBin(c.env, id);
  if (!source) return c.json({ error: "not_found" }, 404);
  if (source.etag !== ifMatch && `"${source.etag}"` !== ifMatch && source.etag !== `"${ifMatch}"`) {
    return c.json({ error: "etag_conflict" }, 412);
  }
  if (key && key.resourceAccess?.mode === "restricted") {
    const targetCollectionId = source.meta.collectionId ?? null;
    if (!targetCollectionId || !checkResourceAccess(key, { type: "collection", id: targetCollectionId })) {
      return c.json({ error: "resource_forbidden" }, 403);
    }
  }

  try {
    const cloned = await cloneBin(c.env, id, ifMatch, source);

    c.header("ETag", cloned.etag);
    c.header("X-JSONBin-Version", String(cloned.meta.currentVersion));
    await auditRequest(c, "bin.created", cloned.meta.id);
    return c.json(cloned, 201);
  } catch (error: any) {
    if (error.message === "not_found") return c.json({ error: "not_found" }, 404);
    if (error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    if (error instanceof SchemaError || error.message?.startsWith("schema_")) {
      return c.json({ error: error.message }, 422);
    }
    throw error;
  }
});

app.post("/", requireAccess("bin:create"), async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: "validation_failed", issues: parsed.error.issues },
      422,
    );
  }

  const key = c.get("apiKey");
  if (key && key.resourceAccess && key.resourceAccess.mode === "restricted") {
    if (!parsed.data.collectionId || !checkResourceAccess(key, { type: "collection", id: parsed.data.collectionId })) {
      return c.json({ error: "resource_forbidden" }, 403);
    }
  }

  const created = await createBin(c.env, parsed.data);

  c.header("ETag", created.etag);
  c.header("X-JSONBin-Version", String(created.meta.currentVersion));
  await auditRequest(c, "bin.created", created.meta.id);
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

app.patch("/:id", requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  let patch: unknown;
  try { patch = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 422); }
  const record = await transformBin(c.env, c.req.param("id"), value => mergePatch(value, patch), etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  await auditRequest(c, "bin.updated", record.meta.id);
    return c.json(record);
});

app.on("PUT", ["/:id/value", "/:id/value/*"], requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
  const etag = c.req.header("If-Match");
  if (!etag?.trim()) return c.json({ error: "precondition_required" }, 428);
  const parsed = updateSchema.strict().safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  const path = valuePath(c.req.url);
  const record = await transformBin(c.env, c.req.param("id"), value => writeValue(value, path, parsed.data.value), etag);
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  await auditRequest(c, "bin.updated", record.meta.id);
    return c.json(record);
});

app.put("/:id", requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
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
    await auditRequest(c, "bin.updated", record.meta.id);
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

app.delete("/:id", requireAccess("bin:delete"), checkBinMutationAccess, async (c) => {
  const deleted = await deleteBin(c.env, c.req.param("id"), c.req.header("If-Match"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  await auditRequest(c, "bin.deleted", c.req.param("id"));
  return c.json({ ok: true });
});

app.patch("/:id/meta", requireAccess("bin:update"), checkBinMutationAccess, async (c) => {
  const parsed = metadataSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 422);
  }
  // Every metadata change is preconditioned: a stale UI must never re-apply an
  // old intent (slug/collection/schema/visibility) against a newer snapshot.
  if (!c.req.header("If-Match")?.trim()) return c.json({ error: "precondition_required" }, 428);

  const key = c.get("apiKey");
  if (key && key.resourceAccess?.mode === "restricted" && parsed.data.collectionId) {
    if (!checkResourceAccess(key, { type: "collection", id: parsed.data.collectionId })) {
      return c.json({ error: "resource_forbidden" }, 403);
    }
  }

  try {
    const record = await updateBinMetadata(c.env, c.req.param("id"), parsed.data, c.req.header("If-Match"));
    if (!record) return c.json({ error: "not_found" }, 404);
    c.header("ETag", record.etag);
    c.header("X-JSONBin-Version", String(record.meta.currentVersion));
    await auditRequest(c, "bin.metadata_updated", record.meta.id);
    return c.json(record);
  } catch (error) {
    if (error instanceof Error && error.message === "bin_locked") return c.json({ error: "bin_locked" }, 423);
    if (error instanceof Error && error.message === "etag_conflict") return c.json({ error: "etag_conflict" }, 412);
    throw error;
  }
});

const readCurrentBySlug: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const load = async () => { c.set("bin", await getBinBySlug(c.env, c.req.param("slug")!)); await next(); };
  if (c.req.raw.headers.has("Authorization")) return requireAccess("bin:read")(c, load);
  const record = await getBinBySlug(c.env, c.req.param("slug")!);
  c.set("bin", record);
  if (record?.meta.visibility === "public") return next();
  return requireAccess("bin:read")(c, next);
};

export const slugApp = new Hono<{ Bindings: Env; Variables: Variables }>();
slugApp.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
slugApp.get("/:slug/published", readCurrentBySlug, async (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  if (!record.meta.publishedVersion) return c.json({ error: "no_published_version" }, 404);

  const published = await getBinVersion(c.env, record.meta.id, record.meta.publishedVersion);
  if (!published) return c.json({ error: "published_version_missing" }, 404);

  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.publishedVersion));
  return c.json({
    meta: record.meta,
    value: published.value,
    etag: record.etag,
  });
});

slugApp.get("/:slug", readCurrentBySlug, async (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json(record);
});

slugApp.on("GET", ["/:slug/value", "/:slug/value/*"], readCurrentBySlug, (c) => {
  const record = c.get("bin");
  if (!record) return c.json({ error: "not_found" }, 404);
  const path = valuePath(c.req.url);
  const value = readValue(record.value, path);
  c.header("ETag", record.etag);
  c.header("X-JSONBin-Version", String(record.meta.currentVersion));
  return c.json({ id: record.meta.id, slug: record.meta.slug, path, value, etag: record.etag, version: record.meta.currentVersion });
});

export default app;
