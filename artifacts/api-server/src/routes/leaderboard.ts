import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";

const router: IRouter = Router();

// Shared pool state (persisted in memory, reset every 3 hours)
let simulatedAdPool = 5.50;
let lastCycleTime = Date.now();
const CYCLE_MS = 3 * 60 * 60 * 1000;

export function getPoolState() {
  return { simulatedAdPool, lastCycleTime, CYCLE_MS };
}

export async function executeRevenuePoolPayout() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const totals = await client.query("SELECT SUM(window_points) as total FROM wallets");
    const totalPoints = parseFloat(totals.rows[0].total || "0");

    if (totalPoints > 0) {
      const netPool = simulatedAdPool * 0.70;
      const wallets = await client.query("SELECT user_id, window_points FROM wallets WHERE window_points > 0");
      for (const row of wallets.rows) {
        const share = (parseFloat(row.window_points) / totalPoints) * netPool;
        await client.query(
          "UPDATE wallets SET real_balance = real_balance + $1 WHERE user_id = $2",
          [share.toFixed(8), row.user_id]
        );
      }
    }

    await client.query("UPDATE wallets SET window_points = 0, action_count = 0");
    await client.query("COMMIT");

    simulatedAdPool = parseFloat((3.0 + Math.random() * 7.0).toFixed(2));
    lastCycleTime = Date.now();
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Start payout cycle
setInterval(() => {
  executeRevenuePoolPayout().catch(console.error);
}, CYCLE_MS);

router.get("/leaderboard", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.username, w.gems, w.window_points, w.real_balance, m.level as miner_level,
             ROW_NUMBER() OVER (ORDER BY w.gems DESC) as rank
      FROM users u
      JOIN wallets w ON u.id = w.user_id
      JOIN miners m ON u.id = m.user_id
      ORDER BY w.gems DESC
      LIMIT 20
    `);
    const entries = result.rows.map((r: { rank: string; username: string; gems: string; window_points: string; miner_level: string; real_balance: string }) => ({
      rank: parseInt(r.rank),
      username: r.username,
      gems: parseInt(r.gems),
      windowPoints: parseFloat(r.window_points),
      minerLevel: parseInt(r.miner_level),
      realBalance: parseFloat(r.real_balance),
    }));
    res.json(entries);
  } catch (err) {
    req.log.error({ err }, "Leaderboard error");
    res.status(500).json({ error: "Leaderboard error" });
  }
});

router.get("/pool-status", async (req, res) => {
  try {
    const totals = await pool.query("SELECT SUM(window_points) as total FROM wallets");
    const totalWindowPoints = parseFloat(totals.rows[0].total || "0");
    const nextPayoutIn = Math.max(0, Math.floor((lastCycleTime + CYCLE_MS - Date.now()) / 1000));

    res.json({
      currentPool: simulatedAdPool,
      nextPayoutIn,
      houseCut: 0.30,
      userCut: 0.70,
      totalWindowPoints,
    });
  } catch (err) {
    req.log.error({ err }, "Pool status error");
    res.status(500).json({ error: "Pool status error" });
  }
});

export default router;
