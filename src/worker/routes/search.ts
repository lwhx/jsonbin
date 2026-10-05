import { Hono } from 'hono';
import type { SessionUser } from '../auth/session';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { SystemError } from '../../shared/system.ts';
import type { SearchType } from '../../shared/search.ts';
import { requireAccess } from '../middleware/auth';
import { managementSession } from '../lib/system-http';
import { rebuildSearchIndex, searchIndexStatus, searchResources } from '../storage/search';
import { checkResourceAccess, type ApiKey } from '../storage/keys';
const app = new Hono<{ Bindings: Env; Variables: { user?: SessionUser; apiKey?: ApiKey } }>();
app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
app.onError((error, c) => {
  if (error instanceof SystemError) return c.json({ error: error.code }, error.status as ContentfulStatusCode);
  console.error('search_request_failed', { requestId: c.get('requestId') });
  return c.json({ error: 'search_unavailable' }, 503);
});
app.get('/index', managementSession, async c => c.json(await searchIndexStatus(c.env)));
app.post('/rebuild', managementSession, async c => c.json(await rebuildSearchIndex(c.env)));
app.get('/', async (c, next) => {
  // Invalid filters still require authentication and cannot narrow permissions.
  const type = c.req.query('type');
  return requireAccess(type === 'bin' ? ['bin:read', 'collection:read'] : type === 'collection' ? ['collection:read']
    : type === 'schema' ? ['schema:read'] : ['bin:read', 'collection:read', 'schema:read'])(c, next);
}, async c => {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => !['q', 'type', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1)) throw new SystemError(400, 'invalid_query');
  const q = (params.get('q') ?? '').trim(), type = params.get('type') ?? 'all', rawLimit = params.get('limit') ?? '20', cursor = params.get('cursor') ?? undefined;
  if (!q || q.length > 160 || !['all', 'bin', 'collection', 'schema'].includes(type) || !/^[1-9]\d?$/.test(rawLimit)
    || Number(rawLimit) > 50 || cursor !== undefined && (!cursor || cursor.length > 512)) throw new SystemError(400, 'invalid_query');
  const result = await searchResources(c.env, { q, type: type as SearchType, limit: Number(rawLimit), cursor });
  const key = c.get('apiKey');
  if (key && key.resourceAccess?.mode === 'restricted') {
    result.items = result.items.filter(item => {
      if (item.type === 'bin') return checkResourceAccess(key, { type: 'bin', id: item.id, collectionId: item.collectionId });
      if (item.type === 'collection') return checkResourceAccess(key, { type: 'collection', id: item.id });
      return true;
    });
  }
  return c.json(result);
});
export default app;
