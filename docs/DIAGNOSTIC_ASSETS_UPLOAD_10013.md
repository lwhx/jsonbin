# Cloudflare Workers Assets 10013 baseline test

This **temporary, unmerged diagnostic branch** is based on JSONBin main commit `eb204860237e9149d90dd0204402aa1d9631e313`, *before* PR #22 introduced the separate SQLite API Key usage Durable Object binding.

The only change on this branch is this Markdown file. It does not affect Worker code, built static assets, Wrangler bindings, API Key accounting, or production.

Purpose: Trigger an independent Cloudflare Workers Preview build to distinguish a generic `assets-upload-session` Cloudflare API `[code: 10013]` failure from a PR #22 Durable Object binding/configuration failure.

Interpretation:

- If **this baseline Preview also fails** at `/workers/scripts/jsonbin/assets-upload-session` with `10013`, the issue is not specific to the new PR #22 binding.
- If the baseline succeeds but PR #22 fails, compare generated Wrangler preview config and provide both build IDs to Cloudflare support; neither result alone proves a DO logic defect.
- Never merge this diagnostic PR or switch production traffic.

Related upstream incident: https://github.com/cloudflare/workers-sdk/issues/13118
