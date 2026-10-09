# SEC-001: Revocable, fixed-14-day sessions — design (2026-10-09)

**Authoritative brief:** 用户提交的《JSONBin v3.2 安全加固与漏洞修复开发任务书》v1.1。基线 main `6af9e4775c4d1c45cb7d07e18045ad8029911405`，基线 [CI](https://github.com/lwhx/jsonbin/actions/runs/37878902511) successful.

## Findings and decisions

Current `src/worker/auth/session.ts` signs a `{id,username,provider,exp}` cookie (14 days) and verifies only its HMAC/expiry. `POST /logout` only deletes the browser cookie. This confirms lack of server-side revocation (SEC-001). Client `App.tsx` currently clears auth state even if logout fails. Old valid cookies cannot be forcibly recalled without server state.

Single-owner system; **one authoritative R2 policy object per deployment**, `system/auth/sessions.json`. Schema: `{version:1,generation:number, legacyDisabled:boolean, sessions: Record<sid,{exp,provider,issuedAt}>, legacyRevoked:Record<tokenHmac,expiry>}`. `sid` is cryptographically random UUIDv4. New signed cookie adds `sid` and `gen`; `exp` is issued once and never extended. Existing maxAge=1,209,600 seconds, HttpOnly, Secure(HTTPS), SameSite=Lax, Path=/ preserved.

Every authenticated Cookie request verifies cryptographic integrity and expiry and performs **one authoritative R2 GET** (policy snapshot). It checks `sid` allowlist and exact generation, or a legacy cookie's revocation fingerprint. Missing/unreadable policy **cannot authorize a new-format cookie**; thrown storage errors cause HTTP 503 and leave Cookie intact (retryable UI). Use R2 conditional ETag CAS for login registration, revoke, logout-all, and expired-record pruning. Only management Session endpoints access session lists; never expose encoded Cookie, signatures or secrets.

Logout removes only the current `sid` (or appends a SHA-256/HMAC fingerprint to legacy denylist). The removed cookie **must reject replay immediately**. Admin may GET active Session list, DELETE one Session by ID, or POST `/auth/logout-all` to increment generation, clear all active entries and permanently disable legacy acceptance. Other devices see 401 on next authorized request. State retention bound: discard expired entries on writes; cap concurrent active sessions at 512 and legacy revocations at 512 (no unsafe auto-eviction of active sessions).

## Legacy cookie migration

The historical cookie contains no SID or generation; requiring instant SID registration would add writes to ordinary requests or silently log everyone out. Accept **only correctly signed, not-expired legacy cookies until their original `exp`**, regardless of the actual production deployment date, as long as the authoritative policy does not revoke the cookie fingerprint or disable legacy. A legacy logout stores a one-way keyed digest of the cookie until its natural expiration; `logout-all` disables all legacy cookies immediately. No new-format login issues legacy cookies, and no read extends old expiry. An arbitrary calendar cutoff is forbidden because delayed rollout could prematurely log out an otherwise valid 14-day Session. A corrupted or unavailable existing policy fails closed with 503; **do not erase a legitimate cookie on storage failure**.

## Performance, operations, rollback

Incremental cost: **one R2 GET per valid Session-authenticated request**, and one CAS R2 PUT per successful login or revocation; no storage write on ordinary reads, no KV lookups, no new Cloudflare service. Benchmark R2 GET / PUT delta and latency p50/p95 (same Miniflare conditions) before release. R2 is canonical; a KV revocation flag cannot provide immediate invalidation. On malformed policy or R2 outage, fail closed with 503 for protected operations while returning auth retry to frontend; do not silently erase cookies.

A single object keeps read-path cost to one GET instead of per-session + generation. This is appropriate to single-owner scope, not unbounded multi-tenant traffic; if session count approaches cap, fail with clear 503 rather than silently evicting an unexpired user. New metadata is additive in R2; rollback to original Worker still accepts signed cookies because it ignores extra fields, **but it does not enforce revocation**. Therefore rollback is a security downgrade: restore a patched version or rotate SESSION_SECRET after documented decision. Never delete policy or change production secrets without confirmation.

## UI and acceptance

- Header `退出登录` must await a 200 server revocation BEFORE locally clearing credentials, otherwise retain view and show retry toast.
- Settings panel lists devices/sessions, lets admin revoke a selected SID or “退出所有设备” with explicit confirmation; if current token revoked, update client auth query and return to login.
- Existing browser startup verifies `/auth/me` during loading and does not flicker login on network 503.
- Test: token replay after logout, A/B/C independent logins, targeted revoke, global generation revoke, legacy migration (and revoke/global disable), R2 outage 503 + existing Cookie retained, signature forgery and expiry boundary, OAuth issuance, correct 14d Max-Age, persistent Chromium profile close/relaunch, day7/day13 valid and day14 expired.
- Security tests RED on `main` before implementing; GREEN on PR + full `npm run typecheck`, `npm test`, `npm run test:browser`, `npm run build:sdk`, `npm run build:mcp`.

**Non-goal:** idle timeout, sliding expiration, client-stored secrets, identity-provider changes, new infrastructure or forced logout of already-valid legacy cookies (except explicit global revoke).
