# SEC-002 Native Cloudflare Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove production KV hot-key write amplification and fail-open behavior while preserving adjustable per-key quotas, explicit unlimited keys, and anonymous public access controls.

**Architecture:** Use Cloudflare Workers local-native Rate Limiting for the default 120/min API Key and 240/min anonymous public quotas, and R2 per-key CAS counters for exact custom rates. Keep KV as explicitly degraded approximate fallback for older local/test runtime, but never silently fail open. No new paid storage.

**Tech Stack:** Hono, Cloudflare Workers binding RateLimit, R2 CAS, KV, Miniflare, Node test, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-sec002-native-rate-limits-design.md`

## Global Constraints

- Baseline main at `6af9e4775c4d1c45cb7d07e18045ad8029911405`, not merged SEC-001 PR #12. SEC-002 is an independent PR from main; expect `middleware/auth.ts` minor overlap on eventual merge.
- Default 120/min/key; public 240/min/IP; per-key explicit `1–10000`; `null` means unlimited, not default.
- Static native RateLimit is per PoP eventually consistent, never claim exact globally; custom R2 CAS is exact per fixed minute at successful conditional commits.
- Never trust client `X-Forwarded-For`; use only Cloudflare `CF-Connecting-IP` and never log or persist its plaintext on new paths.
- 429 must include `Retry-After` and JSON `rate_limit_exceeded`; 503 `rate_limit_unavailable` on backend failures with no open access.
- No added commercial product, D1, Durable Objects, migrations of business records or Session/GitHub change; no production merge/deploy without owner's confirmation.

## Review Focus

1. Native binding missing in production vs tests: deployed `wrangler.jsonc` always defines it; fallback is explicitly documented approximate and fail-closed.
2. Custom value `null`, `120` explicit and `undefined`: no accidental default override or leak of quota.
3. 304/ETag public reads: rate check must precede cached/conditional response.
4. Mixed actual key Bearer+Cookie: Bearer precedence and resource scope checks must remain unchanged; rejected 429 not counted.
5. Rapid concurrent custom-key requests across isolates: CAS retry never over-allows, 503 may be used under contention; no per-request new R2 writes for default native keys.

---

### Task 1: RED behavioral tests

**Files:** `tests/rate-limit.test.mjs`, `tests/worker.test.mjs`.

**Interfaces:** `limitAnonymousRequest(env,request)`; `requireAccess` for key; `checkRateLimit`.

- [ ] **Step 1:** Add tests for absent CACHE+native -> 503; KV get/put throws -> 503, not 200; native mock `limit({key})` denies -> 429 and no KV use; 5 concurrent custom limit=3 requests should produce exactly 3 successes, 2×429.
- [ ] **Step 2:** Run `npm run build && node --test tests/rate-limit.test.mjs` via temporary isolated GitHub Action on branch. **Expected RED:** old code ignores native, allows absent KV and swallows failures; custom concurrency likely overallows (do not treat nondeterministic mismatch as sole evidence).
- [ ] **Step 3:** Commit failing security tests; do not modify production logic yet.

### Task 2: Native default/anonymous binding and strict failure behavior

**Files:** `src/worker/storage/rate-limit.ts`, `src/worker/middleware/auth.ts`, `src/worker/env.d.ts`, `wrangler.jsonc`, `tests/wrangler.jsonc`.

**Interfaces:** `enforceApiKeyRateLimit(env,keyId,rateLimitPerMinute)` returns `Response|null`; `limitAnonymousRequest(env,req,limit?)`.

- [ ] **Step 1:** Introduce two native binding declarations `JSONBIN_KEY_RATE` 120/60 and `JSONBIN_ANON_RATE` 240/60, unique account namespace IDs 847621193 / 847621194. Add the same bindings with test-only namespaces in `tests/wrangler.jsonc`.
- [ ] **Step 2:** Implement safe `limit({key})`, 429 Retry-After 1–60, 503 fail closed on native error, optional missing-binding KV fallback with strict catch. Hash IP with HMAC using available Session secret; do not persist raw IP on new paths.
- [ ] **Step 3:** Run focused tests GREEN; `npm run typecheck && npm run build` green; commit.

### Task 3: Exact dynamic API Key quotas

**Files:** `src/worker/storage/key-rate-limit.ts` (new), `src/worker/storage/rate-limit.ts`, `tests/rate-limit.test.mjs`.

**Interfaces:** `checkExactKeyQuota(env,keyId,limit,now?) -> {allowed:boolean,retryAfterSeconds:number}`.

- [ ] **Step 1:** Single `auth/key-rate/<id>.json` R2 state `{window:number,count:number}`, CAS loop <=16 with conditional create and update; for rejected checks no put. 503 on storage failure or exhausted CAS. Implement only for custom non-120 numeric quota; `null` bypass.
- [ ] **Step 2:** Run deterministic concurrency and expiry tests: N=5 limit=3 exactly 3 accepted; next minute resets; different key unaffected; R2 read/put failure -> 503; token not stored in R2 key. Commit.
- [ ] **Step 3:** Confirm existing key usage Analytics excludes 429/503.

### Task 4: End-to-end regression and docs

**Files:** `tests/rate-limit.test.mjs`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `scripts/bench-native-rate-limits.mjs`.

- [ ] **Step 1:** Run no-CACHE and failing-cache tests, native mocks; preserve Origin, key scopes, anonymous public Bin/Slug, 304 behavior, unaffected Session and OAuth. Benchmark baseline and candidate for KV reads/writes, R2 reads/writes, p50/p95.
- [ ] **Step 2:** Document native per-PoP approximation, static rule vs custom R2 exact, require uniqueness of namespace ids before deployment, KV fallback not production grade, fail-closed 503, 429 Retry-After and no raw IP storage.
- [ ] **Step 3:** Run `npm ci`, `npm run typecheck`, `npm run build:sdk`, `npm run build:mcp`, `npm test`, `npm run test:browser` via GitHub full CI; review no production merge. Commit.

### Task 5: Whole-branch security review and user handoff

**Files:** PR description and docs only unless TDD tests reveal blocking findings.

- [ ] **Step 1:** Self-review or independent reviewer if available; check limit bypass, misleading claims, namespace collisions, backend outage, token/IP privacy, concurrency and R2 budgets.
- [ ] **Step 2:** Fix Critical/Important findings RED→GREEN, re-run full CI, remove temporary diagnostic actions.
- [ ] **Step 3:** Open unmerged PR to main, attach tests, production rollout/rollback notes, cost comparison and compatibility with SEC-001.

## Completion contract

No claim of exact native quotas across PoPs. All security tests red on baseline and green on candidate; full latest CI green, ready but not merged PR and explicit review of new Worker binding change.
