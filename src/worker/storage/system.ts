import { version } from '../../../package.json';
import { type BusinessStats, type ProbeStatus, type SystemInfo } from '../../shared/system.ts';
async function probe(binding: unknown, read: () => Promise<unknown>): Promise<ProbeStatus> {
  if (!binding) return 'unconfigured';
  try { await read(); return 'reachable'; } catch { return 'unavailable'; }
}
const STATISTICS_SCAN_LIMIT = 10000;
const STATISTICS_METADATA_LIMIT = 500;
const METADATA_READ_CONCURRENCY = 8;
async function statistics(env: Env): Promise<SystemInfo['statistics']> {
  try {
    if (!env.DATA) throw new Error();
    const bucket = env.DATA;
    // Prefix listings run concurrently; the shared scan budget still caps total work.
    const objects: R2Object[] = [];
    let overflow = false;
    await Promise.all(['bins/', 'trash/bins/', 'collections/', 'schemas/'].map(prefix => (async () => {
      let cursor: string | undefined;
      do {
        if (overflow) return;
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        objects.push(...page.objects);
        if (objects.length > STATISTICS_SCAN_LIMIT) { overflow = true; return; }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    })()));
    if (overflow) return { status: 'unavailable', error: 'statistics_limit_exceeded' };
    const metadata = objects.filter(o => /^(?:bins|trash\/bins|collections|schemas)\/[^/]+\/meta\.json$/.test(o.key));
    if (metadata.length > STATISTICS_METADATA_LIMIT) return { status: 'unavailable', error: 'statistics_limit_exceeded' };
    const data: BusinessStats = { activeBins: 0, trashBins: 0, pendingImports: 0, collections: 0, schemas: 0, versions: 0, currentValueBytes: 0, storedBytes: 0 };
    data.storedBytes = objects.filter(o => /^(?:(?:bins|trash\/bins|collections|schemas)\/[^/]+\/meta\.json|(?:bins\/[^/]+\/versions|schemas\/[^/]+\/revisions)\/\d{6,}\.json)$/.test(o.key)).reduce((sum, o) => sum + o.size, 0);
    const keys = new Set(objects.map(o => o.key));
    // Metadata bodies are read with bounded concurrency, then folded in listing
    // order so counters and the missing/invalid "unavailable" outcome match a
    // sequential walk.
    const bodies = new Array<Record<string, unknown> | null>(metadata.length).fill(null);
    for (let start = 0; start < metadata.length; start += METADATA_READ_CONCURRENCY) {
      const loaded = await Promise.all(metadata.slice(start, start + METADATA_READ_CONCURRENCY)
        .map(object => bucket.get(object.key).then(record => record ? record.json<Record<string, unknown>>().catch(() => null) : null)));
      loaded.forEach((body, offset) => { bodies[start + offset] = body; });
    }
    for (let index = 0; index < metadata.length; index++) {
      const object = metadata[index], meta = bodies[index];
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
