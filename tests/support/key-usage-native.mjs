import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recordAnalytics } from '../../src/worker/storage/analytics.ts';

class FakeKV {
  store = new Map();
  reads = 0;
  writes = 0;
  async get(key, format) {
    this.reads++;
    if (Array.isArray(key)) return new Map(key.filter(k => this.store.has(k)).map(k => [k, format === 'json' ? JSON.parse(this.store.get(k)) : this.store.get(k)]));
    const raw = this.store.get(key) ?? null;
    return format === 'json' && raw ? JSON.parse(raw) : raw;
  }
  async put(key, value) { this.writes++; this.store.set(key, value); }
}

const event = (status, qualifiedKeyUse, keyId = 'key-1', timestamp='2026-10-08T23:59:56.000Z') => ({
  timestamp, method: 'GET', route: '/api/v1/bins', status, durationMs: 4,
  authType: 'api_key', keyId, qualifiedKeyUse,
});

test('key usage: Analytics uses the same KV write and separates authorized usage from request totals', async () => {
  const kv = new FakeKV(), env = { CACHE: kv };
  await recordAnalytics(env, event(200, true));
  await recordAnalytics(env, event(404, true));
  await recordAnalytics(env, event(422, true));
  await recordAnalytics(env, event(500, true));
  await recordAnalytics(env, event(401, false));
  await recordAnalytics(env, event(403, false));
  await recordAnalytics(env, event(429, false));
  assert.equal(kv.writes, 7, 'one and only one Analytics KV write per event');
  const buckets = [...kv.store.values()].map(JSON.parse);
  assert.equal(buckets.reduce((sum,b) => sum+(b.keys?.['key-1']?.requests ?? 0),0),7);
  assert.equal(buckets.reduce((sum,b) => sum+(b.keys?.['key-1']?.authorizedUses ?? 0),0),4);
  assert.equal(buckets.every(b => !JSON.stringify(b).includes('jb_live_')),true);
  assert.equal(buckets.some(b => b.keys?.['key-1']?.lastAuthorizedAt === '2026-10-08T23:59:56.000Z'),true);
});

test('key usage: middleware marks only actual permitted Bearer requests as qualified', () => {
  const src = readFileSync(new URL('../../src/worker/index.ts', import.meta.url),'utf8');
  assert.match(src, /qualifiedKeyUse:\s*Boolean\(authenticatedKey\)\s*&&\s*!\[401,\s*403,\s*429\]\.includes\(status\)/);
});

test('key usage: Bearer request path never synchronously commits R2 usage metadata', () => {
  const auth = readFileSync(new URL('../../src/worker/middleware/auth.ts', import.meta.url),'utf8');
  assert.doesNotMatch(auth, /await\s+useApiKey\s*\(/);
  assert.doesNotMatch(auth, /apiKeyUsage/);
  const keys = readFileSync(new URL('../../src/worker/storage/keys.ts', import.meta.url),'utf8');
  assert.doesNotMatch(keys, /export async function useApiKey\s*\(/);
  assert.match(auth, /await readApiKey\(c\.env, token\)/, 'credential check must stay in R2');
  assert.match(auth, /authorizeApiKey\(current, required\)/, 'scope check must remain');
  assert.match(auth, /enforceApiKeyRateLimit\(c\.env, current\.key\.id, limit\)/,
    'rate limiting must remain via native/CAS limiter; never restore KV fail-open');
});

test('key usage: daily reader bulk-reads 100 at a time, handles legacy shards and sums timestamps', async () => {
  const { readDailyKeyUsage } = await import('../../src/worker/storage/key-usage-read.ts');
  const kv = new FakeKV(), env = { CACHE: kv }, day='2026-10-08';
  kv.store.set('analytics:agg:2026-10-08T00:0', JSON.stringify({keys:{alice:{requests:6, authorizedUses:3,lastAuthorizedAt:'2026-10-08T00:10:00.000Z'}}}));
  kv.store.set('analytics:agg:2026-10-08T23:3', JSON.stringify({keys:{alice:{requests:4,authorizedUses:2,lastAuthorizedAt:'2026-10-08T23:59:59.000Z'},bob:{authorizedUses:1,lastAuthorizedAt:'2026-10-08T23:40:00.000Z'}}}));
  kv.store.set('analytics:agg:2026-10-08T23', JSON.stringify({keys:{alice:{requests:9}}})); // Old format cannot backfill authorized uses
  const calls=[];
  const rawGet=kv.get.bind(kv);
  kv.get=async (keys,format)=>{calls.push(keys.length); return rawGet(keys,format);};
  const result = await readDailyKeyUsage(env,day,Date.parse('2026-10-09T01:00:00Z'));
  assert.equal(result.status,'ok');
  assert.deepEqual(calls,[100,20]);
  assert.equal(result.byKey.alice.count,5);
  assert.equal(result.byKey.alice.lastUsedAt,'2026-10-08T23:59:59.000Z');
  assert.equal(result.byKey.bob.count,1);
});

test('key usage: daily reader fails closed on corrupt data and tolerates missing CACHE', async () => {
  const { readDailyKeyUsage } = await import('../../src/worker/storage/key-usage-read.ts');
  const kv = new FakeKV(), day='2026-10-08', now=Date.parse('2026-10-09T01:00:00Z');
  assert.equal((await readDailyKeyUsage({},day,now)).status,'unavailable');
  kv.store.set('analytics:agg:2026-10-08T09:1', JSON.stringify({keys:{alice:{authorizedUses:-5}}}));
  assert.equal((await readDailyKeyUsage({CACHE:kv},day,now)).status,'unavailable');
  kv.store.clear();kv.get=async()=>{throw new Error('KV offline');};
  assert.equal((await readDailyKeyUsage({CACHE:kv},day,now)).status,'unavailable');
});

test('key usage: UTC daily reader does not request future hours', async () => {
  const { readDailyKeyUsage } = await import('../../src/worker/storage/key-usage-read.ts');
  const calls=[];const kv={get: async keys=>{calls.push(keys);return new Map();}};
  await readDailyKeyUsage({CACHE:kv},'2026-10-09',Date.parse('2026-10-09T00:01:30Z'));
  assert.equal(calls.flat().length,5);
  assert.equal(calls.flat().every(k=>k.includes('2026-10-09T00')),true);
});

class FakeR2 {
  records = new Map();
  writes = 0;
  conflicts = 0;
  beforeCAS = null;
  async get(key) {
    const o = this.records.get(key);
    return o && { json:async()=>structuredClone(o.value), httpEtag: `"${o.version}"`, uploaded:new Date() };
  }
  async put(key, content, options = {}) {
    let o = this.records.get(key);
    if (options.onlyIf?.etagMatches && this.beforeCAS) {
      const hook=this.beforeCAS;this.beforeCAS=null;hook(key,this.records);o=this.records.get(key);
    }
    if (options.onlyIf?.etagMatches && String(options.onlyIf.etagMatches).replaceAll('"','') !== String(o?.version)) {this.conflicts++;return null;}
    if (options.onlyIf?.etagDoesNotMatch === '*' && o) return null;
    const version=String((Number(o?.version)||0)+1);
    this.records.set(key,{version,value:JSON.parse(content)});
    this.writes++;
    return {httpEtag:`"${version}"`};
  }
  async delete(key) {this.records.delete(key);}
  async list({prefix}) {return {objects:[...this.records.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};}
}
const keyEnv = bucket => ({DATA:bucket,SESSION_SECRET:'c'.repeat(48)});

test('key usage: R2 checkpoint uses CAS and preserves historical baseline without leaking private markers', async () => {
  const keys = await import('../../src/worker/storage/keys.ts');
  const r2=new FakeR2(), env=keyEnv(r2);
  const created=await keys.createKey(env,{name:'historical',scopes:['bin:read']});
  const k='keys/'+created.key.id+'/meta.json', record=r2.records.get(k);
  record.value.usageTotal=117;record.value.usageDaily={'2026-10-08':9};record.value.lastUsedAt='2026-10-07T01:00:00.000Z';
  const afterCreateWrites=r2.writes;
  assert.equal(await keys.applyAuthorizedUsageDay(env,created.key.id,'2026-10-08',3,'2026-10-08T23:20:00.000Z'),'applied');
  assert.equal(await keys.applyAuthorizedUsageDay(env,created.key.id,'2026-10-08',3,'2026-10-08T23:20:00.000Z'),'already_applied');
  const updated=r2.records.get(k).value;
  assert.equal(updated.usageTotal,120);
  assert.equal(updated.usageDaily['2026-10-08'],12);
  assert.equal(updated.lastUsedAt,'2026-10-08T23:20:00.000Z');
  assert.deepEqual(updated.usageAppliedDays,['2026-10-08']);
  assert.equal(r2.writes,afterCreateWrites+1);
  const publicKeys=await keys.listKeys(env);
  assert.equal(publicKeys[0].usageTotal,120);
  assert.equal('usageAppliedDays' in publicKeys[0],false);
  assert.equal('digest' in publicKeys[0],false);
  const states=await keys.listKeysWithUsageState(env);
  assert.deepEqual(states[0].usageAppliedDays,['2026-10-08']);
});

test('key usage: CAS contention never overwrites updated permissions or revocation, purge never resurrects', async () => {
  const keys = await import('../../src/worker/storage/keys.ts');
  const r2=new FakeR2(), env=keyEnv(r2);
  const created=await keys.createKey(env,{name:'before',scopes:['bin:read']});
  const k='keys/'+created.key.id+'/meta.json';
  r2.beforeCAS=(key, records)=>{const cur=records.get(key);cur.version=String(Number(cur.version)+1);cur.value.name='changed';cur.value.scopes=['bin:create'];cur.value.revokedAt='2026-10-09T00:00:00.000Z';};
  assert.equal(await keys.applyAuthorizedUsageDay(env,created.key.id,'2026-10-08',2,'2026-10-08T22:30:00.000Z'),'applied');
  const saved=r2.records.get(k).value;
  assert.equal(r2.conflicts,1);
  assert.equal(saved.name,'changed');
  assert.deepEqual(saved.scopes,['bin:create']);
  assert.equal(saved.revokedAt,'2026-10-09T00:00:00.000Z');
  assert.equal(saved.usageTotal,2);
  await keys.purgeKey(env,created.key.id);
  assert.equal(await keys.applyAuthorizedUsageDay(env,created.key.id,'2026-10-07',1,null),'missing');
  assert.equal(r2.records.has(k),false);
});

test('key usage: settlement waits until UTC 00:30, checkpoints once and retries safely', async () => {
  const keys=await import('../../src/worker/storage/keys.ts');
  const usage=await import('../../src/worker/storage/key-usage.ts');
  const r2=new FakeR2(), kv=new FakeKV(), env={...keyEnv(r2),CACHE:kv};
  const key=await keys.createKey(env,{name:'daily',scopes:['bin:read']});
  const keyPath='keys/'+key.key.id+'/meta.json';
  await recordAnalytics(env,event(200,true,key.key.id,'2026-10-08T23:59:00.000Z'));
  await recordAnalytics(env,event(200,true,key.key.id,'2026-10-09T00:00:00.000Z'));
  const writes=r2.writes;
  const before=await usage.settleRecentKeyUsage(env,Date.parse('2026-10-09T00:15:00Z'));
  assert.equal(before.applied,0);
  assert.equal(r2.writes,writes);
  const first=await usage.settleRecentKeyUsage(env,Date.parse('2026-10-09T00:30:00Z'));
  assert.equal(first.applied,1);
  assert.equal(r2.records.get(keyPath).value.usageTotal,1,'today must not be included in yesterday');
  assert.equal(r2.records.get(keyPath).value.usageDaily['2026-10-08'],1);
  const repeat=await usage.settleRecentKeyUsage(env,Date.parse('2026-10-09T00:45:00Z'));
  assert.equal(repeat.applied,0);
  assert.equal(r2.records.get(keyPath).value.usageTotal,1);
  assert.ok(kv.store.has('keyusage:v2:done:2026-10-08'));
  assert.equal(kv.store.has('keyusage:v2:done:2026-10-09'),false);
});

test('key usage: invalid KV day cannot seal the completed marker', async () => {
  const usage=await import('../../src/worker/storage/key-usage.ts');
  const kv=new FakeKV(),env={CACHE:kv,DATA:new FakeR2()};
  kv.store.set('analytics:agg:2026-10-08T10:0',JSON.stringify({keys:{x:{authorizedUses:-4}}}));
  const output=await usage.settleRecentKeyUsage(env,Date.parse('2026-10-09T00:30:00Z'));
  assert.ok(output.delayedDays.includes('2026-10-08'));
  assert.equal(kv.store.has('keyusage:v2:done:2026-10-08'),false);
});

test('key usage: management view retains historical totals and overlays only unapplied KV days', async () => {
  const keys=await import('../../src/worker/storage/keys.ts');
  const usage=await import('../../src/worker/storage/key-usage.ts');
  const r2=new FakeR2(), kv=new FakeKV(), env={...keyEnv(r2),CACHE:kv};
  const created=await keys.createKey(env,{name:'admin-visible',scopes:['bin:read']});
  const record=r2.records.get('keys/'+created.key.id+'/meta.json');
  record.value.usageTotal=117;record.value.usageDaily={'2026-10-08':9};
  record.value.lastUsedAt='2026-10-08T18:00:00.000Z';record.value.usageAppliedDays=['2026-10-08'];
  await recordAnalytics(env,event(200,true,created.key.id,'2026-10-08T23:40:00.000Z'));
  for(let i=0;i<3;i++)await recordAnalytics(env,event(200,true,created.key.id,`2026-10-09T00:00:0${i}.000Z`));
  const list=await usage.listKeysWithEstimatedUsage(env,Date.parse('2026-10-09T00:10:00.000Z'));
  const key=list.find(k=>k.id===created.key.id);
  assert.equal(key.usageTotal,120,'yesterday should not be counted twice');
  assert.equal(key.usageDaily['2026-10-08'],9);
  assert.equal(key.usageDaily['2026-10-09'],3);
  assert.equal(key.usageApproximate,true);
  assert.equal(key.usageStatus,'ok');
  assert.equal(key.lastUsedAt,'2026-10-09T00:00:02.000Z');
  assert.equal(Object.hasOwn(key,'usageAppliedDays'),false);
  assert.equal(r2.records.get('keys/'+created.key.id+'/meta.json').value.usageTotal,117,'reading the manager list must never modify R2');
  const unavailable=await usage.listKeysWithEstimatedUsage(keyEnv(r2),Date.parse('2026-10-09T00:10:00.000Z'));
  assert.equal(unavailable[0].usageTotal,117);
  assert.equal(unavailable[0].usageStatus,'unavailable');
});

test('key usage: dashboard text explicitly labels counters approximate and stale stats unavailable', () => {
  const ui = readFileSync(new URL('../../src/react-app/features/keys/KeysPage.tsx', import.meta.url),'utf8');
  assert.match(ui,/使用统计为近似值/);
  assert.match(ui,/usageStatus/);
  assert.match(ui,/约/);
});
