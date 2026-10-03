import { version } from '../../../package.json';
import { type BusinessStats, type ProbeStatus, type SystemInfo } from '../../shared/system.ts';
async function probe(binding: unknown, read: () => Promise<unknown>): Promise<ProbeStatus> {
  if (!binding) return 'unconfigured';
  try { await read(); return 'reachable'; } catch { return 'unavailable'; }
}
async function statistics(env: Env): Promise<SystemInfo['statistics']> {
  try {
    if (!env.DATA) throw new Error();
    const objects: R2Object[] = [];
    for (const prefix of ['bins/', 'trash/bins/', 'collections/', 'schemas/']) {
      let cursor: string | undefined;
      do { const page = await env.DATA.list({ prefix, cursor, limit: 1000 }); objects.push(...page.objects);
        if (objects.length > 10000) return { status: 'unavailable', error: 'statistics_limit_exceeded' };
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
    const metadata = objects.filter(o => /^(?:bins|trash\/bins|collections|schemas)\/[^/]+\/meta\.json$/.test(o.key));
    if (metadata.length > 500) return { status: 'unavailable', error: 'statistics_limit_exceeded' };
    const data: BusinessStats = { activeBins: 0, trashBins: 0, pendingImports: 0, collections: 0, schemas: 0, versions: 0, currentValueBytes: 0, storedBytes: 0 };
    data.storedBytes = objects.filter(o => /^(?:(?:bins|trash\/bins|collections|schemas)\/[^/]+\/meta\.json|(?:bins\/[^/]+\/versions|schemas\/[^/]+\/revisions)\/\d{6,}\.json)$/.test(o.key)).reduce((sum, o) => sum + o.size, 0);
    const keys = new Set(objects.map(o => o.key));
    for (const object of metadata) {
      const record = await env.DATA.get(object.key); if (!record) throw new Error();
      const meta = await record.json<Record<string, unknown>>();
      if (!meta || typeof meta !== 'object') throw new Error();
      if (object.key.startsWith('trash/') && keys.has(object.key.slice(6))) continue;
      const prefix = object.key.slice(0, -9);
      const files = objects.filter(o => o.key.startsWith(object.key.startsWith("trash/") ? prefix.slice(6) : prefix));
      if (meta.importState === 'pending') { data.pendingImports++; continue; }
      if (object.key.startsWith('bins/') || object.key.startsWith('trash/')) {
        if (meta.purgeState === 'purged') continue;
        if (meta.deletedAt || (typeof meta.expiresAt === 'string' && Date.parse(meta.expiresAt) <= Date.now())) data.trashBins++; else data.activeBins++;
        data.currentValueBytes += typeof meta.size === 'number' ? meta.size : 0;
        data.versions += files.filter(o => /\/versions\/\d{6,}\.json$/.test(o.key)).length;
      } else if (meta.status === 'active') { if (object.key.startsWith('collections/')) data.collections++; else data.schemas++; }
    }
    return { status: 'available', data };
  } catch { return { status: 'unavailable', error: 'storage_unavailable' }; }
}
export async function getSystemInfo(env: Env): Promise<SystemInfo> {
  const [r2, kv, stats] = await Promise.all([probe(env.DATA, () => env.DATA!.head('system/settings.json')), probe(env.CACHE, () => env.CACHE!.get('system/read-probe')), statistics(env)]);
  return { service: 'jsonbin', runtime: 'cloudflare-workers', version, checkedAt: new Date().toISOString(), storage: { r2, kv }, oauth: { githubConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_ALLOWED_USER_ID) }, statistics: stats };
}
