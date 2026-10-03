import { getJson, putJson, requireDataBucket, listJsonObjects } from "./r2";
import { assertCollectionAvailable, getCollection, detachBinFromCollection } from "./collections";

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

export type BinRecord = {
  meta: BinMeta;
  value: unknown;
  etag: string;
};

export type BinVersionSummary = {
  version: number;
  createdAt: string;
  size: number;
};
export type BinVersionRecord = BinVersionSummary & {
  id: string;
  value: unknown;
  etag: string;
};

function metaKey(id: string) {
  return `bins/${id}/meta.json`;
}

function versionKey(id: string, version: number) {
  return `bins/${id}/versions/${String(version).padStart(6, "0")}.json`;
}

export function normalizeEtag(value: string) {
  return value.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
}

function assertWritable(meta: BinMeta, etag: string, expectedEtag?: string) {
  if (meta.locked) throw new Error("bin_locked");
  if (expectedEtag && normalizeEtag(expectedEtag) !== normalizeEtag(etag)) {
    throw new Error("etag_conflict");
  }
}

async function appendVersion(bucket: R2Bucket, id: string, currentVersion: number, value: unknown) {
  let nextVersion = currentVersion + 1;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `bins/${id}/versions/`, cursor });
    for (const object of page.objects) {
      const number = Number(object.key.split("/").pop()?.replace(/\.json$/, ""));
      if (Number.isSafeInteger(number)) nextVersion = Math.max(nextVersion, number + 1);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Never overwrite an existing version, including an orphan from a failed CAS.
  for (let attempt = 0; attempt < 8; attempt++, nextVersion++) {
    const written = await putJson(bucket, versionKey(id, nextVersion), value, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written) return nextVersion;
  }
  throw new Error("etag_conflict");
}

export async function listBins(env: Env): Promise<BinMeta[]> {
  const items = await listJsonObjects<BinMeta>(requireDataBucket(env), "bins/");
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createBin(
  env: Env,
  input: {
    name: string;
    description?: string;
    value: unknown;
    visibility?: "private" | "public";
    collectionId?: string | null;
  },
): Promise<BinRecord> {
  const bucket = requireDataBucket(env);
  await assertCollectionAvailable(env, input.collectionId);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const json = JSON.stringify(input.value);

  const meta: BinMeta = {
    id,
    name: input.name,
    description: input.description ?? "",
    visibility: input.visibility ?? "private",
    collectionId: input.collectionId ?? null,
    schemaId: null,
    currentVersion: 1,
    size: new TextEncoder().encode(json).byteLength,
    locked: false,
    schemaLocked: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
  };

  await putJson(bucket, versionKey(id, 1), input.value);
  const metaObject = await putJson(bucket, metaKey(id), meta);

  if (input.collectionId && (await getCollection(env, input.collectionId))?.meta.status !== "active") {
    await detachBinFromCollection(env, id, input.collectionId);
    const latest = await getBin(env, id);
    if (latest) return latest;
  }

  return {
    meta,
    value: input.value,
    etag: metaObject.httpEtag,
  };
}

export async function getBin(env: Env, id: string): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const metaObject = await getJson<BinMeta>(bucket, metaKey(id));
  if (!metaObject) return null;

  const valueObject = await getJson<unknown>(
    bucket,
    versionKey(id, metaObject.value.currentVersion),
  );
  if (!valueObject) {
    throw new Error(
      `Bin ${id} is missing version ${metaObject.value.currentVersion}`,
    );
  }

  return {
    meta: metaObject.value,
    value: valueObject.value,
    etag: metaObject.etag,
  };
}

export async function listBinVersions(env: Env, id: string) {
  const bucket = requireDataBucket(env);
  const current = await getJson<BinMeta>(bucket, metaKey(id));
  if (!current) return null;
  const items: BinVersionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `bins/${id}/versions/`, cursor });
    for (const object of page.objects) {
      const filename = object.key.split("/").pop()!;
      if (!/^\d{6,}\.json$/.test(filename)) continue;
      const version = Number(filename.slice(0, -5));
      if (!Number.isSafeInteger(version) || version < 1 || object.key !== versionKey(id, version)) continue;
      items.push({ version, createdAt: object.uploaded.toISOString(), size: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { items: items.sort((a, b) => b.version - a.version), currentVersion: current.value.currentVersion, total: items.length };
}

export async function getBinVersion(env: Env, id: string, version: number): Promise<BinVersionRecord | null> {
  const bucket = requireDataBucket(env);
  // Retained files of a deleted Bin are only accessible through future trash APIs.
  if (!await bucket.head(metaKey(id))) return null;
  const object = await bucket.get(versionKey(id, version));
  if (!object) return null;
  return { id, version, createdAt: object.uploaded.toISOString(), size: object.size,
    value: await object.json(), etag: object.httpEtag };
}

export async function restoreBinVersion(env: Env, id: string, version: number, expectedEtag: string) {
  const historical = await getBinVersion(env, id, version);
  if (!historical) return null;
  // Reuse conditional append and metadata CAS; restoration never overwrites history.
  return updateBin(env, id, historical.value, expectedEtag);
}

export async function updateBin(
  env: Env,
  id: string,
  value: unknown,
  expectedEtag?: string,
): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const current = await getJson<BinMeta>(bucket, metaKey(id));
  if (!current) return null;
  assertWritable(current.value, current.etag, expectedEtag);
  const nextVersion = await appendVersion(bucket, id, current.value.currentVersion, value);
  const now = new Date().toISOString();
  const json = JSON.stringify(value);

  const nextMeta: BinMeta = {
    ...current.value,
    currentVersion: nextVersion,
    size: new TextEncoder().encode(json).byteLength,
    updatedAt: now,
  };

  const written = await putJson(
    bucket,
    metaKey(id),
    nextMeta,
    { onlyIf: { etagMatches: normalizeEtag(current.etag) } },
  );
  if (!written) throw new Error("etag_conflict");

  return {
    meta: nextMeta,
    value,
    etag: written.httpEtag,
  };
}

export async function deleteBin(env: Env, id: string) {
  const bucket = requireDataBucket(env);
  const current = await getJson<BinMeta>(bucket, metaKey(id));
  if (!current) return false;

  const trashKey = `trash/bins/${id}/meta.json`;
  await putJson(bucket, trashKey, {
    ...current.value,
    deletedAt: new Date().toISOString(),
  });

  await bucket.delete(metaKey(id));
  return true;
}

export type BinMetadataInput = {
  name?: string;
  description?: string;
  visibility?: "private" | "public";
  collectionId?: string | null;
};

export async function updateBinMetadata(
  env: Env, id: string, input: BinMetadataInput, expectedEtag?: string,
): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const current = await getBin(env, id);
  if (!current) return null;
  assertWritable(current.meta, current.etag, expectedEtag);
  await assertCollectionAvailable(env, input.collectionId);
  const meta = { ...current.meta, ...input, updatedAt: new Date().toISOString() };
  const written = await putJson(bucket, metaKey(id), meta, {
    onlyIf: { etagMatches: normalizeEtag(current.etag) },
  });
  if (!written) throw new Error("etag_conflict");
  if (input.collectionId && (await getCollection(env, input.collectionId))?.meta.status !== "active") {
    await detachBinFromCollection(env, id, input.collectionId);
    return getBin(env, id);
  }
  return { meta, value: current.value, etag: written.httpEtag };
}
