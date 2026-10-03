import { Hono } from 'hono';
import { ACTIVITY_ACTIONS, type ActivityQuery, type ActivityResourceType } from '../../shared/activity';
import { requireSession } from '../middleware/auth';
import { listActivity } from '../storage/activity';
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.raw.headers.has('Authorization')) return c.json({ error: 'session_required' }, 401);
  await next();
});
app.use('*', requireSession);
app.get('/', async c => {
  const params = new URL(c.req.url).searchParams;
  if ([...params.keys()].some(key => !['limit', 'cursor', 'action', 'resourceType'].includes(key) || params.getAll(key).length !== 1)) return c.json({ error: 'invalid_activity_query' }, 400);
  const limit = params.get('limit'), action = params.get('action'), resourceType = params.get('resourceType');
  if ((limit !== null && (!/^[1-9]\d*$/.test(limit) || Number(limit) > 100))
    || (action !== null && !Object.hasOwn(ACTIVITY_ACTIONS, action))
    || (resourceType !== null && !['auth', 'bin', 'collection', 'schema', 'key', 'system'].includes(resourceType))) return c.json({ error: 'invalid_activity_query' }, 400);
  const query: ActivityQuery = { limit: limit === null ? 50 : Number(limit), cursor: params.get('cursor') ?? undefined,
    action: action as ActivityQuery['action'] ?? undefined, resourceType: resourceType as ActivityResourceType ?? undefined };
  try { return c.json(await listActivity(c.env, query)); }
  catch (error) {
    if (error instanceof Error && error.message === 'invalid_activity_query') return c.json({ error: 'invalid_activity_query' }, 400);
    return c.json({ error: 'internal_server_error' }, 500);
  }
});
export default app;
