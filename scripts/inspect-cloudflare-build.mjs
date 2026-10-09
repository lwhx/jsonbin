#!/usr/bin/env node
/**
 * Read-only Cloudflare Workers Builds diagnosis. No deployments, retries or
 * writes. Pass credentials only through CLOUDFLARE_API_TOKEN environment.
 */
import { pathToFileURL } from 'node:url';

const accountPattern = /^[a-f0-9]{32}$/i;
const buildPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const interesting = /error|fail|denied|forbidden|unauthorized|missing|invalid|unsupported|migrat|durable object|binding|bucket|wrangler|preview/i;

export function parseCloudflareBuild(source, accountId = '') {
  let buildId = String(source).trim();
  if (buildId.startsWith('https://')) {
    const url = new URL(buildId);
    if (url.hostname !== 'dash.cloudflare.com') throw Error('Only Cloudflare Dashboard URLs are accepted');
    const path = url.searchParams.get('to') || url.pathname;
    const match = path.match(/\/?([a-f0-9]{32})\/workers\/services\/view\/[^/]+\/(?:production\/)?builds\/([a-f0-9-]{36})(?:\/|$)/i);
    if (!match) throw Error('Cannot extract Cloudflare account ID and build UUID from URL');
    accountId = match[1];
    buildId = match[2];
  }
  if (!accountPattern.test(accountId)) throw Error('Provide CLOUDFLARE_ACCOUNT_ID or a Dashboard build URL');
  if (!buildPattern.test(buildId)) throw Error('Invalid Workers Build UUID');
  return { accountId: accountId.toLowerCase(), buildId: buildId.toLowerCase() };
}

/** Redaction is best effort: review all output before sharing it. */
export function redactBuildLine(value) {
  return String(value)
    .replace(/(\bauthorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(\bBearer\s+)[a-z0-9._~+/-]{18,}/gi, '$1[REDACTED]')
    .replace(/(\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|ADMIN_PASSWORD|SESSION_SECRET|TOKEN_PEPPER|GITHUB_CLIENT_SECRET)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/("(?:access_token|refresh_token|password|secret|api_key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"');
}

export async function readCloudflareBuild({ accountId, buildId, token, fetchImpl = fetch, maxPages = 20 }) {
  if (!accountPattern.test(accountId) || !buildPattern.test(buildId)) throw Error('Invalid build identifiers');
  if (!token) throw Error('Set CLOUDFLARE_API_TOKEN with Workers CI Read permission');
  const base = 'https://api.cloudflare.com/client/v4/accounts/' + accountId + '/builds/builds/' + buildId;
  const get = async url => {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    let payload;
    try { payload = await response.json(); } catch { throw Error('Cloudflare returned non-JSON response HTTP ' + response.status); }
    if (!response.ok || payload?.success !== true) {
      const codes = Array.isArray(payload?.errors) ? payload.errors.map(x => x.code).join(',') : 'unknown';
      throw Error('Cloudflare API HTTP ' + response.status + ' (error code ' + codes + '); verify Workers CI Read permission');
    }
    return payload.result;
  };
  const build = await get(base);
  const lines = [];
  const seen = new Set();
  let cursor = '', truncated = false;
  for (let page = 0; page < maxPages; page++) {
    const url = base + '/logs' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '');
    const data = await get(url);
    if (!Array.isArray(data?.lines)) throw Error('Unexpected Cloudflare build logs schema');
    for (const entry of data.lines) lines.push(Array.isArray(entry) ? entry.slice(1).join(' ') : String(entry));
    truncated = Boolean(data.truncated);
    const next = typeof data.cursor === 'string' ? data.cursor : '';
    if (!next || seen.has(next)) break;
    if (page === maxPages - 1) { truncated = true; break; }
    seen.add(next);
    cursor = next;
  }
  return { accountId, buildId, build, lines, truncated };
}

export function summarizeCloudflareBuild(result, all = false) {
  const meta = result.build?.build_trigger_metadata || {};
  const sanitized = result.lines.map(redactBuildLine);
  const failures = sanitized.filter(line => interesting.test(line));
  return {
    buildId: result.buildId,
    status: String(result.build?.status || 'unknown'),
    outcome: String(result.build?.build_outcome || 'unknown'),
    branch: redactBuildLine(meta.branch || 'unknown'),
    buildCommand: redactBuildLine(meta.build_command || ''),
    deployCommand: redactBuildLine(meta.deploy_command || ''),
    totalLines: sanitized.length,
    truncated: result.truncated,
    relevantLines: (all ? sanitized : failures.length ? failures : sanitized).slice(all ? -100 : -45),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/inspect-cloudflare-build.mjs --url CLOUD_FLARE_DASHBOARD_BUILD_URL [--json] [--all]');
    console.log('Or: CLOUDFLARE_ACCOUNT_ID=... node scripts/inspect-cloudflare-build.mjs --build BUILD_UUID');
    console.log('CLOUDFLARE_API_TOKEN must be set in the environment (Workers CI Read). Read-only.');
    return;
  }
  let source = '', accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' || argv[i] === '--build') {
      source = argv[++i] || '';
    } else if (argv[i] === '--account-id') {
      accountId = argv[++i] || '';
    } else if (!['--json', '--all'].includes(argv[i])) {
      throw Error('Unknown argument: ' + argv[i]);
    }
  }
  if (!source) throw Error('Supply --url or --build (try --help)');
  const loc = parseCloudflareBuild(source, accountId);
  const report = summarizeCloudflareBuild(await readCloudflareBuild({
    ...loc, token: process.env.CLOUDFLARE_API_TOKEN,
  }), argv.includes('--all'));
  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log('Cloudflare Build ' + report.buildId + ' -- ' + report.status + ' / ' + report.outcome);
  console.log('Branch: ' + report.branch);
  if (report.buildCommand) console.log('Build command: ' + report.buildCommand);
  if (report.deployCommand) console.log('Deploy/Preview command: ' + report.deployCommand);
  console.log('Log lines: ' + report.totalLines + (report.truncated ? ' (partial)' : ''));
  console.log('---- Relevant lines, redacted; review before sharing ----');
  for (const line of report.relevantLines) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Cloudflare diagnosis failed: ' + redactBuildLine(error?.message || error));
    process.exitCode = 1;
  });
}
