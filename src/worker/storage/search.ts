import type { SearchIndexStatus, SearchItem, SearchKind, SearchPage, SearchQuery } from '../../shared/search.ts';
import { SystemError } from '../../shared/system.ts';
import { isImportMarker } from '../../shared/backup.ts';
import { isActiveBin, type StoredBinMeta } from './bin-state';
import type { CollectionMeta } from './collections';
import type { SchemaMeta } from './schemas';
import { getJson, putJson, requireDataBucket } from './r2';

// KV is disposable. R2 object ETags detect missed mutations, and a trusted R2
// digest detects partial/corrupt KV snapshots before they can omit search hits.
const MANIFEST = 'indexes/search/meta.json';
const MAX_OBJECTS = 10000, MAX_RESOURCES = 200, MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const namespaces: Record<SearchKind, string> = { bin: 'bins', collection: 'collections', schema: 'schemas' };
type Entry = { key: string; etag: string; type: SearchKind; id: string };
type Inventory = { entries: Entry[]; hash: string };
type Manifest = { format: 1; generation: string; inventoryHash: string; contentHash: string; builtAt: string; count: number };
type IndexRow = SearchItem & { slug?: string };
type Snapshot = { format: 1; rows: IndexRow[] };
const snapshotKey = (generation: string) => `search:snapshot:${generation}`;
const indexKey = (type: SearchKind, id: string) => `idx:${type}:${id}`;
const metaKey = (type: SearchKind, id: string) => `${namespaces[type]}/${id}/meta.json`;
const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en-US');
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
async function inventory(env: Env): Promise<Inventory> {
  const bucket = requireDataBucket(env), entries: Entry[] = []; let scanned = 0;
  for (const type of ['bin', 'collection', 'schema'] as const) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `${namespaces[type]}/`, cursor, limit: 1000 });
      scanned += page.objects.length;
      if (scanned > MAX_OBJECTS) throw new SystemError(503, 'search_limit_exceeded');
      for (const object of page.objects) {
        const parts = object.key.split('/');
        if (parts.length === 3 && parts[2] === 'meta.json') entries.push({ key: object.key, etag: object.etag, type, id: parts[1] });
      }
      if (entries.length > MAX_RESOURCES) throw new SystemError(503, 'search_limit_exceeded');
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { entries, hash: await digest(JSON.stringify(entries)) };
}
async function readRow(env: Env, type: SearchKind, id: string): Promise<IndexRow | null> {
  const stored = await getJson<StoredBinMeta | CollectionMeta | SchemaMeta>(requireDataBucket(env), metaKey(type, id));
  if (!stored || isImportMarker(stored.value)) return null;
  const meta = stored.value;
  if (type === 'bin') {
    if (!isActiveBin(meta as StoredBinMeta)) return null;
    const bin = meta as Extract<StoredBinMeta, { name: string }>;
    return { type, id, name: bin.name, description: bin.description, updatedAt: bin.updatedAt, collectionId: bin.collectionId, expiresAt: bin.expiresAt };
  }
  if ((meta as CollectionMeta | SchemaMeta).status !== 'active') return null;
  return { type, id, name: (meta as CollectionMeta).name, description: (meta as CollectionMeta).description,
    updatedAt: (meta as CollectionMeta).updatedAt, ...(type === 'collection' ? { slug: (meta as CollectionMeta).slug } : {}) };
}
export async function syncSearchResource(env: Env, type: SearchKind, id: string): Promise<boolean> {
  if (!env.CACHE) return false;
  try {
    const row = await readRow(env, type, id);
    if (row) await env.CACHE.put(indexKey(type, id), JSON.stringify(row));
    else await env.CACHE.delete(indexKey(type, id));
    if (type === 'collection') {
      // Collection slugs are stable; archived collections retain the slug.
      const meta = row ? null : await getJson<CollectionMeta>(requireDataBucket(env), metaKey(type, id));
      const slug = row?.slug ?? (meta && !isImportMarker(meta.value) ? meta.value.slug : undefined);
      if (slug) { if (row) await env.CACHE.put(`idx:slug:${slug}`, id); else await env.CACHE.delete(`idx:slug:${slug}`); }
    }
    return true;
  } catch { console.error('search_index_sync_failed'); return false; }
}
async function scan(env: Env, entries: Entry[]) {
  const rows: IndexRow[] = [];
  // Bound concurrent R2 body reads, including rebuilds and degraded searches.
  for (let i = 0; i < entries.length; i += 16) {
    const batch = await Promise.all(entries.slice(i, i + 16).map(entry => readRow(env, entry.type, entry.id)));
    for (const row of batch) if (row) rows.push(row);
  }
  return rows;
}
async function manifest(env: Env) {
  const object = await requireDataBucket(env).get(MANIFEST);
  if (!object) return null;
  let value: Manifest = { format: 1, generation: '', inventoryHash: '', contentHash: '', builtAt: '', count: 0 };
  try {
    const parsed = await object.json<Manifest>();
    if (parsed?.format === 1 && typeof parsed.generation === 'string' && typeof parsed.inventoryHash === 'string'
      && typeof parsed.contentHash === 'string' && typeof parsed.builtAt === 'string' && Number.isSafeInteger(parsed.count) && parsed.count >= 0) value = parsed;
  } catch { /* Preserve the object's ETag so a corrupt derived manifest can be repaired with CAS. */ }
  return { value, etag: object.httpEtag };
}
async function cached(env: Env, record: Awaited<ReturnType<typeof manifest>>, hash: string): Promise<Snapshot | null> {
  if (!env.CACHE || !record || record.value.format !== 1 || record.value.inventoryHash !== hash) return null;
  try {
    const raw = await env.CACHE.get(snapshotKey(record.value.generation));
    if (!raw || new TextEncoder().encode(raw).length > MAX_SNAPSHOT_BYTES || await digest(raw) !== record.value.contentHash) return null;
    const value = JSON.parse(raw) as Snapshot;
    if (value.format !== 1 || !Array.isArray(value.rows) || value.rows.length !== record.value.count) return null;
    return value;
  } catch { return null; }
}
async function publish(env: Env, source: Inventory, rows: IndexRow[], previous: Awaited<ReturnType<typeof manifest>>) {
  if (!env.CACHE) throw new SystemError(503, 'search_index_unavailable');
  const raw = JSON.stringify({ format: 1, rows } satisfies Snapshot);
  if (new TextEncoder().encode(raw).length > MAX_SNAPSHOT_BYTES) throw new SystemError(503, 'search_limit_exceeded');
  const next: Manifest = { format: 1, generation: crypto.randomUUID(), inventoryHash: source.hash,
    contentHash: await digest(raw), builtAt: new Date().toISOString(), count: rows.length };
  await env.CACHE.put(snapshotKey(next.generation), raw, { expirationTtl: 86400 });
  // Recheck after KV upload. A late write only produces a stale, detectable cache.
  if ((await inventory(env)).hash !== source.hash) throw new SystemError(409, 'search_changed');
  const written = await putJson(requireDataBucket(env), MANIFEST, next, { onlyIf: previous
    ? { etagMatches: previous.etag.replace(/^"|"$/g, '') } : { etagDoesNotMatch: '*' } });
  if (!written) throw new SystemError(409, 'search_changed');
  return next;
}
export async function rebuildSearchIndex(env: Env): Promise<SearchIndexStatus> {
  if (!env.CACHE) throw new SystemError(503, 'search_index_unavailable');
  const before = await inventory(env), previous = await manifest(env), rows = await scan(env, before.entries);
  if ((await inventory(env)).hash !== before.hash) throw new SystemError(409, 'search_changed');
  // Reuse scanned rows, rather than reading every metadata body a second time.
  // 200 resources, at most two KV writes each and 200 abandoned-key deletes
  // leave room below the 1000 internal-service subrequest ceiling.
  try {
    for (const row of rows) {
      await env.CACHE.put(indexKey(row.type, row.id), JSON.stringify(row));
      if (row.slug) await env.CACHE.put(`idx:slug:${row.slug}`, row.id);
    }
  } catch { throw new SystemError(503, 'search_index_unavailable'); }
  const expected = new Set(rows.map(row => indexKey(row.type, row.id)));
  for (const row of rows) if (row.slug) expected.add(`idx:slug:${row.slug}`);
  // Remove abandoned derived rows, including ones whose R2 object was removed.
  let cursor: string | undefined, scanned = 0, removed = 0;
  do {
    const page = await env.CACHE.list({ prefix: 'idx:', cursor, limit: 1000 });
    scanned += page.keys.length;
    if (scanned > MAX_OBJECTS) throw new SystemError(503, 'search_limit_exceeded');
    for (const key of page.keys) if (/^idx:(bin|collection|schema|slug):/.test(key.name) && !expected.has(key.name)) {
      if (removed === 200) throw new SystemError(503, 'search_cleanup_limit_exceeded');
      await env.CACHE.delete(key.name); removed++;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const result = await publish(env, before, rows, previous);
  return { configured: true, available: true, current: true, builtAt: result.builtAt, count: result.count };
}
export async function searchIndexStatus(env: Env): Promise<SearchIndexStatus> {
  const source = await inventory(env), previous = await manifest(env);
  const snapshot = await cached(env, previous, source.hash);
  return { configured: Boolean(env.CACHE), available: Boolean(snapshot), current: Boolean(snapshot), builtAt: previous?.value.builtAt || null, count: previous?.value.count ?? 0 };
}
function matches(row: SearchItem, q: string, collections: Map<string, SearchItem>) {
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return false;
  return [row.name, row.description, row.id, row.collectionId ?? '', row.collectionId ? collections.get(row.collectionId)?.name ?? '' : '']
    .some(value => normalize(value).includes(q));
}
export async function searchResources(env: Env, query: SearchQuery): Promise<SearchPage> {
  const source = await inventory(env), previous = await manifest(env), snapshot = await cached(env, previous, source.hash);
  const rows = snapshot?.rows ?? await scan(env, source.entries);
  if (!snapshot && (await inventory(env)).hash !== source.hash) throw new SystemError(409, 'search_changed');
  if (!snapshot && env.CACHE) {
    // The fallback already read the metadata. Warm a new snapshot; cache failure
    // must never turn a successful authoritative search into a failed request.
    try { await publish(env, source, rows, previous); } catch { console.error('search_index_refresh_failed'); }
  }
  const queryHash = await digest(JSON.stringify([normalize(query.q), query.type, query.limit]));
  let after = '';
  if (query.cursor) {
    try {
      const cursor = JSON.parse(atob(query.cursor)) as { after: string; inventory: string; query: string };
      if (typeof cursor.after !== 'string' || !/^(bin|collection|schema):[^:]{1,64}$/.test(cursor.after) || cursor.query !== queryHash) throw new Error();
      if (cursor.inventory !== source.hash) throw new SystemError(409, 'search_changed');
      after = cursor.after;
    } catch (error) { if (error instanceof SystemError) throw error; throw new SystemError(400, 'invalid_query'); }
  }
  const collections = new Map(rows.filter(row => row.type === 'collection').map(row => [row.id, row]));
  // Key-based continuation survives a missing snapshot whose new R2 scan omits
  // newly expired rows, without shifting offsets and skipping live resources.
  const ordered = [...rows].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
  const items: SearchItem[] = []; let nextCursor: string | null = null;
  let last = after;
  for (let i = 0; i < ordered.length; i++) {
    const candidate = ordered[i];
    const position = `${candidate.type}:${candidate.id}`;
    if (position.localeCompare(after) <= 0) continue;
    if (query.type !== 'all' && candidate.type !== query.type || !matches(candidate, normalize(query.q), collections)) continue;
    const current = await readRow(env, candidate.type, candidate.id);
    if (!current) continue;
    const currentCollections = new Map<string, SearchItem>();
    if (current.collectionId) {
      const collection = await readRow(env, 'collection', current.collectionId);
      if (collection) { currentCollections.set(collection.id, collection); current.collectionName = collection.name; }
    }
    if (!matches(current, normalize(query.q), currentCollections)) continue;
    if (items.length === query.limit) { nextCursor = btoa(JSON.stringify({ after: last, inventory: source.hash, query: queryHash })); break; }
    const { slug: _slug, ...item } = current;
    items.push(item); last = position;
  }
  return { items, nextCursor, source: snapshot ? 'kv' : 'r2' };
}
