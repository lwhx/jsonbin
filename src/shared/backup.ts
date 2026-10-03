import { z } from 'zod';
import { SystemError } from './system.ts';
import { assertSchemaDefinition, assertSchemaValue, type JsonSchema } from './schema-validation.ts';
import type { BackupPackage, RestoreRequest, RestoreResource, ImportMarker } from './backup-types.ts';
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_VALUE_BYTES = 1024 * 1024;
const uuid = z.string().uuid(), date = z.iso.datetime(), positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const common = { id: uuid, name: z.string().trim().min(1).max(160), description: z.string().max(1000), createdAt: date, updatedAt: date };
const defaults = z.object({ defaultVisibility: z.enum(['private', 'public']), defaultTtlSeconds: z.number().int().min(1).max(31536000).nullable() }).strict();
export const collectionMetaShape = z.object({ ...common, slug: z.string().min(1).max(240), status: z.enum(['active', 'deleted']) }).strict();
export const schemaMetaShape = z.object({ ...common, currentRevision: positive, status: z.enum(['active', 'deleted']) }).strict();
export const binMetaShape = z.object({ ...common, visibility: z.enum(['private', 'public']), collectionId: uuid.nullable(), schemaId: uuid.nullable(), schemaRevision: positive.nullable(), currentVersion: positive,
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), locked: z.boolean(), schemaLocked: z.boolean(), expiresAt: date.nullable(), deletedAt: date.optional(), deletionReason: z.enum(['manual', 'expired']).optional() }).strict();
const collection = z.object({ meta: collectionMetaShape }).strict();
const schema = z.object({ meta: schemaMetaShape, revisions: z.array(z.object({ revision: positive, uploadedAt: date, schema: z.unknown() }).strict()) }).strict();
const bin = z.object({ meta: binMetaShape, versions: z.array(z.object({ version: positive, uploadedAt: date, value: z.unknown() }).strict()) }).strict();
const purged = z.object({ id: uuid, deletedAt: date }).strict();
const resource = z.discriminatedUnion('kind', [z.object({ kind: z.literal('collection'), data: collection }).strict(), z.object({ kind: z.literal('schema'), data: schema }).strict(), z.object({ kind: z.literal('bin'), data: bin }).strict(), z.object({ kind: z.literal('purged'), data: purged }).strict()]);
const packageShape = z.object({ format: z.literal('jsonbin-backup'), schemaVersion: z.literal(1), appVersion: z.string().min(1).max(100), exportedAt: date,
  scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('all') }).strict(), z.object({ kind: z.literal('config') }).strict(), z.object({ kind: z.literal('bin'), id: uuid }).strict()]),
  settings: defaults, collections: z.array(collection), schemas: z.array(schema), bins: z.array(bin), purged: z.array(purged) }).strict();
function invalid(): never { throw new SystemError(422, 'validation_failed'); }
export function validateBusinessValue(value: unknown): void {
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number) {
    if (depth > 64) invalid();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid(); return; }
    if (typeof v !== 'object' || ancestors.has(v)) invalid();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) invalid();
    ancestors.add(v); for (const child of Object.values(v)) visit(child, depth + 1); ancestors.delete(v);
  }
  visit(value, 0);
}
export function assertBytes(value: unknown, max = MAX_BACKUP_BYTES) {
  let text: string | undefined; try { text = JSON.stringify(value); } catch { invalid(); }
  if (text === undefined) invalid();
  if (new TextEncoder().encode(text).length > max) throw new SystemError(413, 'payload_too_large');
}
function unique(values: (number | string)[]) { if (new Set(values).size !== values.length) invalid(); }
function checkResource(r: RestoreResource) {
  if (r.kind === 'schema') {
    const { meta, revisions } = r.data; unique(revisions.map(v => v.revision));
    if (!revisions.some(v => v.revision === meta.currentRevision)) invalid();
    for (const v of revisions) { validateBusinessValue(v.schema); try { assertSchemaDefinition(v.schema); } catch { invalid(); } }
  }
  if (r.kind === 'bin') {
    const { meta, versions } = r.data; unique(versions.map(v => v.version));
    if (!versions.some(v => v.version === meta.currentVersion) || (meta.schemaId === null) !== (meta.schemaRevision === null) || (meta.schemaLocked && !meta.schemaId) || Boolean(meta.deletedAt) !== Boolean(meta.deletionReason)) invalid();
    for (const v of versions) { if (!Object.hasOwn(v, 'value')) invalid(); validateBusinessValue(v.value); }
  }
}
export function validateBackup(value: unknown): BackupPackage {
  assertBytes(value);
  const parsed = packageShape.safeParse(value); if (!parsed.success) invalid();
  const p = parsed.data as BackupPackage;
  const count = p.collections.length + p.schemas.length + p.bins.length + p.purged.length;
  if (count > 100 || count + 1 + p.schemas.reduce((n, s) => n + s.revisions.length, 0) + p.bins.reduce((n, b) => n + b.versions.length, 0) > 250) throw new SystemError(413, 'payload_too_large');
  unique(p.collections.map(v => v.meta.id)); unique(p.schemas.map(v => v.meta.id)); unique([...p.bins.map(v => v.meta.id), ...p.purged.map(v => v.id)]);
  for (const s of p.schemas) checkResource({ kind: 'schema', data: s });
  for (const b of p.bins) {
    checkResource({ kind: 'bin', data: b });
    if (b.meta.collectionId && !p.collections.some(c => c.meta.id === b.meta.collectionId)) invalid();
    if (b.meta.schemaId) {
      const revision = p.schemas.find(s => s.meta.id === b.meta.schemaId)?.revisions.find(r => r.revision === b.meta.schemaRevision);
      if (!revision) invalid();
      try { assertSchemaValue(revision.schema, b.versions.find(v => v.version === b.meta.currentVersion)!.value); } catch { invalid(); }
    }
  }
  if (p.scope.kind === 'config' && count !== 0) invalid();
  if (p.scope.kind === 'bin') {
    const id = p.scope.id, b = p.bins.find(b => b.meta.id === id);
    if (!b || p.bins.length !== 1 || p.purged.length || p.collections.length !== (b.meta.collectionId ? 1 : 0) || p.schemas.length !== (b.meta.schemaId ? 1 : 0)) invalid();
  }
  return p;
}
export function validateRestoreRequest(value: unknown): RestoreRequest {
  assertBytes(value);
  const parsed = z.object({ resource, dependencies: z.array(z.object({ kind: z.enum(['collection', 'schema']), id: uuid, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(2) }).strict().safeParse(value);
  if (!parsed.success) invalid();
  const request = parsed.data as RestoreRequest, r = request.resource; checkResource(r);
  const objectCount = r.kind === 'bin' ? r.data.versions.length + 1 : r.kind === 'schema' ? r.data.revisions.length + 1 : 1;
  if (objectCount > 249) throw new SystemError(413, 'payload_too_large');
  const expected = r.kind === 'bin' ? [['collection', r.data.meta.collectionId], ['schema', r.data.meta.schemaId]].filter(([, id]) => id) : [];
  if (request.dependencies.length !== expected.length || expected.some(([kind, id]) => request.dependencies.filter(d => d.kind === kind && d.id === id).length !== 1)) invalid();
  return request;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function sha256(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)))].map(v => v.toString(16).padStart(2, '0')).join(''); }
export function fingerprintResource(r: RestoreResource): Promise<string> { return sha256(new TextEncoder().encode(canonicalJson(r))); }
export function isImportMarker(value: unknown): value is ImportMarker { return value !== null && typeof value === 'object' && (value as Record<string, unknown>).importState === 'pending'; }
export function validateImportMarker(value: unknown): ImportMarker {
  const parsed = z.object({ importState: z.literal('pending'), kind: z.enum(['collection', 'schema', 'bin', 'purged']), id: uuid, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), startedAt: date }).strict().safeParse(value);
  if (!parsed.success) throw new SystemError(409, 'restore_conflict'); return parsed.data;
}
export type { JsonSchema };
