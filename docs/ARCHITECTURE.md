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

Current and planned object layout (system settings and trash management remain later phases):

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

R2 ETags are used for optimistic concurrency control. Dashboard and API updates will support `If-Match` so a stale client cannot silently overwrite newer data.

### KV: disposable edge cache and indexes

KV is used only for derived or rebuildable data:

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
