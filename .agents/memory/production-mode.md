---
name: Production mode setup
description: How MineVault serves static files in production, the Express 5 wildcard fix, and the white-screen-on-restart fix
---

## Rule
The "Start application" workflow MUST build both the frontend and backend before starting the server.
Never use a bare `start` command — always chain build → build → start in one command.

**Why:** On every fresh Replit environment boot (or after an export/deploy), the `dist/` folder does
not exist yet. Running `start` alone finds no `dist/index.mjs` → server crashes → browser gets no
response → white screen. Building inside the workflow command guarantees the dist is always fresh.

**How to apply:** The "Start application" workflow command must always be:
```
BASE_PATH=/ PORT=23242 pnpm --filter @workspace/mining-game run build && pnpm --filter @workspace/api-server run build && PORT=5000 NODE_ENV=production pnpm --filter @workspace/api-server run start
```
- `BASE_PATH` and `PORT=23242` are required by vite.config.ts for the frontend build
- API server serves static files from `artifacts/mining-game/dist/public`
- Static path relative to compiled dist: `path.join(__dirname, "../../mining-game/dist/public")`
- Never split this into separate build + start workflows — it must be one chained command

## Cache-Control fix (secondary white-screen guard)
In `app.ts` the static file server sets `Cache-Control: no-store` for HTML files so browsers never
serve a stale blank page from cache after a restart. JS/CSS assets use their default long-lived
cache (filename hash changes on rebuild). Do NOT remove these headers.

## Express 5 wildcard fix
The SPA fallback route must use `/{*path}` not bare `*` in Express 5.

**Why:** Express 5 uses path-to-regexp v8 which rejects bare `*` wildcards — throws
`PathError: Missing parameter name at index 1: *`. This crashes the server on startup.

**How to apply:** Any new wildcard route in app.ts must use `/{*paramName}` or a regex.
Bare `*` will always crash in Express 5.

## Screenshot tool note
The screenshot tool routes the api-server artifact to `/api/` (its preview path), not `/`.
The app only renders correctly when accessed via the Replit dev domain root.
