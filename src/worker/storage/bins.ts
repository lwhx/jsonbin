import { syncSearchResource } from './search';
import { isImportMarker } from '../../shared/backup.ts';
import { resolveCreateDefaults } from './settings';
import { getJson, putJson, requireDataBucket, listJsonObjects } from "./r2";
import { assertCollectionAvailable, getCollection, detachBinFromCollection } from "./collections";

import { resolveSchemaBinding, assertBoundSchema } from "./schemas";
import { SchemaError } from "../validation/schema";
import { isActiveBin, normalizeEtag, type StoredBinMeta } from "./bin-state";
export { normalizeEtag } from "./bin-state";

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
  size: number;
  locked: boolean;
  schemaLocked: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  contentSearchMode?: "off" | "keys" | "all";
  publishedVersion?: number | null;
  publishedAt?: string | null;
  deletedAt?: string;
  deletionReason?: "manual" | "expired";
  purgeState?: "purging";
  purgeEtag?: string;
  lifecycleId?: string;
};

export type BinAliasRecord = {
  slug: string;
  binId: string;
  lifecycleId?: string;
  createdAt: string;
};

export const binAliasKey = (slug: string) => `aliases/bins/${slug}.json`;

export type BinRecord = {
  meta: BinMeta;
  value: unknown;
  etag: string;
};

export function validateSlug(slug: string | null | undefined): string | null {
  if (slug === null || slug === undefined || slug === "") return null;
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{1,62}[a-z0-9]$/.test(normalized)) {
    throw new Error("invalid_slug");
  }
  return normalized;
}

export function validateTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  if (!Array.isArray(tags)) throw new Error("invalid_tags");
  if (tags.length > 20) throw new Error("tags_limit_reached");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== "string") throw new Error("invalid_tags");
    const tag = raw.trim();
    if (!tag || tag.length > 32) throw new Error("invalid_tags");
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

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
    const page = await bucket.list({ prefix: `bins/${id}/versions/`, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      const number = Number(object.key.split("/").pop()?.replace(/\.json$/, ""));
      if (Number.isSafeInteger(number)) nextVersion = Math.max(nextVersion, number + 1);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Never overwrite an existing version, including an orphan from a failed CAS.
  for (let attempt = 0; attempt < 8; attempt++, nextVersion++) {
    if (!Number.isSafeInteger(nextVersion) || nextVersion < 1) throw new Error("version_limit_reached");
    const written = await putJson(bucket, versionKey(id, nextVersion), value, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (written) return nextVersion;
  }
  throw new Error("etag_conflict");
}

export async function listBins(env: Env, options?: { tag?: string; favorite?: boolean; pinned?: boolean }): Promise<BinMeta[]> {
  const items = await listJsonObjects<StoredBinMeta>(requireDataBucket(env), "bins/");
  return (items.filter(item => isActiveBin(item, Date.now())) as BinMeta[]).filter(item => {
    if (options?.favorite !== undefined && (item.favorite ?? false) !== options.favorite) return false;
    if (options?.pinned !== undefined && (item.pinned ?? false) !== options.pinned) return false;
    if (options?.tag && !(item.tags ?? []).includes(options.tag)) return false;
    return true;
  }).sort((a, b) => {
    const pinA = a.pinned ? 1 : 0;
    const pinB = b.pinned ? 1 : 0;
    if (pinA !== pinB) return pinB - pinA;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export async function cloneBin(
  env: Env,
  id: string,
  ifMatch?: string,
  source?: BinRecord,
): Promise<BinRecord> {
  // Callers that must authorize against the source may pass the exact snapshot
  // they inspected, so permission checks and the write use the same data.
  const current = source ?? await getBin(env, id);
  if (!current) throw new Error("not_found");
  if (ifMatch && current.etag !== ifMatch && `"${current.etag}"` !== ifMatch && current.etag !== `"${ifMatch}"`) {
    throw new Error("etag_conflict");
  }

  // Schema pinned revision validation
  if (current.meta.schemaId && current.meta.schemaRevision) {
    await assertBoundSchema(env, { schemaId: current.meta.schemaId, schemaRevision: current.meta.schemaRevision }, current.value);
  }

  const name = `${current.meta.name} - 副本`.slice(0, 160);
  const bucket = requireDataBucket(env);
  const newId = crypto.randomUUID();
  const lifecycleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const json = JSON.stringify(current.value);

  const meta: BinMeta = {
  id: newId,
  name,
  slug: null,
  tags: Array.isArray(current.meta.tags) ? [...current.meta.tags] : [],
  favorite: false,
    pinned: false,
    description: current.meta.description ?? "",
    visibility: "private",
    collectionId: current.meta.collectionId ?? null,
    schemaId: current.meta.schemaId ?? null,
    schemaRevision: current.meta.schemaRevision ?? null,
    currentVersion: 1,
    size: new TextEncoder().encode(json).byteLength,
    locked: false,
    schemaLocked: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    lifecycleId,
  };

  await putJson(bucket, versionKey(newId, 1), current.value);
  const metaObject = await putJson(bucket, metaKey(newId), meta);
  await syncSearchResource(env, "bin", newId);

  return {
    meta,
    value: current.value,
    etag: metaObject.etag,
  };
}

export async function createBin(
  env: Env,
  input: {
    name: string;
    slug?: string | null;
    tags?: string[];
    favorite?: boolean;
    pinned?: boolean;
    description?: string;
    value: unknown;
    visibility?: "private" | "public";
    collectionId?: string | null;
    schemaId?: string | null;
    schemaLocked?: boolean;
    expiresAt?: string | null;
  },
): Promise<BinRecord> {
  const bucket = requireDataBucket(env);
  const slug = validateSlug(input.slug);
  const tags = validateTags(input.tags);
  await assertCollectionAvailable(env, input.collectionId);
  const binding = await resolveSchemaBinding(env, input.schemaId, input.value);
  if (input.schemaLocked && !binding.schemaId) throw new SchemaError("schema_required");
  const id = crypto.randomUUID();
  const lifecycleId = crypto.randomUUID();
  const now = new Date().toISOString();
  const defaults = await resolveCreateDefaults(env, input, Date.parse(now));
  const json = JSON.stringify(input.value);

  if (slug) {
    const aliasRecord: BinAliasRecord = { slug, binId: id, lifecycleId, createdAt: now };
    const claimed = await putJson(bucket, binAliasKey(slug), aliasRecord, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!claimed) throw new Error("slug_conflict");
  }

  const meta: BinMeta = {
    id,
    name: input.name,
    slug: slug ?? null,
    tags,
    favorite: input.favorite ?? false,
    pinned: input.pinned ?? false,
    description: input.description ?? "",
    visibility: defaults.visibility,
    collectionId: input.collectionId ?? null,
    ...binding,
    currentVersion: 1,
    size: new TextEncoder().encode(json).byteLength,
    locked: false,
    schemaLocked: input.schemaLocked ?? false,
    createdAt: now,
    updatedAt: now,
    expiresAt: defaults.expiresAt,
    lifecycleId,
  };

  try {
    await putJson(bucket, versionKey(id, 1), input.value);
    const metaObject = await putJson(bucket, metaKey(id), meta);
    await syncSearchResource(env, 'bin', id);

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
  } catch (error) {
    if (slug) {
      await bucket.delete(binAliasKey(slug)).catch(() => {});
    }
    throw error;
  }
}

export async function getBin(env: Env, id: string): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const metaObject = await getJson<StoredBinMeta>(bucket, metaKey(id));
  if (!metaObject || !isActiveBin(metaObject.value)) return null;

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
  const current = await getJson<StoredBinMeta>(bucket, metaKey(id));
  if (!current || !isActiveBin(current.value)) return null;
  const items: BinVersionSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `bins/${id}/versions/`, cursor, include: ["customMetadata"] });
    for (const object of page.objects) {
      const filename = object.key.split("/").pop()!;
      if (!/^\d{6,}\.json$/.test(filename)) continue;
      const version = Number(filename.slice(0, -5));
      if (!Number.isSafeInteger(version) || version < 1 || object.key !== versionKey(id, version)) continue;
      items.push({ version, createdAt: object.customMetadata?.originalUploadedAt ?? object.uploaded.toISOString(), size: object.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { items: items.sort((a, b) => b.version - a.version), currentVersion: current.value.currentVersion, total: items.length };
}

export async function getBinVersion(env: Env, id: string, version: number): Promise<BinVersionRecord | null> {
  const bucket = requireDataBucket(env);
  // Retained files of a deleted Bin are only accessible through future trash APIs.
  const current = await getJson<StoredBinMeta>(bucket, metaKey(id));
  if (!current || !isActiveBin(current.value)) return null;
  const object = await bucket.get(versionKey(id, version));
  if (!object) return null;
  return { id, version, createdAt: object.customMetadata?.originalUploadedAt ?? object.uploaded.toISOString(), size: object.size,
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
  const current = await getJson<StoredBinMeta>(bucket, metaKey(id));
  if (!current || !isActiveBin(current.value)) return null;
  assertWritable(current.value, current.etag, expectedEtag);
  await assertBoundSchema(env, current.value, value);
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
  if (!written) {
    // A purge may have raced this in-flight append; don't leave its new orphan behind.
    const latest = await getJson<StoredBinMeta>(bucket, metaKey(id));
    if (latest && !isImportMarker(latest.value) && latest.value.purgeState) await bucket.delete(versionKey(id, nextVersion));
    throw new Error("etag_conflict");
  }

  await syncSearchResource(env, 'bin', id);
  return {
    meta: nextMeta,
    value,
    etag: written.httpEtag,
  };
}

/** Derive and commit against the same snapshot; never merge against newer data silently. */
export async function transformBin(env: Env, id: string, transform: (value: unknown) => unknown, expectedEtag: string) {
  const current = await getBin(env, id);
  if (!current) return null;
  assertWritable(current.meta, current.etag, expectedEtag);
  return updateBin(env, id, transform(current.value), current.etag);
}

export async function deleteBin(env: Env, id: string, expectedEtag?: string) {
  const bucket = requireDataBucket(env);
  const current = await getJson<StoredBinMeta>(bucket, metaKey(id));
  if (!current || isImportMarker(current.value) || current.value.purgeState === "purged") return false;

  // A CAS tombstone makes deletion compete atomically with locking and writes.
  // Retain it so no delayed writer can recreate an active Bin after deletion.
  let deleted = current.value;
  if (!deleted.deletedAt) {
    if (!isActiveBin(deleted)) return false;
    assertWritable(deleted, current.etag, expectedEtag);
    deleted = { ...deleted, deletedAt: new Date().toISOString(), deletionReason: "manual" };
    const written = await putJson(bucket, metaKey(id), deleted, {
      onlyIf: { etagMatches: normalizeEtag(current.etag) },
    });
    if (!written) throw new Error("etag_conflict");
  }
  // Canonical metadata is now the trash record. Avoid a second mutable archive
  // which a delayed deletion could overwrite after restoration or permanent purge.
  await syncSearchResource(env, 'bin', id);
  return true;
}

export type BinMetadataInput = {
  name?: string;
  slug?: string | null;
  tags?: string[];
  favorite?: boolean;
  pinned?: boolean;
  description?: string;
  visibility?: "private" | "public";
  collectionId?: string | null;
  schemaId?: string | null;
  schemaLocked?: boolean;
  refreshSchema?: boolean;
  locked?: boolean;
  contentSearchMode?: "off" | "keys" | "all";
  expiresAt?: string | null;
};

export async function publishBinVersion(
  env: Env,
  id: string,
  targetVersion?: number,
  expectedEtag?: string,
): Promise<BinRecord | null> {
  const current = await getBin(env, id);
  if (!current) return null;
  assertWritable(current.meta, current.etag, expectedEtag);

  const versionToPublish = targetVersion ?? current.meta.currentVersion;
  if (!Number.isInteger(versionToPublish) || versionToPublish < 1 || versionToPublish > current.meta.currentVersion) {
    throw new Error("invalid_version");
  }

  // Load target version value to validate against schema
  const versionObj = await getBinVersion(env, id, versionToPublish);
  if (!versionObj) throw new Error("version_not_found");

  if (current.meta.schemaId && current.meta.schemaRevision) {
    await assertBoundSchema(
      env,
      { schemaId: current.meta.schemaId, schemaRevision: current.meta.schemaRevision },
      versionObj.value,
    );
  }

  const bucket = requireDataBucket(env);
  const now = new Date().toISOString();
  const meta: BinMeta = {
    ...current.meta,
    publishedVersion: versionToPublish,
    publishedAt: now,
    updatedAt: now,
  };

  // The If-Match check above and this final write must commit against the same
  // snapshot, or a concurrent update could be silently overwritten here.
  const written = await putJson(bucket, metaKey(id), meta, {
    onlyIf: { etagMatches: normalizeEtag(current.etag) },
  });
  if (!written) throw new Error("etag_conflict");
  return {
    meta,
    value: current.value,
    etag: written.httpEtag,
  };
}

export async function updateBinMetadata(
  env: Env, id: string, input: BinMetadataInput, expectedEtag?: string,
): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const current = await getBin(env, id);
  if (!current) return null;
  const unlockOnly = input.locked === false && Object.keys(input).length === 1;
  assertWritable(unlockOnly ? { ...current.meta, locked: false } : current.meta, current.etag, expectedEtag);
  await assertCollectionAvailable(env, input.collectionId);

  const changedSlug = input.slug !== undefined && input.slug !== current.meta.slug;
  const newSlug = changedSlug ? validateSlug(input.slug) : current.meta.slug;
  const oldSlug = current.meta.slug;
  const tags = input.tags !== undefined ? validateTags(input.tags) : current.meta.tags;

  const { refreshSchema, ...fields } = input;
  const changedBinding = (input.schemaId !== undefined && input.schemaId !== current.meta.schemaId) || refreshSchema === true;
  if (current.meta.schemaLocked && changedBinding) throw new SchemaError("schema_locked");
  const requestedSchemaId = input.schemaId === undefined ? current.meta.schemaId : input.schemaId;
  if (refreshSchema && !requestedSchemaId) throw new SchemaError("schema_required");
  const binding = changedBinding ? await resolveSchemaBinding(env, requestedSchemaId, current.value)
    : { schemaId: current.meta.schemaId, schemaRevision: current.meta.schemaRevision ?? null };

  const lifecycleId = current.meta.lifecycleId ?? crypto.randomUUID();
  const now = new Date().toISOString();

  // Atomically claim new slug if changed
  if (changedSlug && newSlug) {
    const aliasRecord: BinAliasRecord = { slug: newSlug, binId: id, lifecycleId, createdAt: now };
    const claimed = await putJson(bucket, binAliasKey(newSlug), aliasRecord, {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!claimed) throw new Error("slug_conflict");
  }

  const meta: BinMeta = {
    ...current.meta,
    ...fields,
    ...(input.tags !== undefined ? { tags } : {}),
    ...(changedSlug ? { slug: newSlug } : {}),
    lifecycleId,
    ...binding,
    updatedAt: now,
  };
  if (meta.schemaLocked && !meta.schemaId) {
    if (changedSlug && newSlug) await bucket.delete(binAliasKey(newSlug)).catch(() => {});
    throw new SchemaError("schema_required");
  }

  let written: { httpEtag: string } | null = null;
  try {
    written = await putJson(bucket, metaKey(id), meta, {
      onlyIf: { etagMatches: normalizeEtag(current.etag) },
    });
    if (!written) {
      if (changedSlug && newSlug) await bucket.delete(binAliasKey(newSlug)).catch(() => {});
      throw new Error("etag_conflict");
    }
    // Delete old slug alias after CAS success
    if (changedSlug && oldSlug) {
      await bucket.delete(binAliasKey(oldSlug)).catch(() => {});
    }
  } catch (error) {
    if (changedSlug && newSlug && !written) {
      await bucket.delete(binAliasKey(newSlug)).catch(() => {});
    }
    throw error;
  }

  if (input.collectionId && (await getCollection(env, input.collectionId))?.meta.status !== "active") {
    await detachBinFromCollection(env, id, input.collectionId);
    return getBin(env, id);
  }
  await syncSearchResource(env, 'bin', id);
  return { meta, value: current.value, etag: written.httpEtag };
}

export async function getBinBySlug(env: Env, slug: string): Promise<BinRecord | null> {
  const bucket = requireDataBucket(env);
  const normalized = validateSlug(slug);
  if (!normalized) return null;

  const alias = await getJson<BinAliasRecord>(bucket, binAliasKey(normalized));
  if (!alias) return null;

  const binRecord = await getBin(env, alias.value.binId);
  if (!binRecord) return null;

  // Verify full ownership and lifecycle consistency
  if (binRecord.meta.slug !== normalized) return null;
  if (alias.value.lifecycleId && binRecord.meta.lifecycleId && alias.value.lifecycleId !== binRecord.meta.lifecycleId) {
    return null;
  }

  return binRecord;
}
