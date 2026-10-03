import type { Context } from 'hono';
import type { ActivityAction, ActivityIdentity, ActivityInput } from '../shared/activity';
import { appendActivity } from './storage/activity';
declare module 'hono' {
  interface ContextVariableMap { requestId: string; activityIdentity: ActivityIdentity }
}
export async function recordActivity(env: Env, input: ActivityInput): Promise<void> {
  try { await appendActivity(env, input); }
  catch { console.error('activity_write_failed', { requestId: input.requestId }); }
}
export async function auditRequest<E extends { Bindings: Env }>(c: Context<E>, action: ActivityAction, resourceId: string | null, identity?: ActivityIdentity) {
  const trusted = identity ?? c.get('activityIdentity');
  const requestId = c.get('requestId');
  if (!trusted) { console.error('activity_identity_missing', { requestId }); return; }
  await recordActivity(c.env, { action, resourceId, identity: trusted, requestId });
}
