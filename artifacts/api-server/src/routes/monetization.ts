import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "../lib/db-pool";
import {
  RequestMonetizationTaskHeader,
  RequestMonetizationTaskBody,
  VerifyMonetizationTaskHeader,
  VerifyMonetizationTaskBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

const AD_URL = "https://example.com/ad"; // Simulated ad URL

router.post("/monetization/request-task", async (req, res) => {
  const headerParsed = RequestMonetizationTaskHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const bodyParsed = RequestMonetizationTaskBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { type } = bodyParsed.data;

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + 20 * 1000); // 20s buffer

  try {
    await pool.query(
      `INSERT INTO active_tasks (user_id, task_type, started_at, expires_at, token_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET task_type = $2, started_at = $3, expires_at = $4, token_hash = $5`,
      [userId, type, startedAt, expiresAt, tokenHash]
    );

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

router.post("/monetization/verify-task", async (req, res) => {
  const headerParsed = VerifyMonetizationTaskHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const bodyParsed = VerifyMonetizationTaskBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { token } = bodyParsed.data;

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const taskRes = await pool.query(
      "SELECT * FROM active_tasks WHERE user_id = $1 AND token_hash = $2",
      [userId, tokenHash]
    );

    if (taskRes.rows.length === 0) {
      res.status(400).json({ success: false, reward: "none", message: "Task not found" });
      return;
    }

    const task = taskRes.rows[0];
    const now = new Date();
    const started = new Date(task.started_at);
    const elapsed = (now.getTime() - started.getTime()) / 1000;

    if (elapsed < 15) {
      res.status(400).json({
        success: false,
        reward: "none",
        message: `Wait ${Math.ceil(15 - elapsed)} more seconds`,
      });
      return;
    }

    // Apply reward based on task type
    const taskType = task.task_type;
    let reward = "";

    if (taskType === "drill_boost") {
      // Add 10 gems bonus + 50 window points
      await pool.query(
        "UPDATE wallets SET gems = gems + 10, window_points = window_points + 50 WHERE user_id = $1",
        [userId]
      );
      reward = "drill_boost";
    } else if (taskType === "cool_down") {
      // Reset miner temperature
      await pool.query(
        "UPDATE miners SET temperature = 0, is_running = true WHERE user_id = $1",
        [userId]
      );
      reward = "cool_down";
    }

    // Remove task
    await pool.query("DELETE FROM active_tasks WHERE user_id = $1", [userId]);

    res.json({
      success: true,
      reward,
      message: taskType === "drill_boost"
        ? "Drill overcharged! +10 gems, +50 points"
        : "Server cooled down! Temperature reset to 0",
    });
  } catch (err) {
    req.log.error({ err }, "Verify task error");
    res.status(500).json({ error: "Verification failed" });
  }
});

export default router;
