/**
 * SEC-002: one SQLite-backed Durable Object per credential/client identity.
 * The single-row UPSERT is atomic even with simultaneous requests from
 * different Worker isolates / locations. KV never decides authorization.
 */
const WINDOW_MS = 60_000;

export class ApiRateLimiter {
  constructor(private readonly state: DurableObjectState, _env: Env) {
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS minute_quota (id INTEGER PRIMARY KEY CHECK (id = 1), window_id INTEGER NOT NULL, used INTEGER NOT NULL)",
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json().catch(() => null) as { limit?: unknown } | null;
    const limit = body?.limit;
    if (!Number.isSafeInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 10_000) {
      return Response.json({ error: "invalid_rate_limit" }, { status: 400 });
    }

    const now = Date.now();
    const windowId = Math.floor(now / WINDOW_MS);
    // A change in the configured per-key limit takes effect on the next
    // request without resetting the counter; null limits skip this RPC.
    const accepted = this.state.storage.sql.exec<{ used: number }>(
      `INSERT INTO minute_quota (id, window_id, used) VALUES (1, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         used = CASE WHEN minute_quota.window_id = excluded.window_id
                     THEN minute_quota.used + 1 ELSE 1 END,
         window_id = excluded.window_id
       WHERE minute_quota.window_id <> excluded.window_id OR minute_quota.used < ?
       RETURNING used`,
      windowId, limit,
    ).toArray().length === 1;

    const retryAfterSeconds = accepted ? 0 : Math.max(1, Math.ceil(((windowId + 1) * WINDOW_MS - now) / 1000));
    return Response.json({ allowed: accepted, retryAfterSeconds });
  }
}
