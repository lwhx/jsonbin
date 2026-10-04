import { syncSearchResource } from './search';
import { isImportMarker } from '../../shared/backup.ts';
import { getJson, listJsonObjects, putJson, requireDataBucket } from "./r2";
import { binMetaKey, legacyTrashKey, isExpired, normalizeEtag, type StoredBinMeta } from "./bin-state";
import { getBin, type BinMeta } from "./bins";
import { assertBoundSchema } from "./schemas";
import { detachBinFromCollection, getCollection } from "./collections";

export type TrashRecord = { meta: BinMeta & { deletedAt: string }; etag: string; status: "deleted" | "expired" | "purging" };

async function readTrash(env: Env, id: string): Promise<(TrashRecord & { legacy: boolean }) | null> {
  const bucket = requireDataBucket(env);
  const canonical = await getJson<StoredBinMeta>(bucket, binMetaKey(id));
  const stored = canonical ?? await getJson<BinMeta>(bucket, legacyTrashKey(id));
  if (!stored || isImportMarker(stored.value) || stored.value.purgeState === "purged") return null;
  const meta = stored.value;
  if (!meta.deletedAt && !isExpired(meta)) return null;
  return {
    meta: { ...meta, deletedAt: meta.deletedAt ?? meta.expiresAt!, deletionReason: meta.deletionReason ?? (meta.deletedAt ? "manual" : "expired") },
    etag: stored.etag, legacy: !canonical,
    status: meta.purgeState === "purging" ? "purging" : meta.deletedAt ? "deleted" : "expired",
  };
}

export async function listTrash(env: Env): Promise<TrashRecord[]> {
  const bucket = requireDataBucket(env);
  const [canonical, legacy] = await Promise.all([
    listJsonObjects<StoredBinMeta>(bucket, "bins/"), listJsonObjects<BinMeta>(bucket, "trash/bins/"),
  ]);
  const ids = new Set([...canonical, ...legacy].map(meta => meta.id));
  const records = await Promise.all([...ids].map(id => readTrash(env, id)));
  return records.filter(record => record !== null).map(({ legacy: _legacy, ...record }) => record)
    .sort((a, b) => b.meta.deletedAt.localeCompare(a.meta.deletedAt));
}

async function writableTrash(env: Env, id: string, expectedEtag: string) {
  const current = await readTrash(env, id);
  if (!current) return null;
  const matches = normalizeEtag(current.etag) === normalizeEtag(expectedEtag);
  // A failed purge can resume with either its original approved ETag or its current one.
  if (!matches && !(current.status === "purging" && current.meta.purgeEtag === normalizeEtag(expectedEtag))) throw new Error("etag_conflict");
  if (current.legacy) {
    const stored = await putJson(requireDataBucket(env), binMetaKey(id), current.meta, { onlyIf: { etagDoesNotMatch: "*" } });
    if (!stored) throw new Error("etag_conflict");
    current.etag = stored.httpEtag;
  }
  return current;
}

export async function restoreTrashBin(env: Env, id: string, expectedEtag: string) {
  const current = await writableTrash(env, id, expectedEtag);
  if (!current) return null;
  if (current.status === "purging") throw new Error("bin_purging");
  const bucket = requireDataBucket(env);
  const version = await getJson<unknown>(bucket, `bins/${id}/versions/${String(current.meta.currentVersion).padStart(6, "0")}.json`);
  if (!version) throw new Error("version_missing");
  await assertBoundSchema(env, current.meta, version.value);
  const { deletedAt: _deletedAt, deletionReason: _reason, purgeState: _state, purgeEtag: _purgeEtag, ...fields } = current.meta;
  const collectionId = fields.collectionId && (await getCollection(env, fields.collectionId))?.meta.status === "active" ? fields.collectionId : null;
  const meta: BinMeta = { ...fields, collectionId, visibility: "private", expiresAt: null,
    updatedAt: new Date().toISOString(), lifecycleId: crypto.randomUUID() };
  const written = await putJson(bucket, binMetaKey(id), meta, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!written) throw new Error("etag_conflict");
  await syncSearchResource(env, 'bin', id);
  await bucket.delete(legacyTrashKey(id));
  if (collectionId && (await getCollection(env, collectionId))?.meta.status !== "active") {
    await detachBinFromCollection(env, id, collectionId);
    return getBin(env, id);
  }
  return { meta, value: version.value, etag: written.httpEtag };
}

async function removeContents(bucket: R2Bucket, id: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `bins/${id}/versions/`, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await bucket.delete(legacyTrashKey(id));
}

export async function purgeTrashBin(env: Env, id: string, expectedEtag: string, onCommitted?: () => Promise<void>) {
  const bucket = requireDataBucket(env);
  const canonical = await getJson<StoredBinMeta>(bucket, binMetaKey(id));
  if (canonical && !isImportMarker(canonical.value) && canonical.value.purgeState === "purged") {
    await syncSearchResource(env, 'bin', id);
    await removeContents(bucket, id);
    return { ok: true };
  }
  const current = await writableTrash(env, id, expectedEtag);
  if (!current) return null;
  let etag = current.etag;
  if (current.status !== "purging") {
    const purging = { ...current.meta, purgeState: "purging" as const, purgeEtag: normalizeEtag(expectedEtag) };
    const claimed = await putJson(bucket, binMetaKey(id), purging, { onlyIf: { etagMatches: normalizeEtag(etag) } });
    if (!claimed) throw new Error("etag_conflict");
    etag = claimed.httpEtag;
  }
  // Only the permanent purging state permits physical deletion. Restore cannot win after this CAS.
  await syncSearchResource(env, 'bin', id);
  await removeContents(bucket, id);
  const written = await putJson(bucket, binMetaKey(id), { id, deletedAt: current.meta.deletedAt, purgeState: "purged" },
    { onlyIf: { etagMatches: normalizeEtag(etag) } });
  if (!written) { const latest = await getJson<StoredBinMeta>(bucket, binMetaKey(id)); if (!latest || isImportMarker(latest.value) || latest.value.purgeState !== "purged") throw new Error("etag_conflict"); }
  if (written) { try { await onCommitted?.(); } catch { console.error("activity_notification_failed"); } }
  return { ok: true };
}

// Cron does not determine accessibility: all normal storage reads check the deadline.
export async function sweepBins(env: Env, now = Date.now(), onTransition?: (event: { action: "bin.expired" | "bin.purged"; id: string }) => Promise<void>) {
  const bucket = requireDataBucket(env);
  const items = await listJsonObjects<StoredBinMeta>(bucket, "bins/");
  const result = { expired: 0, purged: 0, conflicts: 0, failed: 0 };
  for (const item of items) {
    if (isImportMarker(item)) continue;
    if (!item.purgeState && (item.deletedAt || !isExpired(item, now))) continue;
    try {
      const current = await getJson<StoredBinMeta>(bucket, binMetaKey(item.id));
      if (!current || isImportMarker(current.value)) continue;
      if (current.value.purgeState) {
        await purgeTrashBin(env, item.id, current.etag, () => onTransition?.({ action: "bin.purged", id: item.id }) ?? Promise.resolve()); result.purged++;
      } else if (!current.value.deletedAt && isExpired(current.value, now)) {
        const deleted = { ...current.value, deletedAt: current.value.expiresAt!, deletionReason: "expired" };
        if (await putJson(bucket, binMetaKey(item.id), deleted, { onlyIf: { etagMatches: normalizeEtag(current.etag) } })) {
          await syncSearchResource(env, 'bin', item.id);
          result.expired++;
          try { await onTransition?.({ action: "bin.expired", id: item.id }); } catch { console.error("activity_notification_failed"); }
        }
        else result.conflicts++;
      }
    } catch { result.failed++; }
  }
  if (result.failed) throw new Error(`bin_sweep_failed:${result.failed}`);
  return result;
}
