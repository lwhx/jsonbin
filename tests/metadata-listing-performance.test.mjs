import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';

test('Bin list and search enumerate resource prefixes instead of every historical JSON version', async t => {
  const h = await createSystemHarness('metadata-enum-' + crypto.randomUUID());
  t.after(() => h.close());
  const created = await h.request('/bins', {
    method: 'POST',
    value: { name: 'metadata-listing-probe', value: { first: true } },
  });
  assert.equal(created.status, 201);
  const { meta } = await created.json();

  for (let version = 2; version <= 36; version++) {
    await h.bucket.put(`bins/${meta.id}/versions/${String(version).padStart(6, '0')}.json`, '{"archived":true}');
  }
  const orphanId = crypto.randomUUID();
  await h.bucket.put(`bins/${orphanId}/versions/000001.json`, '{"orphan":true}');

  const listings = [];
  const heads = [];
  const calls = [];
  const data = h.adapt({
    list: async opts => {
      const page = await h.bucket.list(opts);
      if (opts.prefix === 'bins/') {
        listings.push({ delimiter: opts.delimiter, objects: page.objects.length, grouped: page.delimitedPrefixes.length });
      }
      return page;
    },
    head: async (key, ...args) => { heads.push(key); return h.bucket.head(key, ...args); },
    get: async (key, ...args) => { calls.push(key); return h.bucket.get(key, ...args); },
  });
  const env = { ...h.env, DATA: data };
  const list = await h.request('/bins', {}, env);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).items.some(item => item.id === meta.id));

  const searched = await h.request('/search?q=metadata-listing-probe&type=bin', {}, env);
  assert.equal(searched.status, 200);
  assert.ok((await searched.json()).items.some(item => item.id === meta.id));

  assert.ok(listings.length >= 2);
  assert.ok(listings.every(item => item.delimiter === '/'), 'R2 lists must use directory delimiter');
  assert.ok(listings.every(item => item.objects < 10), 'version bodies must not appear in directory LIST results');
  assert.ok(heads.includes(`bins/${meta.id}/meta.json`), 'search inventory must HEAD canonical metadata');
  assert.ok(!calls.some(key => key.includes('/versions/')), 'list and search should not download historical JSON bodies');
});
