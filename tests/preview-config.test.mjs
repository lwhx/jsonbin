import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const load = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

test('SEC-002 Worker Preview has an isolated DO binding and never reuses production R2/KV', () => {
  const cfg = load('../wrangler.jsonc');
  const prod = cfg.durable_objects.bindings.find(item => item.name === 'RATE_LIMITER');
  const preview = cfg.previews.durable_objects.bindings.find(item => item.name === 'RATE_LIMITER');
  assert.deepEqual(preview, prod);
  assert.equal(cfg.exports.ApiRateLimiter.storage, 'sqlite');
  assert.equal(cfg.exports.ApiRateLimiter.type, 'durable-object');
  const mainR2 = cfg.r2_buckets.find(item => item.binding === 'DATA').bucket_name;
  const previewR2 = cfg.previews.r2_buckets.find(item => item.binding === 'DATA').bucket_name;
  assert.ok(previewR2);
  assert.notEqual(previewR2, mainR2);
  const prodKV = cfg.kv_namespaces.find(item => item.binding === 'CACHE').id;
  assert.ok(!cfg.previews.kv_namespaces?.some(item => item.id === prodKV), 'preview must not share production KV');
  assert.equal(cfg.previews.vars.ADMIN_USERNAME, 'preview-admin');
  assert.equal(Object.hasOwn(cfg.previews.vars, 'ADMIN_PASSWORD'), false);
  assert.equal(Object.hasOwn(cfg.previews.vars, 'SESSION_SECRET'), false);
});

test('SEC-002 Wrangler is locked to Worker Previews-compatible release without changing npm-ci resolution', () => {
  const pkg = load('../package.json');
  const lock = load('../package-lock.json');
  const installed = lock.packages['node_modules/wrangler'].version.split('.').map(Number);
  assert.ok(installed[0] > 4 || installed[0] === 4 && installed[1] >= 135);
  assert.equal(pkg.devDependencies.wrangler, '^4.147.0');
  assert.equal(lock.packages[''].devDependencies.wrangler, pkg.devDependencies.wrangler);
});
