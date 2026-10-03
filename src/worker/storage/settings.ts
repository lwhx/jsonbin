import { z } from 'zod';
import { DEFAULT_SETTINGS_ETAG, SystemError, type SettingsPatch, type SettingsRecord, type UserDefaults } from '../../shared/system.ts';
import { getJson, putJson, requireDataBucket } from './r2';
import { normalizeEtag } from './bin-state';
export const defaultsSchema = z.object({ defaultVisibility: z.enum(['private', 'public']), defaultTtlSeconds: z.number().int().min(1).max(31536000).nullable() }).strict();
const storedSchema = defaultsSchema.extend({ schemaVersion: z.literal(1), updatedAt: z.iso.datetime() }).strict();
const patchSchema = defaultsSchema.partial().refine(value => Object.keys(value).length > 0);
const key = 'system/settings.json';
export async function getSettings(env: Env): Promise<SettingsRecord> {
  try {
    const record = await getJson<unknown>(requireDataBucket(env), key);
    if (!record) return { settings: { schemaVersion: 1, defaultVisibility: 'private', defaultTtlSeconds: null, updatedAt: null }, etag: DEFAULT_SETTINGS_ETAG };
    const parsed = storedSchema.safeParse(record.value);
    if (!parsed.success) throw new Error();
    return { settings: parsed.data, etag: record.etag };
  } catch { throw new SystemError(503, 'settings_unavailable'); }
}
export async function updateSettings(env: Env, input: SettingsPatch, etag: string): Promise<SettingsRecord> {
  if (!etag?.trim()) throw new SystemError(428, 'precondition_required');
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) throw new SystemError(422, 'validation_failed');
  const current = await getSettings(env);
  if (etag !== current.etag) throw new SystemError(412, 'etag_conflict');
  const settings = { ...current.settings, ...parsed.data, updatedAt: new Date().toISOString() };
  try {
    const stored = await putJson(requireDataBucket(env), key, settings, { onlyIf: current.etag === DEFAULT_SETTINGS_ETAG ? { etagDoesNotMatch: '*' } : { etagMatches: normalizeEtag(current.etag) } });
    if (!stored) throw new SystemError(412, 'etag_conflict');
    return { settings, etag: stored.httpEtag };
  } catch (error) { if (error instanceof SystemError) throw error; throw new SystemError(503, 'settings_unavailable'); }
}
export async function resolveCreateDefaults(env: Env, input: { visibility?: UserDefaults['defaultVisibility']; expiresAt?: string | null }, now: number): Promise<{ visibility: UserDefaults['defaultVisibility']; expiresAt: string | null }> {
  const defaults = input.visibility === undefined || input.expiresAt === undefined ? (await getSettings(env)).settings : null;
  return { visibility: input.visibility ?? defaults!.defaultVisibility,
    expiresAt: input.expiresAt !== undefined ? input.expiresAt === null ? null : new Date(input.expiresAt).toISOString()
      : defaults!.defaultTtlSeconds === null ? null : new Date(now + defaults!.defaultTtlSeconds * 1000).toISOString() };
}
