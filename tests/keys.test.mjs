import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

async function withWorker(pepper, fn) {
  const password = randomBytes(32).toString('hex');
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{
    name: 'pepper-tests', modules: true, scriptPath: 'dist/jsonbin/index.js', compatibilityDate: '2026-10-03', r2Buckets: ['DATA'],
    bindings: { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex'), ...(pepper === undefined ? {} : { TOKEN_PEPPER: pepper }) },
  }] }));
  try {
    const login = await mf.dispatchFetch('http://localhost/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password }) });
    assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
    const request = (path, { method = 'GET', value, token } = {}) => mf.dispatchFetch('http://localhost/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    await fn(request, await mf.getR2Bucket('DATA', 'pepper-tests'));
  } finally { await mf.dispose(); }
}
test('HMAC pepper digests are correct, pepper removal/rotation reject old keys and adding a pepper preserves SHA keys', async () => {
  const pepper = randomBytes(32).toString('hex'); let created, stored;
  await withWorker(pepper, async (request, bucket) => {
    const response = await request('/keys', { method: 'POST', value: { name: 'HMAC', scopes: ['bin:read'] } });
    assert.equal(response.status, 201); created = await response.json();
    stored = await (await bucket.get(`keys/${created.key.id}/meta.json`)).json();
    assert.equal(stored.digestAlgorithm, 'hmac-sha256');
    assert.equal(stored.digest, createHmac('sha256', pepper).update(created.token).digest('base64url'));
    assert.ok(!JSON.stringify(stored).includes(created.token));
    assert.equal((await request('/bins', { token: created.token })).status, 200);
    await bucket.put(`keys/${created.key.id}/meta.json`, JSON.stringify({ ...stored, digestAlgorithm: 'sha256', digest: createHash('sha256').update(created.token).digest('base64url') }));
    assert.equal((await request('/bins', { token: created.token })).status, 200);
  });
  for (const changedPepper of [undefined, randomBytes(32).toString('hex')]) {
    await withWorker(changedPepper, async (request, bucket) => {
      await bucket.put(`keys/${created.key.id}/meta.json`, JSON.stringify(stored));
      assert.equal((await request('/bins', { token: created.token })).status, 401);
      assert.equal((await (await request('/keys')).json()).items[0].lastUsedAt, null);
    });
  }
});
test('a blank optional pepper uses SHA-256 while an explicitly weak pepper prevents key issuance', async () => {
  await withWorker('', async (request, bucket) => {
    const response = await request('/keys', { method: 'POST', value: { name: 'SHA', scopes: ['bin:read'] } });
    assert.equal(response.status, 201); const created = await response.json();
    const stored = await (await bucket.get(`keys/${created.key.id}/meta.json`)).json();
    assert.equal(stored.digest, createHash('sha256').update(created.token).digest('base64url'));
    assert.equal(stored.digestAlgorithm, 'sha256');
  });
  await withWorker('too-short', async (request, bucket) => {
    assert.equal((await request('/keys', { method: 'POST', value: { name: 'weak', scopes: ['bin:read'] } })).status, 503);
    assert.equal((await bucket.list({ prefix: 'keys/' })).objects.length, 0);
  });
});

test('an empty Authorization header that reaches the Worker entry rejects Cookie fallback for resources and key administration', async () => {
  // The local HTTP transport strips empty headers, so exercise the built entry directly.
  const { default: app } = await import('../dist/jsonbin/index.js');
  const env = { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex') };
  const login = await app.fetch(new Request('https://example.test/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password: env.ADMIN_PASSWORD }) }), env);
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.fetch(new Request('https://example.test/api/v1/auth/me', { headers: { Cookie: cookie } }), env)).status, 200);
  for (const path of ['/bins', '/bins/example', '/bins/example/value/key', '/collections', '/schemas', '/keys', '/trash/bins', '/activity']) {
    const response = await app.fetch(new Request('https://example.test/api/v1' + path, { headers: { Cookie: cookie, Authorization: '' } }), env);
    assert.equal(response.status, 401);
  }
});


test('created API keys can be revealed later through a Session-only endpoint without exposing plaintext in list or R2', async () => {
  await withWorker(undefined, async (request, bucket) => {
    const createdResponse = await request('/keys', { method: 'POST', value: { name: '可再次查看', scopes: ['bin:read'] } });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();

    const stored = await (await bucket.get(`keys/${created.key.id}/meta.json`)).json();
    assert.ok(!JSON.stringify(stored).includes(created.token));
    assert.ok(stored.tokenCiphertext);
    assert.ok(stored.tokenIv);

    const list = await (await request('/keys')).json();
    assert.equal(list.items[0].revealable, true);
    assert.ok(!JSON.stringify(list).includes(created.token));

    const revealedResponse = await request(`/keys/${created.key.id}/token`);
    assert.equal(revealedResponse.status, 200);
    assert.deepEqual(await revealedResponse.json(), { token: created.token });
    assert.equal((await request('/bins', { token: created.token })).status, 200);
  });
});

test('legacy keys without encrypted plaintext remain usable but report that their token cannot be revealed', async () => {
  await withWorker(undefined, async (request, bucket) => {
    const createdResponse = await request('/keys', { method: 'POST', value: { name: '旧密钥模拟', scopes: ['bin:read'] } });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const path = `keys/${created.key.id}/meta.json`;
    const stored = await (await bucket.get(path)).json();
    delete stored.tokenCiphertext;
    delete stored.tokenIv;
    await bucket.put(path, JSON.stringify(stored));

    const list = await (await request('/keys')).json();
    assert.equal(list.items[0].revealable, false);
    assert.equal((await request(`/keys/${created.key.id}/token`)).status, 409);
    assert.equal((await request('/bins', { token: created.token })).status, 200);
  });
});


test('API keys can be permanently deleted from R2 and immediately stop authenticating', async () => {
  await withWorker(undefined, async (request, bucket) => {
    const createdResponse = await request('/keys', { method: 'POST', value: { name: '永久删除测试', scopes: ['bin:read'] } });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const path = `keys/${created.key.id}/meta.json`;
    assert.ok(await bucket.get(path));
    assert.equal((await request('/bins', { token: created.token })).status, 200);

    const purgeResponse = await request(`/keys/${created.key.id}/purge`, { method: 'DELETE' });
    assert.equal(purgeResponse.status, 200);
    assert.deepEqual(await purgeResponse.json(), { ok: true, id: created.key.id });
    assert.equal(await bucket.get(path), null);

    const list = await (await request('/keys')).json();
    assert.equal(list.items.some(item => item.id === created.key.id), false);
    assert.equal((await request('/bins', { token: created.token })).status, 401);
    assert.equal((await request(`/keys/${created.key.id}/purge`, { method: 'DELETE' })).status, 404);

    const activity = await (await request('/activity?action=key.deleted')).json();
    assert.equal(activity.items.some(item => item.resourceId === created.key.id), true);
  });
});

test('revoked API keys can still be permanently deleted, while Bearer auth cannot use key-management purge', async () => {
  await withWorker(undefined, async (request, bucket) => {
    const createdResponse = await request('/keys', { method: 'POST', value: { name: '撤销后删除', scopes: ['bin:read'] } });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const path = `keys/${created.key.id}/meta.json`;

    assert.equal((await request(`/keys/${created.key.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(await bucket.get(path));

    assert.equal((await request(`/keys/${created.key.id}/purge`, { method: 'DELETE', token: created.token })).status, 401);
    assert.ok(await bucket.get(path));

    assert.equal((await request(`/keys/${created.key.id}/purge`, { method: 'DELETE' })).status, 200);
    assert.equal(await bucket.get(path), null);
  });
});
