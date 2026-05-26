import http from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { attachChat } from "./lib/chat";
import { startPassiveTicker } from "./lib/passive-ticker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
attachChat(server);

// ── WebSocket upgrade forwarding ──────────────────────────────────────────
// In development the Vite dev server needs to receive WebSocket upgrade
// requests (for HMR) that arrive on port 80 (this server).  The proxy
// middleware created in app.ts already intercepts HTTP; we wire up the
// lower-level 'upgrade' event here so WS frames are forwarded as well.
if (process.env.NODE_ENV !== "production") {
  const vitePort = process.env.GAME_DEV_PORT ?? "23242";
  const httpProxy = await import("http-proxy");
  const wsProxy = httpProxy.default.createProxyServer({
    target: `http://localhost:${vitePort}`,
    ws: true,
  });

  server.on("upgrade", (req, socket, head) => {
    // Let the chat WebSocket handler deal with its own path
    if (req.url?.startsWith("/api/")) return;
    // Forward everything else (Vite HMR, etc.) to the game server
    wsProxy.ws(req, socket, head);
  });
}

server.listen(port, () => {
  logger.info({ port }, "Server listening");
  // Start the passive income ticker — runs every 60s, ticks all active miners
  // so players earn offline even when they are not in the game.
  startPassiveTicker();
});
