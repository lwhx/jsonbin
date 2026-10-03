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

Planned object layout:

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
    schema.json

bins/
  <binId>/
    meta.json
    versions/
      000001.json
      000002.json
      000003.json

api-keys/
  <keyId>.json

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

Password credentials are stored as a salted password hash. Session cookies are signed, HttpOnly, Secure and SameSite protected.

API authentication is separate from dashboard sessions.

## API keys

API keys will use a prefixed format such as:

```text
jb_live_<random>
```

The plaintext token is shown once. Durable storage contains only a cryptographic digest.

Planned scopes:

- `bin:read`
- `bin:create`
- `bin:update`
- `bin:delete`
- `collection:read`
- `collection:write`
- `schema:read`
- `schema:write`
- `history:read`

Keys may optionally be restricted to a collection or a bin and may have an expiry date.

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
