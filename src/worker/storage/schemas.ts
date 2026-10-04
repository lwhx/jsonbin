import { syncSearchResource } from './search';
import { isImportMarker } from '../../shared/backup.ts';
import type { ImportMarker } from '../../shared/backup-types.ts';
import { getJson, putJson, listJsonObjects, requireDataBucket } from "./r2";
import { assertSchemaDefinition, assertSchemaValue, SchemaError, type JsonSchema } from "../validation/schema";

export type SchemaMeta = { id: string; name: string; description: string; currentRevision: number;
  createdAt: string; updatedAt: string; status: "active" | "deleted" };
export type SchemaRecord = { meta: SchemaMeta; schema: JsonSchema; etag: string };
export type SchemaInput = { name: string; description?: string; schema: JsonSchema };
const metaKey = (id: string) => `schemas/${id}/meta.json`;
const revisionKey = (id: string, revision: number) => `schemas/${id}/revisions/${String(revision).padStart(6, "0")}.json`;
const normalize = (etag: string) => etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
export async function listSchemas(env: Env) {
  return (await listJsonObjects<SchemaMeta | ImportMarker>(requireDataBucket(env), "schemas/")).filter((meta): meta is SchemaMeta => !isImportMarker(meta) && meta.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function getSchema(env: Env, id: string): Promise<SchemaRecord | null> {
  const bucket = requireDataBucket(env), stored = await getJson<SchemaMeta | ImportMarker>(bucket, metaKey(id));
  if (!stored || isImportMarker(stored.value) || stored.value.status !== "active") return null;
  const revision = await getJson<JsonSchema>(bucket, revisionKey(id, stored.value.currentRevision));
  if (!revision) throw new Error("schema_revision_missing");
  return { meta: stored.value, schema: revision.value, etag: stored.etag };
}
export async function createSchema(env: Env, input: SchemaInput): Promise<SchemaRecord> {
  assertSchemaDefinition(input.schema);
  const bucket = requireDataBucket(env), now = new Date().toISOString();
  const meta: SchemaMeta = { id: crypto.randomUUID(), name: input.name, description: input.description ?? "",
    currentRevision: 1, createdAt: now, updatedAt: now, status: "active" };
  await putJson(bucket, revisionKey(meta.id, 1), input.schema);
  const stored = await putJson(bucket, metaKey(meta.id), meta);
  await syncSearchResource(env, 'schema', meta.id);
  return { meta, schema: input.schema, etag: stored.httpEtag };
}
export async function updateSchema(env: Env, id: string, input: SchemaInput, etag: string) {
  const current = await getSchema(env, id); if (!current) return null;
  if (normalize(current.etag) !== normalize(etag)) throw new Error("etag_conflict");
  assertSchemaDefinition(input.schema);
  const bucket = requireDataBucket(env);
  let revision = current.meta.currentRevision + 1, cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `schemas/${id}/revisions/`, cursor });
    for (const object of page.objects) {
      const number = Number(object.key.split("/").pop()?.replace(/\.json$/, ""));
      if (Number.isSafeInteger(number)) revision = Math.max(revision, number + 1);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  let reserved = false;
  for (let attempt = 0; attempt < 8; attempt++, revision++) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision_limit_reached");
    if (await putJson(bucket, revisionKey(id, revision), input.schema, { onlyIf: { etagDoesNotMatch: "*" } })) { reserved = true; break; }
  }
  if (!reserved) throw new Error("etag_conflict");
  const meta: SchemaMeta = { ...current.meta, name: input.name, description: input.description ?? "",
    currentRevision: revision, updatedAt: new Date().toISOString() };
  const stored = await putJson(bucket, metaKey(id), meta, { onlyIf: { etagMatches: normalize(current.etag) } });
  if (!stored) throw new Error("etag_conflict");
  await syncSearchResource(env, 'schema', id);
  return { meta, schema: input.schema, etag: stored.httpEtag };
}
export async function deleteSchema(env: Env, id: string, etag: string) {
  const current = await getSchema(env, id); if (!current) return false;
  if (normalize(current.etag) !== normalize(etag)) throw new Error("etag_conflict");
  // Archive the model; existing bindings continue to use their immutable revision.
  const stored = await putJson(requireDataBucket(env), metaKey(id), { ...current.meta, status: "deleted", updatedAt: new Date().toISOString() },
    { onlyIf: { etagMatches: normalize(current.etag) } });
  if (!stored) throw new Error("etag_conflict");
  await syncSearchResource(env, 'schema', id);
  return true;
}
export async function resolveSchemaBinding(env: Env, id: string | null | undefined, value: unknown) {
  if (!id) return { schemaId: null, schemaRevision: null };
  const record = await getSchema(env, id);
  if (!record) throw new SchemaError("schema_unavailable");
  assertSchemaValue(record.schema, value);
  return { schemaId: id, schemaRevision: record.meta.currentRevision };
}
export async function assertBoundSchema(env: Env, binding: { schemaId: string | null; schemaRevision?: number | null }, value: unknown) {
  if (!binding.schemaId) return;
  if (!binding.schemaRevision) throw new Error("schema_revision_missing");
  const stored = await getJson<JsonSchema>(requireDataBucket(env), revisionKey(binding.schemaId, binding.schemaRevision));
  if (!stored) throw new Error("schema_revision_missing");
  assertSchemaValue(stored.value, value);
}
