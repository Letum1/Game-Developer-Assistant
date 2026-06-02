# Fixing the White Screen on Replit — Complete Guide

If your Replit app shows a **blank white page** after starting, restarting, or deploying, this document explains every known cause and how to fix each one. These fixes were discovered while building a full-stack Express + Vite + React app on Replit and apply to any similar stack.

---

## Cause 1 — The `dist/` folder doesn't exist yet (most common)

### What happens
Your workflow runs `node dist/index.mjs` (or similar) to start the server, but the `dist/` folder was never built. The server crashes immediately. The browser gets no response → white screen.

This happens on:
- A fresh Replit fork or clone
- After a Replit environment reboot (containers are ephemeral — the file system resets)
- After publishing/deploying for the first time

### The fix
**Always build inside the workflow command itself** — never assume `dist/` already exists.

**Wrong (common mistake):**
```
# Two separate workflows: one builds, one starts
# Problem: the start workflow might run before build finishes, or build is never re-run
pnpm run start
```

**Correct:**
```
# One workflow command that chains build → build → start
pnpm --filter @workspace/frontend run build && pnpm --filter @workspace/api run build && NODE_ENV=production pnpm --filter @workspace/api run start
```

Chain them with `&&` so the server only starts after both builds succeed. If either build fails, the server never starts and you see the actual error in the logs instead of a cryptic white screen.

---

## Cause 2 — Browser caches a blank/error response (white screen after restart)

### What happens
1. You restart your Replit workflow
2. For ~1–2 seconds the server isn't ready yet
3. The browser requests `index.html` and gets a connection-refused error or empty body
4. The browser **caches** that blank response (because `Cache-Control` defaults allow it)
5. Next time you open the app the browser serves the cached blank page → white screen
6. Hard-refreshing (`Ctrl+Shift+R`) fixes it temporarily, but it keeps happening

### The fix
Set `Cache-Control: no-store` on **HTML files only**. JS/CSS assets with hash filenames are safe to cache long-term.

In your Express server (`app.ts` or `server.js`):

```typescript
import express from "express";
import path from "path";

const staticPath = path.join(__dirname, "path/to/your/dist");

// HTML files: never cache — browser always fetches fresh on reload
app.use(
  express.static(staticPath, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// SPA fallback — also set no-store here (see Cause 3 below for the /{*path} syntax)
app.get("/{*path}", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(staticPath, "index.html"));
});
```

**Why only HTML?** Your JS and CSS filenames contain a content hash (e.g. `index-BnnyfqpN.js`). The hash changes every build, so stale caching is harmless for those files — and long-lived caching makes reloads faster. Only `index.html` is the entry point that can go stale.

---

## Cause 3 — Express 5 wildcard crash (`PathError: Missing parameter name`)

### What happens
You upgrade to Express 5 (or start a new project that uses it) and your SPA fallback route uses bare `*`:

```typescript
app.get("*", (req, res) => res.sendFile(...));  // ❌ crashes in Express 5
```

Express 5 uses `path-to-regexp` v8 which **rejects bare `*`** and throws:
```
PathError: Missing parameter name at index 1: *
```

The server crashes on startup → nothing is served → white screen.

### The fix
Use a **named wildcard parameter** with the `/{*name}` syntax:

```typescript
// Express 5 — correct SPA fallback
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});
```

The parameter name (`path` here) can be anything — it's just required by Express 5's router. This is a breaking change from Express 4 where `"*"` was valid.

---

## Cause 4 — Vite dev server rejects requests from the Replit proxy

### What happens
You run Vite in development mode. Replit serves your app through an mTLS proxy (`yourapp.replit.dev`). Vite's default `allowedHosts` setting **blocks requests from unrecognised hostnames** and returns a 403 or a blank frame — white screen in the preview pane.

### The fix
In `vite.config.ts`, set `server.allowedHosts` to `true`:

```typescript
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    allowedHosts: true,  // allow Replit proxy domain + any subdomain
    port: 5173,
  },
});
```

`true` disables host checking entirely for the dev server. This is safe in a Replit sandbox — you are not exposing a production server.

---

## Cause 5 — Static files served from the wrong path

### What happens
Your Express server starts fine, but `express.static(...)` points to the wrong directory. Every request falls through to the SPA fallback or a 404. The browser gets an empty HTML shell with no bundled JS → white screen.

### The fix
When using ESM (`"type": "module"` or `.mjs` files), `__dirname` is not available. Reconstruct it:

```typescript
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Now __dirname is the directory of the compiled server file (e.g. dist/)
// Adjust the relative path to point at your frontend build output
const staticPath = path.join(__dirname, "../../frontend/dist/public");
```

**Tip:** Add a startup log to confirm the path exists:

```typescript
import fs from "fs";
console.log("Static path:", staticPath, "| exists:", fs.existsSync(staticPath));
```

---

## Cause 6 — NODE_ENV not set to `"production"` when serving static files

### What happens
Your `app.ts` uses `if (process.env.NODE_ENV === "production")` to decide between serving static files vs. proxying to Vite. If `NODE_ENV` is missing or wrong, the server tries to proxy to a Vite dev server that isn't running → proxy error → white screen.

### The fix
Always set `NODE_ENV=production` in your start command:

```
NODE_ENV=production node dist/index.mjs
```

Or in your Replit workflow command:

```
NODE_ENV=production pnpm --filter @workspace/api run start
```

---

## Quick checklist

If you see a white screen, go through these in order:

- [ ] Does `dist/` exist? Add a build step before your start command.
- [ ] Are HTML files being cached? Add `Cache-Control: no-store` for `.html` in `express.static`.
- [ ] Are you on Express 5? Change `"*"` to `"/{*path}"` in your SPA fallback route.
- [ ] Is Vite rejecting requests? Set `server.allowedHosts: true` in `vite.config.ts`.
- [ ] Is the static path correct? Log `staticPath` and `fs.existsSync(staticPath)` on startup.
- [ ] Is `NODE_ENV` set? Add `NODE_ENV=production` to your start command.

---

## Full working example (Express 5 + Vite + Replit)

```typescript
// app.ts
import express        from "express";
import path           from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const app        = express();

app.use(express.json());

// Your API routes go here
app.use("/api", myApiRouter);

if (process.env.NODE_ENV === "production") {
  const staticPath = path.join(__dirname, "../../frontend/dist");

  // Serve assets — HTML gets no-store, hashed JS/CSS cache normally
  app.use(
    express.static(staticPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    })
  );

  // SPA fallback — Express 5 requires named wildcard /{*name}
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(staticPath, "index.html"));
  });
}

export default app;
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,   // required for Replit proxy to reach the dev server
    port: 5173,
  },
});
```

```
# Replit workflow command (chains build → build → start in one shot)
pnpm --filter @workspace/frontend run build && pnpm --filter @workspace/api run build && NODE_ENV=production pnpm --filter @workspace/api run start
```
