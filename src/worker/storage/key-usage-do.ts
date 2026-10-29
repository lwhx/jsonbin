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

const CREATE_EVENT_IDS = `CREATE TABLE IF NOT EXISTS usage_event_ids (
  event_id TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL,
  timestamp TEXT NOT NULL
)`;
const EVENT_IDS_BY_DAY = "CREATE INDEX IF NOT EXISTS idx_usage_event_ids_day ON usage_event_ids(utc_day)";
const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

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
    // SQLite schema upgrades are additive: existing P22 counters remain.
    this.state.storage.sql.exec(CREATE_EVENT_IDS);
    this.state.storage.sql.exec(EVENT_IDS_BY_DAY);
    this.tableReady = true;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/usage/increment") {
      // Internal Worker stub only. No Key ID/token/IP, no arbitrary count.
      // Bound the complete payload, not just the optional Content-Length.
      const rawText = await request.text();
      if (rawText.length > 256) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      let raw: unknown;
      try { raw = JSON.parse(rawText); }
      catch { return Response.json({ error: "invalid_usage_event" }, { status: 400 }); }
      if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
          Object.keys(raw).length !== 2 ||
          !("timestamp" in raw) || !("eventId" in raw) ||
          !validTimestamp((raw as { timestamp: unknown }).timestamp) ||
          typeof (raw as { eventId: unknown }).eventId !== "string" ||
          !EVENT_ID_PATTERN.test((raw as { eventId: string }).eventId)) {
        return Response.json({ error: "invalid_usage_event" }, { status: 400 });
      }
      const { timestamp, eventId } = raw as { timestamp: string; eventId: string };
      const now = Date.now();
      const millis = Date.parse(timestamp);
      // Once a day is eligible for pruning, a replay must never resurrect it.
      // Reject stale/future timestamps so dedupe history can be bounded.
      if (millis < now - RETAIN_DAYS * ONE_DAY_MS || millis > now + MAX_FUTURE_SKEW_MS) {
        return Response.json({ error: "usage_event_out_of_window" }, { status: 422 });
      }
      const utcDay = timestamp.slice(0, 10);
      this.ensureTable();

      // The event UUID insert and aggregate UPSERT form ONE SQLite transaction.
      // A response lost after commit is safe to replay with the same ID:
      // duplicates do not change counts or last-used timestamps.
      const decision = this.state.storage.transactionSync(() => {
        const inserted = this.state.storage.sql.exec<{ event_id: string }>(
          "INSERT INTO usage_event_ids (event_id, utc_day, timestamp) VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id",
          eventId, utcDay, timestamp,
        ).toArray().length === 1;
        if (!inserted) {
          const existing = this.state.storage.sql.exec<{ utc_day: string; timestamp: string }>(
            "SELECT utc_day, timestamp FROM usage_event_ids WHERE event_id = ?", eventId,
          ).toArray()[0];
          return existing?.utc_day === utcDay && existing.timestamp === timestamp ? "duplicate" : "conflict";
        }
        this.state.storage.sql.exec(
          `INSERT INTO daily_key_usage (utc_day, authorized_uses, last_authorized_at)
           VALUES (?, 1, ?)
           ON CONFLICT(utc_day) DO UPDATE SET
             authorized_uses = daily_key_usage.authorized_uses + 1,
             last_authorized_at = MAX(daily_key_usage.last_authorized_at, excluded.last_authorized_at)`,
          utcDay, timestamp,
        );
        return "recorded";
      });

      if (decision === "conflict") {
        return Response.json({ error: "usage_event_id_conflict" }, { status: 409 });
      }
      if (!this.alarmKnown) {
        const scheduled = await this.state.storage.getAlarm();
        if (scheduled === null) await this.state.storage.setAlarm(now + NEXT_SWEEP_MS);
        this.alarmKnown = true;
      }
      return Response.json({ ok: true, deduplicated: decision === "duplicate" }, {
        headers: { "Cache-Control": "no-store" },
      });
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
      // Keep the idempotency window aligned to the daily aggregate retention.
      // A stale replay outside that window is explicitly rejected above.
      this.state.storage.sql.exec("DELETE FROM usage_event_ids WHERE utc_day < ?", cutoff);
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
