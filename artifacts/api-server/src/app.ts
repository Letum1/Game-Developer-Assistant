import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { startPassiveTicker } from "./lib/passive-ticker";
import { runStartupMigrations } from "./lib/startup-migrations";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Run idempotent startup migrations (adds any missing DB columns) ────────
runStartupMigrations().catch((err) =>
  logger.error({ err }, "Startup migrations threw unexpectedly"),
);

// ── API routes ─────────────────────────────────────────────────────────────
app.use("/api", router);

// ── Serve the game frontend ────────────────────────────────────────────────
// Production: serve the pre-built Vite output as static files + SPA fallback.
// Development: proxy every non-API request to the Vite dev server so the game
//              is visible at the primary URL (port 80) on the user's device.

if (process.env.NODE_ENV === "production") {
  // Built files land in artifacts/mining-game/dist/public; relative to the
  // compiled API bundle at dist/ that resolves to ../../mining-game/dist/public
  const staticPath = path.join(__dirname, "../../mining-game/dist/public");

  // ── WHITE SCREEN FIX (common Replit issue) ────────────────────────────────
  // PROBLEM: When the Replit environment first boots or restarts, the browser
  // can cache a blank/error response from before the server was fully ready.
  // On the next load it serves that stale blank page → white screen.
  //
  // FIX: We split static serving into two layers:
  //   1. HTML files → no-store (browser NEVER caches them; always fetches fresh)
  //   2. Hashed JS/CSS assets → long-lived cache (filename hash changes on rebuild,
  //      so stale asset caching is safe and speeds up reloads)
  //
  // If you ever see a white screen after restarting, this is why it was added.
  // ─────────────────────────────────────────────────────────────────────────

  // Layer 1: HTML files — set no-store so browsers always fetch a fresh copy.
  // The `setHeaders` callback fires for every static file; we only override
  // Cache-Control when the file is an HTML document.
  app.use(
    express.static(staticPath, {
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          // no-store prevents ANY caching of the HTML shell.
          // This is safe because HTML is tiny; the expensive assets (JS/CSS)
          // are handled separately with long-lived caching below.
          res.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );

  // SPA fallback — unknown paths return index.html so client-side routing works.
  // Express 5 requires a named wildcard parameter instead of bare *.
  // Also sets no-store here to match the static layer above.
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(staticPath, "index.html"));
  });
} else {
  // The Vite dev server port is the PORT assigned to the mining-game artifact.
  // Replit maps it to localPort 23242 in the current environment; override with
  // GAME_DEV_PORT if the platform assigns something different.
  const vitePort = process.env.GAME_DEV_PORT ?? "23242";

  // Proxy all non-API requests (HTML, JS, CSS, WebSocket HMR, etc.) to Vite
  app.use(
    createProxyMiddleware({
      target: `http://localhost:${vitePort}`,
      changeOrigin: true,
      // ws: true is set at the server level in index.ts via the upgrade event
      on: {
        error: (_err, _req, res) => {
          // Graceful fallback while Vite is still starting up
          if (res && "headersSent" in res && !res.headersSent) {
            (res as express.Response)
              .status(503)
              .send(
                "<html><body style='background:#000;color:#0f0;font-family:monospace;padding:2rem'>" +
                  "<h2>⛏ MineVault</h2><p>Game server is starting up, please wait a moment and refresh…</p>" +
                  "</body></html>",
              );
          }
        },
      },
    }),
  );
}

export default app;
