import type { BinMeta } from "./bins";

export type PurgedBin = { id: string; deletedAt: string; purgeState: "purged" };
export type StoredBinMeta = BinMeta | PurgedBin;
export const binMetaKey = (id: string) => `bins/${id}/meta.json`;
export const legacyTrashKey = (id: string) => `trash/bins/${id}/meta.json`;
export const normalizeEtag = (etag: string) => etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

export function isExpired(meta: BinMeta, now = Date.now()) {
  return meta.expiresAt !== null && Date.parse(meta.expiresAt) <= now;
}
export function isActiveBin(meta: StoredBinMeta, now = Date.now()): meta is BinMeta {
  return meta.purgeState !== "purged" && !meta.deletedAt && !isExpired(meta, now);
}
