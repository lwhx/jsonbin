import { spawn } from 'node:child_process';

// Restrict the environment copied into local Worker bindings to test-only values.
const env = {
  PATH: process.env.PATH,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? '/tmp/jsonbin-test-config',
  WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
  ADMIN_USERNAME: 'browser-test',
  ADMIN_PASSWORD: process.env.JSONBIN_TEST_PASSWORD,
  SESSION_SECRET: process.env.JSONBIN_TEST_SESSION_SECRET,
  APP_ORIGIN: 'http://127.0.0.1:5174',
};
const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'tests/vite-test.config.ts', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 0));
