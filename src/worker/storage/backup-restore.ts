import { syncSearchResource } from './search';
import { readBackupJson } from './backup-json';
import { SystemError } from '../../shared/system.ts';
import { canonicalJson, fingerprintResource, isImportMarker, validateImportMarker, validateRestoreRequest } from '../../shared/backup.ts';
import type { BackupBinMeta, BackupCollection, BackupSchema, RestoreRequest, RestoreResource, RestoreResult } from '../../shared/backup-types.ts';
import { assertSchemaDefinition, assertSchemaValue, type JsonSchema } from '../../shared/schema-validation.ts';
import { historyKey } from './backup-export';
import { putJson, requireDataBucket } from './r2';
import { normalizeEtag } from './bin-state';
import { detachBinFromCollection, getCollection } from './collections';
const conflict = () => new SystemError(409, 'restore_conflict');
const dependencyConflict = () => new SystemError(409, 'restore_dependency_conflict');
const namespace = (kind: RestoreResource['kind']) => kind === 'collection' ? 'collections' : kind === 'schema' ? 'schemas' : 'bins';
async function objects(bucket: R2Bucket, prefix: string) {
  const result: R2Object[] = []; let cursor: string | undefined;
  do { const page = await bucket.list({ prefix, cursor, limit: 250 }); result.push(...page.objects); if (result.length > 250) throw conflict(); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  return result;
}
async function read(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key); if (!object) return null;
  try { return { object, value: await readBackupJson(object) as Record<string, unknown> }; }
  catch (error) { if (error instanceof SystemError) throw conflict(); throw error; }
}
async function checkDependencies(bucket: R2Bucket, input: RestoreRequest) {
  for (const dependency of input.dependencies) {
    const prefix = `${namespace(dependency.kind)}/${dependency.id}/`, record = await read(bucket, prefix + 'meta.json');
    if (!record || isImportMarker(record.value) || record.object.customMetadata?.restoreFingerprint !== dependency.fingerprint) throw dependencyConflict();
    let resource: RestoreResource;
    if (dependency.kind === 'collection') resource = { kind: 'collection', data: { meta: record.value } as BackupCollection };
    else {
      const revisions: BackupSchema['revisions'] = [];
      const order = new Map<number, number>();
      for (const file of await objects(bucket, prefix)) {
        if (file.key === prefix + 'meta.json') continue;
        const revision = Number(file.key.slice((prefix + 'revisions/').length, -5));
        if (!Number.isSafeInteger(revision) || revision < 1 || file.key !== historyKey('schema', dependency.id, revision)) throw dependencyConflict();
        const stored = await read(bucket, file.key); if (!stored) throw dependencyConflict();
        const position = stored.object.customMetadata?.restoreOrder;
        if (position === undefined || !/^(0|[1-9]\d*)$/.test(position) || Number(position) >= 250) throw dependencyConflict();
        order.set(revision, Number(position));
        revisions.push({ revision, uploadedAt: stored.object.customMetadata?.originalUploadedAt ?? stored.object.uploaded.toISOString(), schema: stored.value as JsonSchema });
      }
      revisions.sort((a, b) => order.get(a.revision)! - order.get(b.revision)!);
      if (revisions.some((r, index) => order.get(r.revision) !== index)) throw dependencyConflict();
      resource = { kind: 'schema', data: { meta: record.value, revisions } as BackupSchema };
      if (input.resource.kind === 'bin') {
        const bin = input.resource.data, pinned = revisions.find(r => r.revision === bin.meta.schemaRevision);
        if (!pinned) throw dependencyConflict();
        try { assertSchemaDefinition(pinned.schema); assertSchemaValue(pinned.schema, bin.versions.find(v => v.version === bin.meta.currentVersion)!.value); } catch { throw dependencyConflict(); }
      }
    }
    // Receipts alone do not authorize changed metadata or changed model files.
    if (await fingerprintResource(resource) !== dependency.fingerprint) throw dependencyConflict();
    if ((await bucket.head(prefix + 'meta.json'))?.etag !== record.object.etag) throw dependencyConflict();
  }
}
async function cleanupCollection(env: Env, input: RestoreRequest, result: RestoreResult): Promise<RestoreResult> {
  if (input.resource.kind !== 'bin' || !input.resource.data.meta.collectionId) return result;
  const { id, collectionId } = input.resource.data.meta;
  try {
    if ((await getCollection(env, collectionId))?.meta.status !== 'active' && await detachBinFromCollection(env, id, collectionId)) result.warnings = ['collection_detached'];
  } catch { result.warnings = ['collection_cleanup_failed']; }
  return result;
}
export async function restoreResource(env: Env, raw: RestoreRequest): Promise<RestoreResult> {
  const input = validateRestoreRequest(raw), resource = input.resource, id = resource.kind === 'purged' ? resource.data.id : resource.data.meta.id;
  const result = (status: RestoreResult['status']): RestoreResult => ({ kind: resource.kind, id, status });
  try {
    const bucket = requireDataBucket(env), prefix = `${namespace(resource.kind)}/${id}/`, key = prefix + 'meta.json', fingerprint = await fingerprintResource(resource);
    let record = await read(bucket, key);
    async function existing() {
      if (record && !isImportMarker(record.value)) return record.object.customMetadata?.restoreFingerprint === fingerprint ? cleanupCollection(env, input, result('unchanged')) : result('skipped');
      if (record) {
        const marker = validateImportMarker(record.value);
        if (marker.fingerprint !== fingerprint || marker.kind !== resource.kind || marker.id !== id) return result('skipped');
      }
      return null;
    }
    const first = await existing(); if (first) return first;
    if (!record) {
      if ((await bucket.list({ prefix, limit: 1 })).objects.length || ((resource.kind === 'bin' || resource.kind === 'purged') && (await bucket.list({ prefix: `trash/bins/${id}/`, limit: 1 })).objects.length)) return result('skipped');
      await checkDependencies(bucket, input);
      const marker = { importState: 'pending', kind: resource.kind, id, fingerprint, startedAt: new Date().toISOString() };
      await putJson(bucket, key, marker, { onlyIf: { etagDoesNotMatch: '*' } });
      record = await read(bucket, key); if (!record) throw conflict();
      const raced = await existing(); if (raced) return raced;
    }
    const files = resource.kind === 'bin' ? resource.data.versions.map((v, order) => ({ order, key: historyKey('bin', id, v.version), value: v.value, uploadedAt: v.uploadedAt }))
      : resource.kind === 'schema' ? resource.data.revisions.map((v, order) => ({ order, key: historyKey('schema', id, v.revision), value: v.schema, uploadedAt: v.uploadedAt })) : [];
    const expected = new Set([key, ...files.map(v => v.key)]);
    async function checkFiles(complete: boolean) {
      const stored = await objects(bucket, prefix);
      if (stored.some(o => !expected.has(o.key)) || (complete && stored.length !== expected.size) || ((resource.kind === 'bin' || resource.kind === 'purged') && (await bucket.list({ prefix: `trash/bins/${id}/`, limit: 1 })).objects.length)) throw conflict();
    }
    await checkFiles(false); await checkDependencies(bucket, input);
    for (const file of files) {
      record = await read(bucket, key); if (!record) throw conflict(); const changed = await existing(); if (changed) return changed;
      const written = await bucket.put(file.key, JSON.stringify(file.value), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, onlyIf: { etagDoesNotMatch: '*' }, customMetadata: { originalUploadedAt: file.uploadedAt, restoreOrder: String(file.order) } });
      const stored = await read(bucket, file.key);
      if (!stored || canonicalJson(stored.value) !== canonicalJson(file.value) || stored.object.customMetadata?.originalUploadedAt !== file.uploadedAt || stored.object.customMetadata?.restoreOrder !== String(file.order)) throw conflict();
      // A concurrent publisher may already have been permanently deleted. Remove only our late conditional creation.
      if (written && (resource.kind === 'bin' || resource.kind === 'purged')) {
        const latest = await read(bucket, key);
        if (latest?.value.purgeState === 'purged') { await bucket.delete(file.key); return result('skipped'); }
      }
    }
    await checkFiles(true); await checkDependencies(bucket, input);
    record = await read(bucket, key); if (!record) throw conflict(); const completed = await existing(); if (completed) return completed;
    const rawMeta = resource.kind === 'purged' ? { ...resource.data, purgeState: 'purged' }
      : resource.kind === 'bin' ? { ...resource.data.meta, size: new TextEncoder().encode(JSON.stringify(resource.data.versions.find(v => v.version === resource.data.meta.currentVersion)!.value)).length, lifecycleId: crypto.randomUUID() } : resource.data.meta;

    // Handle slug restoration with collision fallback (15.1)
    let meta = rawMeta;
    if (resource.kind === 'bin') {
      const binMeta = rawMeta as BackupBinMeta & { lifecycleId: string };
      if (binMeta.slug) {
        const slug = binMeta.slug;
        const aliasKey = `aliases/bins/${slug}.json`;
        const claimed = await putJson(bucket, aliasKey, { slug, binId: id, createdAt: new Date().toISOString() }, {
          onlyIf: { etagDoesNotMatch: '*' },
        });
        if (!claimed) {
          // Detach slug to preserve primary bin recovery without collision overwrite
          meta = { ...binMeta, slug: null };
        }
      }
    }

    const published = await putJson(bucket, key, meta, { onlyIf: { etagMatches: normalizeEtag(record.object.httpEtag) }, customMetadata: { restoreFingerprint: fingerprint } });
    if (published) {
      await syncSearchResource(env, resource.kind === 'purged' ? 'bin' : resource.kind, id);
      return cleanupCollection(env, input, result('created'));
    }
    record = await read(bucket, key); const winner = await existing(); if (winner) return winner; throw conflict();
  } catch (error) { if (error instanceof SystemError) throw error; throw new SystemError(503, 'storage_unavailable'); }
}
