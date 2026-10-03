import { fingerprintResource, validateBackup } from '../../../shared/backup.ts';
import type { BackupPackage, RestoreRequest, RestoreResource, RestoreResult } from '../../../shared/backup-types.ts';
import { SystemApiError, type SystemClient } from './api.ts';
export async function buildRestoreRequests(input: BackupPackage): Promise<RestoreRequest[]> {
  const p = validateBackup(input), resources: RestoreResource[] = [ ...p.collections.map(data => ({ kind: 'collection' as const, data })), ...p.schemas.map(data => ({ kind: 'schema' as const, data })), ...p.bins.map(data => ({ kind: 'bin' as const, data })), ...p.purged.map(data => ({ kind: 'purged' as const, data })) ];
  const fingerprints = new Map<string, string>();
  for (const r of resources) fingerprints.set(`${r.kind}/${r.kind === 'purged' ? r.data.id : r.data.meta.id}`, await fingerprintResource(r));
  return resources.map(resource => ({ resource, dependencies: resource.kind !== 'bin' ? [] : (['collection', 'schema'] as const).flatMap(kind => {
    const id = resource.data.meta[kind === 'collection' ? 'collectionId' : 'schemaId']; return id ? [{ kind, id, fingerprint: fingerprints.get(`${kind}/${id}`)! }] : [];
  }) }));
}
export async function runRestore(backup: BackupPackage, client: SystemClient, onResult: (r: RestoreResult) => void, signal?: AbortSignal): Promise<RestoreResult[]> {
  const requests = await buildRestoreRequests(backup), results: RestoreResult[] = [], done = new Map<string, RestoreResult>();
  for (const request of requests) {
    if (signal?.aborted) break;
    const r = request.resource, id = r.kind === 'purged' ? r.data.id : r.data.meta.id;
    let result: RestoreResult;
    if (request.dependencies.some(d => !['created', 'unchanged'].includes(done.get(`${d.kind}/${d.id}`)?.status ?? 'failed'))) result = { kind: r.kind, id, status: 'dependency_skipped', error: 'restore_dependency_conflict' };
    else {
      try { result = await client.restoreResource(request, signal); }
      catch (error) {
        if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') break;
        result = { kind: r.kind, id, status: error instanceof SystemApiError && error.code === 'restore_dependency_conflict' ? 'dependency_skipped' : 'failed', error: error instanceof SystemApiError ? error.status === 0 ? 'network_error' : error.code : 'request_failed' };
      }
    }
    results.push(result); done.set(`${r.kind}/${id}`, result); onResult(result);
  }
  return results;
}
