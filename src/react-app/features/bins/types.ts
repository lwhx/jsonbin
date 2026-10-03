export type BinMeta = {
  id: string;
  name: string;
  description: string;
  visibility: "private" | "public";
  collectionId: string | null;
  schemaId: string | null;
  currentVersion: number;
  size: number;
  locked: boolean;
  schemaLocked: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};
export type BinRecord = { meta: BinMeta; value: unknown; etag: string };
export type MetadataInput = Pick<BinMeta, "name" | "description" | "visibility">;
