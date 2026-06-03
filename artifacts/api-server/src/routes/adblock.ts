// ============================================================
// adblock.ts — Adblocker detection report endpoint
//
// The frontend bait-element detector calls POST /api/adblock-report
// to record whether a user's browser is hiding ad-bait elements.
// This is stored in the users table and visible in the admin panel.
//
// The route requires x-user-id (same as all other game routes).
// ============================================================

import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";

const router: IRouter = Router();

// ── POST /api/adblock-report ──────────────────────────────────────────────
// Body: { detected: boolean }
// Upserts the adblock_detected flag for the calling user.
router.post("/adblock-report", async (req, res) => {
  const rawId = req.headers["x-user-id"];
  if (!rawId) {
    res.status(401).json({ error: "Missing x-user-id" });
    return;
  }
  const userId = parseInt(rawId as string);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Invalid user id" });
    return;
  }

  const { detected } = req.body as { detected?: boolean };
  if (typeof detected !== "boolean") {
    res.status(400).json({ error: "detected must be a boolean" });
    return;
  }

  try {
    await pool.query(
      "UPDATE users SET adblock_detected = $1 WHERE id = $2",
      [detected, userId],
    );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "adblock-report error");
    res.status(500).json({ error: "Failed to save adblock status" });
  }
});

export default router;
