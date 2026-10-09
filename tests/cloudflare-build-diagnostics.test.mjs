import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCloudflareBuild, readCloudflareBuild, redactBuildLine, summarizeCloudflareBuild } from '../scripts/inspect-cloudflare-build.mjs';

const accountId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const buildId = '8aeddd36-862f-4568-a9f7-a1b275cde33b';
const dashboard = 'https://dash.cloudflare.com/' + accountId + '/workers/services/view/jsonbin/production/builds/' + buildId;
const response = (result, status = 200) => new Response(JSON.stringify({
  success: status === 200, result, errors: status === 200 ? [] : [{ code: 403 }],
}), { status, headers: { 'content-type': 'application/json' } });

test('Cloudflare Build inspector accepts direct and redirected dashboard URLs, but not foreign hosts', () => {
  const expected = { accountId, buildId };
  assert.deepEqual(parseCloudflareBuild(dashboard), expected);
  assert.deepEqual(parseCloudflareBuild('https://dash.cloudflare.com/?to=/' + accountId + '/workers/services/view/jsonbin/production/builds/' + buildId), expected);
  assert.deepEqual(parseCloudflareBuild(buildId, accountId), expected);
  assert.throws(() => parseCloudflareBuild(dashboard.replace('dash.cloudflare.com', 'example.test')), /Only Cloudflare/);
  assert.throws(() => parseCloudflareBuild(buildId), /CLOUDFLARE_ACCOUNT_ID/);
});

test('read-only API uses cursor pagination and redacts sensitive log content in summaries', async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/' + buildId)) return response({ status: 'completed', build_outcome: 'fail', build_trigger_metadata: { branch: 'security/sec-002', deploy_command: 'npx wrangler versions upload' } });
    if (!url.includes('?cursor=')) return response({ cursor: 'next', lines: [[123, 'Build ready'], [124, 'Error: Authorization: Bearer supersecret-123456789012345']], truncated: true });
    assert.ok(url.endsWith('?cursor=next'));
    return response({ cursor: null, lines: [[125, 'Error: SESSION_SECRET=a-private-secret']], truncated: false });
  };
  const result = await readCloudflareBuild({ accountId, buildId, token: 'private-token', fetchImpl: fake });
  const summary = summarizeCloudflareBuild(result);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.options.method === 'GET' && c.options.headers.Authorization === 'Bearer private-token'));
  assert.equal(summary.totalLines, 3);
  assert.equal(summary.outcome, 'fail');
  assert.equal(summary.deployCommand, 'npx wrangler versions upload');
  assert.equal(summary.relevantLines.length, 2);
  assert.doesNotMatch(JSON.stringify(summary), /a-private-secret|supersecret|private-token/);
  assert.match(JSON.stringify(summary), /\[REDACTED\]/);
});

test('Cloudflare permission failures remain safe and do not include secrets', async () => {
  await assert.rejects(readCloudflareBuild({ accountId, buildId, token: 'private', fetchImpl: async () => response(null, 403) }), /HTTP 403/);
  await assert.rejects(readCloudflareBuild({ accountId, buildId, token: '' }), /Workers CI Read/);
  assert.equal(redactBuildLine('CLOUDFLARE_API_TOKEN=abc123 Authorization: Bearer very-long-token-secret-123456'), 'CLOUDFLARE_API_TOKEN=[REDACTED] Authorization: Bearer [REDACTED]');
});
