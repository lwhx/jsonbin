# JSONBin v3 Architecture

## Product scope

JSONBin v3 is a single-user, private JSON storage and configuration platform designed for Cloudflare.

It is intentionally **not** a multi-tenant database product. The priorities are:

- excellent Web UI;
- reliable REST API for scripts and automation;
- simple operations;
- strong data integrity;
- complete version history;
- minimal infrastructure.

## Runtime

- Cloudflare Workers
- Hono
- TypeScript
- React + Vite
- Cloudflare Vite Plugin

## Storage model

### R2: source of truth

R2 owns all durable state.

Nothing stored only in KV is considered authoritative.

Current and planned object layout (system/settings.json is implemented; system/auth is reserved; the trash prefix is retained for legacy compatibility):

```text
system/
  settings.json
  auth/
    admin.json
    github.json

collections/
  <collectionId>/
    meta.json

schemas/
  <schemaId>/
    meta.json
    revisions/
      000001.json
      000002.json

bins/
  <binId>/
    meta.json
    versions/
      000001.json
      000002.json
      000003.json

keys/
  <keyId>/
    meta.json

trash/
  bins/
  collections/
```

A bin version is immutable. Updating a bin creates a new version and atomically advances its metadata.

R2 ETags are used for optimistic concurrency control. Dashboard updates send `If-Match`; Merge Patch, deep writes and data-lock changes require it. Partial writes derive from one snapshot and publish through the same schema validation, immutable append and metadata CAS as full replacements.

Bin deletion conditionally writes `deletedAt` to canonical metadata, which is also the authoritative trash record. Active reads, history and collection counts exclude deleted and expired Bins. Legacy `trash/bins/<id>/meta.json` records are conditionally adopted when restored or purged; an active or terminal canonical record takes precedence over a stale archive.

Restoration validates the existing immutable value against its pinned schema and clears the deletion marker with CAS. It clears TTL, defaults visibility to private, preserves data/schema locks and detaches unavailable collections. A new lifecycle ID prevents old trash ETags from applying to another deletion of the same Bin. It preserves the JSON version and historical objects.

Permanent deletion claims a non-restorable `purging` state with CAS, deletes all version pages and legacy archives, then retains only `{id,deletedAt,purgeState:"purged"}`. Interrupted deletion can resume with its approved ETag or current trash ETag. The minimal terminal marker prevents delayed writes or legacy archive imports from reviving deleted JSON. Batch deletion accepts explicit ID/ETag pairs and reports per-item outcomes.

TTL enforcement happens at request time, independently of cron or caches. A scheduled handler runs every 15 minutes in UTC to archive expired Bins (including locked ones) and resume purges. It rechecks canonical state and conditionally updates metadata, preserving concurrent deadline changes. Terminal cleanup also removes late orphan files after interrupted in-flight writes. The current scan uses R2 directly; future indexes may optimize discovery but cannot replace authoritative access checks.

### KV: disposable edge cache and indexes

KV is reserved for derived or rebuildable data (not yet used for these indexes):

- slug -> bin ID index;
- public/read cache;
- collection list cache;
- dashboard summaries;
- search index;
- short-lived UI/session cache where appropriate.

Security decisions, version numbers and canonical metadata must never depend solely on KV because KV is eventually consistent.

## Authentication

JSONBin v3 is single-user.

Dashboard login will support:

1. local username + password;
2. GitHub OAuth restricted to one configured GitHub numeric user ID.

There is no public registration.

Local password login reads ADMIN_USERNAME and ADMIN_PASSWORD from Cloudflare Worker variables/secrets. The plaintext password is not committed to Git. Session cookies are signed, HttpOnly, Secure on HTTPS and SameSite protected.

API authentication is separate from dashboard sessions.

## API keys

API keys use a UUID lookup selector and 256 random secret bits:

```text
jb_live_<uuid-without-hyphens>_<base64url-random-secret>
```

The plaintext token is returned only on creation and shown once. `keys/<keyId>/meta.json` stores metadata and a SHA-256 digest, or HMAC-SHA-256 when an optional stable `TOKEN_PEPPER` Secret is configured. Public list/revoke responses contain neither token nor digest. Key administration requires a signed dashboard session; a Bearer credential cannot issue or revoke keys.

Implemented scopes:

- `bin:read`
- `bin:create`
- `bin:update`
- `bin:delete`
- `collection:read`
- `collection:write`
- `schema:read`
- `schema:write`
- `history:read`

Keys support optional future expiry, idempotent revocation and last-used timestamps. Resource-specific restrictions are a future extension; current scopes cover the single owner’s resources. Every authorization reads canonical R2 state and conditionally updates last use. CAS retries recheck credentials and cannot resurrect a revoked key. Existing requests already authorized before revocation may complete.

An Authorization header received by the Worker takes precedence over Cookies; invalid Bearer credentials return 401, missing scopes return 403. Collection member reads require `collection:read` plus `bin:read`; historical restore requires `bin:update` plus `history:read`. Cookie-authenticated writes validate a supplied Origin against APP_ORIGIN or the request origin. Bearer clients continue to follow scope and existing ETag/lock/schema rules.

Public Bins allow anonymous GET of the current record and deep paths only when no Authorization header is supplied. Lists, history and mutations remain authenticated. Visibility and returned JSON come from the same metadata/immutable-version snapshot. Bin responses use `Cache-Control: no-store`; no public read cache is currently used. Data locks block mutation and deletion but permit an isolated conditional unlock; schema locks remain independent.

## Core API

The v1 API will live below:

```text
/api/v1
```

Planned resources:

```text
GET    /api/v1/bins
POST   /api/v1/bins

GET    /api/v1/bins/:id
PUT    /api/v1/bins/:id
PATCH  /api/v1/bins/:id
DELETE /api/v1/bins/:id

GET    /api/v1/bins/:id/value/*
PUT    /api/v1/bins/:id/value/*
PATCH  /api/v1/bins/:id/meta
GET    /api/v1/bins/:id/versions
GET    /api/v1/bins/:id/versions/:version
POST   /api/v1/bins/:id/versions/:version/restore

GET    /api/v1/collections
POST   /api/v1/collections

GET    /api/v1/schemas
POST   /api/v1/schemas

GET    /api/v1/keys
POST   /api/v1/keys
DELETE /api/v1/keys/:id
```

## Bin features

The first stable release targets:

- JSON CRUD;
- deep-path reads and writes;
- JSON Merge Patch;
- collections;
- public/private visibility;
- schemas;
- schema validation;
- data lock;
- schema lock;
- version history;
- diff;
- restore;
- ETag / If-Match;
- TTL / expiry;
- trash / restore;
- import / export;
- search;
- API key permissions;
- responsive light/dark dashboard.

## Web UI

The dashboard should feel like a modern developer SaaS, not an admin template.

Primary sections:

- Overview
- Bins
- Collections
- Schemas
- API Keys
- Activity
- API Docs
- Trash
- Settings

The implementation order and acceptance criteria are maintained in [DEVELOPMENT.md](DEVELOPMENT.md).

The Bin detail view will eventually contain:

- Editor
- Tree
- History
- Diff
- API
- Settings

The editor experience will use Monaco and the history comparison will use Monaco Diff Editor.

## Security principles

- never log Authorization headers, cookies or API tokens;
- never persist API tokens in plaintext;
- GitHub login must enforce the configured numeric GitHub user ID;
- state-changing dashboard actions require CSRF protection;
- API writes use explicit scopes;
- writes support optimistic concurrency;
- security-critical canonical state lives in R2, not KV;
- restrictive security headers are enabled by default.

## Legacy

The original Remy Sharp JSONBin code is preserved on the `legacy-v2.6.4` branch.

The `main` branch is a clean reimplementation and does not attempt runtime compatibility with the old Express/MongoDB stack.


## System settings and business backups (P10)

`/api/v1/system/info|settings|import|export|restore` requires a management Session, rejects every explicit Authorization, validates Origin for writes and returns no-store. The existing public health endpoint keeps its contract. R2 `system/settings.json` stores only versioned defaults and update time; reads of absent settings return private/null and a virtual ETag without creating an object. PATCH uses mandatory If-Match and conditional create/update. Defaults are resolved in common server-side Bin creation only for omitted visibility/expiry fields; explicit null means no expiry and relative TTL uses creation time.

System probes use read-only R2 HEAD/KV GET. OAuth reports configuration presence, never values. Statistics scan at most 10000 R2 objects and 500 metadata bodies; errors/limits yield unavailable rather than partial totals. Canonical/legacy precedence and pending/purged exclusion apply to usable history; physical stored bytes include canonical orphan files.

Exports project an allowlist into `jsonbin-backup` schemaVersion 1: defaults, collection metadata, all retained model revisions, Bin metadata/versions, trash/expired records and terminal purge markers. System authentication, keys/digests, activity, KV, unknown namespaces and internal restore metadata are excluded; arbitrary user JSON is preserved. Canonical metadata overrides old trash. Each captured resource's metadata ETag and history membership, plus settings ETag, are rechecked; a change/missing dependency/transition aborts export. This is per-resource consistency, not a global transaction: newly created resources may be absent.

The closed backup graph has 100-resource/250-logical-object/10-MiB JSON limits; each metadata/marker, revision/version and settings counts once. Business depth is at most 64 excluding wrappers; ordinary JSON import limits each value to 1 MiB, while backup values share the 10-MiB package budget; a schema is at most 64 KiB. UTF-8 is decoded strictly, BOM accepted. Browser ZIP is standard uncompressed STORE with exactly manifest.json and backup.json, verified CRC32, SHA-256 and byte count. The reader bounds actual bytes and rejects compression, encryption, ZIP64, descriptors, extras, paths, duplicate/overlapping entries and conflicting headers. Worker restore takes JSON resources, not ZIP.

Restore is create-only per resource and retains original IDs. Collections/models publish before dependent Bins. Conditional metadata claims store a validated hidden `importState:pending` marker and content fingerprint. Ordinary reads/writes/listing, trash, lifecycle and Cron reject/skip these claims; interrupted claims are not automatically discarded. Immutable files are conditionally created, then all expected files and actual dependency receipts are verified before metadata CAS publication. Same-content imports resume; other claims and existing canonical/legacy/orphan/purged resources are skipped without overwrite. Bin publication creates a new lifecycle ID and preserves source visibility, expiry, locks, deletion state and pinned schema revision. Old history values are not revalidated against later models; current values are checked against their pinned revision.

R2 custom metadata holds private restoreFingerprint receipts, originalUploadedAt and restoreOrder for history reconstruction; these fields never enter backup metadata or API values. Unchanged completed receipts allow safe repeat results; ordinary edits drop receipts. Expected dependency fingerprints are checked against actual published metadata and immutable files, including original revision order. Settings are only a candidate: applying them is a separate mandatory If-Match PATCH. Publication may be followed by collection detachment during concurrent deletion; cleanup failure remains created/unchanged with a warning. There is no cross-resource rollback. Abort stops client work and does not undo accepted server commits; network failure requires inspecting outcomes before repeating raw import.

The Chinese settings UI keeps file contents only in component memory. Default settings use ETag conflict handling; preview/confirmation precedes writes, results remain per item and configuration application is separate. Generation/mounted/AbortController guards discard late file reads and responses on selection, navigation or logout, and Blob URLs are released after downloads. Bin detail exports the saved server value while retaining editor drafts.
