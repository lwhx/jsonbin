import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { verifyPassword } from "../auth/password";
import {
  clearSession,
  issueSession,
  readSession,
} from "../auth/session";
import { base64UrlEncode } from "../lib/crypto";

const app = new Hono<{ Bindings: Env }>();

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
});

app.get("/config", (c) => {
  return c.json({
    passwordEnabled: Boolean(
      c.env.ADMIN_USERNAME && c.env.ADMIN_PASSWORD_HASH,
    ),
    githubEnabled: Boolean(
      c.env.GITHUB_CLIENT_ID &&
        c.env.GITHUB_CLIENT_SECRET &&
        c.env.GITHUB_ALLOWED_USER_ID,
    ),
  });
});

app.post("/login", async (c) => {
  const body = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: "invalid_request" }, 400);
  }

  const configuredUsername = c.env.ADMIN_USERNAME;
  const usernameMatches =
    Boolean(configuredUsername) && body.data.username === configuredUsername;
  const passwordMatches = await verifyPassword(
    body.data.password,
    c.env.ADMIN_PASSWORD_HASH,
  );

  if (!usernameMatches || !passwordMatches) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  await issueSession(c, {
    id: "local-admin",
    username: configuredUsername!,
    provider: "password",
  });

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
  clearSession(c);
  return c.json({ ok: true });
});

app.get("/me", async (c) => {
  const user = await readSession(c);
  if (!user) return c.json({ authenticated: false }, 401);
  return c.json({ authenticated: true, user });
});

app.get("/github", (c) => {
  if (!c.env.GITHUB_CLIENT_ID) {
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
    return c.json({ error: "invalid_oauth_state" }, 400);
  }

  deleteCookie(c, "jsonbin_oauth_state", { path: "/" });

  if (
    !c.env.GITHUB_CLIENT_ID ||
    !c.env.GITHUB_CLIENT_SECRET ||
    !c.env.GITHUB_ALLOWED_USER_ID
  ) {
    return c.json({ error: "github_oauth_not_configured" }, 503);
  }

  const callback = new URL("/api/v1/auth/github/callback", c.req.url).toString();

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
    return c.json({ error: "github_token_exchange_failed" }, 502);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };

  if (!tokenData.access_token) {
    return c.json({ error: tokenData.error ?? "github_token_missing" }, 401);
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": "jsonbin-cloudflare-v3",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!userResponse.ok) {
    return c.json({ error: "github_user_lookup_failed" }, 502);
  }

  const githubUser = (await userResponse.json()) as {
    id: number;
    login: string;
  };

  if (String(githubUser.id) !== String(c.env.GITHUB_ALLOWED_USER_ID)) {
    return c.json({ error: "github_user_not_allowed" }, 403);
  }

  await issueSession(c, {
    id: String(githubUser.id),
    username: githubUser.login,
    provider: "github",
  });

  return c.redirect("/");
});

export default app;
