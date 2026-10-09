import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const password = randomBytes(32).toString('hex');
const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{
  name: 'cli-tests', modules: true, scriptPath: 'dist/jsonbin/index.js',
  compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], kvNamespaces: ['CACHE'], durableObjects: { RATE_LIMITER: { className: 'ApiRateLimiter', useSQLite: true } },
  bindings: { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex') },
}] }));
const app = (await import('../dist/jsonbin/index.js')).default;
const env = { DATA: await mf.getR2Bucket('DATA', 'cli-tests'), CACHE: await mf.getKVNamespace('CACHE', 'cli-tests'), RATE_LIMITER: await mf.getDurableObjectNamespace('RATE_LIMITER', 'cli-tests'),
  ADMIN_USERNAME: 'test', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex') };

// A real HTTP origin so the CLI's fetch can reach the worker.
let origin;
/** Optional hook fired after a proxied GET /bins/:id — used to race the CLI's conditional PUT. */
let onBinGet = null;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const response = await app.fetch(new Request(origin + req.url, { method: req.method, headers: { ...req.headers, 'CF-Connecting-IP': '203.0.113.25' }, ...(body ? { body } : {}) }), env);
  if (req.method === 'GET' && /^\/api\/v1\/bins\/[0-9a-f-]{36}$/.test(req.url) && response.ok && onBinGet) {
    const hook = onBinGet; onBinGet = null;
    await hook(req.url, response.headers.get('etag'));
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

let token = '';
test.before(async () => {
  const login = await app.fetch(new Request(`${origin}/api/v1/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test', password }) }), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const key = await app.fetch(new Request(`${origin}/api/v1/keys`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'cli', scopes: ['bin:read', 'bin:create', 'bin:update'] }) }), env);
  assert.equal(key.status, 201);
  token = (await key.json()).token;
});
test.after(async () => { await new Promise(r => server.close(r)); await mf.dispose(); });

function cli(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join('cli', 'jsonbin.mjs'), ...args], {
      env: { ...process.env, JSONBIN_URL: origin, JSONBIN_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('cli whoami/list/push/pull/diff/publish cover the full round trip', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonbin-cli-'));
  const configFile = join(dir, 'config.json');
  const updatedFile = join(dir, 'config-v2.json');
  const pulledFile = join(dir, 'pulled.json');

  const whoami = await cli(['whoami']);
  assert.equal(whoami.code, 0, whoami.stderr);
  assert.match(whoami.stdout, /令牌有效/);

  const listEmpty = await cli(['list']);
  assert.equal(listEmpty.code, 0);
  assert.match(listEmpty.stdout, /没有数据仓/);

  await writeFile(configFile, JSON.stringify({ env: 'staging', port: 4000, feature: { dark: false } }, null, 2));
  const created = await cli(['push', configFile]);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /已创建/);
  const id = /[0-9a-f-]{36}/.exec(created.stdout)[0];

  const list = await cli(['list']);
  assert.match(list.stdout, new RegExp(id.slice(0, 8)));
  assert.match(list.stdout, /config/);

  const pull = await cli(['pull', id, '-o', pulledFile]);
  assert.equal(pull.code, 0);
  assert.deepEqual(JSON.parse(await readFile(pulledFile, 'utf8')), { env: 'staging', port: 4000, feature: { dark: false } });

  const same = await cli(['diff', configFile, id]);
  assert.equal(same.code, 0, same.stderr);
  assert.match(same.stdout, /一致/);

  await writeFile(updatedFile, JSON.stringify({ env: 'production', port: 8080, feature: { dark: true }, extra: [1, 2] }, null, 2));
  const changed = await cli(['diff', updatedFile, id]);
  assert.equal(changed.code, 1);
  assert.match(changed.stdout, /~ env/);
  assert.match(changed.stdout, /\+ extra/);

  const pushed = await cli(['push', updatedFile, '--target', id]);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.match(pushed.stdout, /v2/);

  const publish = await cli(['publish', id]);
  assert.equal(publish.code, 0, publish.stderr);
  assert.match(publish.stdout, /已发布/);
  const publishedPull = await cli(['pull', id, '--published']);
  assert.deepEqual(JSON.parse(publishedPull.stdout), { env: 'production', port: 8080, feature: { dark: true }, extra: [1, 2] });

  // A concurrent write between the CLI's ETag fetch and its PUT yields 412;
  // without --force the push exits 1, with --force it refetches and wins.
  onBinGet = async (url, etag) => {
    await app.fetch(new Request(origin + url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-Match': etag.replace(/"/g, '') },
      body: JSON.stringify({ value: { raced: true } }) }), env);
  };
  const stale = await cli(['push', configFile, '--target', id]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /412/);
  onBinGet = null;
  const forced = await cli(['push', configFile, '--target', id, '--force']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stdout, /v[34]/);
});

test('cli pull resolves slug targets and pull of a missing bin fails cleanly', async () => {
  const response = await app.fetch(new Request(`${origin}/api/v1/bins`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '别名仓', slug: 'cli-slug-target', value: { via: 'slug' } }) }), env);
  assert.equal(response.status, 201);

  const pulled = await cli(['pull', 'cli-slug-target']);
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.deepEqual(JSON.parse(pulled.stdout), { via: 'slug' });

  const missing = await cli(['pull', '11111111-1111-4111-8111-111111111111']);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /404/);
});

test('cli reports missing configuration clearly', async () => {
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [join('cli', 'jsonbin.mjs'), 'whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => stderr += chunk);
    child.on('exit', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /JSONBIN_URL/);
});
