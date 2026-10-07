import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { JsonBinClient, EtagConflictError, NotFoundError, PermissionDeniedError } from '../sdk/typescript/dist/index.js';

test('TypeScript SDK: full lifecycle (create, get, jsonPatch, mergePatch, publish, 304, error mapping)', async (t) => {
  const h = await createSystemHarness('sdk-ts-' + crypto.randomUUID());
  t.after(() => h.close());

  // Create an API Key for the SDK client
  const keyRes = await h.request('/keys', {
    method: 'POST',
    value: { name: 'SDK Test Key', scopes: ['bin:read', 'bin:create', 'bin:update', 'history:read'] },
  });
  const { token } = await keyRes.json();

  // Initialize SDK
  const client = new JsonBinClient({
    baseUrl: 'http://localhost',
    token,
  });

  // Intercept client fetch to forward to harness miniflare
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
    const headers = new Headers(init?.headers);
    const method = init?.method || 'GET';
    const body = init?.body ? String(init.body) : undefined;
    const reqHeaders = {};
    headers.forEach((v, k) => { reqHeaders[k] = v; });

    return h.worker.fetch(new Request(`https://example.test${path}`, {
      method,
      headers: reqHeaders,
      body,
    }), h.env);
  };

  try {
    // 1. Create Bin
    const created = await client.bins.create({
      name: 'SDK Config',
      slug: 'sdk-config',
      value: { env: 'dev', port: 3000 },
    });
    assert.equal(created.meta.name, 'SDK Config');
    assert.equal(created.value.port, 3000);

    // 2. Get Bin
    const fetched = await client.bins.get('sdk-config');
    assert.equal(fetched.modified !== false && fetched.value.env, 'dev');

    // 3. 304 If-None-Match
    const cached = await client.bins.get('sdk-config', { ifNoneMatch: created.etag });
    assert.equal(cached.modified, false);

    // 4. JSON Patch
    const patched = await client.bins.jsonPatch(
      created.meta.id,
      [
        { op: 'replace', path: '/port', value: 8080 },
        { op: 'add', path: '/version', value: '1.0' },
      ],
      { etag: created.etag },
    );
    assert.equal(patched.value.port, 8080);
    assert.equal(patched.value.version, '1.0');

    // 5. Merge Patch
    const merged = await client.bins.mergePatch(
      created.meta.id,
      { env: 'prod' },
      { etag: patched.etag },
    );
    assert.equal(merged.value.env, 'prod');
    assert.equal(merged.value.port, 8080);

    // 6. ETag conflict mapping
    await assert.rejects(
      async () => {
        await client.bins.update(created.meta.id, { broken: true }, { etag: '"wrong"' });
      },
      (err) => err instanceof EtagConflictError,
    );

    // 7. Publish
    const published = await client.bins.publish(created.meta.id, { etag: merged.etag });
    assert.equal(published.meta.publishedVersion, 3);

    // 8. Read Published
    const pubRead = await client.bins.getPublished('sdk-config');
    assert.equal(pubRead.modified !== false && pubRead.value.port, 8080);

    // 9. 404 Mapping
    await assert.rejects(
      async () => {
        await client.bins.get('non-existent-bin-uuid-1234');
      },
      (err) => err instanceof NotFoundError,
    );

    // 10. Versions listing & specific version get
    const versions = await client.bins.listVersions(created.meta.id);
    assert.equal(versions.total >= 3, true);
    const v1 = await client.bins.getVersion(created.meta.id, 1);
    assert.equal(v1.value.port, 3000);

    // 11. Collections Resource (verify insufficient_scope first)
    await assert.rejects(
      async () => {
        await client.collections.create({ name: 'SDK Test Collection' });
      },
      (err) => err instanceof PermissionDeniedError,
    );

    // Create an admin key with full valid scopes
    const adminKeyRes = await h.request('/keys', {
      method: 'POST',
      value: { name: 'SDK Admin Key', scopes: ['bin:read', 'bin:create', 'bin:update', 'collection:read', 'collection:write', 'schema:read', 'schema:write'] },
    });
    const { token: adminToken } = await adminKeyRes.json();
    const adminClient = new JsonBinClient({ baseUrl: 'http://localhost', token: adminToken });

    const col = await adminClient.collections.create({ name: 'SDK Test Collection' });
    assert.equal(col.meta.name, 'SDK Test Collection');
    const cols = await adminClient.collections.list();
    assert.equal(cols.items.some(c => c.id === col.meta.id), true);

    // 12. Schemas Resource
    const schema = await adminClient.schemas.create({
      name: 'SDK Schema',
      schema: { type: 'object', properties: { port: { type: 'number' } }, required: ['port'] },
    });
    assert.equal(schema.meta.name, 'SDK Schema');
    const validRes = await adminClient.schemas.validate(schema.meta.id, { port: 80 });
    assert.equal(validRes.valid, true);
    const invalidRes = await adminClient.schemas.validate(schema.meta.id, { port: 'invalid' });
    assert.equal(invalidRes.valid, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('TypeScript SDK: trash, history and search contracts match the real Worker (F13/F14)', async (t) => {
  const h = await createSystemHarness('sdk-ts-contract-' + crypto.randomUUID());
  t.after(() => h.close());

  const keyRes = await h.request('/keys', {
    method: 'POST',
    value: { name: 'SDK Contract Key', scopes: ['bin:read', 'bin:create', 'bin:update', 'bin:delete', 'history:read', 'collection:read', 'schema:read'] },
  });
  const { token } = await keyRes.json();
  const client = new JsonBinClient({ baseUrl: 'http://localhost', token });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const headers = new Headers(init?.headers);
    const reqHeaders = {};
    headers.forEach((v, k) => { reqHeaders[k] = v; });
    return h.worker.fetch(new Request(`https://example.test${parsed.pathname}${parsed.search}`, {
      method: init?.method || 'GET', headers: reqHeaders,
      body: init?.body ? String(init.body) : undefined,
    }), h.env);
  };
  try {
    // Trash lifecycle over the real routes: list → restore → batch purge.
    const created = await client.bins.create({ name: 'SDK Trash Roundtrip', value: { keep: true } });
    await client.bins.delete(created.meta.id);
    const trash = await client.trash.list();
    const entry = trash.items.find(i => i.meta.id === created.meta.id);
    assert.ok(entry, 'trash.list must hit /trash/bins');
    assert.ok(entry.meta.deletedAt);
    assert.equal(entry.status, 'deleted');
    const restored = await client.trash.restore(entry.meta.id, { etag: entry.etag });
    assert.equal(restored.meta.id, created.meta.id);
    assert.equal(restored.meta.deletedAt, undefined);

    // History contract: createdAt (not uploaded), currentVersion, flat getVersion.
    const versions = await client.bins.listVersions(created.meta.id);
    assert.equal(versions.currentVersion, 1);
    assert.equal(typeof versions.items[0].createdAt, 'string');
    assert.equal('uploaded' in versions.items[0], false, 'the API never returns an uploaded field');
    const v1 = await client.bins.getVersion(created.meta.id, 1);
    assert.deepEqual(v1.value, { keep: true });
    assert.equal(v1.version, 1);
    assert.equal('meta' in v1, false, 'getVersion returns a flat record, not meta/value');

    // Metadata search pages by cursor and reports its source; no total field.
    const found = await client.search.metadata('Trash Roundtrip');
    assert.ok(Array.isArray(found.items));
    assert.equal(found.items.some(i => i.id === created.meta.id), true);
    assert.equal('total' in found, false, 'search.metadata must not claim a total');
    assert.ok(['kv', 'r2'].includes(found.source));

    // Batch purge takes the explicit client-approved snapshots only.
    await client.bins.delete(created.meta.id);
    const again = await client.trash.list();
    const entry2 = again.items.find(i => i.meta.id === created.meta.id);
    const purged = await client.trash.purgeMany([{ id: entry2.meta.id, etag: entry2.etag }]);
    assert.deepEqual(purged.results, [{ id: created.meta.id, status: 200 }]);
    assert.equal((await client.trash.list()).items.some(i => i.meta.id === created.meta.id), false);
    await assert.rejects(() => client.bins.get(created.meta.id), NotFoundError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
