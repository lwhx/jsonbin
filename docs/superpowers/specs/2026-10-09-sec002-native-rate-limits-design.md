# SEC-002 — Cloudflare Native Rate Limiting + Exact Custom API-Key Budgets (2026-10-09)

**Project:** lwhx/jsonbin, one-owner Cloudflare Workers + R2 + KV, main baseline `6af9e4775c4d1c45cb7d07e18045ad8029911405`. User-supplied security hardening brief v1.1, SEC-002. PR #12 (SEC-001 sessions) is separate and currently unmerged.

## Confirmed failure mechanism

`src/worker/storage/rate-limit.ts` implements KV `get(key)` then `put(key,count+1)` on a shared minute key. Cloudflare KV is eventually consistent: concurrent increments overwrite one another and the same KV key allows **at most one write per second** (rate-limited writes throw 429); the existing `requireAccess` and anonymous limiter `catch(() => null)`, effectively granting unthrottled access on KV outage or hot-key conflicts.

Official sources, checked 2026-10-09:
- https://developers.cloudflare.com/kv/platform/limits/
- https://developers.cloudflare.com/kv/api/write-key-value-pairs/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

Cloudflare Workers Rate Limiting bindings are fast, per-Cloudflare-location and approximate/eventually consistent (NOT exact globally). Binding rules set `simple.limit` and `period` **statically**; `.limit({key})` does not accept a dynamic limit. Cannot claim an exact 1–10,000 per-key quota using only that binding.

## Decisions

1. **Common-case zero-KV-write protection:** Two native bindings in `wrangler.jsonc`, `JSONBIN_KEY_RATE` with `120/60s` and `JSONBIN_ANON_RATE` with `240/60s`, with distinct positive-integer namespace IDs reserved for this Worker. Keys: `k:<stable key-id>` and `a:<HMAC(SERVER_SECRET, CF-Connecting-IP)>`. Never send Bearer Token or raw IP as a limiter key. Default API Key `undefined` or `120` uses binding; `rateLimitPerMinute: null` explicitly disables limiter. Cloudflare global per-PoP approximation is openly documented.
2. **Exact, dynamic custom limits:** For any numeric key limit not equal to default 120, use per-key R2 object `auth/key-rate/<UUID>.json` with a rolling fixed UTC-minute counter and ETag CAS retry. `1…10000` remains supported exactly at the storage consistency boundary. `429 rate_limit_exceeded` with computed `Retry-After` on quota, and no KV writes. Explicit custom limits cost one R2 read+one conditional R2 put on allowed request; may cause conflict retries/503 under extreme bursts; this tradeoff must be documented and benchmarked. Only one bounded R2 object per key, not one per minute.
3. **No silent fail open:** Native binding call errors, R2 custom storage failure or KV fallback failure return `503 rate_limit_unavailable` with `Cache-Control:no-store` and a conservative `Retry-After`. This is an intentional availability/security tradeoff. Responses with 429/503 do not accrue qualified API usage; GitHub OAuth and Session-authorized requests must not be limited.
4. **Compatibility fallback:** To avoid breaking separate Miniflare tests, local development with missing native binding may still use existing approximate KV algorithm, but any KV get/put error MUST fail closed instead of allowing access. In the deployed Worker, `wrangler.jsonc` binds both native limiters, so the vulnerable KV hot path is not used for default API Keys or public reads. This fallback MUST NOT be described as exact or recommended for public production use. Missing BOTH limiter binding and KV returns 503; explicit unlimited API key continues to work. Introduce no new secrets or paid data service.
5. **Public endpoint scope:** Only truly anonymous public Bin/Slug reads are IP-limited. Authenticated Bearer requests are key-limited; Session requests and GitHub OAuth are unaffected. Keep resource authorization and 304 ordering, stable 429 JSON and Retry-After, privacy-safe logs and no raw IP in R2/KV native-limiter use. Existing KV fallback key names may still contain raw IP but SHOULD be migrated to keyed digest with a compatibility note.
6. **Cloudflare deployment safety:** This changes Worker binding config; do not merge/deploy without human review. Namespace IDs must be unique within a Cloudflare account (two candidate numeric IDs `847621193`, `847621194` are preselected, verify against existing account deployments). Static native counters are regional approximation, not globally exact accounting.

## Acceptance

- RED on main: missing CACHE and injected KV error must NOT allow protected Bearer/default or public access; 503 expected; old code returns 200. Native mock limiter denies when `.limit()` returns false; old code ignores it. Concurrent `rateLimitPerMinute:3` Burst must allow only 3, reject remainder with 429, R2 state reflects exactly 3.
- GREEN: native default and public counters invoked with private stable key, no KV read/write, return 429 with Retry-After; per-key isolation; custom 3/10/10000 and null behavior; malformed/unauthorized requests never consume; 429/503 absent from qualified analytics; R2 outage 503; KV fallback fail closed; browser Session/GitHub unchanged.
- `npm ci`, `npm run typecheck`, `npm run build:sdk`, `npm run build:mcp`, `npm test`, `npm run test:browser` on full PR and targeted RED→GREEN; local Miniflare before/after R2/KV op and p50/p95 benchmark.
- PR remains unmerged. **SEC-002 does not imply SEC-003–010 are fixed.**

## Rollback / risk

A rollback to the old Worker brings back KV approximate fail-open hot key behavior. Keep the new binding config in production if the application code is rolled back to a compatible version. No migration of existing user keys is needed; the old KV minute counters are ephemeral, disposable. Native binding calls cannot be used for exact billing, and per-IP limits can affect multiple users behind shared NAT.
