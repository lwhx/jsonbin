import { auditRequest } from "../activity";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  clearSession,
  issueSession,
  readSession,
  sessionConfigured,
} from "../auth/session";
import { base64UrlEncode, timingSafeEqualText } from "../lib/crypto";
import { allowedRequestOrigin } from "../auth/origin";
import { readBoundedJson } from "../lib/system-http";
import { checkPasswordLoginGuard, clearPasswordLoginFailures, recordPasswordLoginFailure } from "../storage/login-guard";
import { SystemError } from "../../shared/system";

const app = new Hono<{ Bindings: Env }>();

async function loginFailure(c: Context<{ Bindings: Env }>, error: string, status: 400 | 401 | 403 | 429 | 502 | 503) {
  await auditRequest(c, "auth.login_failed", null, { actor: { type: "anonymous", id: null }, provider: "anonymous" });
  return c.json({ error }, status);
}

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
});

app.get("/config", (c) => {
  return c.json({
    passwordEnabled: Boolean(
      sessionConfigured(c.env) && c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD,
    ),
    githubEnabled: Boolean(
      sessionConfigured(c.env) && c.env.GITHUB_CLIENT_ID &&
        c.env.GITHUB_CLIENT_SECRET &&
        c.env.GITHUB_ALLOWED_USER_ID,
    ),
  });
});

app.post("/login", async (c) => {
  if (!allowedRequestOrigin(c.req.raw, c.env)) return c.json({ error: "origin_not_allowed" }, 403);
  if (!sessionConfigured(c.env)) return c.json({ error: "session_not_configured" }, 503);
  // Only password login uses the authoritative R2 guard. OAuth, existing
  // sessions and API keys are unaffected by login-IP lockouts.
  let loginGuard: Awaited<ReturnType<typeof checkPasswordLoginGuard>>;
  try {
    loginGuard = await checkPasswordLoginGuard(c.env, c.req.raw);
  } catch {
    return c.json({ error: "login_guard_unavailable" }, 503);
  }
  if (loginGuard.lock) {
    c.header("Retry-After", String(loginGuard.lock.retryAfterSeconds));
    return c.json({ error: loginGuard.lock.error }, 429);
  }
  let input: unknown;
  try { input = await readBoundedJson(c.req.raw, 4096); }
  catch (error) {
    if (error instanceof SystemError && error.status === 413) return c.json({ error: error.code }, 413);
    return loginFailure(c, "invalid_request", 400);
  }
  const body = loginSchema.safeParse(input);
  if (!body.success) {
    return loginFailure(c, "invalid_request", 400);
  }

  const configuredUsername = c.env.ADMIN_USERNAME;
  const [usernameMatches, passwordMatches] = await Promise.all([
    timingSafeEqualText(body.data.username, configuredUsername ?? ''),
    timingSafeEqualText(body.data.password, c.env.ADMIN_PASSWORD ?? ''),
  ]);

  if (!usernameMatches || !passwordMatches) {
    let lock;
    try {
      lock = await recordPasswordLoginFailure(c.env, loginGuard);
    } catch {
      return c.json({ error: "login_guard_unavailable" }, 503);
    }
    if (lock) {
      c.header("Retry-After", String(lock.retryAfterSeconds));
      return loginFailure(c, lock.error, 429);
    }
    return loginFailure(c, "invalid_credentials", 401);
  }

  try {
    const lock = await clearPasswordLoginFailures(c.env, loginGuard);
    if (lock) {
      c.header("Retry-After", String(lock.retryAfterSeconds));
      return c.json({ error: lock.error }, 429);
    }
  } catch {
    return c.json({ error: "login_guard_unavailable" }, 503);
  }

  await issueSession(c, {
    id: "local-admin",
    username: configuredUsername!,
    provider: "password",
  });

  await auditRequest(c, "auth.login_succeeded", null, { actor: { type: "session", id: "local-admin" }, provider: "password" });
  return c.json({
    ok: true,
    user: {
      id: "local-admin",
      username: configuredUsername,
      provider: "password",
    },
  });
});

app.post("/logout", (c) => {
  if (!allowedRequestOrigin(c.req.raw, c.env)) return c.json({ error: "origin_not_allowed" }, 403);
  clearSession(c);
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const user = await readSession(c);
  if (!user) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, user });
});

app.get("/github", (c) => {
  if (!sessionConfigured(c.env)) return c.json({ error: "session_not_configured" }, 503);
  if (!c.env.GITHUB_CLIENT_ID || !c.env.GITHUB_CLIENT_SECRET || !c.env.GITHUB_ALLOWED_USER_ID) {
    return c.json({ error: "github_oauth_not_configured" }, 503);
  }

  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  setCookie(c, "jsonbin_oauth_state", state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const callback = new URL("/api/v1/auth/github/callback", c.req.url).toString();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);

  return c.redirect(authorize.toString());
});

app.get("/github/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, "jsonbin_oauth_state");

  if (!code || !state || !expectedState || state !== expectedState) {
    return loginFailure(c, "invalid_oauth_state", 400);
  }

  deleteCookie(c, "jsonbin_oauth_state", { path: "/" });

  if (!sessionConfigured(c.env)) return loginFailure(c, "session_not_configured", 503);

  if (
    !c.env.GITHUB_CLIENT_ID ||
    !c.env.GITHUB_CLIENT_SECRET ||
    !c.env.GITHUB_ALLOWED_USER_ID
  ) {
    return loginFailure(c, "github_oauth_not_configured", 503);
  }

  const callback = new URL("/api/v1/auth/github/callback", c.req.url).toString();

  let tokenData: { access_token?: string; error?: string };
  try {
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "jsonbin-cloudflare-v3",
        },
        body: JSON.stringify({
          client_id: c.env.GITHUB_CLIENT_ID,
          client_secret: c.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: callback,
        }),
      },
    );

    if (!tokenResponse.ok) {
      return loginFailure(c, "github_token_exchange_failed", 502);
    }

    tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };
  } catch { return loginFailure(c, "github_token_exchange_failed", 502); }

  if (typeof tokenData?.access_token !== 'string' || !tokenData.access_token) {
    return loginFailure(c, "github_token_missing", 401);
  }

  let githubUser: { id: number; login: string };
  try {
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "jsonbin-cloudflare-v3",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!userResponse.ok) {
      return loginFailure(c, "github_user_lookup_failed", 502);
    }

    githubUser = (await userResponse.json()) as {
      id: number;
      login: string;
    };
  } catch { return loginFailure(c, "github_user_lookup_failed", 502); }

  if (!githubUser || !Number.isSafeInteger(githubUser.id) || githubUser.id <= 0 ||
    typeof githubUser.login !== 'string' || !githubUser.login || githubUser.login.length > 128) {
    return loginFailure(c, "github_user_lookup_failed", 502);
  }

  if (!githubUser || String(githubUser.id) !== String(c.env.GITHUB_ALLOWED_USER_ID)) {
    return loginFailure(c, "github_user_not_allowed", 403);
  }

  await issueSession(c, {
    id: String(githubUser.id),
    username: githubUser.login,
    provider: "github",
  });

  await auditRequest(c, "auth.login_succeeded", null, { actor: { type: "session", id: String(githubUser.id) }, provider: "github" });
  return c.redirect("/");
});

export default app;
