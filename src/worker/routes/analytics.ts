import { Hono } from "hono";
import { managementSession } from "../lib/system-http";
import { queryAnalytics } from "../storage/analytics";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

// Management Session only - Bearer tokens are prohibited
app.use("*", managementSession);

app.get("/overview", async (c) => {
  const range = c.req.query("range") || "24h";
  const hours = range === "1h" ? 1 : range === "7d" ? 168 : range === "30d" ? 720 : 24;
  const data = await queryAnalytics(c.env, hours);
  return c.json(data);
});

export default app;
