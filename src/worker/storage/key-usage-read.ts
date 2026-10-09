import { ANALYTICS_PREFIX, ANALYTICS_SHARDS_COUNT } from './analytics.ts';

/** Disposable, eventually-consistent usage observations (never used for authorization). */
export type UsageIncrement = { count: number; lastUsedAt: string | null };
export type DailyUsageSnapshot = {
  day: string;
  status: 'ok' | 'unavailable';
  byKey: Record<string, UsageIncrement>;
  asOf: string | null;
};

const invalid = (day: string): DailyUsageSnapshot => ({ day, status: 'unavailable', byKey: {}, asOf: null });
const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(day + 'T00:00:00.000Z').toISOString().slice(0, 10) === day;

export async function readDailyKeyUsage(env: Env, utcDay: string, nowMs = Date.now()): Promise<DailyUsageSnapshot> {
  if (!env.CACHE || !validDay(utcDay) || !Number.isFinite(nowMs)) return invalid(utcDay);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  if (utcDay > today) return invalid(utcDay);
  const hourCount = utcDay === today ? new Date(nowMs).getUTCHours() + 1 : 24;
  const keys: string[] = [];
  for (let i = 0; i < hourCount; i++) {
    const prefix = `${ANALYTICS_PREFIX}${utcDay}T${String(i).padStart(2, '0')}`;
    keys.push(prefix);
    for (let shard = 0; shard < ANALYTICS_SHARDS_COUNT; shard++) keys.push(`${prefix}:${shard}`);
  }
  const byKey: Record<string, UsageIncrement> = Object.create(null);
  try {
    for (let offset = 0; offset < keys.length; offset += 100) {
      const chunk = keys.slice(offset, offset + 100);
      const records = await env.CACHE.get(chunk, 'json');
      if (!(records instanceof Map)) return invalid(utcDay);
      for (const key of chunk) {
        const bucket = records.get(key);
        if (bucket === null || bucket === undefined) continue;
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) return invalid(utcDay);
        if (bucket.keys === undefined) continue;
        if (!bucket.keys || typeof bucket.keys !== 'object' || Array.isArray(bucket.keys)) return invalid(utcDay);
        for (const [id, raw] of Object.entries(bucket.keys as Record<string, unknown>)) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(utcDay);
          const observation = raw as { authorizedUses?: unknown; lastAuthorizedAt?: unknown };
          if (observation.authorizedUses === undefined) continue; // Legacy metrics do not prove qualified usage.
          const count = observation.authorizedUses;
          if (!Number.isSafeInteger(count) || (count as number) < 0) return invalid(utcDay);
          const stamp = observation.lastAuthorizedAt;
          if (stamp !== undefined && stamp !== null &&
              (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp)) || !stamp.startsWith(utcDay))) return invalid(utcDay);
          const current = byKey[id] ?? { count: 0, lastUsedAt: null };
          current.count += count as number;
          if (!Number.isSafeInteger(current.count)) return invalid(utcDay);
          if (typeof stamp === 'string' && (!current.lastUsedAt || current.lastUsedAt < stamp)) current.lastUsedAt = stamp;
          byKey[id] = current;
        }
      }
    }
    return { day: utcDay, status: 'ok', byKey, asOf: new Date(nowMs).toISOString() };
  } catch {
    return invalid(utcDay);
  }
}
