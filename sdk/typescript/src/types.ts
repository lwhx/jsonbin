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

export type ApiKeyRecord = {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  resourceAccess?: {
    mode: "all" | "restricted";
    binIds?: string[];
    collectionIds?: string[];
  };
  createdAt: string;
  updatedAt: string;
  etag: string;
  token?: string; // Only returned on creation
};
