import { readFile } from 'node:fs/promises';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
function originOf(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('origin_required');
  return url.origin;
}

let failures = 0;
function check(name, valid) {
  console.log(`${valid ? 'PASS' : 'FAIL'} ${name}`);
  if (!valid) failures++;
}
try {
  const origin = originOf(process.argv[2] ?? process.env.JSONBIN_PRODUCTION_ORIGIN);
  const browserOrigin = originOf(process.env.JSONBIN_BROWSER_ORIGIN ?? origin);
  const request = (path, options = {}) => fetch(origin + path, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const health = await request('/api/v1/system/health');
  const info = await health.json();
  check('health service/version/bindings', health.status === 200 && info.ok === true && info.service === 'jsonbin' && info.version === version && info.storage?.r2 === true && info.storage?.kv === true);
  check('API security headers', health.headers.get('cache-control') === 'no-store' && health.headers.get('x-content-type-options') === 'nosniff' && health.headers.get('x-frame-options') === 'DENY' && health.headers.get('content-security-policy')?.includes("default-src 'none'") && /^[\da-f-]{36}$/.test(health.headers.get('x-request-id') ?? ''));
  const html = await request('/');
  const csp = html.headers.get('content-security-policy') ?? '';
  check('HTML security headers', html.status === 200 && html.headers.get('content-type')?.includes('text/html') && html.headers.get('x-content-type-options') === 'nosniff' && html.headers.get('x-frame-options') === 'DENY' && html.headers.get('referrer-policy') === 'no-referrer' && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'") && !csp.includes('unsafe-eval'));
  const anonymous = await request('/api/v1/bins');
  check('anonymous private management rejected', anonymous.status === 401 && anonymous.headers.get('cache-control') === 'no-store');
  for (const [name, value, allowed] of [['browser origin', browserOrigin, true], ['foreign origin', 'https://cors-probe.invalid', false], ['opaque origin', 'null', false]]) {
    const response = await request('/api/v1/bins', { method: 'OPTIONS', headers: { Origin: value, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'Content-Type,Authorization,If-Match' } });
    check(`CORS ${name}`, response.status === 204 && response.headers.get('access-control-allow-origin') === (allowed ? value : null) && response.headers.get('cache-control') === 'no-store' && /Origin/i.test(response.headers.get('vary') ?? '') && (!allowed || response.headers.get('access-control-allow-credentials') === 'true'));
  }
} catch {
  console.error('FAIL production probe could not complete; check the origin, connectivity and deployment');
  failures++;
}
if (failures) process.exitCode = 1;
