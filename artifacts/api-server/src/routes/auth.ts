// ============================================================
// auth.ts — Login and registration routes
//
// Auth model: SHA-256 hashed passwords stored in PostgreSQL.
// The userId is returned on success and the client stores it in
// localStorage, sending it as x-user-id on every subsequent request.
//
// Admin detection: if the registered/logged-in username matches
// the ADMIN_USERNAME env var (default "admin"), the response
// includes isAdmin: true so the frontend can show the admin panel.
// ============================================================

import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "../lib/db-pool";
import { RegisterBody, LoginBody } from "@workspace/api-zod";

const router: IRouter = Router();

// Admin username is read from env so it can be changed without a redeploy.
// Default "admin" is fine for local dev; set ADMIN_USERNAME in Replit Secrets
// if you want a less obvious callsign in production.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";

router.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, password } = parsed.data;
  try {
    const hash = crypto.createHash("sha256").update(password).digest("hex");

    const userRes = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash]
    );
    const user = userRes.rows[0];

    await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.id]);
    await pool.query("INSERT INTO miners (user_id) VALUES ($1)", [user.id]);

    const startingItems = [
      ["pickaxe_wood", 1],
      ["seed_oak", 5],
      ["block_dirt", 20],
    ];
    for (const [itemId, qty] of startingItems) {
      await pool.query(
        "INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, $3)",
        [user.id, itemId, qty]
      );
    }

    // Include isAdmin flag so the frontend can show the admin panel
    res.json({
      success: true,
      userId: user.id,
      username: user.username,
      isAdmin: user.username === ADMIN_USERNAME,
    });
  } catch {
    res.status(400).json({ error: "Username already taken" });
  }
});

router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, password } = parsed.data;
  try {
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const result = await pool.query(
      // Also fetch is_banned and is_admin — added by startup migrations
      "SELECT id, username, COALESCE(is_banned, false) AS is_banned, COALESCE(is_admin, false) AS is_admin FROM users WHERE username = $1 AND password_hash = $2",
      [username, hash]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const user = result.rows[0];

    // Banned users cannot log in — show a clear message
    if (user.is_banned) {
      res.status(403).json({ error: "Your account has been banned. Contact support if you believe this is a mistake." });
      return;
    }

    // isAdmin: true if username is the env-configured root admin OR
    // the DB `is_admin` flag was granted by the root admin
    const isAdmin = user.username === ADMIN_USERNAME || user.is_admin === true;

    res.json({
      success: true,
      userId: user.id,
      username: user.username,
      isAdmin,
    });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

export default router;
