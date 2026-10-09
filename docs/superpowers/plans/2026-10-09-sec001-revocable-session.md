# SEC-001 Revocable Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add immediate per-session and global revocation with a persistent fixed 14-day Cookie, low R2 cost, backwards-compatible legacy migration, and multi-device settings controls.

**Architecture:** One strongly-consistent R2 policy object, ETag CAS writes on login/revoke; one R2 GET on authenticated request, no KV or per-request writes. New signed Cookie embeds SID + generation. Temporary legacy-cookie validation and denylist ensure existing browsers stay logged in until their original expiry.

**Tech Stack:** Cloudflare Workers, R2, Hono, React Query, Playwright, Miniflare, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-09-session-revocation-design.md` and user-provided v1.1 security task book.

## Global Constraints

- Latest main baseline `6af9e4775c4d1c45cb7d07e18045ad8029911405`; existing latest GitHub CI green.
- Retain 14-day HttpOnly/Secure/SameSite cookie with *fixed*, not sliding expiry and no idle timeout.
- Existing password, GitHub OAuth, API Key, SDK and MCP usage remain compatible; no extra cloud services.
- R2 canonical, KV non-authoritative; protect all ordinary management actions on revocation.
- No production merge, Cloudflare Secret changes, data deletion or deployment without user's explicit confirmation.
- On R2 state failure, return retryable 503; never clear a valid Cookie or leak credentials.
- Tests before code; verify RED then GREEN; full GitHub CI + persistent-browser and p50/p95/R2-op benchmark.

## Review Focus

- Concurrent login/logout-all must not revive revoked generations: CAS race integration test.
- Legacy valid cookie must work before deadline; global revoke must block it: signed-cookie integration test.
- Successful logout must revoke old cookie despite local browser reimport: server replay test.
- Error on R2 GET must remain retryable (503) instead of unauthenticated login: outage test.
- Multi-device independent sessions and true process-relaunch persistence, not only page reload: worker + persistent-profile browser tests.

---

### Task 1: RED authentication and revocation tests

**Files:** `tests/session-revocation.test.mjs`, `tests/browser/session-persistence.spec.ts`, existing `tests/security.test.mjs`.

**Interfaces:** POST `/api/v1/auth/login`, POST `/api/v1/auth/logout`, POST `/api/v1/auth/logout-all`, GET `/api/v1/auth/sessions`, DELETE `/api/v1/auth/sessions/:id`, GET `/api/v1/auth/me`.

- [ ] Write node tests: login A/B distinct signed SID, A logout invalidates old Cookie, B stays authorized, targeted revoke of B, global revoke A/B/C, invalid/new cookie, pre-migration legacy HMAC cookie until original exp, revoked legacy, R2 outage 503, concurrent CAS correctness and OAuth fallback.
- [ ] Write Playwright browser test with Chromium launchPersistentContext and same profile directory after close/reopen; inspect Cookie Max-Age and compare login re-entry.
- [ ] GitHub Actions targeted RED verifying expected failures on current source, not test fixture setup error.
- [ ] Commit only failing tests.

### Task 2: Durable Session registry and signed cookie integration

**Files:** create `src/worker/storage/sessions.ts`, modify `src/worker/auth/session.ts`.

**Interfaces:** `registerSession(env,{sid,exp,provider,issuedAt})`; `isSessionActive(env,{sid,gen,exp,legacyDigest?})`; `revokeSession(env,{sid?,legacyDigest?})`; `revokeAllSessions(env)`; `listActiveSessions(env)` -- all using strongly-consistent R2 state, immutable cookie SID, CAS.

- [ ] Add strict R2 policy parser + ETag CAS mutation loop, cap 512, prune expired rows on mutations, fail closed on unavailable/corrupt policy.
- [ ] Add SID/gen to new signed Cookies without changing 14d Max-Age or exp semantics.
- [ ] Enforce server policy on authenticated read, legacy migration through 2026-10-25 only, no accidental catch of storage 503 as 401.
- [ ] Run targeted tests GREEN and existing `tests/security.test.mjs`; adapt time-controlled test for explicit finite legacy cutover without weakening behavioral assertions.
- [ ] Commit.

### Task 3: Auth routes and safe logout UI

**Files:** modify `src/worker/routes/auth.ts`, `src/worker/middleware/auth.ts`, `src/react-app/App.tsx`.

- [ ] Wire POST logout to server revoke, POST logout-all, GET sessions and DELETE session ID as management-Session-only routes (Origin-protected writes; Bearer never accepted).
- [ ] Convert Session store outage into status 503 rather than login page; handle OAuth issuance failure with controlled 503, no new Cookie.
- [ ] Change client logout to clear auth queries only after 200; on 503/network error toast and preserve page/cookie/drafts.
- [ ] Execute RED/GREEN server + browser tests.
- [ ] Commit.

### Task 4: Device management in Settings

**Files:** create `src/react-app/features/settings/SessionPanel.tsx`; modify `src/react-app/features/settings/SettingsPage.tsx`, `src/react-app/App.tsx`.

- [ ] Show active sessions (createdAt, provider, current badge; no Cookie/token), targeted revoke and “退出所有设备”.
- [ ] Require explicit confirmation for global action, and propagate current-revoke UI auth invalidation.
- [ ] Test A/B/C session independence and UI navigation/dirty-confirm protections.
- [ ] Commit.

### Task 5: Browser 14d, performance and release proof

**Files:** `tests/browser/session-persistence.spec.ts`, `tests/session-revocation.test.mjs`, `scripts/bench-session.mjs`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`.

- [ ] Persistent-profile Chromium close/reopen test for session survival; simulated day7/day13/expiry tests without waiting 14d; OAuth cookie test.
- [ ] Benchmark baseline/current Miniflare R2 GET/PUT/session-validation p50/p95; document extra single GET, costs and 503 failure behavior.
- [ ] Document migration date, new R2 canonical object backup, revocation rollback, no secret changes.
- [ ] Run `npm ci`, `npm run typecheck`, `npm run build:sdk`, `npm run build:mcp`, `npm test`, `npm run test:browser` in CI.
- [ ] Whole-branch self-review and one fresh reviewer if available, then PR for user's approval. **Do not merge main.**

## Completion Contract

Every checked task has a matching test result/commit SHA. Final report includes tests, R2 operations, p50/p95, legacy migration behavior, unknowns, and a non-merged PR URL.
