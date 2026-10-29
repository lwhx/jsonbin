import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const browser = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));

test('P22 usage DO uses a separate SQLite namespace from the rate limiter with Preview isolation', () => {
  const production = cfg.durable_objects.bindings;
  const preview = cfg.previews.durable_objects.bindings;
  const usage = production.find(x => x.name === 'KEY_USAGE_COUNTER');
  assert.deepEqual(usage, { name: 'KEY_USAGE_COUNTER', class_name: 'ApiKeyUsageCounter' });
  assert.deepEqual(preview.find(x => x.name === 'KEY_USAGE_COUNTER'), usage);
  assert.notEqual(production.find(x => x.name === 'RATE_LIMITER').class_name, usage.class_name,
    'idle rate-limit cleanup must never delete long-lived usage counters');
  assert.deepEqual(cfg.exports.ApiKeyUsageCounter, { type: 'durable-object', storage: 'sqlite' });
  assert.deepEqual(browser.durable_objects.bindings.find(x => x.name === 'KEY_USAGE_COUNTER'), usage);
  assert.deepEqual(browser.exports.ApiKeyUsageCounter, cfg.exports.ApiKeyUsageCounter);

  assert.notEqual(cfg.vars?.KEY_USAGE_DO_SHADOW, '1');
  assert.notEqual(cfg.previews.vars?.KEY_USAGE_DO_SHADOW, '1');
  assert.notEqual(browser.vars?.KEY_USAGE_DO_SHADOW, '1');
  assert.equal(cfg.previews.kv_namespaces?.length ?? 0, 0, 'do not inherit production analytics KV in Preview');
  assert.notEqual(cfg.previews.r2_buckets[0].bucket_name, cfg.r2_buckets[0].bucket_name);
});

test('P22 shadow is internal-only and does not change the API Key settlement source', () => {
  const root = readFileSync(new URL('../src/worker/index.ts', import.meta.url), 'utf8');
  const settle = readFileSync(new URL('../src/worker/storage/key-usage.ts', import.meta.url), 'utf8');
  assert.match(root, /export \{ ApiKeyUsageCounter \} from "\.\/storage\/key-usage-do"/);
  assert.match(root, /KEY_USAGE_DO_SHADOW === "1"/);
  assert.doesNotMatch(root, /app\.route\([^\n]*key-usage-do/);
  assert.match(settle, /readDailyKeyUsage\(env, day, nowMs\)/);
  assert.doesNotMatch(settle, /readKeyUsageShadow|ApiKeyUsageCounter|KEY_USAGE_COUNTER/);
});
