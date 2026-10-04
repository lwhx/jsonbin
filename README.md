# JSONBin v3

A private, Cloudflare-native JSON storage and configuration platform.

This repository started from Remy Sharp's original JSONBin project. The legacy code is preserved on the **`legacy-v2.6.4`** branch. The modern implementation lives on **`main`** and is a clean Cloudflare rewrite.

## Direction

JSONBin v3 is designed for a single owner and for scripts, automation, Workers, VPS tools and small applications that need a reliable JSON/configuration API.

### Stack

- Cloudflare Workers
- Cloudflare R2 — canonical durable storage
- Cloudflare KV — cache and rebuildable indexes
- Hono + TypeScript
- React + Vite
- Cloudflare Vite Plugin
- Tailwind CSS

No MongoDB, D1, Redis or standalone server is required.

## Current status

The `main` branch currently has a deployable Cloudflare-native v3 foundation with:

- Cloudflare Worker + Hono API
- React dashboard with Chinese UI
- username/password login and signed sessions
- optional GitHub OAuth
- R2 + KV bindings
- basic Bin list/create/read/update/delete backend
- ETag / If-Match groundwork
- GitHub Actions typecheck + production build
- Cloudflare automatic deployment

The P1 implementation adds a Bin detail page with a locally bundled Monaco JSON editor, metadata settings, save/delete actions, refreshable links, and unsaved-draft protection. P2 adds version history, read-only comparison of any two versions and restoration into a new immutable version. P3 adds collections, member counts and Bin membership settings. Collection deletion detaches members and preserves their JSON and version history. P4 adds Draft 7 JSON Schema management, sample validation and Bin bindings to immutable model revisions. Creation, updates and historical restoration validate against the pinned revision; model locks protect binding changes, and deleting a model retains existing constraints. P5 adds API key administration, one-time token disclosure, expiry/revocation and scoped Bearer authentication for resource APIs. P6 adds JSON Merge Patch, deep-path reads/writes, data-lock controls and anonymous current reads for public Bins. See the development plan for local, CI and production acceptance status.

The Bin detail **树形视图** tab is now available: inspect the current JSON draft, expand objects/arrays, navigate with the keyboard and copy a selected node's complete JSON. Viewing retains unsaved editor/settings changes and never writes or changes versions. Invalid JSON prompts correction in the editor; locked Bins remain readable. Large trees display 200 visible nodes per batch and long text previews retain the full value for copying. See [tree view design](docs/superpowers/specs/2026-10-04-json-tree-design.md).

P7 adds request-time TTL and resumable trash/restore/purge maintenance. P8–P10 add activity, generated API documentation, defaults and bounded business backup/import/export. P11 adds authenticated global metadata search, collection-name matching, Ctrl/Cmd+K navigation, disposable KV indexes with R2 fallback, and a Settings action to rebuild indexes. See [development progress](docs/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md) and [P11 design](docs/superpowers/specs/2026-10-04-p11-search-design.md) for limits and acceptance evidence. Production functional acceptance remains separately tracked.

P12 hardens Session parsing, login/OAuth, CORS, security headers and error logging, and validates the production build's CSP with Chromium. [Operations and release acceptance](docs/OPERATIONS.md) describes R2/KV backups, isolated recovery and the remaining production gates. The version remains `3.0.0-alpha.4` until actual production authentication, browser behavior, recovery and Cron acceptance are recorded. Functional delivery `d2a2d03` passed local typecheck/build, 159 automated tests and 53 Chromium tests, [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37168561281) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/6a15ef37-c2b8-4849-bb7e-5eae5333a4ae).

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Health check:

```text
GET /api/v1/system/health
```


### Login configuration

For personal single-user use, configure these Worker variables/secrets:

```text
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
SESSION_SECRET=a-random-string-at-least-32-characters
```

Store `ADMIN_PASSWORD` and `SESSION_SECRET` as Cloudflare Secrets. Do not commit their real values to Git.

`SESSION_SECRET` must have at least 32 characters; otherwise login is disabled with 503 and existing sessions are unauthenticated. Password login accepts at most 4 KiB of actual UTF-8 request body. Cookies last 14 days and use HttpOnly, Secure on HTTPS, and SameSite=Lax; rotating the signing secret invalidates existing sessions.

Browser CORS defaults to the request's own origin. Optional `APP_ORIGIN` must be one exact canonical HTTP(S) origin, such as `https://json.example.com`, without credentials, path or trailing slash. Foreign/opaque origins are denied; invalid configuration fails closed. Login, logout and Session writes apply the same rule. Non-browser clients may omit Origin but still need authentication and scopes. Every API response is no-store and includes `X-Request-ID` for safe log correlation. See [production checks](docs/OPERATIONS.md#stable-发布门槛).

## Cloudflare resources

Create the resources before enabling the bindings in `wrangler.jsonc`.

Example:

```bash
npx wrangler r2 bucket create jsonbin-data
npx wrangler kv namespace create CACHE
```

Then place the generated KV namespace ID in `wrangler.jsonc` and enable:

- `DATA` -> R2 bucket
- `CACHE` -> KV namespace

Generate Worker types after bindings change:

```bash
npm run cf:types
```

## Build and deploy

Cloudflare Workers Builds should use the `main` production branch.

Build command:

```bash
npm run build
```

Deploy command:

```bash
npx wrangler deploy
```

Local verification:

```bash
npm run typecheck
npm run build
npm test
npm run test:browser
```

Browser tests start an isolated local Worker with disposable R2/KV and in-memory test credentials. They use system Chromium when available; otherwise install it with `npx playwright install chromium`. No Cloudflare production credentials or resources are used.

In the cloud workspace, export `XDG_CONFIG_HOME=/workspace/.cloud-config` and `WRANGLER_SEND_METRICS=false` before Wrangler/Vite commands so tool state stays in a writable directory.

Bin metadata is updated through `PATCH /api/v1/bins/:id/meta` with `If-Match` and a JSON object containing `name`, `description`, and/or `visibility`. Metadata updates preserve the JSON version. JSON saves use `PUT /api/v1/bins/:id`, reserve immutable version objects, and conditionally update canonical metadata; conflicts return 412. Orphan versions from failed concurrent writes are retained and their numbers are skipped on subsequent saves.

Version history is available through `GET /api/v1/bins/:id/versions` and `GET /api/v1/bins/:id/versions/:version`. Lists include all retained version objects, including orphans, with R2 upload timestamps and stored file sizes. `POST /api/v1/bins/:id/versions/:version/restore` appends the selected value as a new version while preserving current metadata. Send the current Bin ETag in `If-Match`, rather than the historical object's ETag; missing preconditions return 428, stale ETags return 412 and locked Bins return 423. These endpoints accept a signed session or scoped Bearer token and cannot read deleted Bins. History reads require `history:read`; restoration also requires `bin:update`. See the detail page's history tab for JSON viewing and Diff.

Collections use `GET/POST /api/v1/collections`, `GET/PATCH/DELETE /api/v1/collections/:id` and `GET /api/v1/collections/:id/bins`. Creation and editing accept a name and optional description; stable slugs are generated automatically. PATCH and DELETE require the collection ETag in `If-Match`. Assign a Bin with `collectionId` during creation or through its metadata endpoint, and set it to `null` to remove it from a collection. Deletion blocks new members and clears only the association, including for locked Bins. If cleanup is interrupted, the collection remains visible as deleting and the same DELETE request can resume it. Completed deletions retain an internal tombstone and disappear from normal collection APIs.

## Partial updates and public reads

`PATCH /api/v1/bins/:id` accepts a raw RFC 7396 Merge Patch document. Object members merge, `null` removes a member, and arrays/scalars replace the target. `GET /api/v1/bins/:id/value/settings/theme` reads a nested value; `PUT` to that path accepts `{"value":"dark"}`. `/value` addresses the root; `/value/` addresses an empty key. Segments are URL-decoded once, then use JSON Pointer escaping (`~1` for `/`, `~0` for `~`). Array indexes start at zero; a final `-` appends. Parent nodes must exist.

Both partial-write endpoints require `bin:update` for Bearer clients and the current Bin ETag in `If-Match`. Missing preconditions return 428, stale ETags return 412, and missing paths return 404. They validate the complete resulting JSON against the pinned schema before appending an immutable version. Deep reads return `{id, path, value, etag, version}`; writes return a full BinRecord. See the detail page's API tab or the [P6 development notes](docs/DEVELOPMENT.md#p6-高级-bin-api) for examples and edge cases.

Set `locked` through the metadata endpoint with `If-Match`, or use the detail settings controls. Data locks block JSON/settings changes, historical restoration and ordinary deletion. Unlock with a separate `{"locked":false}` request; the schema lock stays unchanged. Bin DELETE accepts optional `If-Match` and conditionally marks canonical metadata as deleted, preserving historical files and preventing concurrent updates from reviving deleted data. The deleted metadata is the authoritative trash record.

Public Bins allow anonymous GET of their current record (JSON and metadata) and deep paths. Lists, history and writes still require authentication. Private Bins require a session or scoped key for every read. An explicit Authorization header must always be valid and sufficiently scoped, even on public Bins. All Bin responses use `Cache-Control: no-store`; new anonymous reads fail after switching to private. An already authorized in-flight read can return its original public snapshot. Existing APP_ORIGIN/CORS settings still govern browser cross-origin requests.

## TTL and trash

P7 supports `expiresAt` on Bin creation and metadata updates. Use a future ISO timestamp with a timezone, or `null` for no expiry. Metadata changes to this field require `If-Match`. Dashboard creation/settings use local time and show remaining time in the Bin list and detail page. Once expired, Bins immediately disappear from normal reads/writes, history and collection counts, including public access. Data locks do not extend a configured TTL.

The Worker runs a scheduled task every 15 minutes (`*/15 * * * *` in UTC) to mark expired Bins as deleted and resume interrupted permanent deletion. Request-time expiry checks and the trash list work before the scheduled task runs. No extra service or secret is required.

The dashboard's 回收站 page provides restore, permanent deletion, batch empty, timestamps and retry states:

| Endpoint | Bearer scopes | Request |
| --- | --- | --- |
| `GET /api/v1/trash/bins` | `bin:read` | Returns `{items,total}`, each item includes metadata, ETag and status |
| `POST /api/v1/trash/bins/:id/restore` | `bin:update` + `history:read` | Current trash ETag in `If-Match` |
| `DELETE /api/v1/trash/bins/:id` | `bin:delete` | Current trash ETag in `If-Match` |
| `POST /api/v1/trash/bins/purge` | `bin:delete` | `{"items":[{"id":"UUID","etag":"current ETag"}]}`; 1–100 unique items |

All endpoints also accept an admin session and reject anonymous access. Restore validates the saved JSON against its pinned schema, keeps the same ID and immutable versions, clears expiry and returns the Bin to **private** visibility. Data/schema locks remain; unavailable collection associations are detached. Missing preconditions return 428, stale ETags 412, and missing records 404. Restore returns 409 for a record being purged or missing historical/model files and 422 for schema violations.

Permanent deletion claims a `purging` state before deleting all versions and legacy archives, so it cannot race a successful restore. Failed cleanup is resumable through the API or cron. Completion retains only an internal `{id,deletedAt,purgeState:"purged"}` marker to prevent resurrection; JSON and descriptive metadata are removed. Batch responses use HTTP 200 with a status for each item; check every result. The dashboard deletes only the snapshots included in its confirmation, preserving newly trashed records and reporting conflicts.

Legacy `trash/bins/<id>/meta.json` records remain readable and are conditionally migrated when restored or purged. New deletions use canonical metadata only. See the [P7 development notes](docs/DEVELOPMENT.md#p7-ttl-与回收站) for concurrency, cleanup and acceptance details.

## API keys

Create a key from the dashboard's API 密钥 page, select only the needed scopes, and save the token shown once. `GET/POST /api/v1/keys` and `DELETE /api/v1/keys/:id` require a signed admin session; Bearer credentials cannot administer keys. R2 stores the digest and metadata, and list/revoke responses never return the token or digest.

For scripts, keep the token in an environment variable:

```bash
curl "$JSONBIN_ORIGIN/api/v1/bins" \
  -H "Authorization: Bearer $JSONBIN_TOKEN"
```

Existing resources accept `bin:read/create/update/delete`, `collection:read/write`, `schema:read/write`, and `history:read`. Listing collection members requires both `collection:read` and `bin:read`; restoring history requires `bin:update` and `history:read`. Authentication errors return 401, missing scopes return 403, and existing ETag, lock and schema constraints still apply. See the [P5 development notes](docs/DEVELOPMENT.md#p5-api-密钥与外部-api-认证) for the complete mapping.

By default, 256 random secret bits are stored as a SHA-256 digest. To add a pepper for new keys, configure `TOKEN_PEPPER` as a Cloudflare Secret with at least 32 characters:

```bash
npx wrangler secret put TOKEN_PEPPER
```

Keep the pepper stable: replacing or removing it invalidates existing HMAC keys. Adding it preserves older SHA-256 keys. Create replacement keys before rotation and revoke old ones. No pepper is needed to run the existing local setup; `.dev.vars.example` includes the optional setting.

## Documentation

- [Development plan](docs/DEVELOPMENT.md) — step-by-step implementation order and acceptance criteria
- [Architecture](docs/ARCHITECTURE.md) — storage, runtime and security architecture
- [Operations](docs/OPERATIONS.md) — R2/KV backup, isolated recovery and stable release gates

## Roadmap

The first stable v3 release is planned to include:

- single-user username/password login
- GitHub OAuth restricted to one GitHub account
- JSON Bin CRUD
- collections
- schemas and validation
- API keys and scoped permissions
- deep-path access
- JSON Merge Patch
- immutable version history
- diff and restore
- ETag / If-Match conflict protection
- data/schema locks
- TTL
- trash
- import/export
- search
- polished desktop/mobile dashboard


## Activity records

P8 adds the Chinese **活动记录** dashboard at `/#/activity`, with refresh, operation/resource filters and cursor pagination. `GET /api/v1/activity` requires a management Session; explicit Authorization headers are rejected even with a valid Cookie. API Keys cannot read this list.

Records are immutable R2 objects containing fixed action summaries, safe resource/user/key IDs, timestamps and server-generated request IDs. Passwords, Cookie/Authorization values, tokens or digests, OAuth code/state, names/descriptions, JSON values and field paths are excluded. Successful management operations and anonymous credential/body-validation failures are recorded; Origin rejection, oversized login bodies and disabled login configuration do not write activity; partial trash batches record only successful items.

Business commits and activity writes are separate. A failed activity write preserves the business result and may leave a missing record; this is a recent operation list, not a guaranteed audit chain. The existing 15-minute Cron retries cleanup to the newest 2000 records, with temporary overflow possible. Queries are bounded and may return fewer items or empty pages with a continuation cursor.

Local typecheck/build, 84 Worker/client tests and 36 Chromium tests pass. The feature commit `2ea35a6` passed [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37136840897) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/53499be9-9162-4b9c-ab17-46c98afad16c); production interaction and real Cron execution remain unverified. See [P8 development notes](docs/DEVELOPMENT.md#p8-活动记录). P9 documentation is described below.


## API documentation

P9 adds the Chinese **API 文档** dashboard at `/#/docs` and shared examples in each Bin’s **API** tab. It documents authentication, scopes, resource requests/responses, ETags, Merge Patch, JSON Pointer paths and errors. Copyable curl, JavaScript fetch and Python requests examples use the current deployment origin. Replace the marked credentials and demo resource IDs before running them.

Bin examples use the saved ID/ETag/state and fixed demo JSON; they never include saved JSON, names, descriptions or drafts. Public current reads can omit credentials, while history and writes retain their authentication requirements. Viewing or copying examples executes no business requests and preserves editor drafts.

The sequential example creates a demo Bin and reads fresh ETags before both writes. It requires bin:create/read/update; its curl version also needs Python 3 for JSON parsing. Python samples require requests on the caller’s machine and explicitly encode JSON as UTF-8 bytes.

Local typecheck/build, 91 Worker/client tests and 40 Chromium tests pass. The feature commit `1073436` passed [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37141128306) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/b37a3f07-8da5-4def-9ab2-d277d323dc3d). Production authentication/CORS, deployed browser behavior and real Cron execution remain unverified because the public production URL and suitable credentials are unavailable; deployment configuration differences remain unverified. See [P9 development notes](docs/DEVELOPMENT.md#p9-api-文档). P10 settings, import and export are described below.


## Settings, JSON import and business backups

P10 adds the Chinese **设置** page at `/#/settings`. System information reports package version, read-only R2/KV probes, OAuth configuration and bounded business statistics. These probes do not verify storage writes, OAuth login or actual Cron execution. Statistics scan at most 10000 objects and read 500 metadata records; failures or excess return unavailable statistics instead of partial totals.

Default settings live in `system/settings.json`. An absent object returns private/no-expiry defaults without writing. Settings updates require the returned ETag in `If-Match` (428 when absent, 412 on conflict). Visibility and TTL apply only to omitted creation fields; an explicit `expiresAt:null` disables expiry. TTL is null or an integer from 1 to 31536000 seconds, calculated when the server creates the Bin. Existing Bins remain unchanged.

New `/api/v1/system/info`, `/settings`, `/import`, `/export` and `/restore` endpoints require a management Session and reject every explicit Authorization header, including Bearer plus Cookie. Writes check Origin; responses are no-store. Public `/system/health` remains available. The API documentation page includes curl, JavaScript and Python examples.

Ordinary JSON import previews each complete UTF-8 file (BOM accepted) as one value, including arrays, false and null. Each file and serialized value are limited to 1 MiB; a batch is at most 100 items and 10 MiB, with business nesting at most 64 levels. Invalid structure produces no writes; valid batches report each created/failed item. Writes are not automatically retried. Network interruption may already have committed data: check the list before importing again. Files stay in page memory.

`GET /api/v1/system/export` accepts only `scope=all|config&format=backup`, or `scope=bin&id=<UUID>&format=value|backup`. Current-value downloads use only the saved current snapshot, retain editor drafts and do not depend on all history, associations or defaults. Configuration exports contain only defaults and format metadata, with empty resource arrays. Versioned `jsonbin-backup` JSON includes defaults, collections, all retained model revisions and Bin versions, trash/expired metadata and terminal purge markers. System credentials, API Keys/digests, activity, KV, internal receipts and unknown namespaces are excluded; user JSON values remain intact. Canonical records take precedence over legacy trash. Missing dependencies/files or transitional states return 409; metadata/history changes during export return `backup_changed`. Snapshots are consistent per captured resource; newly created resources after scanning starts may be absent.

Backups are bounded to 100 resources, 250 logical objects (each metadata/terminal marker, revision/version and settings counts once) and 10 MiB UTF-8 JSON; value/schema depth excludes wrappers. The 1 MiB per-value limit applies to ordinary JSON import; backup values share the 10 MiB package budget. Models retain the existing 64 KiB limit. Browser ZIP uses uncompressed STORE with exactly `manifest.json` and `backup.json`, CRC32 and manifest SHA-256/byte count; total ZIP size is at most 10 MiB + 64 KiB. Arbitrary, compressed, encrypted, ZIP64, descriptor, extra/path entries and malformed archives are rejected. Standard ZIP tools can read these exports; the Worker accepts individually validated JSON resources rather than arbitrary ZIP uploads.

Restore preserves IDs, visibility, TTL, locks, deletion state, pinned model revisions and history. Existing active/deleted/purged/legacy/orphan targets are skipped without overwrite; conflicting dependencies skip their Bins. Settings require a separate ETag update. Collections and models publish first; each resource conditionally claims hidden pending metadata, creates immutable files, verifies dependencies and then publishes with CAS. Interrupted imports remain hidden and are not cleaned by Cron; the same backup can resume, while changed content cannot take ownership. A repeated completed receipt returns unchanged; ordinary edits invalidate receipts. If dependencies changed, retry cannot overwrite them; migrate the original backup to an empty instance. Expired restored Bins immediately follow trash rules. A concurrent collection deletion may detach membership after publication; cleanup failure reports a warning while retaining created data. Cancellation stops waiting and does not undo commits.

No established legacy JSONBin export protocol/sample is available, so legacy-format import is currently not applicable. Ordinary JSON is never auto-unpacked based on a `format` field. See [P10 development notes](docs/DEVELOPMENT.md#p10-设置导入与导出) and the [approved design](docs/superpowers/specs/2026-10-04-p10-settings-backup-design.md).

P10 is merged and pushed to main at functional delivery commit `804fa4b`. Local typecheck/build, all 132 Worker/client tests and all 48 Chromium tests pass, with no failures or skipped tests. The independent whole-branch review's three Important findings have verified fixes and both Minor documentation findings are corrected; none are deferred. [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37163198650) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/9d2ef383-8491-4acf-8dea-d9cc69a8b982) passed for the exact functional commit. Subsequent documentation-only commits have their own checks. Production authentication/CORS, deployed browser behavior and real Cron remain unverified because the production URL and suitable credentials are unavailable. P11 search and KV indexes are delivered; P12 security and release acceptance is the current phase.

For development on another computer, use the remote main branch and follow [the development handoff](docs/DEVELOPMENT.md#11-在另一台电脑接续开发), [P12 design](docs/superpowers/specs/2026-10-04-p12-release-design.md) and [operations guide](docs/OPERATIONS.md).
