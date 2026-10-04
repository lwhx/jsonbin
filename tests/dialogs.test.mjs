import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test("业务前端不再使用浏览器原生 confirm/alert/prompt", async () => {
  const files = await walk(path.resolve("src/react-app"));
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const api of ["window.confirm(", "window.alert(", "window.prompt("]) {
      if (source.includes(api)) offenders.push(path.relative(process.cwd(), file) + ": " + api);
    }
  }
  assert.deepEqual(offenders, []);
});

test("弹窗遮罩和 dialog 容器只由共享 Dialog 组件实现", async () => {
  const files = await walk(path.resolve("src/react-app"));
  const offenders = [];
  for (const file of files) {
    if (file.endsWith(path.join("components", "Dialog.tsx"))) continue;
    const source = await readFile(file, "utf8");
    if (source.includes('className="dialog-backdrop"')) offenders.push(path.relative(process.cwd(), file));
  }
  assert.deepEqual(offenders, []);
});
