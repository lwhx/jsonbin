import { base64UrlEncode, hmacSign, timingSafeEqualBase64Url } from "../lib/crypto";
import { getJson, listJsonObjects, putJson, requireDataBucket } from "./r2";

export const API_SCOPES = ["bin:read", "bin:create", "bin:update", "bin:delete", "collection:read", "collection:write", "schema:read", "schema:write", "history:read"] as const;
export type ApiScope = typeof API_SCOPES[number];
export type ApiKey = { id: string; name: string; prefix: string; scopes: ApiScope[];
  createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null };
type StoredKey = ApiKey & { digest: string; digestAlgorithm: "sha256" | "hmac-sha256" };
export type KeyInput = { name: string; scopes: ApiScope[]; expiresAt?: string | null };
const keyPath = (id: string) => `keys/${id}/meta.json`;
const normalize = (etag: string) => etag.replace(/^"(.*)"$/, "$1");
function publicKey(stored: StoredKey): ApiKey {
  const { digest: _digest, digestAlgorithm: _algorithm, ...key } = stored; return key;
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
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
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
  const key: StoredKey = { id, name: input.name, prefix: `jb_live_${selector.slice(0, 8)}…`, scopes: [...input.scopes],
    createdAt: new Date().toISOString(), expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    revokedAt: null, lastUsedAt: null, digest, digestAlgorithm };
  const created = await putJson(requireDataBucket(env), keyPath(id), key, { onlyIf: { etagDoesNotMatch: "*" } });
  if (!created) throw new Error("key_update_conflict");
  return { key: publicKey(key), token };
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
export async function readApiKey(env: Env, token: string) {
  const id = tokenId(token); if (!id) return null;
  const stored = await getJson<StoredKey>(requireDataBucket(env), keyPath(id));
  if (!stored || stored.value.revokedAt || (stored.value.expiresAt && Date.parse(stored.value.expiresAt) <= Date.now())) return null;
  const expected = await tokenDigest(env, token, stored.value.digestAlgorithm);
  if (!expected || !await timingSafeEqualBase64Url(expected, stored.value.digest)) return null;
  return { key: publicKey(stored.value), stored: stored.value, etag: stored.etag };
}
export async function useApiKey(env: Env, token: string, initial: NonNullable<Awaited<ReturnType<typeof readApiKey>>>, required: ApiScope[]) {
  const bucket = requireDataBucket(env);
  let current: typeof initial | null = initial;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!current || current.key.revokedAt || (current.key.expiresAt && Date.parse(current.key.expiresAt) <= Date.now())) return "unauthorized";
    if (required.some(scope => !current!.key.scopes.includes(scope))) return "insufficient_scope";
    const next = { ...current.stored, lastUsedAt: new Date().toISOString() };
    // CAS prevents touching an outdated or revoked record. A retry rechecks all credentials and scopes.
    if (await putJson(bucket, keyPath(current.key.id), next, { onlyIf: { etagMatches: normalize(current.etag) } })) return "ok";
    current = await readApiKey(env, token);
  }
  return "busy";
}
