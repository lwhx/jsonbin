import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Run dependency-free TS module tests under native Node 22 TS stripping. */
test('key usage: native TypeScript storage regression suite', () => {
  const fixture = fileURLToPath(new URL('./support/key-usage-native.mjs', import.meta.url));
  const loader = fileURLToPath(new URL('./support/ts-relative-loader.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--experimental-loader', loader, '--test', fixture],
    { encoding: 'utf8', timeout: 30000, env });
  assert.equal(result.status, 0, `Native TS regressions failed:\n${result.stdout}\n${result.stderr}`);
});
