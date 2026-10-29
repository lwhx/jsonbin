/**
 * Read-only monitor for the GitHub -> Cloudflare production build integration.
 * GitHub CI success alone does NOT mean that Cloudflare deployed a Worker.
 * Unlike Preview checks, the production build link contains /production/builds/.
 */
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function classifyCloudflareProductionBuild(checks) {
  const cloudflare = (Array.isArray(checks) ? checks : []).filter(check =>
    check?.name === 'Workers Builds: jsonbin' &&
    check?.app?.slug === 'cloudflare-workers-and-pages'
  );
  const production = cloudflare.filter(check => {
    if (typeof check.details_url !== 'string') return false;
    try {
      const url = new URL(check.details_url);
      return url.hostname === 'dash.cloudflare.com' &&
        /^\\/[a-z0-9]+\\/workers\\/services\\/view\\/jsonbin\\/production\\/builds\\/[^/]+\\/?$/i.test(url.pathname);
    } catch { return false; }
  }).sort((a, b) => (a.started_at ?? '').localeCompare(b.started_at ?? ''));

  const selected = production.at(-1);
  const previewCount = cloudflare.length - production.length;
  if (!selected) return { state: 'missing', previewCount, url: null };
  if (selected.status === 'completed') {
    return {
      state: selected.conclusion === 'success' ? 'success' : 'failure',
      conclusion: selected.conclusion ?? 'unknown',
      previewCount,
      url: selected.details_url,
    };
  }
  return { state: 'pending', previewCount, url: selected.details_url };
}

export async function fetchGitHubChecks({ repository, sha, token, fetchImpl = fetch }) {
  if (!/^[\\w.-]+\\/[\\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('invalid_github_repository_or_commit');
  }
  if (!token) throw new Error('GITHUB_TOKEN_missing');
  const url = `https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jsonbin-cloudflare-build-monitor',
    },
  });
  if (!response.ok) throw new Error(`github_checks_http_${response.status}`);
  const data = await response.json();
  return classifyCloudflareProductionBuild(data.check_runs);
}

export async function waitForProductionBuild(options) {
  const { attempts = 42, intervalMs = 10000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = options;
  let last = { state: 'missing', previewCount: 0, url: null };
  let failureStreak = 0;
  for (let i = 1; i <= attempts; i++) {
    last = await fetchGitHubChecks(options);
    console.log(`Cloudflare production build check ${i}/${attempts}: ${last.state} (preview-only checks: ${last.previewCount})`);
    if (last.state === 'success') return last;
    // Cloudflare sometimes posts an early failed placeholder before the real
    // check starts. It must remain failed for >= 90 seconds before we stop.
    failureStreak = last.state === 'failure' ? failureStreak + 1 : 0;
    if (failureStreak >= 9) return last;
    if (i < attempts) await sleep(intervalMs);
  }
  return last;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  const result = await waitForProductionBuild({ repository, sha, token });
  const link = result.url ? `[Cloudflare build log](${result.url})` : 'No production build check was found';
  const ok = result.state === 'success';
  const summary = [
    '## Cloudflare production build monitor',
    '',
    `- Commit: \`${sha.slice(0, 12)}\``,
    `- Production check: **${result.state}**`,
    `- Preview-only checks observed: ${result.previewCount}`,
    `- Detail: ${link}`,
    '',
    ok
      ? 'A successful production **build check** was found. Verify active rollout in Cloudflare Deployments; a successful build alone does not prove the new version receives traffic.'
      : 'GitHub CI does not deploy the Worker. Check Cloudflare Worker > Settings > Build > Branch control (production=main), build watch paths and GitHub repository connection. Preview checks do not count as production builds.',
  ].join('\\n') + '\\n';
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!ok) {
    console.error('::error title=Cloudflare production build missing::Cloudflare did not report a successful production build for the main branch commit.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error('Cloudflare production monitor failed:', error?.message ?? 'unknown_error');
    process.exitCode = 1;
  });
}
