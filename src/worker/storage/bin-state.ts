import { isImportMarker } from '../../shared/backup.ts';
import type { ImportMarker } from '../../shared/backup-types.ts';
import type { BinMeta } from "./bins";

export type PurgedBin = { id: string; deletedAt: string; purgeState: "purged" };
export type StoredBinMeta = BinMeta | PurgedBin | ImportMarker;
export const binMetaKey = (id: string) => `bins/${id}/meta.json`;
export const legacyTrashKey = (id: string) => `trash/bins/${id}/meta.json`;
export const normalizeEtag = (etag: string) => etag.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

export function isExpired(meta: StoredBinMeta, now = Date.now()): boolean {
  return "expiresAt" in meta && typeof meta.expiresAt === "string" && Date.parse(meta.expiresAt) <= now;
}

export function isActiveBin(meta: StoredBinMeta, now = Date.now()): meta is BinMeta {
  return !isImportMarker(meta) && meta.purgeState !== "purged" && !("deletedAt" in meta && meta.deletedAt) && !isExpired(meta, now);
}
