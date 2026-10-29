import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCloudflareProductionBuild,
  fetchGitHubChecks,
  waitForProductionBuild,
} from '../scripts/check-cloudflare-production-build.mjs';

const repo = 'lwhx/jsonbin';
const sha = 'b7d61f8de27a049fbc4aa15f0eb3e9a80d45790a';
const account = '7946c64d5ff82047528862a11ccd2157';
const base = 'https://dash.cloudflare.com/' + account +
  '/workers/services/view/jsonbin/production/';
const check = (path, status = 'completed', conclusion = 'success', time = '2026-10-29T02:00:00Z') => ({
  name: 'Workers Builds: jsonbin',
  app: { slug: 'cloudflare-workers-and-pages' },
  details_url: base + path,
  status,
  conclusion,
  started_at: time,
});

test('Cloudflare Preview success cannot masquerade as a production build', () => {
  const result = classifyCloudflareProductionBuild([
    check('previews/perf-safe-public-bin-read-cache/builds/preview1'),
    { ...check('builds/wrong-app'), app: { slug: 'github-actions' } },
  ]);
  assert.equal(result.state, 'missing');
  assert.equal(result.previewCount, 1);
  assert.equal(result.url, null);
});

test('Production build records are matched precisely and newest run wins', () => {
  const selected = classifyCloudflareProductionBuild([
    check('builds/old', 'completed', 'failure', '2026-10-29T01:00:00Z'),
    check('builds/latest', 'completed', 'success', '2026-10-29T02:00:00Z'),
    check('previews/test/builds/preview'),
    { ...check('builds/foreign'), details_url: 'https://evil.example.test/' + account + '/workers/services/view/jsonbin/production/builds/foreign' },
  ]);
  assert.equal(selected.state, 'success');
  assert.equal(selected.previewCount, 1);
  assert.equal(selected.url, base + 'builds/latest');
  assert.equal(classifyCloudflareProductionBuild([check('builds/failing', 'completed', 'failure')]).state, 'failure');
  assert.equal(classifyCloudflareProductionBuild([check('builds/running', 'in_progress', null)]).state, 'pending');
});

test('Only the exact requested SHA is inspected through read-only GitHub Checks', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ check_runs: [check('builds/latest')] });
  };
  const result = await fetchGitHubChecks({ repository: repo, sha, token: 'test-token', fetchImpl });
  assert.equal(result.state, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/lwhx/jsonbin/commits/' + sha + '/check-runs?per_page=100');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.method, undefined, 'GET without any mutation');
  await assert.rejects(fetchGitHubChecks({ repository: 'bad/path/extra', sha, token: 'test' }), /invalid_github/);
  await assert.rejects(fetchGitHubChecks({ repository: repo, sha, token: '' }), /GITHUB_TOKEN/);
});

test('Transient failed placeholder is tolerated until a successful production check appears', async () => {
  let count = 0;
  const fetchImpl = async () => {
    count++;
    return Response.json({
      check_runs: [check('builds/prod', 'completed', count < 4 ? 'failure' : 'success')],
    });
  };
  const result = await waitForProductionBuild({
    repository: repo, sha, token: 'test-token', fetchImpl,
    attempts: 5, intervalMs: 0, sleep: async () => {},
  });
  assert.equal(result.state, 'success');
  assert.equal(count, 4);
});
