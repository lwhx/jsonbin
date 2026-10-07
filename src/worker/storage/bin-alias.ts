import { getJson, putJson } from "./r2";
import { binMetaKey, normalizeEtag } from "./bin-state";

/**
 * Slug aliases are derived state: the canonical `bins/<id>/meta.json` record is
 * the only authority over which lifecycle owns a slug. Every helper here keeps
 * alias writes conditional (R2 has no conditional delete) so a losing or failed
 * operation can never delete or overwrite a foreign alias.
 */

export type BinAliasRecord = {
  slug: string;
  binId: string;
  lifecycleId?: string;
  createdAt: string;
};

export const binAliasKey = (slug: string) => `aliases/bins/${slug}.json`;

export function readBinAlias(bucket: R2Bucket, slug: string) {
  return getJson<BinAliasRecord>(bucket, binAliasKey(slug));
}

/** First claim of a slug: succeeds only while no alias object exists at all. */
export function createBinAlias(bucket: R2Bucket, record: BinAliasRecord) {
  return putJson(bucket, binAliasKey(record.slug), record, { onlyIf: { etagDoesNotMatch: "*" } });
}

/** Take over a known alias snapshot (same bin, or a holder verified dead by the caller). */
export function rewriteBinAlias(bucket: R2Bucket, record: BinAliasRecord, expectedEtag: string) {
  return putJson(bucket, binAliasKey(record.slug), record, { onlyIf: { etagMatches: normalizeEtag(expectedEtag) } });
}

export type AliasClaim = { outcome: "created" } | { outcome: "adopted" } | { outcome: "conflict" };

/**
 * Claim a slug for a bin lifecycle. An alias that already names the same bin id
 * (a previous attempt of this very operation, or an earlier life of the bin) is
 * converged to `record` instead of being treated as a foreign conflict; only a
 * live alias owned by another bin reports "conflict".
 */
export async function claimBinAlias(bucket: R2Bucket, record: BinAliasRecord): Promise<AliasClaim> {
  const created = await createBinAlias(bucket, record);
  if (created) return { outcome: "created" };

  const existing = await readBinAlias(bucket, record.slug);
  if (!existing || existing.value.binId !== record.binId) return { outcome: "conflict" };
  const adopted = await rewriteBinAlias(bucket, record, existing.etag);
  return adopted ? { outcome: "adopted" } : { outcome: "conflict" };
}

/**
 * Release a slug this bin no longer owns. Deletion is not conditional in R2, so
 * the release first re-CASes the alias onto this (going-away) bin: any takeover
 * racing in between loses the CAS and keeps its own alias, and the final delete
 * can then only remove an alias that still names this bin.
 */
export async function releaseBinAlias(bucket: R2Bucket, slug: string, binId: string): Promise<void> {
  const alias = await readBinAlias(bucket, slug);
  if (!alias || alias.value.binId !== binId) return;
  const converged = await rewriteBinAlias(bucket, alias.value, alias.etag);
  if (!converged) return;
  await bucket.delete(binAliasKey(slug)).catch(() => {});
}

/**
 * Converge a bin's alias to the lifecycle its canonical metadata publishes.
 * Heals the divergence a lost restore/backup race leaves behind (alias pinned to
 * a lifecycle that never became active). Best-effort by design: never throws,
 * returns whether the alias actually needed rewriting.
 */
export async function reconcileBinAliasToCanonical(bucket: R2Bucket, binId: string): Promise<boolean> {
  try {
    const meta = await getJson<{ slug?: string | null; lifecycleId?: string }>(bucket, binMetaKey(binId));
    if (!meta || !meta.value.slug || !meta.value.lifecycleId) return false;
    const alias = await readBinAlias(bucket, meta.value.slug);
    if (!alias || alias.value.binId !== binId) return false;
    if (alias.value.lifecycleId === meta.value.lifecycleId) return false;
    const converged = await rewriteBinAlias(bucket, { ...alias.value, lifecycleId: meta.value.lifecycleId }, alias.etag);
    return Boolean(converged);
  } catch {
    return false;
  }
}
