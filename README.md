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

The `main` branch currently contains the new application foundation:

- Cloudflare Worker + Hono API
- React dashboard shell
- light/dark theme
- responsive layout
- system health endpoint
- R2/KV binding contract
- v3 architecture and security model

The next implementation layers are authentication, R2 storage primitives and JSON Bin CRUD.

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
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
