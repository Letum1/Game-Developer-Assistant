import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GetWalletHeader } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/wallet", async (req, res) => {
  const parsed = GetWalletHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  try {
    const result = await pool.query("SELECT * FROM wallets WHERE user_id = $1", [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }
    const w = result.rows[0];
    res.json({
      userId: w.user_id,
      gems: parseInt(w.gems),
      worldLocks: parseInt(w.world_locks),
      diamondLocks: parseInt(w.diamond_locks),
      realBalance: parseFloat(w.real_balance),
      windowPoints: parseFloat(w.window_points),
      actionCount: parseInt(w.action_count),
    });
  } catch (err) {
    req.log.error({ err }, "Get wallet error");
    res.status(500).json({ error: "Wallet error" });
  }
});

export default router;
