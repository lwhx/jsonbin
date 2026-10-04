import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import { SystemError } from "../../shared/system";
import {
  base64UrlDecode,
  base64UrlEncode,
  hmacSign,
  timingSafeEqualBase64Url,
} from "../lib/crypto";

const COOKIE_NAME = "jsonbin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export type SessionUser = {
  id: string;
  username: string;
  provider: "password" | "github";
};

type SessionPayload = SessionUser & {
  exp: number;
};

type JsonBinContextEnv = { Bindings: Env };

export function sessionConfigured(env: Env) {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= 32;
}

function sessionSecret<T extends JsonBinContextEnv>(c: Context<T>) {
  const secret = c.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new SystemError(503, "session_not_configured");
  }
  return secret;
}

export async function issueSession<T extends JsonBinContextEnv>(
  c: Context<T>,
  user: SessionUser,
) {
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(sessionSecret(c), encodedPayload);
  const token = `${encodedPayload}.${signature}`;

  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSession(c: Context) {
  deleteCookie(c, COOKIE_NAME, { path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:" });
}

export async function readSession<T extends JsonBinContextEnv>(
  c: Context<T>,
): Promise<SessionUser | null> {
  if (!sessionConfigured(c.env)) return null;
  try {
    const token = getCookie(c, COOKIE_NAME);
    if (!token || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [encodedPayload, signature] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
    const bytes = base64UrlDecode(encodedPayload);
    if (base64UrlEncode(bytes) !== encodedPayload || base64UrlEncode(base64UrlDecode(signature)) !== signature) return null;
    const expected = await hmacSign(sessionSecret(c), encodedPayload);
    if (!await timingSafeEqualBase64Url(signature, expected)) return null;
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const payload = JSON.parse(json) as SessionPayload;
    if (!payload || typeof payload !== 'object' ||
      typeof payload.id !== 'string' || !payload.id || payload.id.length > 128 ||
      typeof payload.username !== 'string' || !payload.username || payload.username.length > 128 ||
      !['password', 'github'].includes(payload.provider) ||
      !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return {
      id: payload.id,
      username: payload.username,
      provider: payload.provider,
    };
  } catch {
    return null;
  }
}
