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
export default app;
