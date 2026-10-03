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
  if (result.status === 'created') await auditRequest(c, result.kind === 'collection' ? 'collection.imported' : result.kind === 'schema' ? 'schema.imported' : 'bin.imported', result.id);
  return c.json(result);
});
export default app;
