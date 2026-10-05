import { requireDataBucket } from "./r2";
import { getJson, putJson } from "./r2";
import { SchemaError, assertSchemaValue } from "../validation/schema";
import { getSchema } from "./schemas";

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
      if (stored?.value) list.push(stored.value);
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
  },
): Promise<TemplateRecord> {
  const bucket = requireDataBucket(env);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  let schemaRevision: number | null = null;
  if (input.schemaId) {
    const schemaRecord = await getSchema(env, input.schemaId);
    if (!schemaRecord) throw new SchemaError("schema_unavailable");
    assertSchemaValue(schemaRecord.schema, input.value);
    schemaRevision = schemaRecord.meta.currentRevision;
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
    nextVersion += 1;
    await putJson(bucket, templateVersionKey(id, nextVersion), nextValue);
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

  const metaObject = await putJson(bucket, templateMetaKey(id), meta);
  return {
    meta,
    value: nextValue,
    etag: metaObject.etag,
  };
}

export async function deleteTemplate(env: Env, id: string, ifMatch?: string): Promise<{ ok: true }> {
  const current = await getTemplate(env, id);
  if (!current) throw new Error("not_found");
  if (ifMatch && current.etag !== ifMatch && `"${current.etag}"` !== ifMatch && current.etag !== `"${ifMatch}"`) {
    throw new Error("etag_conflict");
  }

  const bucket = requireDataBucket(env);
  for (let v = 1; v <= current.meta.currentVersion; v++) {
    await bucket.delete(templateVersionKey(id, v));
  }
  await bucket.delete(templateMetaKey(id));
  return { ok: true };
}
