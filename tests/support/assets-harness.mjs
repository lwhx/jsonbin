import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise the same Worker-first API + static SPA routing as production.
export async function createAssetsHarness() {
  const password = randomBytes(32).toString('hex');
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, workers: [{
    name: 'production-assets', modules: true, scriptPath: 'dist/jsonbin/index.js', compatibilityDate: '2026-10-03',
    r2Buckets: ['DATA'], kvNamespaces: ['CACHE'],
    bindings: { ADMIN_USERNAME: 'assets-test', ADMIN_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex') },
    assets: { directory: 'dist/client', run_worker_first: ['/api/*'], routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: 'single-page-application' } },
  }] }));
  try {
    const origin = (await mf.ready).origin;
    return { origin, password, request: (path, options) => mf.dispatchFetch(origin + path, options), close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
