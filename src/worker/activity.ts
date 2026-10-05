import type { Context } from 'hono';
import type { ActivityAction, ActivityIdentity, ActivityInput } from '../shared/activity';
import { appendActivity } from './storage/activity';
import { dispatchWebhooks } from './storage/webhooks';

// Only resource lifecycle actions can be observed by webhooks; auth and key
// administration events stay private.
const DISPATCHABLE_ACTION = /^(bin|collection|schema|template|system)[.]/;
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
  if (DISPATCHABLE_ACTION.test(action)) {
    // Delivery must never block or fail the audited mutation; waitUntil keeps
    // it alive after the response when the runtime provides an execution context.
    const dispatch = dispatchWebhooks(c.env, { action, resourceId, actor: trusted.actor, requestId });
    try { c.executionCtx.waitUntil(dispatch); } catch { void dispatch.catch(() => {}); }
  }
}
