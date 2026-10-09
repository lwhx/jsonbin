import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialedSmoke } from '../scripts/check-sec002-preview-auth.mjs';

test('SEC-002 authenticated smoke cannot reach production or use missing credentials', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw Error('unexpected request'); };
  await assert.rejects(credentialedSmoke({ fetchImpl }), /SEC002_PREVIEW_ADMIN_PASSWORD/);
  await assert.rejects(credentialedSmoke({
    password: 'only-for-tests-1234567890', origin: 'https://js.gnn.im', fetchImpl,
  }), /origin_must_be_sec002_preview/);
  await assert.rejects(credentialedSmoke({
    username: 'production-admin', password: 'only-for-tests-1234567890', fetchImpl,
  }), /username_must_be_preview_admin/);
  assert.equal(requests, 0);
});

test('SEC-002 smoke detects missing Preview secrets without password guesses or writes', async () => {
  let requests = 0;
  const fetchImpl = async (_url, opt) => {
    requests++;
    assert.equal(opt.method, 'GET');
    return Response.json({ passwordEnabled: false });
  };
  await assert.rejects(credentialedSmoke({
    password: 'only-for-tests-1234567890', fetchImpl,
  }), /Set Preview-only ADMIN_PASSWORD and SESSION_SECRET/);
  assert.equal(requests, 1);
});
