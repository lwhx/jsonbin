import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import authRoutes from "./routes/auth";
import binRoutes from "./routes/bins";
import collectionRoutes from "./routes/collections";
import { version } from "../../package.json";

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.use("/api/*", secureHeaders());

app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.APP_ORIGIN;
      if (!allowed) return origin;
      return origin === allowed ? origin : allowed;
    },
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    exposeHeaders: ["ETag", "X-JSONBin-Version"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/bins", binRoutes);
app.route("/api/v1/collections", collectionRoutes);

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
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/v1", (c) => {
  return c.json({
    name: "JSONBin API",
    version: "v1",
    status: "alpha",
  });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));

app.onError((error, c) => {
  console.error("request_failed", {
    message: error.message,
    path: c.req.path,
    method: c.req.method,
  });

  return c.json({ error: "internal_server_error" }, 500);
});

export default app;
