import { SystemError } from "../../shared/system";
import { getJson, putJson, requireDataBucket } from "./r2";

/**
 * One strongly-consistent R2 document for a single-owner deployment.
 * Authentication does ONE GET and no writes; registration/revocation use CAS.
 * Never serve authoritative revocation data from eventually-consistent KV.
 */
const PATH = "system/auth/sessions.json";
const VERSION = 1;
const MAX_ACTIVE = 512;
const MAX_REVOKED_LEGACY = 512;
const MAX_RETRIES = 16;

export type RegisteredSession = {
  exp: number;
  issuedAt: number;
  provider: "password" | "github";
};
export type SessionRegistry = {
  version: 1;
  generation: number;
  legacyDisabled: boolean;
  sessions: Record<string, RegisteredSession>;
  legacyRevoked: Record<string, number>;
};
type Stored = { value: SessionRegistry; etag: string } | null;
export type SessionPrincipal = {
  sid?: string;
  gen?: number;
  exp: number;
  provider: RegisteredSession["provider"];
  legacyDigest?: string;
};
export type SessionSummary = { id: string; provider: RegisteredSession["provider"]; issuedAt: string; expiresAt: string; current: boolean };

const sidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[A-Za-z0-9_-]{43}$/;
const safeInt = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const fail = (): never => { throw new SystemError(503, "session_state_unavailable"); };
const normalize = (etag: string) => etag.replace(/^"(.*)"$/, "$1");

function validate(raw: unknown): SessionRegistry {
  if (!plain(raw) || raw.version !== VERSION || !safeInt(raw.generation) || raw.generation === 0 ||
      typeof raw.legacyDisabled !== "boolean" || !plain(raw.sessions) || !plain(raw.legacyRevoked)) return fail();
  const sessions = Object.entries(raw.sessions);
  const legacy = Object.entries(raw.legacyRevoked);
  if (sessions.length > MAX_ACTIVE || legacy.length > MAX_REVOKED_LEGACY) return fail();
  for (const [sid, entry] of sessions) {
    if (!sidPattern.test(sid) || !plain(entry) || !safeInt(entry.exp) || !safeInt(entry.issuedAt) ||
        (entry.provider !== "password" && entry.provider !== "github")) return fail();
  }
  for (const [digest, exp] of legacy) if (!digestPattern.test(digest) || !safeInt(exp)) return fail();
  return raw as SessionRegistry;
}

const empty = (): SessionRegistry => ({
  version: VERSION, generation: 1, legacyDisabled: false, sessions: {}, legacyRevoked: {},
});
function prune(value: SessionRegistry, now: number) {
  for (const [sid, entry] of Object.entries(value.sessions)) {
    if (entry.exp * 1000 <= now) delete value.sessions[sid];
  }
  for (const [digest, exp] of Object.entries(value.legacyRevoked)) {
    if (exp * 1000 <= now) delete value.legacyRevoked[digest];
  }
}
function copied(value: SessionRegistry): SessionRegistry {
  return { ...value, sessions: { ...value.sessions }, legacyRevoked: { ...value.legacyRevoked } };
}

export async function readSessionRegistry(env: Env): Promise<Stored> {
  try {
    const loaded = await getJson<unknown>(requireDataBucket(env), PATH);
    return loaded ? { value: validate(loaded.value), etag: loaded.etag } : null;
  } catch {
    return fail();
  }
}
async function mutate<T>(env: Env, change: (draft: SessionRegistry) => { value: T; write: boolean }, now = Date.now()): Promise<T> {
  const bucket = requireDataBucket(env);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await readSessionRegistry(env);
    const draft = copied(current?.value ?? empty());
    const before = JSON.stringify(draft);
    prune(draft, now);
    const result = change(draft);
    if (!result.write && before === JSON.stringify(draft)) return result.value;
    const onlyIf = current ? { etagMatches: normalize(current.etag) } : { etagDoesNotMatch: "*" };
    try {
      if (await putJson(bucket, PATH, draft, { onlyIf })) return result.value;
    } catch {
      return fail();
    }
  }
  return fail();
}

export async function registerSession(env: Env, sid: string, entry: RegisteredSession): Promise<number> {
  if (!sidPattern.test(sid) || !safeInt(entry.exp) || !safeInt(entry.issuedAt)) return fail();
  return mutate(env, draft => {
    if (Object.keys(draft.sessions).length >= MAX_ACTIVE) return fail();
    draft.sessions[sid] = entry;
    return { value: draft.generation, write: true };
  });
}

export function registryAuthorizes(registry: SessionRegistry | null, principal: SessionPrincipal, now = Date.now()): boolean {
  if (principal.sid && principal.gen !== undefined) {
    if (!registry || principal.gen !== registry.generation) return false;
    const stored = registry.sessions[principal.sid];
    return Boolean(stored && stored.exp === principal.exp && stored.provider === principal.provider && stored.exp * 1000 > now);
  }
  if (!principal.legacyDigest || now >= Date.UTC(2026, 9, 25)) return false;
  if (!registry) return true;
  return !registry.legacyDisabled && !(principal.legacyDigest in registry.legacyRevoked);
}

export async function revokeSingleSession(env: Env, principal: SessionPrincipal): Promise<void> {
  await mutate(env, draft => {
    if (!registryAuthorizes(draft, principal)) return { value: undefined, write: false };
    if (principal.sid) {
      delete draft.sessions[principal.sid];
    } else if (principal.legacyDigest) {
      if (Object.keys(draft.legacyRevoked).length >= MAX_REVOKED_LEGACY) return fail();
      draft.legacyRevoked[principal.legacyDigest] = principal.exp;
    }
    return { value: undefined, write: true };
  });
}

export async function revokeSessionId(env: Env, id: string): Promise<boolean> {
  if (!sidPattern.test(id)) return false;
  return mutate(env, draft => {
    if (!Object.hasOwn(draft.sessions, id)) return { value: false, write: false };
    delete draft.sessions[id];
    return { value: true, write: true };
  });
}

export async function revokeAllSessions(env: Env, principal: SessionPrincipal): Promise<void> {
  await mutate(env, draft => {
    if (!registryAuthorizes(draft, principal)) throw new SystemError(401, "unauthorized");
    if (draft.generation === Number.MAX_SAFE_INTEGER) return fail();
    draft.generation += 1;
    draft.sessions = {};
    draft.legacyRevoked = {};
    draft.legacyDisabled = true;
    return { value: undefined, write: true };
  });
}

export async function listSessionSummaries(env: Env, currentSid?: string): Promise<SessionSummary[]> {
  const registry = await readSessionRegistry(env);
  if (!registry) return [];
  const now = Date.now();
  return Object.entries(registry.value.sessions)
    .filter(([, value]) => value.exp * 1000 > now)
    .map(([id, value]) => ({
      id, provider: value.provider,
      issuedAt: new Date(value.issuedAt).toISOString(),
      expiresAt: new Date(value.exp * 1000).toISOString(),
      current: id === currentSid,
    }))
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
}

/** Scheduled once daily; no write when nothing has expired. */
export async function pruneExpiredSessions(env: Env, now = Date.now()): Promise<void> {
  const present = await readSessionRegistry(env);
  if (!present) return;
  await mutate(env, draft => ({ value: undefined, write: false }), now);
}
