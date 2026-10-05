import { base64UrlDecode, base64UrlEncode, hmacSign, timingSafeEqualBase64Url } from "../lib/crypto";
import { getJson, listJsonObjects, putJson, requireDataBucket } from "./r2";

export const API_SCOPES = ["bin:read", "bin:create", "bin:update", "bin:delete", "collection:read", "collection:write", "schema:read", "schema:write", "history:read"] as const;
export type ApiScope = typeof API_SCOPES[number];
export type ResourceAccess =
  | { mode: "all" }
  | { mode: "restricted"; binIds: string[]; collectionIds: string[] };

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  resourceAccess?: ResourceAccess;
  usageTotal?: number;
  usageDaily?: Record<string, number>;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  revealable: boolean;
};
type StoredKey = Omit<ApiKey, "revealable"> & {
  digest: string;
  digestAlgorithm: "sha256" | "hmac-sha256";
  tokenEncryption?: "aes-gcm-v1";
  tokenIv?: string;
  tokenCiphertext?: string;
};
export type KeyInput = {
  name: string;
  scopes: ApiScope[];
  expiresAt?: string | null;
  resourceAccess?: ResourceAccess;
};
const keyPath = (id: string) => `keys/${id}/meta.json`;
const normalize = (etag: string) => etag.replace(/^"(.*)"$/, "$1");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function publicKey(stored: StoredKey): ApiKey {
  const { digest: _digest, digestAlgorithm: _algorithm, tokenEncryption: _encryption, tokenIv: _iv, tokenCiphertext: _ciphertext, ...key } = stored;
  return {
    ...key,
    resourceAccess: stored.resourceAccess ?? { mode: "all" },
    usageTotal: stored.usageTotal ?? 0,
    usageDaily: stored.usageDaily ?? {},
    revealable: Boolean(stored.tokenEncryption === "aes-gcm-v1" && stored.tokenIv && stored.tokenCiphertext)
  };
}
function tokenId(token: string) {
  const selector = /^jb_live_([0-9a-f]{32})_[A-Za-z0-9_-]{43}$/.exec(token)?.[1];
  if (!selector) return null;
  return `${selector.slice(0, 8)}-${selector.slice(8, 12)}-${selector.slice(12, 16)}-${selector.slice(16, 20)}-${selector.slice(20)}`;
}
async function tokenDigest(env: Env, token: string, algorithm: StoredKey["digestAlgorithm"]) {
  if (algorithm === "hmac-sha256") {
    if (!env.TOKEN_PEPPER || env.TOKEN_PEPPER.length < 32) return null;
    return hmacSign(env.TOKEN_PEPPER, token);
  }
  if (algorithm !== "sha256") return null;
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}
async function tokenEncryptionKey(env: Env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("token_encryption_unavailable");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`jsonbin/api-key/aes-gcm/v1\0${env.SESSION_SECRET}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptToken(env: Env, id: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`jsonbin/api-key/${id}`) },
    await tokenEncryptionKey(env),
    encoder.encode(token),
  );
  return { tokenEncryption: "aes-gcm-v1" as const, tokenIv: base64UrlEncode(iv), tokenCiphertext: base64UrlEncode(ciphertext) };
}
async function decryptToken(env: Env, stored: StoredKey) {
  if (stored.tokenEncryption !== "aes-gcm-v1" || !stored.tokenIv || !stored.tokenCiphertext) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(stored.tokenIv), additionalData: encoder.encode(`jsonbin/api-key/${stored.id}`) },
      await tokenEncryptionKey(env),
      base64UrlDecode(stored.tokenCiphertext),
    );
    const token = decoder.decode(plaintext);
    if (tokenId(token) !== stored.id) return null;
    const digest = await tokenDigest(env, token, stored.digestAlgorithm);
    if (!digest || !await timingSafeEqualBase64Url(digest, stored.digest)) return null;
    return token;
  } catch {
    return null;
  }
}
export async function listKeys(env: Env) {
  const items = await listJsonObjects<StoredKey>(requireDataBucket(env), "keys/");
  return items.map(publicKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function createKey(env: Env, input: KeyInput) {
  if (env.TOKEN_PEPPER && env.TOKEN_PEPPER.length < 32) throw new Error("token_pepper_invalid");
  const id = crypto.randomUUID(), selector = id.replaceAll("-", "");
  // 256 random secret bits; the UUID selector only locates the authoritative R2 record.
  const token = `jb_live_${selector}_${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
  const digestAlgorithm = env.TOKEN_PEPPER ? "hmac-sha256" : "sha256";
  const digest = (await tokenDigest(env, token, digestAlgorithm))!;
  const encrypted = await encryptToken(env, id, token);
  const resourceAccess: ResourceAccess = input.resourceAccess?.mode === "restricted"
    ? {
        mode: "restricted",
        binIds: Array.from(new Set(input.resourceAccess.binIds || [])),
        collectionIds: Array.from(new Set(input.resourceAccess.collectionIds || [])),
      }
    : { mode: "all" };

  const key: StoredKey = { id, name: input.name, prefix: `jb_live_${selector.slice(0, 8)}…`, scopes: [...input.scopes],
    resourceAccess,
    usageTotal: 0,
    usageDaily: {},
    createdAt: new Date().toISOString(), expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    revokedAt: null, lastUsedAt: null, digest, digestAlgorithm, ...encrypted };
  const created = await putJson(requireDataBucket(env), keyPath(id), key, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!created) throw new Error("key_update_conflict");
  return { key: publicKey(key), token };
}
export async function revealKey(env: Env, id: string) {
  const stored = await getJson<StoredKey>(requireDataBucket(env), keyPath(id));
  if (!stored) return { status: "not_found" as const };
  const token = await decryptToken(env, stored.value);
  if (!token) return { status: "unavailable" as const };
  return { status: "ok" as const, token };
}
export async function purgeKey(env: Env, id: string) {
  const bucket = requireDataBucket(env);
  const stored = await getJson<StoredKey>(bucket, keyPath(id));
  if (!stored) return false;
  await bucket.delete(keyPath(id));
  return true;
}
export async function revokeKey(env: Env, id: string) {
  const bucket = requireDataBucket(env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await getJson<StoredKey>(bucket, keyPath(id));
    if (!stored) return null;
    if (stored.value.revokedAt) return publicKey(stored.value);
    const next = { ...stored.value, revokedAt: new Date().toISOString() };
    if (await putJson(bucket, keyPath(id), next, { onlyIf: { etagMatches: normalize(stored.etag) } })) return publicKey(next);
  }
  throw new Error("key_update_conflict");
}

export type KeyUpdateInput = {
  name?: string;
  scopes?: ApiScope[];
  expiresAt?: string | null;
  resourceAccess?: ResourceAccess;
};

/** Edits scopes / resource scope / name / expiry on a live key. Revocation stays terminal. */
export async function updateKey(env: Env, id: string, input: KeyUpdateInput) {
  const bucket = requireDataBucket(env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await getJson<StoredKey>(bucket, keyPath(id));
    if (!stored) return null;
    if (stored.value.revokedAt) throw new Error("key_revoked");
    const next: StoredKey = { ...stored.value };
    if (input.name !== undefined) next.name = input.name;
    if (input.scopes !== undefined) next.scopes = [...input.scopes];
    if (input.resourceAccess !== undefined) {
      next.resourceAccess = input.resourceAccess.mode === "restricted"
        ? {
            mode: "restricted",
            binIds: Array.from(new Set(input.resourceAccess.binIds || [])),
            collectionIds: Array.from(new Set(input.resourceAccess.collectionIds || [])),
          }
        : { mode: "all" };
    }
    if (input.expiresAt !== undefined) {
      next.expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null;
    }
    if (await putJson(bucket, keyPath(id), next, { onlyIf: { etagMatches: normalize(stored.etag) } })) return publicKey(next);
  }
  throw new Error("key_update_conflict");
}
export async function readApiKey(env: Env, token: string) {
  const id = tokenId(token); if (!id) return null;
  const stored = await getJson<StoredKey>(requireDataBucket(env), keyPath(id));
  if (!stored || stored.value.revokedAt || (stored.value.expiresAt && Date.parse(stored.value.expiresAt) <= Date.now())) return null;
  const expected = await tokenDigest(env, token, stored.value.digestAlgorithm);
  if (!expected || !await timingSafeEqualBase64Url(expected, stored.value.digest)) return null;
  return { key: publicKey(stored.value), stored: stored.value, etag: stored.etag };
}
export function checkResourceAccess(
  key: ApiKey,
  resource: { type: "bin" | "collection"; id?: string; collectionId?: string | null },
): boolean {
  const policy = key.resourceAccess ?? { mode: "all" };
  if (policy.mode === "all") return true;

  if (resource.type === "bin") {
    if (resource.id && policy.binIds.includes(resource.id)) return true;
    if (resource.collectionId && policy.collectionIds.includes(resource.collectionId)) return true;
    return false;
  }

  if (resource.type === "collection") {
    if (resource.id && policy.collectionIds.includes(resource.id)) return true;
    return false;
  }

  return false;
}

/** Credential + scope verdict only; usage is counted later so denied requests stay uncounted. */
export function authorizeApiKey(initial: NonNullable<Awaited<ReturnType<typeof readApiKey>>>, required: ApiScope[]): "ok" | "unauthorized" | "insufficient_scope" {
  const key = initial.key;
  if (key.revokedAt || (key.expiresAt && Date.parse(key.expiresAt) <= Date.now())) return "unauthorized";
  if (required.some(scope => !key.scopes.includes(scope))) return "insufficient_scope";
  return "ok";
}

/** Commits one authorized usage atomically; best-effort and never throws into a finalized response. */
export async function useApiKey(env: Env, token: string, initial: NonNullable<Awaited<ReturnType<typeof readApiKey>>>, required: ApiScope[]) {
  const bucket = requireDataBucket(env);
  let current: typeof initial | null = initial;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!current || current.key.revokedAt || (current.key.expiresAt && Date.parse(current.key.expiresAt) <= Date.now())) return "unauthorized";

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const prevDaily = current.stored.usageDaily || {};

    // Keep only last 31 days
    const dailyKeys = Object.keys(prevDaily).sort();
    const cutoff = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
    const usageDaily: Record<string, number> = {};
    for (const d of dailyKeys) {
      if (d >= cutoff) usageDaily[d] = prevDaily[d];
    }
    usageDaily[today] = (usageDaily[today] || 0) + 1;

    const next: StoredKey = {
      ...current.stored,
      usageTotal: (current.stored.usageTotal || 0) + 1,
      usageDaily,
      lastUsedAt: now.toISOString(),
    };

    // CAS prevents touching an outdated or revoked record; a lost race retries against the latest.
    if (await putJson(bucket, keyPath(current.key.id), next, { onlyIf: { etagMatches: normalize(current.etag) } })) return "ok";
    current = await readApiKey(env, token);
  }
  return "busy";
}
