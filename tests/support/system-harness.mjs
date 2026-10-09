import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
export async function createSystemHarness(name) {
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{ name, modules: true,
    scriptPath: 'dist/jsonbin/index.js', compatibilityDate: '2026-10-03', r2Buckets: ['DATA'], kvNamespaces: ['CACHE'], durableObjects: { RATE_LIMITER: { className: 'ApiRateLimiter', useSQLite: true } } }] }));
  const bucket = await mf.getR2Bucket('DATA', name), cache = await mf.getKVNamespace('CACHE', name), limiter = await mf.getDurableObjectNamespace('RATE_LIMITER', name);
  const worker = (await import('../../dist/jsonbin/index.js')).default;
  const env = { DATA: bucket, CACHE: cache, RATE_LIMITER: limiter, ADMIN_USERNAME: 'test', ADMIN_PASSWORD: randomBytes(32).toString('hex'), SESSION_SECRET: randomBytes(32).toString('hex') };
  const login = await worker.fetch(new Request('https://example.test/api/v1/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:env.ADMIN_USERNAME,password:env.ADMIN_PASSWORD})}), env);
  if (login.status !== 200) throw new Error('harness_login_failed');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { worker, env, bucket, cookie, close: () => mf.dispose(),
    getLimiterStorage(identity) { return mf.getDurableObjectStorage(limiter.idFromName(identity)); },
    adapt(overrides) { return new Proxy(bucket, {get(target,key) { if (key in overrides) return overrides[key]; const value=target[key]; return typeof value==='function' ? value.bind(target) : value; }}); },
    request(path,options={},bindings=env) {
      return worker.fetch(new Request('https://example.test/api/v1'+path, {method:options.method??'GET', headers:{Cookie:cookie,'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.30',...options.headers}, ...(options.value===undefined ? {} : {body:JSON.stringify(options.value)}), ...(options.body===undefined?{}:{body:options.body})}), bindings);
    }
  };
}
