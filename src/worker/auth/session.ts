import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { SystemError } from "../../shared/system";
import {
  base64UrlDecode, base64UrlEncode, hmacSign, timingSafeEqualBase64Url,
} from "../lib/crypto";
import {
  listSessionSummaries, readSessionRegistry, registerSession, registryAuthorizes,
  revokeAllSessions, revokeSingleSession, revokeSessionId,
  type SessionPrincipal, type SessionSummary,
} from "../storage/sessions";

const COOKIE_NAME = "jsonbin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const sidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SessionUser = {
  id: string;
  username: string;
  provider: "password" | "github";
};
type SessionPayload = SessionUser & { exp: number; sid?: string; gen?: number };
export type SessionContext = { user: SessionUser; principal: SessionPrincipal };
type JsonBinContextEnv = { Bindings: Env };

export function sessionConfigured(env: Env) {
  return typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32;
}
function sessionSecret<T extends JsonBinContextEnv>(c: Context<T>) {
  const secret = c.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new SystemError(503, "session_not_configured");
  return secret;
}

/** Register the SID durably BEFORE sending the signed persistent Cookie. */
export async function issueSession<T extends JsonBinContextEnv>(c: Context<T>, user: SessionUser) {
  const now = Date.now();
  const sid = crypto.randomUUID();
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const gen = await registerSession(c.env, sid, { exp, issuedAt: now, provider: user.provider });
  const payload: SessionPayload = { ...user, exp, sid, gen };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(sessionSecret(c), encoded);
  setCookie(c, COOKIE_NAME, `${encoded}.${signature}`, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}
export function clearSession(c: Context) {
  deleteCookie(c, COOKIE_NAME, {
    path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:",
  });
}

/** Verify signature and cookie structure before looking up authoritative R2 state. */
async function readSignedCookie<T extends JsonBinContextEnv>(c: Context<T>): Promise<SessionContext | null> {
  if (!sessionConfigured(c.env)) return null;
  const token = getCookie(c, COOKIE_NAME);
  if (!token || token.length > 4096) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encoded, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
    const bytes = base64UrlDecode(encoded);
    if (base64UrlEncode(bytes) !== encoded || base64UrlEncode(base64UrlDecode(signature)) !== signature) return null;
    const expected = await hmacSign(sessionSecret(c), encoded);
    if (!await timingSafeEqualBase64Url(signature, expected)) return null;
    const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const claims = JSON.parse(json) as SessionPayload;
    if (!claims || typeof claims !== "object" ||
        typeof claims.id !== "string" || !claims.id || claims.id.length > 128 ||
        typeof claims.username !== "string" || !claims.username || claims.username.length > 128 ||
        !["password", "github"].includes(claims.provider) ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;

    const user: SessionUser = { id: claims.id, username: claims.username, provider: claims.provider };
    if (claims.sid === undefined && claims.gen === undefined) {
      // A finite migration period for cookies issued before SID support.
      const legacyDigest = await hmacSign(sessionSecret(c), `legacy-session/v1\0${token}`);
      return { user, principal: { exp: claims.exp, provider: claims.provider, legacyDigest } };
    }
    if (typeof claims.sid !== "string" || !sidPattern.test(claims.sid) ||
        !Number.isSafeInteger(claims.gen) || (claims.gen as number) < 1) return null;
    return { user, principal: { exp: claims.exp, provider: claims.provider, sid: claims.sid, gen: claims.gen } };
  } catch {
    return null;
  }
}

/** R2 outage is not an invalid Cookie: throw 503, never erase the Cookie. */
export async function readSessionContext<T extends JsonBinContextEnv>(c: Context<T>): Promise<SessionContext | null> {
  const signed = await readSignedCookie(c);
  if (!signed) return null;
  const registry = await readSessionRegistry(c.env);
  if (!registryAuthorizes(registry?.value ?? null, signed.principal)) return null;
  return signed;
}
export async function readSession<T extends JsonBinContextEnv>(c: Context<T>): Promise<SessionUser | null> {
  return (await readSessionContext(c))?.user ?? null;
}

/** Idempotent logout; revokes the signed Cookie server-side before clearing it. */
export async function revokeCurrentSession<T extends JsonBinContextEnv>(c: Context<T>): Promise<void> {
  const current = await readSessionContext(c);
  if (current) await revokeSingleSession(c.env, current.principal);
}

export async function revokeEverySession(c: Context<any>): Promise<void> {
  const current = await readSessionContext(c);
  if (!current) throw new SystemError(401, "unauthorized");
  await revokeAllSessions(c.env, current.principal);
}

export async function listCurrentSessions(c: Context<any>): Promise<SessionSummary[]> {
  const current = await readSessionContext(c);
  if (!current) throw new SystemError(401, "unauthorized");
  return listSessionSummaries(c.env, current.principal.sid);
}

export async function revokeSessionById(c: Context<any>, sid: string): Promise<boolean> {
  return revokeSessionId(c.env, sid);
}

export async function currentSessionId(c: Context<any>): Promise<string | null> {
  return (await readSessionContext(c))?.principal.sid ?? null;
}
