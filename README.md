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

Records are immutable R2 objects containing fixed action summaries, safe resource/user/key IDs, timestamps and server-generated request IDs. Passwords, Cookie/Authorization values, tokens or digests, OAuth code/state, names/descriptions, JSON values and field paths are excluded. Successful management operations and anonymous login failures are recorded; partial trash batches record only successful items.

Business commits and activity writes are separate. A failed activity write preserves the business result and may leave a missing record; this is a recent operation list, not a guaranteed audit chain. The existing 15-minute Cron retries cleanup to the newest 2000 records, with temporary overflow possible. Queries are bounded and may return fewer items or empty pages with a continuation cursor.

Local typecheck/build, 84 Worker/client tests and 36 Chromium tests pass. The feature commit `2ea35a6` passed [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37136840897) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/53499be9-9162-4b9c-ab17-46c98afad16c); production interaction and real Cron execution remain unverified. See [P8 development notes](docs/DEVELOPMENT.md#p8-活动记录). P9 documentation is described below.


## API documentation

P9 adds the Chinese **API 文档** dashboard at `/#/docs` and shared examples in each Bin’s **API** tab. It documents authentication, scopes, resource requests/responses, ETags, Merge Patch, JSON Pointer paths and errors. Copyable curl, JavaScript fetch and Python requests examples use the current deployment origin. Replace the marked credentials and demo resource IDs before running them.

Bin examples use the saved ID/ETag/state and fixed demo JSON; they never include saved JSON, names, descriptions or drafts. Public current reads can omit credentials, while history and writes retain their authentication requirements. Viewing or copying examples executes no business requests and preserves editor drafts.

The sequential example creates a demo Bin and reads fresh ETags before both writes. It requires bin:create/read/update; its curl version also needs Python 3 for JSON parsing. Python samples require requests on the caller’s machine and explicitly encode JSON as UTF-8 bytes.

Local typecheck/build, 91 Worker/client tests and 40 Chromium tests pass. The feature commit `1073436` passed [GitHub CI](https://github.com/lwhx/jsonbin/actions/runs/37141128306) and [Workers Builds](https://dash.cloudflare.com/7946c64d5ff82047528862a11ccd2157/workers/services/view/jsonbin/production/builds/b37a3f07-8da5-4def-9ab2-d277d323dc3d). Production authentication/CORS, deployed browser behavior and real Cron execution remain unverified because the public production URL and suitable credentials are unavailable; deployment configuration differences remain unverified. See [P9 development notes](docs/DEVELOPMENT.md#p9-api-文档). Next phase: P10 settings, import and export.
