/**
 * P22: optional SQLite-backed per-API-Key usage shadow.
 *
 * One Durable Object per canonical API Key UUID, independent of ApiRateLimiter.
 * Every qualified request increments one UTC-day row atomically. The existing
 * KV counters, R2 settlement, authentication and limits remain authoritative.
 *
 * There is no externally exposed route to this object. The only caller is
 * the same Worker's internal Durable Object namespace binding.
 */
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS daily_key_usage (
  utc_day TEXT PRIMARY KEY,
  authorized_uses INTEGER NOT NULL CHECK (authorized_uses >= 0),
  last_authorized_at TEXT NOT NULL
)`;

const ONE_DAY_MS = 86_400_000;
const RETAIN_DAYS = 35;
const NEXT_SWEEP_MS = ONE_DAY_MS;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validDay(input: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(input) &&
    !Number.isNaN(Date.parse(input + "T00:00:00.000Z")) &&
    new Date(input + "T00:00:00.000Z").toISOString().slice(0, 10) === input;
}

function validTimestamp(input: unknown): input is string {
  if (typeof input !== "string" || !ISO_UTC.test(input)) return false;
  const millis = Date.parse(input);
  return Number.isFinite(millis) && new Date(millis).toISOString() === input;
}

export class ApiKeyUsageCounter {
  private tableReady = false;
  private alarmKnown = false;

  constructor(private readonly state: DurableObjectState, _env: Env) {}

  private ensureTable() {
    if (this.tableReady) return;
    this.state.storage.sql.exec(CREATE_TABLE);
    this.tableReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/usage/increment") {
      // Only an internal Worker stub calls this endpoint. Never accept a Key ID,
      // token, requester IP, or arbitrary count value in the request body.
      const declaredSize = Number(request.headers.get("content-length") ?? "0");
      if (!Number.isFinite(declaredSize) || declaredSize > 256) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const raw: unknown = await request.json().catch(() => null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
          Object.keys(raw).length !== 1 || !("timestamp" in raw) ||
          !validTimestamp((raw as { timestamp: unknown }).timestamp)) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const timestamp = (raw as { timestamp: string }).timestamp;
      const utcDay = timestamp.slice(0, 10);
      this.ensureTable();
      // A single SQLite UPSERT is serializable under concurrent DO RPCs.
      // No app-level read/modify/write, no shared per-hour KV shard collision.
      this.state.storage.sql.exec(
        `INSERT INTO daily_key_usage (utc_day, authorized_uses, last_authorized_at)
         VALUES (?, 1, ?)
         ON CONFLICT(utc_day) DO UPDATE SET
           authorized_uses = daily_key_usage.authorized_uses + 1,
           last_authorized_at = MAX(daily_key_usage.last_authorized_at, excluded.last_authorized_at)`,
        utcDay, timestamp,
      );

      if (!this.alarmKnown) {
        const scheduled = await this.state.storage.getAlarm();
        if (scheduled === null) await this.state.storage.setAlarm(Date.now() + NEXT_SWEEP_MS);
        this.alarmKnown = true;
      }
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }

    if (request.method === "GET" && pathname.startsWith("/usage/day/")) {
      const day = pathname.slice("/usage/day/".length);
      if (!validDay(day)) return Response.json({ error: "invalid_utc_day" }, { status: 400 });
      this.ensureTable();
      const row = this.state.storage.sql.exec<{ authorized_uses: number; last_authorized_at: string }>(
        "SELECT authorized_uses, last_authorized_at FROM daily_key_usage WHERE utc_day = ?", day,
      ).toArray()[0];
      return Response.json({
        day,
        count: row?.authorized_uses ?? 0,
        lastUsedAt: row?.last_authorized_at ?? null,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    return new Response(null, { status: 405 });
  }

  async alarm(): Promise<void> {
    // Pruning shares the DO's concurrency gate with ongoing writes; never
    // erase an active Key counter when the cleanup alarm races with a request.
    await this.state.blockConcurrencyWhile(async () => {
      this.ensureTable();
      const cutoff = new Date(Date.now() - RETAIN_DAYS * ONE_DAY_MS).toISOString().slice(0, 10);
      this.state.storage.sql.exec("DELETE FROM daily_key_usage WHERE utc_day < ?", cutoff);
      const remaining = this.state.storage.sql.exec<{ utc_day: string }>(
        "SELECT utc_day FROM daily_key_usage LIMIT 1",
      ).toArray();
      if (remaining.length) {
        await this.state.storage.setAlarm(Date.now() + NEXT_SWEEP_MS);
        this.alarmKnown = true;
      } else {
        // Reclaim even the SQLite metadata of an expired, inactive Key.
        await this.state.storage.deleteAll();
        this.tableReady = false;
        this.alarmKnown = false;
      }
    });
  }
}
