import { z } from 'zod';
import { ACTIVITY_ACTIONS, type ActivityAction, type ActivityEntry, type ActivityPage, type ActivityQuery } from '../../shared/activity';
import { base64UrlDecode, base64UrlEncode } from '../lib/crypto';
import { requireDataBucket } from './r2';

export const ACTIVITY_RETENTION = 2000;
const DATE_MAX = 8640000000000000;
const uuid = z.string().uuid();
const actions = Object.keys(ACTIVITY_ACTIONS) as [ActivityAction, ...ActivityAction[]];
const actor = z.object({ type: z.enum(['session', 'api_key', 'anonymous', 'system']), id: z.string().nullable() }).strict();
export const identitySchema = z.object({ actor, provider: z.enum(['password', 'github', 'api_key', 'anonymous', 'system']) }).strict().refine(({ actor, provider }) => {
  if (actor.type === 'anonymous' || actor.type === 'system') return provider === actor.type && actor.id === null;
  if (actor.type === 'api_key') return provider === 'api_key' && uuid.safeParse(actor.id).success;
  return provider === 'password' ? actor.id === 'local-admin' : provider === 'github' && /^\d{1,20}$/.test(actor.id ?? '');
});
const entrySchema = z.object({ id: uuid, action: z.enum(actions), resourceType: z.enum(['auth', 'bin', 'collection', 'schema', 'key']),
  resourceId: uuid.nullable(), actor, provider: z.enum(['password', 'github', 'api_key', 'anonymous', 'system']),
  timestamp: z.iso.datetime(), summary: z.string(), requestId: uuid }).strict().refine(entry => {
    const [type, summary] = ACTIVITY_ACTIONS[entry.action];
    return entry.resourceType === type && entry.summary === summary && (type === 'auth' ? entry.resourceId === null : entry.resourceId !== null)
      && identitySchema.safeParse({ actor: entry.actor, provider: entry.provider }).success;
  });
export function activityKey(timestamp: number, id: string) {
  return `activity/${String(DATE_MAX - timestamp).padStart(16, '0')}-${id}.json`;
}
function validKey(key: string) {
  const match = /^activity\/(\d{16})-([0-9a-f-]{36})\.json$/.exec(key);
  if (!match || !uuid.safeParse(match[2]).success) return false;
  const millis = DATE_MAX - Number(match[1]);
  return millis >= 0 && Number.isSafeInteger(millis) && activityKey(millis, match[2]) === key;
}
const cursorSchema = z.object({ v: z.literal(1), after: z.string().refine(validKey), action: z.enum(actions).nullable(),
  resourceType: z.enum(['auth', 'bin', 'collection', 'schema', 'key']).nullable() }).strict();
function decodeCursor(query: ActivityQuery) {
  if (query.cursor === undefined) return undefined;
  try {
    if (query.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
    const value = cursorSchema.parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(query.cursor))));
    if (value.action !== (query.action ?? null) || value.resourceType !== (query.resourceType ?? null)) throw new Error();
    return value.after;
  } catch { throw new Error('invalid_activity_query'); }
}
export async function listActivity(env: Env, query: ActivityQuery): Promise<ActivityPage> {
  let after = decodeCursor(query);
  const bucket = requireDataBucket(env), items: ActivityEntry[] = [];
  const limit = query.limit ?? 50;
  let scanned = 0, gets = 0;
  const result = (more: boolean): ActivityPage => ({ items, retentionLimit: ACTIVITY_RETENTION,
    nextCursor: more && after ? base64UrlEncode(JSON.stringify({ v: 1, after, action: query.action ?? null, resourceType: query.resourceType ?? null })) : null });
  while (scanned < 1000) {
    const page = await bucket.list({ prefix: 'activity/', startAfter: after, limit: 200, include: ['customMetadata'] });
    for (let index = 0; index < page.objects.length; index++) {
      const object = page.objects[index]; scanned++;
      // Invalid keys are never used as cursor anchors or read paths.
      if (!validKey(object.key)) continue;
      after = object.key;
      const metadata = object.customMetadata;
      if ((!query.action || metadata?.action === query.action) && (!query.resourceType || metadata?.resourceType === query.resourceType)) {
        gets++;
        const stored = await bucket.get(object.key);
        if (stored) {
          let data: unknown;
          try { data = await stored.json(); } catch { data = null; }
          const parsed = entrySchema.safeParse(data);
          if (parsed.success && activityKey(Date.parse(parsed.data.timestamp), parsed.data.id) === object.key
            && metadata?.action === parsed.data.action && metadata?.resourceType === parsed.data.resourceType) items.push(parsed.data);
        }
      }
      if (items.length >= limit || gets >= 40 || scanned >= 1000) return result(index < page.objects.length - 1 || page.truncated);
    }
    if (!page.truncated) return result(false);
    // A page of invalid keys cannot produce a safe continuation anchor.
    if (!after || after < page.objects.at(-1)!.key) {
      // Continue with R2's cursor internally; return no attacker-controlled anchor.
      return result(false);
    }
  }
  return result(true);
}

export async function appendActivity(env: Env, input: import('../../shared/activity').ActivityInput): Promise<ActivityEntry> {
  const checked = z.object({ action: z.enum(actions), resourceId: uuid.nullable(), identity: identitySchema, requestId: uuid }).strict().parse(input);
  const [resourceType, summary] = ACTIVITY_ACTIONS[checked.action];
  if ((resourceType === 'auth') !== (checked.resourceId === null)) throw new Error('invalid_activity');
  const bucket = requireDataBucket(env), timestamp = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = crypto.randomUUID();
    const entry: ActivityEntry = { id, action: checked.action, resourceType, resourceId: checked.resourceId,
      actor: { type: checked.identity.actor.type, id: checked.identity.actor.id }, provider: checked.identity.provider,
      timestamp: new Date(timestamp).toISOString(), summary, requestId: checked.requestId };
    const written = await bucket.put(activityKey(timestamp, id), JSON.stringify(entry), {
      onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { action: entry.action, resourceType: entry.resourceType },
    });
    if (written) return entry;
  }
  throw new Error('activity_create_conflict');
}
