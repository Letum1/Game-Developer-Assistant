---
name: Production mode setup
description: How MineVault serves static files in production and the Express 5 wildcard fix required
---

## Rule
The "Start application" workflow runs a production build + start, NOT a dev proxy. The SPA fallback route must use `/{*path}` not bare `*` in Express 5.

**Why:** Express 5 uses path-to-regexp v8 which rejects bare `*` wildcards — throws `PathError: Missing parameter name at index 1: *`. This crashes the server on startup.

**How to apply:** Any new wildcard route in app.ts must use `/{*paramName}` or a regex (`/\/.*/`). Bare `*` will always crash in Express 5.

## Workflow command
```
PORT=23242 BASE_PATH=/ pnpm --filter @workspace/mining-game run build && pnpm --filter @workspace/api-server run build && PORT=8080 NODE_ENV=production pnpm --filter @workspace/api-server run start
```
- mining-game build requires PORT + BASE_PATH env vars
- API server serves static files from `artifacts/mining-game/dist/public`
- Static path relative to compiled dist: `path.join(__dirname, "../../mining-game/dist/public")`

## Screenshot tool limitation
The screenshot tool routes api-server artifact to `/api/` (its preview path), not `/`. The app only renders correctly when accessed via the Replit dev domain root. Dark bg confirmed via inline CSS on `<html>` tag.
