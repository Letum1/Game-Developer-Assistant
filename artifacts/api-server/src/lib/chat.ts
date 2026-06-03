// ============================================================
// chat.ts — Real-time multiplayer chat via WebSocket
//
// Connected clients send JSON: { userId, username, message }
// The server checks is_muted before broadcasting.
// Muted players receive a MUTED error frame; their message is dropped.
//
// Broadcast format: { username, message, ts }
// Error format:     { error: "MUTED" }
// ============================================================

import { WebSocketServer, WebSocket } from "ws";
import type http from "http";
import { logger } from "./logger";
import { pool } from "./db-pool";

export function attachChat(server: http.Server): void {
  const wss = new WebSocketServer({ server, path: "/api/chat" });

  wss.on("connection", (ws, req) => {
    logger.info({ ip: req.socket.remoteAddress }, "Chat client connected");

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as {
          userId?: unknown;
          username?: unknown;
          message?: unknown;
        };

        const userId  = parseInt(String(data.userId ?? "0")) || null;
        const username = String(data.username ?? "Anonymous").slice(0, 24);
        const message  = String(data.message ?? "").slice(0, 200);

        if (!message.trim()) return;

        // ── Mute check — only if userId was supplied ────────────────────
        if (userId) {
          const muteRes = await pool.query(
            "SELECT COALESCE(is_muted, false) AS is_muted FROM users WHERE id = $1",
            [userId],
          );
          if (muteRes.rows[0]?.is_muted === true) {
            // Notify the muted sender only; don't broadcast
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ error: "MUTED", message: "You are muted and cannot chat." }));
            }
            return;
          }
        }

        // Broadcast to all connected clients
        const frame = JSON.stringify({ username, message, ts: Date.now() });
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(frame);
          }
        });
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("error", (err) => logger.warn({ err }, "Chat WS error"));
  });

  logger.info("Chat WebSocket server attached at /api/chat");
}
