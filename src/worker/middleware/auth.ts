import type { MiddlewareHandler } from "hono";
import { readSession, type SessionUser } from "../auth/session";

type Variables = {
  user: SessionUser;
};

export const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const user = await readSession(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  c.set("user", user);
  await next();
};
