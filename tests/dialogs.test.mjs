import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'react-app');

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : [];
  }));
  return nested.flat();
}

test('React 业务代码不再使用浏览器原生 confirm/alert/prompt', async () => {
  const offenders = [];
  for (const file of await sourceFiles(root)) {
    const content = await readFile(file, 'utf8');
    for (const api of ['window.confirm(', 'window.alert(', 'window.prompt(']) {
      if (content.includes(api)) offenders.push(file.replace(root, 'src/react-app') + ': ' + api);
    }
  }
  assert.deepEqual(offenders, []);
});
