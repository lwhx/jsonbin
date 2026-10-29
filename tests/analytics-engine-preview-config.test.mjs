import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { shadowComparisonEnabled } from '../src/worker/storage/analytics-engine-compare.ts';

const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

test('Analytics Engine experiment is enabled ONLY in isolated Worker Previews', () => {
  assert.equal(config.name, 'jsonbin');
  assert.equal(config.analytics, undefined, 'production must not expose SQL binding');
  assert.equal(config.analytics_engine_datasets, undefined, 'production must not write shadow events');
  assert.notEqual(config.vars?.ANALYTICS_EVENTS_SHADOW, '1');
  assert.notEqual(config.vars?.ANALYTICS_SHADOW_COMPARE, '1');

  const preview = config.previews;
  assert.equal(preview.vars.ANALYTICS_EVENTS_SHADOW, '1');
  assert.equal(preview.vars.ANALYTICS_SHADOW_COMPARE, '1');
  assert.equal(preview.vars.ANALYTICS_SHADOW_DATASET, 'jsonbin-api-shadow-pr20');
  assert.equal(preview.analytics.binding, 'ANALYTICS_SQL');
  assert.deepEqual(preview.analytics_engine_datasets, [
    { binding: 'ANALYTICS_EVENTS', dataset: 'jsonbin-api-shadow-pr20' },
  ]);
  assert.equal(preview.r2_buckets[0].bucket_name, 'jsonbin-sec002-preview-data');
  assert.notEqual(preview.r2_buckets[0].bucket_name, config.r2_buckets[0].bucket_name);
  const productionKVIds = new Set((config.kv_namespaces ?? []).map(item => item.id));
  for (const namespace of preview.kv_namespaces ?? []) {
    assert.equal(productionKVIds.has(namespace.id), false, 'preview KV cannot point at production');
  }
});

test('Preview SQL dataset is allowlisted but query remains opt-in and never substitutes KV', () => {
  const binding = { query: async () => ({ data: [], rows: 0 }) };
  assert.equal(shadowComparisonEnabled({
    ANALYTICS_SQL: binding,
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-pr20',
    ANALYTICS_SHADOW_COMPARE: '1',
    ANALYTICS_EVENTS_SHADOW: '1',
  }), true);
  assert.equal(shadowComparisonEnabled({
    ANALYTICS_SQL: binding,
    ANALYTICS_SHADOW_DATASET: 'jsonbin-api-shadow-pr20',
    ANALYTICS_SHADOW_COMPARE: '1',
  }), false);
});
