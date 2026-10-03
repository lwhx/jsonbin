import type { ExportQuery, ImportBatchResult, ImportItem, SettingsPatch, SettingsRecord, SystemInfo } from '../../../shared/system.ts';
import type { RestoreRequest, RestoreResult } from '../../../shared/backup-types.ts';
import { MAX_BACKUP_BYTES } from '../../../shared/backup.ts';
const messages: Record<number, string> = { 0: '连接中断，部分操作可能已经提交；请检查列表后再重试。', 400: '请求格式无效，请重新选择。', 401: '登录已过期，请重新登录。', 403: '请求来源无权限，请从本站操作。', 404: '资源不存在，请刷新列表。', 409: '数据正在变化或存在恢复冲突，请检查结果后重试。', 412: '设置已被其他操作修改；草稿已保留，请重新读取设置。', 413: '文件或批次超过大小、资源或对象数量上限。', 422: '文件、字段或关联不符合格式，请检查后重新选择。', 428: '请先读取最新设置再保存。', 503: '存储或设置暂不可用，请稍后重试。' };
export class SystemApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super(messages[status] ?? '操作失败，请稍后重试。'); this.status = status; this.code = code; }
}
export type SystemClient = { getInfo(signal?: AbortSignal): Promise<SystemInfo>; getSettings(signal?: AbortSignal): Promise<SettingsRecord>;
  patchSettings(patch: SettingsPatch, etag: string, signal?: AbortSignal): Promise<SettingsRecord>; importJson(items: readonly ImportItem[], signal?: AbortSignal): Promise<ImportBatchResult>;
  exportData(query: ExportQuery, signal?: AbortSignal): Promise<Uint8Array>; restoreResource(input: RestoreRequest, signal?: AbortSignal): Promise<RestoreResult> };
const codes = new Set(['invalid_query', 'validation_failed', 'invalid_json', 'payload_too_large', 'settings_unavailable', 'backup_changed', 'backup_unavailable', 'restore_conflict', 'restore_dependency_conflict', 'storage_unavailable', 'session_required', 'unauthorized', 'origin_not_allowed', 'etag_conflict', 'precondition_required', 'not_found']);
async function readBytes(response: Response, max: number): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  let length = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length;
    if (length > max) { await reader.cancel(); throw new SystemApiError(413, 'payload_too_large'); } chunks.push(value); }
    const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
  } finally { reader.releaseLock(); }
}
export function createSystemClient(base = '/api/v1/system'): SystemClient {
  async function request(path: string, init: RequestInit = {}) {
    let response: Response;
    try { response = await fetch(base + path, { ...init, credentials: 'include', cache: 'no-store' }); }
    catch (error) { if (init.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error; throw new SystemApiError(0, 'network_error'); }
    if (!response.ok) {
      let code = 'request_failed';
      try { const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(response, 8192))); if (typeof data?.error === 'string' && codes.has(data.error)) code = data.error; } catch { /* Fixed fallback; never echo response content. */ }
      throw new SystemApiError(response.status, code);
    }
    return response;
  }
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(await request(path, init), 65536))) as T; }
    catch (error) { if (error instanceof SystemApiError || init?.signal?.aborted) throw error; throw new SystemApiError(0, 'invalid_response'); }
  }
  const write = (value: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal });
  return { getInfo: signal => json('/info', { signal }), getSettings: signal => json('/settings', { signal }),
    patchSettings: (patch, etag, signal) => json('/settings', { ...write(patch, signal), method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': etag } }),
    importJson: (items, signal) => json('/import', write({ items }, signal)),
    async exportData(query, signal) {
      const params = new URLSearchParams({ scope: query.scope, format: query.format, ...(query.scope === 'bin' ? { id: query.id } : {}) });
      try { return await readBytes(await request('/export?' + params, { signal }), MAX_BACKUP_BYTES); }
      catch (error) { if (error instanceof SystemApiError || signal?.aborted) throw error; throw new SystemApiError(0, 'network_error'); }
    }, restoreResource: (input, signal) => json('/restore', write(input, signal)) };
}
export const systemApi = createSystemClient();
