export { readDailyKeyUsage } from './key-usage-read';
export type { DailyUsageSnapshot, UsageIncrement } from './key-usage-read';

import { readDailyKeyUsage } from './key-usage-read';
import { applyAuthorizedUsageDay, listKeysWithUsageState } from './keys';

/** Settle at most three completed UTC days with resumable CAS-guarded checkpoints. */
export async function settleRecentKeyUsage(
  env: Env, nowMs = Date.now(),
): Promise<{ scannedDays: string[]; applied: number; delayedDays: string[] }> {
  const result = { scannedDays: [] as string[], applied: 0, delayedDays: [] as string[] };
  if (!env.CACHE || !env.DATA || !Number.isFinite(nowMs)) return result;
  const now = new Date(nowMs);
  const todayUTC = now.toISOString().slice(0, 10);
  for (let back = 1; back <= 3; back++) {
    const day = new Date(nowMs - back * 86400000).toISOString().slice(0, 10);
    if (day >= todayUTC || (back === 1 && (now.getUTCHours() === 0 && now.getUTCMinutes() < 30))) continue;
    const marker = `keyusage:v2:done:${day}`;
    let done: string | null;
    try { done = await env.CACHE.get(marker); }
    catch { result.delayedDays.push(day); continue; }
    if (done === '1') continue;
    result.scannedDays.push(day);
    const snapshot = await readDailyKeyUsage(env, day, nowMs);
    if (snapshot.status !== 'ok') { result.delayedDays.push(day); continue; }

    // Checkpoints for missing/purged Key IDs cannot recreate authorization records.
    const present = await listKeysWithUsageState(env);
    const existing = new Map(present.map(({ key, usageAppliedDays }) => [key.id, usageAppliedDays]));
    const pending = Object.entries(snapshot.byKey).filter(([id, observation]) =>
      observation.count > 0 && existing.has(id) && !existing.get(id)?.includes(day));
    const limit = 100;
    let failed = pending.length > limit;
    for (const [id, observation] of pending.slice(0, limit)) {
      const status = await applyAuthorizedUsageDay(env, id, day, observation.count, observation.lastUsedAt);
      if (status === 'applied') result.applied++;
      if (status === 'busy') failed = true;
    }
    if (failed) { result.delayedDays.push(day); continue; }
    try { await env.CACHE.put(marker, '1', { expirationTtl: 35 * 86400 }); }
    catch { result.delayedDays.push(day); }
  }
  return result;
}

/** Enrich the existing manager-only API Key list without rewriting canonical R2. */
export async function listKeysWithEstimatedUsage(env: Env, nowMs = Date.now()): Promise<import('./keys').ApiKey[]> {
  const keys = await listKeysWithUsageState(env);
  if (!keys.length) return [];
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  const markUnavailable = () => keys.map(({ key }) => ({ ...key, usageApproximate: true as const, usageStatus: 'unavailable' as const, usageAsOf: null }));
  if (!env.CACHE) return markUnavailable();
  const [recent, previous] = await Promise.all([
    readDailyKeyUsage(env, today, nowMs),
    readDailyKeyUsage(env, yesterday, nowMs),
  ]);
  if (recent.status !== 'ok' || previous.status !== 'ok') return markUnavailable();
  return keys.map(({ key, usageAppliedDays }) => {
    const daily: Record<string, number> = { ...(key.usageDaily ?? {}) };
    let total = key.usageTotal ?? 0;
    let lastUsedAt = key.lastUsedAt;
    let delayed = false;
    for (const day of [previous, recent]) {
      if (usageAppliedDays.includes(day.day)) continue;
      const incr = day.byKey[key.id];
      if (!incr) continue;
      total += incr.count;
      daily[day.day] = (daily[day.day] ?? 0) + incr.count;
      if (incr.lastUsedAt && (!lastUsedAt || lastUsedAt < incr.lastUsedAt)) lastUsedAt = incr.lastUsedAt;
      if (day.day === yesterday && incr.count > 0 && (now.getUTCHours() > 0 || now.getUTCMinutes() >= 30)) delayed = true;
    }
    return {
      ...key, usageTotal: total, usageDaily: daily, lastUsedAt,
      usageApproximate: true as const,
      usageStatus: delayed ? 'delayed' as const : 'ok' as const,
      usageAsOf: recent.asOf,
    };
  });
}
