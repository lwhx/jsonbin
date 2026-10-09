#!/usr/bin/env node
// Opt-in SEC-002 authentication, Key and 429 tests on the isolated Preview.
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { previewOrigin, SEC002_PREVIEW_ORIGIN } from './check-sec002-preview.mjs';

export async function credentialedSmoke({ password, username = 'preview-admin',
  origin = SEC002_PREVIEW_ORIGIN, fetchImpl = fetch, skipMinuteWait = false } = {}) {
  const base = previewOrigin(origin);
  if (!password || password.length < 16) throw Error('SEC002_PREVIEW_ADMIN_PASSWORD required');
  if (username !== 'preview-admin') throw Error('username_must_be_preview_admin');
  let cookie = '';
  const binIds = [], keyIds = [], checks = [], cleanupWarnings = [];
  const send = (path, opt = {}) => {
    if (!/^\/[a-z0-9/-]+$/i.test(path) || path.startsWith('//')) throw Error('invalid_api_path');
    const headers = {
      Origin: base,
      ...(opt.value === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(opt.session && cookie ? { Cookie: cookie } : {}),
      ...(opt.token ? { Authorization: 'Bearer ' + opt.token } : {}),
      ...opt.headers,
    };
    return fetchImpl(base + '/api/v1' + path, {
      method: opt.method || 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(15000),
      ...(opt.value === undefined ? {} : { body: JSON.stringify(opt.value) }),
    });
  };
  const expect = async (label, path, status, opt) => {
    const r = await send(path, opt);
    if (r.status !== status) throw Error(label + ': HTTP ' + r.status + ' instead of ' + status);
    checks.push(label);
    return r;
  };
  try {
    const conf = await (await expect('Preview auth config', '/auth/config', 200)).json();
    if (conf.passwordEnabled !== true) throw Error('Set Preview-only ADMIN_PASSWORD and SESSION_SECRET');
    const login = await expect('Preview login', '/auth/login', 200, {
      method: 'POST', value: { username, password },
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
    if (!cookie.includes('=')) throw Error('Missing Preview session Cookie');
    const marker = randomUUID();
    const newBin = async visibility => {
      const res = await expect('Create test ' + visibility + ' Bin', '/bins', 201, {
        method: 'POST', session: true,
        value: { name: 'SEC002-' + marker + '-' + visibility, visibility, value: { sec002: marker } },
      });
      const bin = await res.json();
      if (!bin.meta?.id || !bin.etag) throw Error('Unexpected Bin create result');
      binIds.push(bin.meta.id);
      return bin;
    };
    const a = await newBin('private'), b = await newBin('public');
    const aPath = '/bins/' + a.meta.id, bPath = '/bins/' + b.meta.id;
    await expect('Private anonymous denied', aPath, 401);
    await expect('Public anonymous read', bPath, 200);
    await expect('Invalid Bearer cannot use public fallback', bPath, 401, { token: 'not-a-sec002-token' });
    const newKey = async (name, overrides) => {
      const res = await expect('Create test ' + name + ' Key', '/keys', 201, {
        method: 'POST', session: true,
        value: { name: 'SEC002-' + marker + '-' + name, scopes: ['bin:read'], ...overrides },
      });
      const obj = await res.json();
      if (!obj.key?.id || !obj.token) throw Error('Unexpected API Key create result');
      keyIds.push(obj.key.id);
      return obj;
    };
    const scoped = await newKey('scoped', {
      resourceAccess: { mode: 'restricted', binIds: [b.meta.id], collectionIds: [] },
      rateLimitPerMinute: null,
    });
    await expect('Scoped Key allowed', bPath, 200, { token: scoped.token });
    await expect('Scoped Key cannot read other Bin', aPath, 403, { token: scoped.token });
    const limited = await newKey('limited', { rateLimitPerMinute: 3 });
    // Avoid a false 429 assertion if real time crosses the minute boundary.
    if (!skipMinuteWait) {
      const intoMinute = Date.now() % 60000;
      if (intoMinute > 49000) await new Promise(done => setTimeout(done, 60100 - intoMinute));
    }
    for (let i = 1; i <= 3; i++) await expect('Limited Key allowed ' + i, bPath, 200, { token: limited.token });
    const rate = await expect('Limited Key 429', bPath, 429, { token: limited.token });
    const retry = Number(rate.headers.get('retry-after'));
    if (!Number.isInteger(retry) || retry < 1 || retry > 60) throw Error('429 Retry-After invalid');
    checks.push('Retry-After header');
    await expect('Session unaffected by Key 429', aPath, 200, { session: true });
    const patched = await expect('Set Key rate limit to null', '/keys/' + limited.key.id, 200, {
      method: 'PATCH', session: true, value: { rateLimitPerMinute: null },
    });
    if ((await patched.json()).key?.rateLimitPerMinute !== null) throw Error('Null rate limit not persisted');
    await expect('Explicitly unlimited Key works', bPath, 200, { token: limited.token });
    await expect('Revoke test Key', '/keys/' + scoped.key.id, 200, { method: 'DELETE', session: true });
    await expect('Revoked Key rejected', bPath, 401, { token: scoped.token });
    const privateMeta = await expect('Switch public Bin to private', bPath + '/meta', 200, {
      method: 'PATCH', session: true, headers: { 'If-Match': b.etag },
      value: { visibility: 'private' },
    });
    if ((await privateMeta.json()).meta?.visibility !== 'private') throw Error('Visibility change failed');
    await expect('Public to private revokes anonymous', bPath, 401);
  } finally {
    // Cleanup is scoped to UUIDs returned from THIS invocation; no global deletes.
    if (cookie) {
      for (const id of keyIds) try {
        const r = await send('/keys/' + id + '/purge', { method: 'DELETE', session: true });
        if (![200,404].includes(r.status)) cleanupWarnings.push('Key cleanup HTTP ' + r.status);
      } catch { cleanupWarnings.push('Key cleanup failed'); }
      for (const id of binIds) try {
        const r = await send('/bins/' + id, { method: 'DELETE', session: true });
        if (![200,404].includes(r.status)) cleanupWarnings.push('Bin deletion HTTP ' + r.status);
      } catch { cleanupWarnings.push('Bin deletion failed'); }
      if (binIds.length) try {
        const r = await send('/trash/bins', { session: true });
        if (r.status !== 200) throw Error('Preview Trash unavailable');
        const items = (await r.json()).items || [];
        for (const id of binIds) {
          const obj = items.find(item => item?.meta?.id === id);
          if (!obj?.etag) { cleanupWarnings.push('Test Bin remains in Trash'); continue; }
          const purged = await send('/trash/bins/' + id, {
            method: 'DELETE', session: true, headers: { 'If-Match': obj.etag },
          });
          if (![200,404].includes(purged.status)) cleanupWarnings.push('Bin purge HTTP ' + purged.status);
        }
      } catch { cleanupWarnings.push('Check test Bin entries in Preview Trash'); }
    }
  }
  return { ok: checks.length >= 20 && cleanupWarnings.length === 0, checks, cleanupWarnings };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    throw Error('Writes test-only records. Pass --execute to confirm.');
  }
  const out = await credentialedSmoke({ password: process.env.SEC002_PREVIEW_ADMIN_PASSWORD });
  for (const result of out.checks) console.log('PASS ' + result);
  for (const warning of out.cleanupWarnings) console.log('WARN ' + warning);
  if (!out.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    // Never print tokens, cookie headers, user-provided JSON or credentials.
    console.error('SEC-002 Preview auth smoke: FAIL ' + String(err?.message || err).slice(0,150));
    process.exitCode = 1;
  });
}
