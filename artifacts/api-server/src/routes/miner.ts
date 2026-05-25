import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import {
  GetMinerHeader,
  MinerTickHeader,
  UpgradeMinerHeader,
  MaintainMinerHeader,
  MaintainMinerBody,
} from "@workspace/api-zod";
import {
  MINER_RATES,
  MINER_UPGRADE_COSTS,
  TEMP_RISE_PER_HOUR,
  MAX_TEMP,
} from "../lib/game-constants";

const router: IRouter = Router();

function minerRate(level: number): number {
  return MINER_RATES[level] ?? MINER_RATES[10];
}

function formatMiner(m: Record<string, unknown>) {
  const level = parseInt(m.level as string);
  return {
    userId: m.user_id,
    level,
    unlocked: m.unlocked,
    currentBalance: parseFloat(m.current_balance as string),
    temperature: parseFloat(m.temperature as string),
    isRunning: m.is_running,
    solarPanels: m.solar_panels,
    generators: m.generators,
    fuel: m.fuel,
    lastMaintenanceAt: (m.last_maintenance_at as Date).toISOString(),
    lastTickAt: (m.last_tick_at as Date).toISOString(),
    ratePerSecond: minerRate(level),
  };
}

router.get("/miner", async (req, res) => {
  const parsed = GetMinerHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  try {
    const result = await pool.query("SELECT * FROM miners WHERE user_id = $1", [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Miner not found" });
      return;
    }
    res.json(formatMiner(result.rows[0]));
  } catch (err) {
    req.log.error({ err }, "Get miner error");
    res.status(500).json({ error: "Miner error" });
  }
});

router.post("/miner/tick", async (req, res) => {
  const parsed = MinerTickHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM miners WHERE user_id = $1 FOR UPDATE", [userId]);
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Miner not found" });
      return;
    }
    const m = result.rows[0];
    const now = new Date();
    const lastTick = new Date(m.last_tick_at);
    const elapsedSeconds = (now.getTime() - lastTick.getTime()) / 1000;

    const level = parseInt(m.level);
    const temp = parseFloat(m.temperature);
    // A rig needs at least one solar panel OR generator to produce any income.
    // Without power it sits idle regardless of is_running flag.
    const hasPower = parseInt(m.solar_panels) > 0 || parseInt(m.generators) > 0;
    const isRunning = m.is_running && temp < MAX_TEMP && hasPower;

    let newBalance = parseFloat(m.current_balance);
    let newTemp = temp;

    if (isRunning && elapsedSeconds > 0) {
      const rate = minerRate(level);
      newBalance += rate * elapsedSeconds;
      // Temperature rises proportional to uptime
      newTemp = Math.min(MAX_TEMP, temp + (TEMP_RISE_PER_HOUR / 3600) * elapsedSeconds);
    }

    // Rig shuts down when overheated OR when it has no power source
    const stillRunning = newTemp < MAX_TEMP && hasPower;

    await client.query(
      "UPDATE miners SET current_balance = $1, temperature = $2, is_running = $3, last_tick_at = $4 WHERE user_id = $5",
      [newBalance.toFixed(10), newTemp.toFixed(2), stillRunning, now, userId]
    );

    await client.query("COMMIT");

    const updated = await pool.query("SELECT * FROM miners WHERE user_id = $1", [userId]);
    res.json(formatMiner(updated.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Miner tick error");
    res.status(500).json({ error: "Tick failed" });
  } finally {
    client.release();
  }
});

router.post("/miner/upgrade", async (req, res) => {
  const parsed = UpgradeMinerHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const minerRes = await client.query("SELECT * FROM miners WHERE user_id = $1 FOR UPDATE", [userId]);
    if (minerRes.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Miner not found" });
      return;
    }
    const m = minerRes.rows[0];
    const level = parseInt(m.level);

    if (level >= 10) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Max level reached" });
      return;
    }

    const cost = MINER_UPGRADE_COSTS[level];
    const walletRes = await client.query("SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE", [userId]);
    const wallet = walletRes.rows[0];

    if (parseInt(wallet.gems) < cost) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Need ${cost} gems to upgrade` });
      return;
    }

    await client.query("UPDATE wallets SET gems = gems - $1 WHERE user_id = $2", [cost, userId]);
    await client.query("UPDATE miners SET level = level + 1, unlocked = true WHERE user_id = $1", [userId]);

    await client.query("COMMIT");

    const updated = await pool.query("SELECT * FROM miners WHERE user_id = $1", [userId]);
    res.json(formatMiner(updated.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Upgrade miner error");
    res.status(500).json({ error: "Upgrade failed" });
  } finally {
    client.release();
  }
});

router.post("/miner/maintain", async (req, res) => {
  const headerParsed = MaintainMinerHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const bodyParsed = MaintainMinerBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { type } = bodyParsed.data;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Check if user has the required item
    const itemId = type === "flush_cooling" ? "water_bucket" : "thermal_paste";
    const invRes = await client.query(
      "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2",
      [userId, itemId]
    );

    if (invRes.rows.length === 0 || parseInt(invRes.rows[0].quantity) < 1) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `Need a ${itemId} to perform this maintenance` });
      return;
    }

    // Consume item
    await client.query(
      "UPDATE inventories SET quantity = quantity - 1 WHERE user_id = $1 AND item_id = $2",
      [userId, itemId]
    );

    const now = new Date();
    await client.query(
      "UPDATE miners SET temperature = 0, is_running = true, last_maintenance_at = $1 WHERE user_id = $2",
      [now, userId]
    );

    await client.query("COMMIT");
    const updated = await pool.query("SELECT * FROM miners WHERE user_id = $1", [userId]);
    res.json(formatMiner(updated.rows[0]));
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Maintain miner error");
    res.status(500).json({ error: "Maintenance failed" });
  } finally {
    client.release();
  }
});

export default router;
