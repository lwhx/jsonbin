import { Hono } from "hono";
import { managementSession } from "../lib/system-http";
import { queryAnalytics } from "../storage/analytics";
import { compareShadowAnalytics, shadowComparisonEnabled, shadowComparisonRange } from "../storage/analytics-engine-compare";

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

/** Opt-in management-only diagnostic; never replaces the existing KV dashboard. */
app.get("/shadow-compare", async (c) => {
  if (!shadowComparisonEnabled(c.env)) return c.json({ error: "not_found" }, 404);
  const range = c.req.query("range") || "24h";
  if (!shadowComparisonRange(range)) return c.json({ error: "invalid_range" }, 400);
  try {
    const comparison = await compareShadowAnalytics(c.env, range);
    return c.json(comparison);
  } catch {
    return c.json({ error: "analytics_compare_unavailable" }, 503);
  }
});

export default app;
