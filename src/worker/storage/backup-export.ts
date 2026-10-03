import { version } from '../../../package.json';
import { SystemError, type ExportPayload, type ExportQuery } from '../../shared/system.ts';
import { MAX_BACKUP_BYTES, binMetaShape, collectionMetaShape, schemaMetaShape, validateBackup, isImportMarker } from '../../shared/backup.ts';
import type { BackupPackage, BackupBin, BackupSchema, BackupCollection } from '../../shared/backup-types.ts';
import { getSettings } from './settings';
import { requireDataBucket } from './r2';
const jsonType = 'application/json; charset=utf-8' as const;
const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const metaPattern = new RegExp(`^(bins|trash/bins|collections|schemas)/(${uuid})/meta\\.json$`);
export const historyKey = (kind: 'bin' | 'schema', id: string, number: number) => `${kind === 'bin' ? 'bins' : 'schemas'}/${id}/${kind === 'bin' ? 'versions' : 'revisions'}/${String(number).padStart(6, '0')}.json`;
async function list(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = []; let cursor: string | undefined;
  do { const page = await bucket.list({ prefix, cursor, limit: 1000, include: ['customMetadata'] }); objects.push(...page.objects);
    if (objects.length > 10000) throw new SystemError(413, 'payload_too_large'); cursor = page.truncated ? page.cursor : undefined;
  } while (cursor); return objects;
}
function project(value: Record<string, unknown>, keys: string[]) { return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])); }
export async function exportData(env: Env, query: ExportQuery): Promise<ExportPayload> {
  try {
    const bucket = requireDataBucket(env), settings = await getSettings(env);
    const p: BackupPackage = { format: 'jsonbin-backup', schemaVersion: 1, appVersion: version, exportedAt: new Date().toISOString(), scope: query.scope === 'bin' ? { kind: 'bin', id: query.id } : { kind: query.scope },
      settings: { defaultVisibility: settings.settings.defaultVisibility, defaultTtlSeconds: settings.settings.defaultTtlSeconds }, collections: [], schemas: [], bins: [], purged: [] };
    const checks: (() => Promise<void>)[] = []; let bytesRead = 0, objectCount = 1;
    async function read(key: string) {
      const object = await bucket.get(key); if (!object) throw new SystemError(409, 'backup_unavailable');
      bytesRead += object.size; if (bytesRead > MAX_BACKUP_BYTES || ++objectCount > 250) throw new SystemError(413, 'payload_too_large');
      let value: unknown; try { value = await object.json(); } catch { throw new SystemError(409, 'backup_unavailable'); }
      return { object, value };
    }
    async function capture(key: string) {
      const match = metaPattern.exec(key); if (!match) throw new SystemError(409, 'backup_unavailable');
      const [, namespace, id] = match, { object, value } = await read(key);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SystemError(409, 'backup_unavailable');
      const meta = value as Record<string, unknown>;
      if (meta.id !== id || isImportMarker(meta) || meta.purgeState === 'purging' || meta.status === 'deleting') throw new SystemError(409, 'backup_unavailable');
      const checkMeta = async () => {
        if ((await bucket.head(key))?.etag !== object.etag || (namespace === 'trash/bins' && await bucket.head(`bins/${id}/meta.json`))) throw new SystemError(409, 'backup_changed');
      };
      checks.push(checkMeta);
      if (namespace === 'collections') { const result = { meta: project(meta, Object.keys(collectionMetaShape.shape)) } as BackupCollection; p.collections.push(result); await checkMeta(); return; }
      if (meta.purgeState === 'purged') { p.purged.push({ id, deletedAt: meta.deletedAt as string }); await checkMeta(); return; }
      const kind = namespace === 'schemas' ? 'schema' : 'bin';
      const prefix = `${kind === 'schema' ? 'schemas' : 'bins'}/${id}/${kind === 'schema' ? 'revisions' : 'versions'}/`;
      const canonical = (objects: R2Object[]) => objects.filter(o => {
        const filename = o.key.slice(prefix.length), n = Number(filename.slice(0, -5));
        return /^\d{6,}\.json$/.test(filename) && Number.isSafeInteger(n) && n > 0 && o.key === historyKey(kind, id, n);
      }).sort((a, b) => a.key.localeCompare(b.key));
      const files = canonical(await list(bucket, prefix));
      if (objectCount + files.length > 250) throw new SystemError(413, 'payload_too_large');
      const snapshot = JSON.stringify(files.map(o => [o.key, o.etag]));
      checks.push(async () => { if (JSON.stringify(canonical(await list(bucket, prefix)).map(o => [o.key, o.etag])) !== snapshot) throw new SystemError(409, 'backup_changed'); });
      const history = [];
      for (const file of files) {
        const record = await read(file.key); if (record.object.etag !== file.etag) throw new SystemError(409, 'backup_changed');
        history.push({ number: Number(file.key.slice(prefix.length, -5)), uploadedAt: record.object.customMetadata?.originalUploadedAt ?? record.object.uploaded.toISOString(), value: record.value });
      }
      if (kind === 'schema') p.schemas.push({ meta: project(meta, Object.keys(schemaMetaShape.shape)), revisions: history.map(v => ({ revision: v.number, uploadedAt: v.uploadedAt, schema: v.value })) } as BackupSchema);
      else {
        const normalized: Record<string, unknown> = { collectionId: null, schemaId: null, schemaRevision: null, locked: false, schemaLocked: false, expiresAt: null, ...meta };
        if (meta.deletedAt && !meta.deletionReason) normalized.deletionReason = 'manual';
        const current = history.find(v => v.number === meta.currentVersion);
        if (!current) throw new SystemError(409, 'backup_unavailable');
        normalized.size = new TextEncoder().encode(JSON.stringify(current.value)).length;
        p.bins.push({ meta: project(normalized, Object.keys(binMetaShape.shape)), versions: history.map(v => ({ version: v.number, uploadedAt: v.uploadedAt, value: v.value })) } as BackupBin);
      }
      await checkMeta();
    }
    if (query.scope === 'all') {
      const keys = new Map<string, string>();
      for (const namespace of ['trash/bins/', 'bins/', 'collections/', 'schemas/']) for (const object of await list(bucket, namespace)) {
        const match = metaPattern.exec(object.key); if (!match) continue;
        keys.set(`${match[1] === 'trash/bins' ? 'bins' : match[1]}/${match[2]}`, object.key);
      }
      if (keys.size > 100) throw new SystemError(413, 'payload_too_large');
      for (const key of keys.values()) await capture(key);
    } else if (query.scope === 'bin') {
      const key = await bucket.head(`bins/${query.id}/meta.json`) ? `bins/${query.id}/meta.json` : `trash/bins/${query.id}/meta.json`;
      if (!await bucket.head(key)) throw new SystemError(404, 'not_found'); await capture(key);
      const bin = p.bins[0]; if (!bin) throw new SystemError(404, 'not_found');
      if (bin.meta.collectionId) await capture(`collections/${bin.meta.collectionId}/meta.json`);
      if (bin.meta.schemaId) await capture(`schemas/${bin.meta.schemaId}/meta.json`);
    }
    let validated: BackupPackage;
    try { validated = validateBackup(p); } catch (error) { if (error instanceof SystemError && error.status === 413) throw error; throw new SystemError(409, 'backup_unavailable'); }
    for (const check of checks) await check();
    if ((await getSettings(env)).etag !== settings.etag) throw new SystemError(409, 'backup_changed');
    const body = new TextEncoder().encode(JSON.stringify(query.format === 'value' ? validated.bins[0].versions.find(v => v.version === validated.bins[0].meta.currentVersion)!.value : validated));
    if (body.length > MAX_BACKUP_BYTES) throw new SystemError(413, 'payload_too_large');
    return { body, fileName: query.scope === 'bin' ? `jsonbin-${query.id}-${query.format}.json` : `jsonbin-${query.scope}-backup.json`, contentType: jsonType,
      activity: { action: query.scope === 'bin' ? 'bin.exported' : 'system.exported', resourceId: query.scope === 'bin' ? query.id : null } };
  } catch (error) { if (error instanceof SystemError) throw error; throw new SystemError(503, 'storage_unavailable'); }
}
