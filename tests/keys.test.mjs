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
    const request = (path, { method = 'GET', value, token, etag } = {}) => mf.dispatchFetch('http://localhost/api/v1' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { Cookie: cookie }), ...(etag ? { 'If-Match': etag } : {}) },
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


test('P14 resource policies restrict Bin and Collection access dynamically', async () => {
  await withWorker(undefined, async (request) => {
    const collectionA = await (await request('/collections', { method: 'POST', value: { name: 'Allowed' } })).json();
    const collectionB = await (await request('/collections', { method: 'POST', value: { name: 'Denied' } })).json();

    const binA = await (await request('/bins', { method: 'POST', value: { name: 'Bin A', collectionId: collectionA.meta.id, value: { allowed: true } } })).json();
    const binB = await (await request('/bins', { method: 'POST', value: { name: 'Bin B', collectionId: collectionB.meta.id, value: { denied: true } } })).json();
    const binDirect = await (await request('/bins', { method: 'POST', value: { name: 'Bin Direct', value: { direct: true } } })).json();

    // 1. Old / unspecified key defaults to "all" mode
    const defaultKeyRes = await request('/keys', { method: 'POST', value: { name: 'Default All', scopes: ['bin:read', 'collection:read'] } });
    const defaultKey = await defaultKeyRes.json();
    assert.equal(defaultKey.key.resourceAccess.mode, 'all');
    const defaultBinList = await (await request('/bins', { token: defaultKey.token })).json();
    assert.equal(defaultBinList.items.length >= 3, true);

    // 2. Restricted key with collection A and binDirect
    const keyResponse = await request('/keys', {
      method: 'POST',
      value: {
        name: 'Restricted',
        scopes: ['bin:read', 'bin:create', 'bin:update', 'collection:read', 'history:read'],
        resourceAccess: {
          mode: 'restricted',
          binIds: [binDirect.meta.id],
          collectionIds: [collectionA.meta.id],
        },
      },
    });
    assert.equal(keyResponse.status, 201);
    const key = await keyResponse.json();
    assert.equal(key.key.resourceAccess.mode, 'restricted');

    // 3. List only returns allowed Bin/Collection
    const binList = await (await request('/bins', { token: key.token })).json();
    assert.deepEqual(binList.items.map(item => item.id).sort(), [binA.meta.id, binDirect.meta.id].sort());
    const collectionList = await (await request('/collections', { token: key.token })).json();
    assert.deepEqual(collectionList.items.map(item => item.id), [collectionA.meta.id]);

    // 4. Direct access honors collection & direct bin policy
    assert.equal((await request('/bins/' + binA.meta.id, { token: key.token })).status, 200);
    assert.equal((await request('/bins/' + binDirect.meta.id, { token: key.token })).status, 200);
    assert.equal((await request('/bins/' + binB.meta.id, { token: key.token })).status, 403);
    assert.equal((await request('/collections/' + collectionA.meta.id, { token: key.token })).status, 200);
    assert.equal((await request('/collections/' + collectionB.meta.id, { token: key.token })).status, 403);

    // 5. Deep path and history access
    assert.equal((await request('/bins/' + binA.meta.id + '/value/allowed', { token: key.token })).status, 200);
    assert.equal((await request('/bins/' + binB.meta.id + '/value/denied', { token: key.token })).status, 403);
    assert.equal((await request('/bins/' + binA.meta.id + '/versions', { token: key.token })).status, 200);
    assert.equal((await request('/bins/' + binB.meta.id + '/versions', { token: key.token })).status, 403);

    // 6. Dynamic move: Move binA from collectionA to collectionB -> access immediately lost
    const moveRes = await request('/bins/' + binA.meta.id + '/meta', {
      method: 'PATCH',
      etag: binA.etag,
      value: { collectionId: collectionB.meta.id },
    });
    assert.equal(moveRes.status, 200);
    assert.equal((await request('/bins/' + binA.meta.id, { token: key.token })).status, 403);

    // 7. Restricted key cannot create ungrouped Bin, but can create inside allowed Collection
    assert.equal((await request('/bins', { method: 'POST', token: key.token, value: { name: 'Ungrouped', value: {} } })).status, 403);
    assert.equal((await request('/bins', { method: 'POST', token: key.token, value: { name: 'Allowed Create', collectionId: collectionA.meta.id, value: {} } })).status, 201);
    assert.equal((await request('/bins', { method: 'POST', token: key.token, value: { name: 'Denied Create', collectionId: collectionB.meta.id, value: {} } })).status, 403);
  });
});

test('P18: API Key records authorized usage counters atomically in useApiKey CAS', async () => {
  await withWorker(undefined, async (request) => {
    const createKeyRes = await request('/keys', {
      method: 'POST',
      value: { name: 'Usage Counter Key', scopes: ['bin:read'] },
    });
    assert.equal(createKeyRes.status, 201);
    const { key, token } = await createKeyRes.json();
    assert.equal(key.usageTotal, 0);

    // Authenticate 3 valid read requests
    await request('/bins', { token });
    await request('/bins', { token });
    await request('/bins', { token });

    // Read keys list to verify counters
    const listRes = await request('/keys');
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const updatedKey = list.items.find(k => k.id === key.id);

    assert.equal(updatedKey.usageTotal, 3);
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(updatedKey.usageDaily[today], 3);
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

test('audit: usage counters skip resource denials, scope misses and invalid tokens', async () => {
  await withWorker(undefined, async (request) => {
    const allowedCol = await (await request('/collections', { method: 'POST', value: { name: 'Usage Allowed' } })).json();
    const deniedBin = await (await request('/bins', { method: 'POST', value: { name: 'Usage Denied', value: { x: 1 } } })).json();
    const key = await (await request('/keys', { method: 'POST', value: {
      name: 'usage-policy', scopes: ['bin:read', 'bin:create'],
      resourceAccess: { mode: 'restricted', binIds: [], collectionIds: [allowedCol.meta.id] },
    } })).json();

    const usage = async () => (await (await request('/keys')).json()).items.find(k => k.id === key.key.id).usageTotal;

    // 401 invalid token -> not counted
    await request('/bins', { token: 'jb_live_' + '0'.repeat(32) + '_' + 'A'.repeat(43) });
    assert.equal(await usage(), 0, 'invalid token must not be counted');

    // 403 insufficient scope -> not counted
    await request('/keys', { token: key.token });
    assert.equal(await usage(), 0, 'scope miss must not be counted');

    // 403 resource denial -> not counted
    const deniedRes = await request('/bins/' + deniedBin.meta.id, { token: key.token });
    assert.equal(deniedRes.status, 403);
    assert.equal(await usage(), 0, 'resource denial must not be counted');

    // Allowed access -> counted exactly once
    const allowedBin = await (await request('/bins', { method: 'POST', token: key.token, value: { name: 'Usage OK', collectionId: allowedCol.meta.id, value: { ok: true } } })).json();
    assert.equal(allowedBin.status ?? 201, 201);
    assert.equal((await request('/bins/' + allowedBin.meta.id, { token: key.token })).status, 200);
    assert.equal(await usage(), 2, 'allowed create + read are counted');

    // 404 on a permitted-but-missing resource is still authorized usage
    await request('/bins/11111111-1111-4111-8111-111111111111', { token: key.token });
    assert.equal(await usage(), 3);
  });
});
