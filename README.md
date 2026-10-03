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

The P1 implementation adds a Bin detail page with a locally bundled Monaco JSON editor, metadata settings, save/delete actions, refreshable links, and unsaved-draft protection. P2 adds version history, read-only comparison of any two versions and restoration into a new immutable version. P3 adds collections, member counts and Bin membership settings. Collection deletion detaches members and preserves their JSON and version history. P4 adds Draft 7 JSON Schema management, sample validation and Bin bindings to immutable model revisions. Creation, updates and historical restoration validate against the pinned revision; model locks protect binding changes, and deleting a model retains existing constraints. P5 adds API key administration, one-time token disclosure, expiry/revocation and scoped Bearer authentication for existing resource APIs. See the development plan for local, CI and production acceptance status.

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
