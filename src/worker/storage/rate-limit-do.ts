/**
 * SEC-002: one SQLite-backed Durable Object per credential/client identity.
 * The UPSERT is atomic even under cross-isolate concurrency. A single alarm
 * periodically checks idleness and deleteAll() reclaims the SQLite database
 * (including Cloudflare metadata) after two inactive minute windows.
 *
 * Keep this class name and its SQLite exports lifecycle during rollbacks.
 */
const WINDOW_MS = 60_000;
const REAP_CHECK_MS = 2 * WINDOW_MS;
const SQL = "CREATE TABLE IF NOT EXISTS minute_quota (id INTEGER PRIMARY KEY CHECK (id = 1), window_id INTEGER NOT NULL, used INTEGER NOT NULL)";

export class ApiRateLimiter {
  private tableReady = false;
  private alarmKnown = false;

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  private ensureTable() {
    if (this.tableReady) return;
    // Do not create a table in the constructor: it is also invoked when an
    // alarm wakes an otherwise idle object for storage cleanup.
    this.state.storage.sql.exec(SQL);
    this.tableReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.json().catch(() => null) as { limit?: unknown } | null;
    const limit = body?.limit;
    if (!Number.isSafeInteger(limit) || typeof limit !== "number" || limit < 1 || limit > 10_000) {
      return Response.json({ error: "invalid_rate_limit" }, { status: 400 });
    }

    this.ensureTable();
    const now = Date.now();
    const windowId = Math.floor(now / WINDOW_MS);
    // Dynamic per-Key limits apply without resetting a current window;
    // an explicit null opt-out is handled at the caller, before any RPC.
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

    // Checking the alarm only on the first fetch of each DO instance (or
    // after cleanup) avoids adding an alarm write to every API request.
    // The alarm itself reschedules while recent traffic is present.
    if (!this.alarmKnown) {
      const existing = await this.state.storage.getAlarm();
      if (existing === null) await this.state.storage.setAlarm(now + REAP_CHECK_MS);
      this.alarmKnown = true;
    }

    const retryAfterSeconds = accepted ? 0 : Math.max(1, Math.ceil(((windowId + 1) * WINDOW_MS - now) / 1000));
    return Response.json({ allowed: accepted, retryAfterSeconds });
  }

  async alarm(): Promise<void> {
    // Prevent a newly accepted request from racing against deleteAll() and
    // inadvertently getting its live counter erased during cleanup.
    await this.state.blockConcurrencyWhile(async () => {
      this.ensureTable();
      const last = this.state.storage.sql.exec<{ window_id: number }>(
        "SELECT window_id FROM minute_quota WHERE id = 1",
      ).toArray()[0];
      const currentWindow = Math.floor(Date.now() / WINDOW_MS);
      if (last && currentWindow - last.window_id <= 2) {
        await this.state.storage.setAlarm(Date.now() + REAP_CHECK_MS);
        this.alarmKnown = true;
        return;
      }
      // Unlike DELETE/DROP TABLE, deleteAll frees SQLite metadata and the
      // alarm itself (compatibility_date >= 2026-02-24).
      await this.state.storage.deleteAll();
      this.tableReady = false;
      this.alarmKnown = false;
    });
  }
}
