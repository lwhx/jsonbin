import systemRoutes from './routes/system';
import searchRoutes from './routes/search';
import { recordActivity } from "./activity";
import { pruneActivity } from "./storage/activity";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import activityRoutes from "./routes/activity";
import keyRoutes from "./routes/keys";
import authRoutes from "./routes/auth";
import binRoutes, { slugApp } from "./routes/bins";
import schemaRoutes from "./routes/schemas";
import collectionRoutes from "./routes/collections";
import trashRoutes from "./routes/trash";
import templateRoutes from "./routes/templates";
import webhookRoutes from "./routes/webhooks";
import analyticsRoutes from "./routes/analytics";
import mcpRoutes from "./routes/mcp";
import { generateOpenApiSpec } from "../shared/openapi";
import { sweepBins } from "./storage/trash";
import { dispatchWebhooks, sweepWebhookDeliveries } from "./storage/webhooks";
import { recordAnalytics, normalizeRoute, type AnalyticsDataPoint } from "./storage/analytics";
import { shadowAnalyticsEvent } from "./storage/analytics-engine-shadow";
import { recordKeyUsageShadow } from "./storage/key-usage-do-shadow";
import { enqueueKeyUsageShadow, consumeKeyUsageEvents, archiveKeyUsageDeadLetters } from "./storage/key-usage-queue";
import { settleRecentKeyUsage } from "./storage/key-usage";
import { pruneExpiredPasswordGuards } from "./storage/login-guard";
import { version } from "../../package.json";
import { applicationOrigin } from "./auth/origin";

// This named export provisions the SQLite-backed Durable Object class.
export { ApiRateLimiter } from "./storage/rate-limit-do";
// P22: a separate, optional durable usage shadow; NEVER share the limiter DO.
export { ApiKeyUsageCounter } from "./storage/key-usage-do";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

// Named export for contract tests (route coverage against the OpenAPI spec).
export { app };

app.use("/api/*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  c.header("Cache-Control", "no-store");
  const start = performance.now();

  await next();

  const durationMs = Math.round(performance.now() - start);
  const url = new URL(c.req.url);
  const route = normalizeRoute(url.pathname);
  // Report the identity the auth middlewares actually established, not a guess
  // from header names: a rejected Bearer attempt still counts as api_key.
  const authenticatedKey = (c.get as any)("apiKey");
  const authenticatedUser = (c.get as any)("user");
  const authType = authenticatedKey
    ? "api_key"
    : authenticatedUser
      ? "session"
      : c.req.header("Authorization")
        ? "api_key"
        : "anonymous";
  const status = c.res.status;
  const keyId = authenticatedKey?.id ?? (c.get("apiKeyId" as any)) ?? null;

  // Best-effort metrics: never block the response, never fail the request.
  // CORS preflights are browser infrastructure, not business requests: one
  // precedes every cross-origin write and carries no dashboard signal, so
  // recording them would double analytics KV traffic for pure noise.
  const point: AnalyticsDataPoint = {
    timestamp: new Date().toISOString(),
    method: c.req.method,
    route,
    status,
    durationMs,
    authType,
    keyId,
    qualifiedKeyUse: Boolean(authenticatedKey) && ![401, 403, 429].includes(status),
  };
  // Shadow only: opt-in Analytics Engine event does not affect authoritative
  // KV rollups, daily Key usage settlement or API business responses.
  if (c.req.method !== "OPTIONS") shadowAnalyticsEvent(c.env, point);
  const record = c.req.method === "OPTIONS"
    ? null
    : recordAnalytics(c.env, point).catch(() => {});
  // P22: independent SQLite shadow writes ONLY for permitted API Key use.
  // No flag means no DO RPC, no extra cost and no behavioral change. A shadow
  // error cannot change the response or existing KV/R2 usage bookkeeping.
  // Optional Queue transport is awaited, not deferred to waitUntil. This makes
  // successful enqueue durable before returning, while leaving API results intact.
  const queued = c.req.method !== "OPTIONS" && c.env.KEY_USAGE_QUEUE_SHADOW === "1" &&
    point.authType === "api_key" && point.qualifiedKeyUse
    ? await enqueueKeyUsageShadow(c.env, point, requestId)
    : false;
  const shadowUsage = !queued && c.req.method !== "OPTIONS" && c.env.KEY_USAGE_DO_SHADOW === "1" &&
    point.authType === "api_key" && point.qualifiedKeyUse
    ? recordKeyUsageShadow(c.env, point, requestId)
    : null;

  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    const ctx = c.executionCtx;
    waitUntil = (promise) => ctx.waitUntil(promise);
  } catch {
    waitUntil = undefined;
  }

  const pending: Promise<unknown>[] = [];
  if (record) pending.push(record);
  if (shadowUsage) pending.push(shadowUsage);
  if (pending.length) {
    // Keep both independent best-effort observers alive after the response.
    // In direct worker.fetch tests, complete both before returning.
    const completion = Promise.allSettled(pending);
    if (waitUntil) waitUntil(completion);
    else await completion;
  }
});
app.use("/api/*", secureHeaders({
  xFrameOptions: 'DENY',
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
}));

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      return origin === applicationOrigin(c.req.raw, c.env) ? origin : null;
    },
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    exposeHeaders: ["ETag", "X-JSONBin-Version", "X-Request-ID", "Retry-After"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.route("/api/v1/system", systemRoutes);
app.route("/api/v1/search", searchRoutes);
app.route("/api/v1/activity", activityRoutes);
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/keys", keyRoutes);
app.route("/api/v1/bins", binRoutes);
app.route("/api/v1/b", slugApp);
app.route("/api/v1/collections", collectionRoutes);
app.route("/api/v1/schemas", schemaRoutes);
app.route("/api/v1/trash", trashRoutes);
app.route("/api/v1/templates", templateRoutes);
app.route("/api/v1/webhooks", webhookRoutes);
app.route("/api/v1/analytics", analyticsRoutes);
app.route("/api/v1/mcp", mcpRoutes);

app.get("/api/v1/openapi.json", (c) => {
  return c.json(generateOpenApiSpec());
});

app.get("/api/v1/system/health", (c) => {
  return c.json({
    ok: true,
    service: "jsonbin",
    version,
    runtime: "cloudflare-workers",
    storage: {
      r2: Boolean(c.env.DATA),
      kv: Boolean(c.env.CACHE),
    },
    // Binding-presence signal, not proof the Durable Object RPC/SQLite works.
    // The release gate must still exercise a real Key and 429 in production.
    rateLimiterConfigured: Boolean(c.env.RATE_LIMITER),
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1", (c) => {
  return c.json({
    name: "JSONBin API",
    version: "v1",
    status: "stable",
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("request_failed", {
    requestId: c.get("requestId"),
    method: c.req.method,
  });

  return c.json({ error: "internal_server_error" }, 500);
});

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Separate consumer gate; producer shutdown must not implicitly drop an
    // existing backlog, and a stray production binding must fail closed.
    if (env.KEY_USAGE_CONSUMER_ENABLED !== "1") throw new Error("usage_queue_consumer_disabled");
    if (batch.queue.startsWith("jsonbin-key-usage-dlq-")) {
      await archiveKeyUsageDeadLetters(batch, env);
    } else {
      await consumeKeyUsageEvents(batch, env);
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    const requestId = crypto.randomUUID();
    const [sweep] = await Promise.allSettled([sweepBins(env, Date.now(), async ({ action, id }) => {
      await Promise.allSettled([
        recordActivity(env, { action, resourceId: id, requestId, identity: { actor: { type: "system", id: null }, provider: "system" } }),
        dispatchWebhooks(env, { action, resourceId: id, actor: { type: "system", id: null }, requestId }),
      ]);
    })]);
    // Prune after system events settle, even when Bin maintenance failed.
    const [prune, webhookSweep, keyUsage] = await Promise.allSettled([
      pruneActivity(env), sweepWebhookDeliveries(env), settleRecentKeyUsage(env, controller.scheduledTime ?? Date.now()),
    ]);
    if (keyUsage.status === "rejected") console.error("scheduled_key_usage_failed", { requestId });
    // A daily, bounded pass removes expired authoritative IP lock records.
    // Never block scheduled Bin/Webhook maintenance if cleanup is unavailable.
    const scheduledAt = controller.scheduledTime ?? Date.now();
    const utc = new Date(scheduledAt);
    if (utc.getUTCHours() === 3 && utc.getUTCMinutes() === 0) {
      const [loginCleanup] = await Promise.allSettled([pruneExpiredPasswordGuards(env, scheduledAt)]);
      if (loginCleanup.status === "rejected") console.error("scheduled_login_guard_cleanup_failed", { requestId });
    }
    if (sweep.status === "rejected" || prune.status === "rejected" || webhookSweep.status === "rejected") {
      console.error("scheduled_maintenance_failed", { requestId, bins: sweep.status, activity: prune.status, webhooks: webhookSweep.status });
      throw new Error("scheduled_maintenance_failed");
    }
  },
};
