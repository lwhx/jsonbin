# JSONBin v3.2 Security Hardening — Staged Plan (2026-10-09)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans on one independently testable batch at a time, using test-driven development before security changes.

**Goal:** Fulfill the owner's 2026-10-09 v1.1 security task book without changing Cloudflare Workers + R2 + KV or silently shortening 14-day persistent login.

**Baseline:** main SHA `6af9e4775c4d1c45cb7d07e18045ad8029911405`; [baseline CI](https://github.com/lwhx/jsonbin/actions/runs/37878902511) passing. This plan is based on source inspection, not presumed exploitation.

**Global constraints:** Keep all existing JSONBin API, SDK, MCP, Schema, Webhook, OAuth and Chinese UI features, avoid D1/paid infrastructure; preserve maxAge=1209600 and avoid idle logout; no private credentials in logs; no prod mutations, merge or Secret changes without confirmation. Use independent PRs and full `npm run typecheck`, `npm run build:sdk`, `npm run build:mcp`, `npm test`, `npm run test:browser` at every high-risk batch.

## Baseline assessment and delivery order

| ID | Initial status from source | Verified observations / remaining questions | Batch and files |
|---|---|---|---|
| SEC-001 | **Confirmed missing revocation** | 14d HMAC Cookie currently stateless, logout only deletes browser Cookie; old signed cookie replayable. New R2 registry, global generation, device UI and migration required. | Batch A `auth/session.ts`, `routes/auth.ts`, `middleware/auth.ts`, Settings and tests. |
| SEC-002 | **Partially remediated / approximate limits** | Password login already uses R2 CAS, 3-failure cooldown and 6-failure IP ban; API Key and public Bin limiters still use non-atomic GET/PUT KV and fail open. Confirm edge WAF/Ratelimit alternatives and costs; no unapproved Durable Objects. | Batch B `storage/rate-limit.ts`, auth middleware, tests. |
| SEC-003 | **Confirmed plaintext risk** | `Webhook.secret` is included in R2 Webhook metadata, mirrored to KV and exposed through manager APIs/React type. AES-GCM migration and client compatibility required. | Batch C `storage/webhooks.ts`, routes, React, migration and tests. |
| SEC-004 | **Insufficient URL validation confirmed; exploitability unproven** | Current create/update schema only checks http(s) URL, does not reject private/loopback/etc. Delivery already `redirect:manual` and timeouts. Workers DNS/private routing needs environment-specific validation. | Batch C URL policy utility + delivery & validation tests. |
| SEC-005 | **Needs scoped path audit** | Key scope checks and resource filters exist; Schema, Slug, clone, bulk, publishing, content search and MCP helper paths require matrix/regressions before claiming bypass. | Batch D route/SDK/OpenAPI permission matrix and tests. |
| SEC-006 | **Regex ReDoS risk requires proof** | `schema-validation.ts` compiles user patterns with native `RegExp`; rejecting invalid syntax alone doesn't bound catastrophic backtracking. Test malicious inputs in isolated Worker; choose compatible bounded policy. | Batch E Schema validator and bounded tests. |
| SEC-007 | **Confirmed inconsistent request budgets** | `readBoundedJson` exists, but multiple management routes use unbounded `c.req.json()`; classify per-endpoint legitimate sizes before tightening. | Batch E request body readers, OpenAPI and 413 tests. |
| SEC-008 | **Partially implemented, needs regression** | MCP bearer gate exists and tools forward to business APIs; review batch size, per-tool total cost, rate-limit interactions, same-origin injection. | Batch F `routes/mcp.ts`, tests. |
| SEC-009 | **CI scanning gap confirmed** | GitHub CI runs npm ci/typecheck/build/tests, but no dedicated audit, CodeQL or dependency bot in current workflow. | Batch G CI + least permissions + vulnerability triage. |
| SEC-010 | **Needs audit** | Error handler logs fixed method+ID, but Webhook, data export, access logs, key/session secret reuse and migration require additional review. | Batch G logging + key migration docs and tests. |

## Each security batch's independent completion checklist

1. Re-read latest main and preserve baseline HEAD SHA; detect changes from prior batches.
2. Reproduce the vulnerability with a **failing** test or mark as potential with evidence, not speculation.
3. Write focused design: root cause, routes/files, authorization and data migration, compatibility, rollback, Cloudflare read/write cost, and tests.
4. Implement in a new isolated branch (not main) with commit-level test results; no unrelated refactors.
5. Run associated security tests then full CI and Playwright acceptance; benchmark same workload p50/p95 and R2/KV operation count where latency affected.
6. Produce PR and status report, leave unmerged pending human confirmation.
7. Maintain audit table as PRs land; never mark a group complete because an adjacent group passed.

## First batch (SEC-001)

- Design: [SEC-001 spec](../specs/2026-10-09-session-revocation-design.md).
- Detailed implementation: [SEC-001 plan](2026-10-09-sec001-revocable-session.md).
- Hard constraints: 14d fixed Cookie, per-device and global R2-authenticated revocation, migration for old Cookie, real Chromium restart, added R2 read measured.
- **The remaining SEC-002 through SEC-010 groups are not considered fixed by this first batch.**
