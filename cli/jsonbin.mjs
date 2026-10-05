#!/usr/bin/env node
/**
 * JSONBin CLI — zero-dependency client for the /api/v1 HTTP API.
 *
 * Configuration (flags override environment):
 *   --url <origin>    or JSONBIN_URL    e.g. https://js.gnn.im
 *   --token <token>   or JSONBIN_TOKEN  an API key (jb_live_...)
 *   --slug            treat <target> as a slug alias instead of an id
 *
 * Commands:
 *   whoami                              verify credentials against the instance
 *   list [--limit N]                    table of bins (id, version, updated, name)
 *   pull <target> [--published] [-o f]  fetch current (or published) JSON
 *   push <file> [--target t] [--name n] [--create] [--force]
 *                                       create or conditionally update a bin
 *   diff <file> <target>                deep-compare local JSON with remote
 *   publish <target> [--version n]      publish the current (or given) version
 */
import { readFile, writeFile } from "node:fs/promises";

const USAGE = `用法: jsonbin <command> [options]

命令:
  whoami                                验证实例与令牌
  list [--limit N]                      列出数据仓
  pull <id|slug> [--published] [-o 文件]  拉取当前或已发布 JSON
  push <文件> [--target id|slug] [--name 名称] [--create] [--force]
                                        创建或条件更新数据仓
  diff <文件> <id|slug>                 对比本地与远端 JSON（有差异退出码 1）
  publish <id|slug> [--version N]       发布版本

通用选项:
  --url <origin>      实例地址（或 JSONBIN_URL）
  --token <token>     API Key（或 JSONBIN_TOKEN）
  --slug              目标按 slug 别名解析
  --help, -h          显示本帮助`;

class CliError extends Error {
  code;
  constructor(message, code = 2) { super(message); this.code = code; }
}
function fail(message, code = 2) {
  throw new CliError(message, code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--help" || value === "-h") { flags.help = true; continue; }
    if (value.startsWith("-")) {
      const key = value.replace(/^-+/, "");
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) { flags[key] = next; index++; }
      else flags[key] = true;
    } else positional.push(value);
  }
  return { positional, flags };
}

function configuration(flags) {
  const origin = (flags.url ?? process.env.JSONBIN_URL ?? "").replace(/\/+$/, "");
  const token = flags.token ?? process.env.JSONBIN_TOKEN ?? "";
  if (!origin) fail("缺少实例地址：使用 --url 或设置 JSONBIN_URL");
  if (!token) fail("缺少 API Key：使用 --token 或设置 JSONBIN_TOKEN");
  return { origin, token };
}

async function api(origin, token, path, init = {}) {
  let response;
  try {
    response = await fetch(`${origin}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  } catch (error) {
    fail(`无法连接 ${origin}: ${error.message}`);
  }
  return response;
}

async function readJson(response, context) {
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { fail(`${context}: 响应不是有效 JSON（HTTP ${response.status}）`); }
  }
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body ? `: ${body.error}` : "";
    fail(`${context} 失败 (HTTP ${response.status})${detail}`, response.status === 412 ? 1 : 2);
  }
  return body;
}

async function resolveTarget(config, target, { published = false } = {}) {
  const bySlug = config.slug || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
  const base = bySlug ? `/b/${encodeURIComponent(target)}` : `/bins/${encodeURIComponent(target)}`;
  const response = await api(config.origin, config.token, published ? `${base}/published` : base);
  const body = await readJson(response, "读取数据仓");
  const meta = body.meta ?? body;
  const etag = (response.headers.get("etag") ?? body.etag ?? "").replace(/"/g, "");
  if (!meta.id || !etag) fail("无法解析数据仓元数据");
  return { id: meta.id, etag, value: "value" in body ? body.value : body, path: base };
}

async function readLocalFile(file) {
  let text;
  try { text = await readFile(file, "utf8"); }
  catch (error) { fail(`无法读取文件 ${file}: ${error.message}`); }
  try { return JSON.parse(text); }
  catch (error) { fail(`${file} 不是有效 JSON: ${error.message}`); }
}

function diffValues(local, remote, path = "", out = []) {
  if (JSON.stringify(local) === JSON.stringify(remote)) return out;
  const localObject = local !== null && typeof local === "object";
  const remoteObject = remote !== null && typeof remote === "object";
  if (localObject && remoteObject && !Array.isArray(local) === !Array.isArray(remote)) {
    const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      diffValues(local?.[key], remote?.[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  const brief = value => {
    const text = JSON.stringify(value);
    return text === undefined ? "undefined" : text.length > 60 ? `${text.slice(0, 57)}…` : text;
  };
  if (remote === undefined) out.push(`+ ${path} = ${brief(local)}`);
  else if (local === undefined) out.push(`- ${path} = ${brief(remote)}`);
  else out.push(`~ ${path}: ${brief(remote)} → ${brief(local)}`);
  return out;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !positional.length) { console.log(USAGE); return; }
  const [command, ...rest] = positional;
  const config = configuration(flags);

  if (command === "whoami") {
    const response = await api(config.origin, config.token, "/bins");
    await readJson(response, "验证凭据");
    console.log(`已连接 ${config.origin}，令牌有效。`);
    return;
  }

  if (command === "list") {
    const response = await api(config.origin, config.token, "/bins");
    const body = await readJson(response, "列出数据仓");
    const items = body.items.slice(0, Number(flags.limit) > 0 ? Number(flags.limit) : 50);
    if (!items.length) { console.log("（没有数据仓）"); return; }
    for (const item of items) {
      console.log(`${item.id}  v${String(item.currentVersion).padStart(3)}  ${item.updatedAt.slice(0, 19).replace("T", " ")}  ${item.name}`);
    }
    console.log(`\n共 ${body.total} 个（显示 ${items.length} 个）`);
    return;
  }

  if (command === "pull") {
    const target = rest[0];
    if (!target) fail("用法: jsonbin pull <id|slug> [--published] [-o 文件]");
    const { value } = await resolveTarget(config, target, { published: flags.published === true });
    const text = JSON.stringify(value, null, 2) + "\n";
    if (typeof flags.o === "string") { await writeFile(flags.o, text, "utf8"); console.log(`已写入 ${flags.o}`); }
    else process.stdout.write(text);
    return;
  }

  if (command === "push") {
    const file = rest[0];
    if (!file) fail("用法: jsonbin push <文件> [--target id|slug] [--name 名称] [--create] [--force]");
    const value = await readLocalFile(file);
    const name = typeof flags.name === "string" ? flags.name : file.split(/[\\/]/).pop().replace(/\.[^.]*$/, "");

    if (flags.create || !flags.target) {
      const response = await api(config.origin, config.token, "/bins", { method: "POST", body: JSON.stringify({ name, value }) });
      const body = await readJson(response, "创建数据仓");
      console.log(`已创建 ${body.meta.id}（v1，名称“${body.meta.name}”）`);
      return;
    }

    const target = await resolveTarget(config, flags.target);
    let etag = target.etag;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await api(config.origin, config.token, `/bins/${target.id}`, {
        method: "PUT", headers: { "If-Match": etag }, body: JSON.stringify({ value }),
      });
      if (response.status === 412 && attempt === 0 && flags.force === true) {
        const fresh = await resolveTarget(config, flags.target);
        etag = fresh.etag;
        continue;
      }
      const body = await readJson(response, "更新数据仓");
      console.log(`已更新 ${target.id} → v${body.meta.currentVersion}`);
      return;
    }
    fail("并发冲突：远端持续变化，--force 重试仍失败", 1);
  }

  if (command === "diff") {
    const [file, target] = rest;
    if (!file || !target) fail("用法: jsonbin diff <文件> <id|slug>");
    const local = await readLocalFile(file);
    const { value: remote } = await resolveTarget(config, target);
    const changes = diffValues(local, remote);
    if (!changes.length) { console.log("本地与远端一致。"); return; }
    console.log(`发现 ${changes.length} 处差异（+ 本地新增 / - 远端独有 / ~ 修改）:`);
    for (const line of changes.slice(0, 200)) console.log(line);
    if (changes.length > 200) console.log(`…以及另外 ${changes.length - 200} 处`);
    process.exitCode = 1;
    return;
  }

  if (command === "publish") {
    const target = rest[0];
    if (!target) fail("用法: jsonbin publish <id|slug> [--version N]");
    const current = await resolveTarget(config, target);
    const version = Number(flags.version) > 0 ? Number(flags.version) : undefined;
    const response = await api(config.origin, config.token, `/bins/${current.id}/publish`, {
      method: "POST", headers: { "If-Match": current.etag }, body: JSON.stringify(version ? { version } : {}),
    });
    const body = await readJson(response, "发布版本");
    console.log(`已发布 ${current.id} 的 v${body.meta.publishedVersion}（当前 v${body.meta.currentVersion}）`);
    return;
  }

  fail(`未知命令: ${command}\n\n${USAGE}`);
}

main().catch(error => {
  if (error instanceof CliError) {
    process.stderr.write(`jsonbin: ${error.message}\n`);
    process.exitCode = error.code;
    return;
  }
  process.stderr.write(`jsonbin: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
