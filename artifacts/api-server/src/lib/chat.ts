import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { logger } from "./logger";

export function attachChat(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/api/chat" });

  wss.on("connection", (ws, req) => {
    logger.info({ ip: req.socket.remoteAddress }, "Chat client connected");

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as { username?: unknown; message?: unknown };
        const msg = {
          username: String(data.username ?? "Anonymous").slice(0, 24),
          message: String(data.message ?? "").slice(0, 200),
          ts: Date.now(),
        };
        if (!msg.message.trim()) return;
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(msg));
          }
        });
      } catch {
        // ignore malformed messages
      }
    });

    ws.on("error", (err) => logger.warn({ err }, "Chat WS error"));
  });

  logger.info("Chat WebSocket server attached at /api/chat");
}
