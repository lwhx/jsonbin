import { createBin } from '../storage/bins';
import { assertBytes, validateBusinessValue, MAX_VALUE_BYTES } from '../../shared/backup.ts';
import type { ImportBatchResult } from '../../shared/system.ts';
import { restoreResource } from '../storage/backup-restore';
import { validateRestoreRequest, MAX_BACKUP_BYTES } from '../../shared/backup.ts';
import { z } from 'zod';
import { exportData } from '../storage/backup-export';
import type { ExportQuery } from '../../shared/system.ts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SystemError, type SettingsPatch } from '../../shared/system.ts';
import { managementSession, readBoundedJson } from '../lib/system-http';
import { getSettings, updateSettings } from '../storage/settings';
import { getSystemInfo } from '../storage/system';
import { auditRequest } from '../activity';
const app = new Hono<{ Bindings: Env }>();
app.onError((error, c) => {
  c.header('Cache-Control', 'no-store');
  if (error instanceof SystemError) return c.json({ error: error.code }, error.status as ContentfulStatusCode);
  console.error('system_request_failed', { requestId: c.get('requestId') });
  return c.json({ error: 'internal_server_error' }, 500);
});
app.get('/settings', managementSession, async c => { const record = await getSettings(c.env); c.header('ETag', record.etag); return c.json(record); });
app.patch('/settings', managementSession, async c => {
  const etag = c.req.header('If-Match'); if (!etag?.trim()) throw new SystemError(428, 'precondition_required');
  const record = await updateSettings(c.env, await readBoundedJson(c.req.raw, 4096) as SettingsPatch, etag);
  c.header('ETag', record.etag); await auditRequest(c, 'system.settings_updated', null); return c.json(record);
});
app.get('/info', managementSession, async c => c.json(await getSystemInfo(c.env)));
app.get('/export', managementSession, async c => {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => !['scope', 'format', 'id'].includes(key) || params.getAll(key).length !== 1)) throw new SystemError(400, 'invalid_query');
  const scope = params.get('scope'), format = params.get('format'), id = params.get('id');
  if (!((scope === 'all' || scope === 'config') && format === 'backup' && id === null) && !(scope === 'bin' && z.string().uuid().safeParse(id).success && (format === 'value' || format === 'backup'))) throw new SystemError(400, 'invalid_query');
  const result = await exportData(c.env, { scope, format, ...(id === null ? {} : { id }) } as ExportQuery);
  await auditRequest(c, result.activity.action, result.activity.resourceId);
  return new Response(Uint8Array.from(result.body), { headers: { 'Content-Type': result.contentType, 'Content-Disposition': `attachment; filename="${result.fileName}"`, 'Cache-Control': 'no-store' } });
});
app.post('/restore', managementSession, async c => {
  const input = validateRestoreRequest(await readBoundedJson(c.req.raw, MAX_BACKUP_BYTES));
  const result = await restoreResource(c.env, input);
  if (result.status === 'created') await auditRequest(c, result.kind === 'collection' ? 'collection.imported' : result.kind === 'schema' ? 'schema.imported' : result.kind === 'template' ? 'template.imported' : 'bin.imported', result.id);
  return c.json(result);
});
app.post('/import', managementSession, async c => {
  const raw = await readBoundedJson(c.req.raw, MAX_BACKUP_BYTES);
  const parsed = z.object({ items: z.array(z.object({ name: z.string().trim().min(1).max(160), value: z.unknown() }).strict()).min(1).max(100) }).strict().safeParse(raw);
  if (!parsed.success) throw new SystemError(422, 'validation_failed');
  for (const item of parsed.data.items) {
    if (!Object.hasOwn(item, 'value')) throw new SystemError(422, 'validation_failed');
    validateBusinessValue(item.value); assertBytes(item.value, MAX_VALUE_BYTES);
  }
  const result: ImportBatchResult = { results: [] };
  for (const [index, item] of parsed.data.items.entries()) {
    try { const record = await createBin(c.env, item); await auditRequest(c, 'bin.imported', record.meta.id); result.results.push({ index, status: 'created', id: record.meta.id }); }
    catch (error) { result.results.push({ index, status: 'failed', error: error instanceof SystemError && error.code === 'settings_unavailable' ? 'settings_unavailable' : 'storage_unavailable' }); }
  }
  return c.json(result);
});
export default app;
