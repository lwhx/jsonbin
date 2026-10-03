import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
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

function sessionSecret(c: Context<{ Bindings: Env }>) {
  const secret = c.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

export async function issueSession(
  c: Context<{ Bindings: Env }>,
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
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function readSession(
  c: Context<{ Bindings: Env }>,
): Promise<SessionUser | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = await hmacSign(sessionSecret(c), encodedPayload);
  const valid = await timingSafeEqualBase64Url(signature, expected);
  if (!valid) return null;

  try {
    const json = new TextDecoder().decode(base64UrlDecode(encodedPayload));
    const payload = JSON.parse(json) as SessionPayload;
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return {
      id: payload.id,
      username: payload.username,
      provider: payload.provider,
    };
  } catch {
    return null;
  }
}
