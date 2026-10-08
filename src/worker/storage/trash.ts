import { syncSearchResource } from './search';
import { isImportMarker } from '../../shared/backup.ts';
import { getJson, listJsonObjects, putJson, requireDataBucket } from "./r2";
import { binMetaKey, legacyTrashKey, isExpired, normalizeEtag, type StoredBinMeta } from "./bin-state";
import { getBin, type BinMeta } from "./bins";
import { createBinAlias, readBinAlias, reconcileBinAliasToCanonical, releaseBinAlias, rewriteBinAlias, type BinAliasRecord } from "./bin-alias";
import { assertBoundSchema } from "./schemas";
import { detachBinFromCollection, getCollection } from "./collections";

export type TrashRecord = { meta: BinMeta & { deletedAt: string }; etag: string; status: "deleted" | "expired" | "purging" };

export async function readTrash(env: Env, id: string): Promise<(TrashRecord & { legacy: boolean }) | null> {
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
  // The listed snapshot already proves clearly-active Bins can never be trash
  // records; only genuine candidates (tombstones, expiry, purging) pay the
  // authoritative re-read that produces the fresh ETag trash responses need.
  const candidates = canonical.filter(meta =>
    isImportMarker(meta) || meta.purgeState || meta.deletedAt || isExpired(meta, Date.now()),
  ).map(meta => meta.id);
  const ids = new Set([...candidates, ...legacy.map(meta => meta.id)]);
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
  const lifecycleId = crypto.randomUUID();
  const meta: BinMeta = { ...fields, collectionId, visibility: "private", expiresAt: null,
    publishedVersion: null, publishedAt: null,
    updatedAt: new Date().toISOString(), lifecycleId };

  // Rebuild the slug alias so /b/:slug resolves against the new lifecycle.
  // A slug now owned by another live Bin is never overwritten; the restored
  // Bin keeps its data and loses only the conflicting alias.
  let slugWarning: string | undefined;
  const slug = meta.slug ?? null;
  if (slug) {
    const alias = await readBinAlias(bucket, slug);
    const owned = alias && alias.value.binId === id;
    const owner = alias && !owned ? await getBin(env, alias.value.binId) : null;
    const contested = Boolean(owner && owner.meta.slug === slug);
    if (!contested) {
      const record: BinAliasRecord = { slug, binId: id, lifecycleId, createdAt: new Date().toISOString() };
      const claimed = alias
        ? await rewriteBinAlias(bucket, record, alias.etag)
        : await createBinAlias(bucket, record);
      if (!claimed) {
        meta.slug = null;
        slugWarning = "slug_conflict_detached";
      }
    } else {
      meta.slug = null;
      slugWarning = "slug_conflict_detached";
    }
  }

  const written = await putJson(bucket, binMetaKey(id), meta, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!written) {
    // A concurrent restore won the metadata CAS. The canonical winner decides
    // the slug's fate: our alias side effect must never outlive this loser —
    // converge it to the winner's lifecycle, or release it when the winner no
    // longer claims the slug (otherwise the slug stays dead and unclaimable).
    if (slug) {
      const canonical = await getJson<StoredBinMeta>(bucket, binMetaKey(id));
      const value = canonical?.value;
      // Purged markers have no slug: only a live BinMeta can still claim it.
      const canonicalSlug = value && !isImportMarker(value) && "currentVersion" in value ? value.slug ?? null : null;
      if (canonicalSlug === slug) await reconcileBinAliasToCanonical(bucket, id);
      else await releaseBinAlias(bucket, slug, id);
    }
    throw new Error("etag_conflict");
  }
  await syncSearchResource(env, 'bin', id, meta);
  await bucket.delete(legacyTrashKey(id));
  if (collectionId && (await getCollection(env, collectionId))?.meta.status !== "active") {
    await detachBinFromCollection(env, id, collectionId);
    const detached = await getBin(env, id);
    return detached ? { ...detached, ...(slugWarning ? { warnings: [slugWarning] } : {}) } : null;
  }
  return { meta, value: version.value, etag: written.httpEtag, ...(slugWarning ? { warnings: [slugWarning] } : {}) };
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
    await syncSearchResource(env, 'bin', id, canonical.value);
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
  if (current.meta.slug) {
    await releaseBinAlias(bucket, current.meta.slug, id);
  }
  await syncSearchResource(env, 'bin', id, current.meta);
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
        const deleted: BinMeta = { ...current.value, deletedAt: current.value.expiresAt!, deletionReason: "expired" };
        if (await putJson(bucket, binMetaKey(item.id), deleted, { onlyIf: { etagMatches: normalizeEtag(current.etag) } })) {
          await syncSearchResource(env, 'bin', item.id, deleted);
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
