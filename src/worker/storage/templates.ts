import { requireDataBucket } from "./r2";
import { getJson, putJson } from "./r2";
import { isImportMarker } from "../../shared/backup.ts";
import { SchemaError, assertSchemaValue } from "../validation/schema";
import { getSchema, assertBoundSchema } from "./schemas";
import { normalizeEtag } from "./bin-state";

export type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  currentVersion: number;
  tags: string[];
  schemaId: string | null;
  schemaRevision: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type TemplateRecord = {
  meta: TemplateMeta;
  value: unknown;
  etag: string;
};

export function templateMetaKey(id: string): string {
  return `templates/${id}/meta.json`;
}

export function templateVersionKey(id: string, version: number): string {
  return `templates/${id}/versions/${String(version).padStart(6, "0")}.json`;
}

export async function getTemplate(env: Env, id: string): Promise<TemplateRecord | null> {
  const bucket = requireDataBucket(env);
  const metaObj = await bucket.get(templateMetaKey(id));
  if (!metaObj) return null;

  const meta = (await metaObj.json()) as TemplateMeta;
  // A tombstoned template is being removed or is a pending restore import marker.
  if (!meta || meta.deletedAt || isImportMarker(meta)) return null;

  const valueObj = await bucket.get(templateVersionKey(id, meta.currentVersion));
  const value = valueObj ? await valueObj.json() : null;

  return {
    meta,
    value,
    etag: metaObj.etag,
  };
}

export async function listTemplates(env: Env): Promise<TemplateMeta[]> {
  const bucket = requireDataBucket(env);
  const list: TemplateMeta[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({ prefix: "templates/", cursor, limit: 1000 });
    const metaKeys = page.objects.map(o => o.key).filter(k => k.endsWith("/meta.json"));
    for (const k of metaKeys) {
      const stored = await getJson<TemplateMeta>(bucket, k);
      if (stored?.value && !isImportMarker(stored.value) && !stored.value.deletedAt) list.push(stored.value);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createTemplate(
  env: Env,
  input: {
    name: string;
    description?: string;
    tags?: string[];
    value: unknown;
    schemaId?: string | null;
    schemaRevision?: number | null;
  },
): Promise<TemplateRecord> {
  const bucket = requireDataBucket(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  let schemaRevision: number | null = null;
  if (input.schemaId) {
    const schemaRecord = await getSchema(env, input.schemaId);
    if (!schemaRecord) throw new SchemaError("schema_unavailable");
    if (input.schemaRevision) {
      // Pin the template to the exact revision the caller captured.
      await assertBoundSchema(env, { schemaId: input.schemaId, schemaRevision: input.schemaRevision }, input.value);
      schemaRevision = input.schemaRevision;
    } else {
      assertSchemaValue(schemaRecord.schema, input.value);
      schemaRevision = schemaRecord.meta.currentRevision;
    }
  }

  const meta: TemplateMeta = {
    id,
    name: input.name.trim(),
    description: input.description?.trim() ?? "",
    currentVersion: 1,
    tags: Array.isArray(input.tags) ? input.tags.map(t => t.trim()).filter(Boolean) : [],
    schemaId: input.schemaId ?? null,
    schemaRevision,
    createdAt: now,
    updatedAt: now,
  };

  await putJson(bucket, templateVersionKey(id, 1), input.value);
  const metaObject = await putJson(bucket, templateMetaKey(id), meta);

  return {
    meta,
    value: input.value,
    etag: metaObject.etag,
  };
}

/** Reserve the next immutable version slot; concurrent writers never overwrite existing history. */
async function appendTemplateVersion(bucket: R2Bucket, id: string, currentVersion: number, value: unknown) {
  let nextVersion = currentVersion + 1;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `templates/${id}/versions/`, cursor });
    for (const object of page.objects) {
      const number = Number(object.key.split("/").pop()?.replace(/\.json$/, ""));
      if (Number.isSafeInteger(number)) nextVersion = Math.max(nextVersion, number + 1);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Never overwrite an existing version, including an orphan from a failed CAS.
  for (let attempt = 0; attempt < 8; attempt++, nextVersion++) {
    if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) throw new Error("version_limit_reached");
    const written = await putJson(bucket, templateVersionKey(id, nextVersion), value, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written) return nextVersion;
  }
  throw new Error("etag_conflict");
}

export async function updateTemplate(
  env: Env,
  id: string,
  input: {
    name?: string;
    description?: string;
    tags?: string[];
    value?: unknown;
    schemaId?: string | null;
  },
  ifMatch?: string,
): Promise<TemplateRecord> {
  const current = await getTemplate(env, id);
  if (!current) throw new Error("not_found");
  if (ifMatch && current.etag !== ifMatch && `"${current.etag}"` !== ifMatch && current.etag !== `"${ifMatch}"`) {
    throw new Error("etag_conflict");
  }

  const bucket = requireDataBucket(env);
  const now = new Date().toISOString();
  const nextValue = input.value !== undefined ? input.value : current.value;

  let schemaId = current.meta.schemaId;
  let schemaRevision = current.meta.schemaRevision;

  if (input.schemaId !== undefined) {
    if (input.schemaId) {
      const schemaRecord = await getSchema(env, input.schemaId);
      if (!schemaRecord) throw new SchemaError("schema_unavailable");
      assertSchemaValue(schemaRecord.schema, nextValue);
      schemaId = input.schemaId;
      schemaRevision = schemaRecord.meta.currentRevision;
    } else {
      schemaId = null;
      schemaRevision = null;
    }
  } else if (schemaId) {
    const schemaRecord = await getSchema(env, schemaId);
    if (schemaRecord) {
      assertSchemaValue(schemaRecord.schema, nextValue);
    }
  }

  let nextVersion = current.meta.currentVersion;
  if (input.value !== undefined) {
    nextVersion = await appendTemplateVersion(bucket, id, current.meta.currentVersion, nextValue);
  }

  const meta: TemplateMeta = {
    ...current.meta,
    name: input.name !== undefined ? input.name.trim() : current.meta.name,
    description: input.description !== undefined ? input.description.trim() : current.meta.description,
    tags: input.tags !== undefined ? input.tags.map(t => t.trim()).filter(Boolean) : current.meta.tags,
    schemaId,
    schemaRevision,
    currentVersion: nextVersion,
    updatedAt: now,
  };

  // Commit the meta pointer against the snapshot that was validated above; the
  // possibly-orphaned version file left by a lost race is harmless.
  const metaObject = await putJson(bucket, templateMetaKey(id), meta, {
    onlyIf: { etagMatches: normalizeEtag(current.etag) },
  });
  if (!metaObject) throw new Error("etag_conflict");
  return {
    meta,
    value: nextValue,
    etag: metaObject.httpEtag,
  };
}

export async function deleteTemplate(env: Env, id: string, ifMatch?: string): Promise<{ ok: true }> {
  const current = await getTemplate(env, id);
  if (!current) throw new Error("not_found");
  if (ifMatch && current.etag !== ifMatch && `"${current.etag}"` !== ifMatch && current.etag !== `"${ifMatch}"`) {
    throw new Error("etag_conflict");
  }

  const bucket = requireDataBucket(env);
  // CAS tombstone first: a concurrent update that changes meta.json makes this
  // claim fail, so deletion can never destroy a freshly committed new version.
  const tombstoned = await putJson(bucket, templateMetaKey(id), {
    ...current.meta, deletedAt: new Date().toISOString(),
  }, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!tombstoned) throw new Error("etag_conflict");

  for (let v = 1; v <= current.meta.currentVersion; v++) {
    await bucket.delete(templateVersionKey(id, v)).catch(() => {});
  }
  await bucket.delete(templateMetaKey(id));
  return { ok: true };
}
