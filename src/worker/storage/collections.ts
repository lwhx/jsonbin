import { getJson, putJson, requireDataBucket, listJsonObjects } from "./r2";
import { isActiveBin, type StoredBinMeta } from "./bin-state";

export type CollectionMeta = {
  id: string; name: string; description: string; slug: string;
  createdAt: string; updatedAt: string; status: "active" | "deleting" | "deleted";
};
export type CollectionInput = { name: string; description?: string };
function key(id: string) { return `collections/${id}/meta.json`; }
function normalizeEtag(etag: string) { return etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1"); }

export async function getCollection(env: Env, id: string) {
  const stored = await getJson<CollectionMeta>(requireDataBucket(env), key(id));
  if (!stored || stored.value.status === "deleted") return null;
  return { meta: stored.value, etag: stored.etag };
}

export async function assertCollectionAvailable(env: Env, id: string | null | undefined) {
  if (!id) return;
  const collection = await getCollection(env, id);
  if (!collection || collection.meta.status !== "active") throw new Error("collection_unavailable");
}

export async function listCollectionBins(env: Env, id: string) {
  if (!await getCollection(env, id)) return null;
  const bins = await listJsonObjects<StoredBinMeta>(requireDataBucket(env), "bins/");
  return bins.filter(bin => isActiveBin(bin)).filter(bin => bin.collectionId === id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listCollections(env: Env) {
  const bucket = requireDataBucket(env);
  const [collections, bins] = await Promise.all([
    listJsonObjects<CollectionMeta>(bucket, "collections/"), listJsonObjects<StoredBinMeta>(bucket, "bins/"),
  ]);
  const counts = new Map<string, number>();
  for (const bin of bins) if (isActiveBin(bin) && bin.collectionId) counts.set(bin.collectionId, (counts.get(bin.collectionId) ?? 0) + 1);
  return collections.filter(meta => meta.status !== "deleted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(meta => ({ ...meta, binCount: counts.get(meta.id) ?? 0 }));
}

export async function createCollection(env: Env, input: CollectionInput) {
  const id = crypto.randomUUID(); const now = new Date().toISOString();
  const meta: CollectionMeta = { id, name: input.name, description: input.description ?? "",
    slug: `collection-${id}`, createdAt: now, updatedAt: now, status: "active" };
  const stored = await putJson(requireDataBucket(env), key(id), meta);
  return { meta, etag: stored.httpEtag };
}

export async function updateCollection(env: Env, id: string, input: Partial<CollectionInput>, expectedEtag: string) {
  const current = await getCollection(env, id);
  if (!current) return null;
  if (current.meta.status !== "active") throw new Error("collection_deleting");
  if (normalizeEtag(current.etag) !== normalizeEtag(expectedEtag)) throw new Error("etag_conflict");
  const meta = { ...current.meta, ...input, updatedAt: new Date().toISOString() };
  const stored = await putJson(requireDataBucket(env), key(id), meta, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!stored) throw new Error("etag_conflict");
  return { meta, etag: stored.httpEtag };
}

// Clear only this relation, including locked Bins. Preserve JSON, versions and every other field.
export async function detachBinFromCollection(env: Env, binId: string, collectionId: string) {
  const bucket = requireDataBucket(env); const binKey = `bins/${binId}/meta.json`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await getJson<StoredBinMeta>(bucket, binKey);
    if (!current || !isActiveBin(current.value) || current.value.collectionId !== collectionId) return false;
    const stored = await putJson(bucket, binKey, { ...current.value, collectionId: null, updatedAt: new Date().toISOString() },
      { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
    if (stored) return true;
  }
  throw new Error("collection_delete_conflict");
}

export async function deleteCollection(env: Env, id: string, expectedEtag: string) {
  const bucket = requireDataBucket(env);
  let current = await getJson<CollectionMeta>(bucket, key(id));
  if (!current) return null;
  if (current.value.status === "deleted") return { ok: true, detached: 0 };
  if (current.value.status === "active") {
    if (normalizeEtag(current.etag) !== normalizeEtag(expectedEtag)) throw new Error("etag_conflict");
    const deleting = { ...current.value, status: "deleting" as const, updatedAt: new Date().toISOString() };
    const stored = await putJson(bucket, key(id), deleting, { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
    if (!stored) throw new Error("etag_conflict");
    current = { value: deleting, etag: stored.httpEtag, uploaded: stored.uploaded };
  }
  // A persistent deleting marker blocks new membership and lets a failed cleanup resume.
  const members = await listCollectionBins(env, id) ?? [];
  let detached = 0;
  for (const member of members) if (await detachBinFromCollection(env, member.id, id)) detached++;
  const stored = await putJson(bucket, key(id), { ...current.value, status: "deleted", updatedAt: new Date().toISOString() },
    { onlyIf: { etagMatches: normalizeEtag(current.etag) } });
  if (!stored) {
    const latest = await getJson<CollectionMeta>(bucket, key(id));
    if (latest?.value.status !== "deleted") throw new Error("collection_delete_conflict");
  }
  return { ok: true, detached };
}
