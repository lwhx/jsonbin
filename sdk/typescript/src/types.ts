export type JsonBinOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
};

export type BinMeta = {
  id: string;
  name: string;
  slug?: string | null;
  tags?: string[];
  favorite?: boolean;
  pinned?: boolean;
  description: string;
  visibility: "private" | "public";
  collectionId: string | null;
  schemaId: string | null;
  schemaRevision: number | null;
  currentVersion: number;
  publishedVersion?: number | null;
  publishedAt?: string | null;
  contentSearchMode?: "off" | "keys" | "all";
  size: number;
  locked: boolean;
  schemaLocked: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type BinRecord<T = unknown> = {
  meta: BinMeta;
  value: T;
  etag: string;
};

/** Flat version object returned by getVersion (not wrapped in meta/value). */
export type BinVersionRecord<T = unknown> = {
  id: string;
  version: number;
  createdAt: string;
  size: number;
  value: T;
  etag: string;
};

export type BinVersionSummary = {
  version: number;
  createdAt: string;
  size: number;
  message?: string;
};

export type BinVersionList = {
  items: BinVersionSummary[];
  currentVersion: number;
  total: number;
};

/** Metadata search pages by cursor; there is no total count. */
export type SearchMetadataResult = {
  items: Array<Record<string, unknown> & { id: string; type: string }>;
  nextCursor?: string;
  source: "kv" | "r2";
};

/** A trashed Bin snapshot: restore/purge require its exact ETag. */
export type TrashEntry = {
  meta: BinMeta & { deletedAt: string };
  etag: string;
  status: "deleted" | "expired" | "purging";
};

export type CreateBinInput<T = unknown> = {
  name: string;
  value: T;
  slug?: string | null;
  tags?: string[];
  favorite?: boolean;
  pinned?: boolean;
  description?: string;
  visibility?: "private" | "public";
  collectionId?: string | null;
  schemaId?: string | null;
  schemaLocked?: boolean;
  expiresAt?: string | null;
};

export type JsonPatchOperation =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export type CollectionRecord = {
  id: string;
  name: string;
  description: string;
  etag: string;
  createdAt: string;
  updatedAt: string;
};

export type SchemaRecord = {
  id: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  revision: number;
  etag: string;
  createdAt: string;
  updatedAt: string;
};
