/**
 * monetization.ts — Rewarded Ad Task System
 *
 * Flow:
 *   1. Client calls POST /monetization/request-task  → server creates a timestamped task in DB,
 *      returns a one-time token and the ad URL to open in a popup.
 *   2. Client shows a 15-second countdown with anti-cheat guards (tab-visibility pause,
 *      popup-close detection). See Miner.tsx for the full client-side anti-cheat logic.
 *   3. After the countdown, client calls POST /monetization/verify-task with the token.
 *   4. Server independently checks that ≥15 s elapsed since the task was created,
 *      grants the reward, and deletes the task row so the token cannot be reused.
 *
 * Anti-double-spend: the token is SHA-256 hashed before storage; only the plain token is
 * sent to the client, so even if the DB is read directly, raw tokens cannot be crafted.
 *
 * Task types and their rewards:
 *   drill_boost  — +10 gems, +50 window_points  (mining speed boost)
 *   cool_down    — reset miner temperature to 0  (cooling fix)
 *   gem_reward   — +50 gems, +25 window_points  (dedicated "Watch Ad for Gems" flow)
 */

import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "../lib/db-pool";
import {
  RequestMonetizationTaskHeader,
  RequestMonetizationTaskBody,
  VerifyMonetizationTaskHeader,
  VerifyMonetizationTaskBody,
} from "@workspace/api-zod";
import {
  DRILL_BOOST_MULTIPLIER,
  DRILL_BOOST_DURATION_MS,
  DRILL_BOOST_MAX_PER_DAY,
} from "../lib/game-constants";

const router: IRouter = Router();

// ── Ad URL ──────────────────────────────────────────────────────────────────
// Replace this with your real Adsterra Direct Link URL when you have it.
// The client opens this in a popup; we verify on the server independently via timestamp.
// Adsterra Smartlink — opens in a popup when the player clicks "Watch Ad for Gems".
// This is your real Adsterra direct link; replace if you rotate the link in the dashboard.
const AD_URL = "https://www.effectivecpmnetwork.com/jh72a2xr?key=4b8ea0885e0edebf30ad4b1234ebcc20";

// ── Minimum time (seconds) the player must keep the ad open ─────────────────
// Server re-verifies this independently — client-side countdown is for UX only.
const REQUIRED_WATCH_SECONDS = 15;

// ── Task expiry window (seconds) — how long after request the token is valid ──
// Slightly longer than REQUIRED_WATCH_SECONDS to absorb network latency.
const TASK_EXPIRY_SECONDS = 20;

// ── POST /api/monetization/request-task ─────────────────────────────────────
// Creates a timestamped task row for the user and returns a one-time token.
// Uses ON CONFLICT to replace any existing pending task (one task per user at a time).
router.post("/monetization/request-task", async (req, res) => {
  // Validate user identity from header
  const headerParsed = RequestMonetizationTaskHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  // Validate request body (type must be a known task type)
  const bodyParsed = RequestMonetizationTaskBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { type } = bodyParsed.data;

  // Generate a cryptographically-random token; only the hash goes to the DB.
  // The plain token is returned to the client and checked at verify time.
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + TASK_EXPIRY_SECONDS * 1000);

  try {
    // Upsert: one pending task per user. Starting a new task cancels any previous one.
    await pool.query(
      `INSERT INTO active_tasks (user_id, task_type, started_at, expires_at, token_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET task_type  = $2,
             started_at = $3,
             expires_at = $4,
             token_hash = $5`,
      [userId, type, startedAt, expiresAt, tokenHash]
    );

    // Return the plain token + ad URL to open
    res.json({
      success: true,
      token,
      expiresAt: expiresAt.toISOString(),
      adUrl: AD_URL,
    });
  } catch (err) {
    req.log.error({ err }, "Request task error");
    res.status(500).json({ error: "Task request failed" });
  }
});

// ── POST /api/monetization/verify-task ──────────────────────────────────────
// Called by the client after the countdown finishes.
// Server independently verifies elapsed time — client cannot skip the wait.
router.post("/monetization/verify-task", async (req, res) => {
  // Validate user identity from header
  const headerParsed = VerifyMonetizationTaskHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  // Validate request body (must contain the plain token)
  const bodyParsed = VerifyMonetizationTaskBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { token } = bodyParsed.data;

  try {
    // Hash the submitted token and look it up — prevents forged tokens
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const taskRes = await pool.query(
      "SELECT * FROM active_tasks WHERE user_id = $1 AND token_hash = $2",
      [userId, tokenHash]
    );

    if (taskRes.rows.length === 0) {
      // Task not found — either already claimed, wrong token, or never started
      res.status(400).json({ success: false, reward: "none", message: "Task not found" });
      return;
    }

    const task = taskRes.rows[0];
    const now = new Date();
    const started = new Date(task.started_at);
    const elapsed = (now.getTime() - started.getTime()) / 1000;

    // SERVER-SIDE time guard — even if the client skips the countdown, this blocks the reward.
    // The client anti-cheat (tab-pause + popup-close detection) adds a second layer of defense.
    if (elapsed < REQUIRED_WATCH_SECONDS) {
      res.status(400).json({
        success: false,
        reward: "none",
        message: `Wait ${Math.ceil(REQUIRED_WATCH_SECONDS - elapsed)} more seconds`,
      });
      return;
    }

    // ── Apply reward based on task type ────────────────────────────────────
    const taskType = task.task_type as string;
    let reward = "";
    let message = "";

    if (taskType === "drill_boost") {
      // ── Overcharge Drill — apply 1.5× rate boost for 30 minutes ─────────────
      // Check and reset the daily counter if needed
      const minerRes = await pool.query(
        "SELECT drill_boost_today, drill_boost_reset FROM miners WHERE user_id = $1",
        [userId]
      );
      const miner = minerRes.rows[0];
      const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
      const lastReset = miner?.drill_boost_reset
        ? String(miner.drill_boost_reset).slice(0, 10)
        : null;
      const boostToday = lastReset === today ? (parseInt(miner?.drill_boost_today) || 0) : 0;

      if (boostToday >= DRILL_BOOST_MAX_PER_DAY) {
        res.status(400).json({
          success: false,
          reward: "none",
          message: `Daily limit reached (${DRILL_BOOST_MAX_PER_DAY} overcharges/day). Come back tomorrow!`,
        });
        return;
      }

      // Apply the boost: sets drill_boost_until 30 minutes in the future
      const boostUntil = new Date(Date.now() + DRILL_BOOST_DURATION_MS);
      await pool.query(
        `UPDATE miners
         SET drill_boost_until  = $2,
             drill_boost_today  = $3,
             drill_boost_reset  = $4
         WHERE user_id = $1`,
        [userId, boostUntil, boostToday + 1, today]
      );
      // Small gem bonus for watching the ad
      await pool.query(
        "UPDATE wallets SET gems = gems + 5, window_points = window_points + 50 WHERE user_id = $1",
        [userId]
      );
      reward  = "drill_boost";
      message = `Drill overcharged! +50% rate for 30 min. +5 💎 (${boostToday + 1}/${DRILL_BOOST_MAX_PER_DAY} today)`;
      void DRILL_BOOST_MULTIPLIER; // used via import, silences linter

    } else if (taskType === "cool_down") {
      // Emergency cooling: reset miner temperature so it can run again immediately
      await pool.query(
        "UPDATE miners SET temperature = 0, is_running = true WHERE user_id = $1",
        [userId]
      );
      reward  = "cool_down";
      message = "Server cooled down! Temperature reset to 0";

    } else if (taskType === "gem_reward") {
      // Dedicated "Watch Ad for Gems" reward: +50 gems, +25 leaderboard window points
      await pool.query(
        "UPDATE wallets SET gems = gems + 50, window_points = window_points + 25 WHERE user_id = $1",
        [userId]
      );
      reward  = "gem_reward";
      message = "+50 Gems credited to your wallet!";
    }

    // Delete the task row so the token cannot be reused (one-time claim)
    await pool.query("DELETE FROM active_tasks WHERE user_id = $1", [userId]);

    res.json({ success: true, reward, message });

  } catch (err) {
    req.log.error({ err }, "Verify task error");
    res.status(500).json({ error: "Verification failed" });
  }
});

export default router;
