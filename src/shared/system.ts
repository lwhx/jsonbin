export type UserDefaults = { defaultVisibility: 'private' | 'public'; defaultTtlSeconds: number | null };
export type SystemSettings = UserDefaults & { schemaVersion: 1; updatedAt: string | null };
export type SettingsRecord = { settings: SystemSettings; etag: string };
export type SettingsPatch = Partial<UserDefaults>;
export const DEFAULT_SETTINGS_ETAG = '"settings-default-v1"';
export type ProbeStatus = 'unconfigured' | 'reachable' | 'unavailable';
export type BusinessStats = Record<'activeBins' | 'trashBins' | 'pendingImports' | 'collections' | 'schemas' | 'versions' | 'currentValueBytes' | 'storedBytes', number>;
export type SystemInfo = { service: 'jsonbin'; runtime: 'cloudflare-workers'; version: string; checkedAt: string;
  storage: { r2: ProbeStatus; kv: ProbeStatus }; oauth: { githubConfigured: boolean };
  statistics: { status: 'available'; data: BusinessStats } | { status: 'unavailable'; error: 'statistics_limit_exceeded' | 'storage_unavailable' } };
export class SystemError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export type ImportItem = { name: string; value: unknown };
export type ImportResult = { index: number; status: 'created'; id: string } | { index: number; status: 'failed'; error: string };
export type ImportBatchResult = { results: ImportResult[] };
export type ExportQuery = { scope: 'all' | 'config'; format: 'backup' } | { scope: 'bin'; id: string; format: 'value' | 'backup' };
export type ExportPayload = { body: Uint8Array; fileName: string; contentType: 'application/json; charset=utf-8'; activity: { action: 'system.exported' | 'bin.exported'; resourceId: string | null } };
