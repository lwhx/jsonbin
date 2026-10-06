import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemHarness } from './support/system-harness.mjs';
import { JsonBinClient, EtagConflictError, NotFoundError } from '../sdk/typescript/dist/index.js';

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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
