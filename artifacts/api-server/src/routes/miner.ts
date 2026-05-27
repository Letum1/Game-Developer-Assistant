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
  UPGRADE_POINTS_REQUIRED,
  TEMP_RISE_PER_HOUR,
  FAN_COOLING_PER_HOUR,
  MAX_TEMP,
  MAX_FUEL,
  FUEL_DRAIN_RATE,
  BATTERY_CHARGE_RATE,
  getDayFactor,
} from "../lib/game-constants";

const router: IRouter = Router();

// Rate is based on ACTIVE rigs (those with power), not total rig count.
// Clamped to ceiling tier 9.
function minerRate(activeRigs: number): number {
  return MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;
}

// Formats raw DB row into the API response shape.
// Key new fields:
//   level / rigCount  — total mining_rig blocks placed (compute hardware)
//   activeRigs        — rigs actually running (limited by power supply)
//   powerSupply       — max power units available (solar+always-on, ignores day/night here)
//   powerDemand       — power units needed = rigCount
//   fanCount          — cooling fan blocks connected (reduce temp rise)
function formatMiner(m: Record<string, unknown>) {
  const rigCount    = parseInt(m.level as string) || 0;  // level = total mining_rig blocks
  const fanCount    = parseInt(m.fans  as string) || 0;
  const solarPanels = parseInt(m.solar_panels as string) || 0;
  const generators  = parseInt(m.generators   as string) || 0;
  // Max possible power supply (day + always-on combined) — actual supply is
  // day/night-adjusted in the tick, but show full capacity here for the UI.
  const powerSupply  = solarPanels + generators;
  const activeRigs   = Math.min(rigCount, powerSupply);  // rough estimate for display
  const nextUpgradeCost   = MINER_UPGRADE_COSTS[rigCount] ?? null;
  const nextUpgradePoints = UPGRADE_POINTS_REQUIRED[rigCount] ?? null;
  return {
    userId: m.user_id,
    level:        rigCount,    // kept for API compat; semantically = total rig count
    rigCount,                  // total mining_rig blocks placed
    fanCount,                  // cooling fan blocks
    solarPanels,
    generators,
    powerSupply,               // max power units (solar + always-on)
    powerDemand:  rigCount,    // power units needed to run all rigs
    activeRigs,                // rigs that are powered (capped by supply)
    unlocked: m.unlocked,
    currentBalance: parseFloat(m.current_balance as string),
    temperature: parseFloat(m.temperature as string),
    isRunning: m.is_running,
    fuel: m.fuel,
    lastMaintenanceAt: (m.last_maintenance_at as Date).toISOString(),
    lastTickAt: (m.last_tick_at as Date).toISOString(),
    ratePerSecond: minerRate(activeRigs),   // rate depends on powered rigs
    nextUpgradeCost,
    nextUpgradePoints,
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

    // level column now stores total mining_rig block count (rigCount).
    // fans column stores fan_block count connected to the cluster.
    const rigCount    = parseInt(m.level) || 0;   // total mining_rig blocks placed
    const fans        = parseInt(m.fans)  || 0;   // fan_block count (cooling)
    const temp        = parseFloat(m.temperature);
    const solarPanels = parseInt(m.solar_panels) || 0;
    const generators  = parseInt(m.generators)   || 0;

    // Solar panels only generate power during the day (dayFactor > 0.15).
    // Batteries and generators (stored in the `generators` column) are always-on.
    // A rig with ONLY solar panels goes offline at night — no stored energy.
    const dayFactor    = getDayFactor(Date.now());
    const solarActive  = solarPanels > 0 && dayFactor > 0.15; // sun is up enough
    const alwaysOn     = generators > 0 && fuel > 0;          // battery/generator needs stored energy
    const hasPower     = solarActive || alwaysOn;

    // Active rigs = min(rigCount, power supply). Power supply = powered solar + always-on.
    // Excess rigs beyond power supply are idle (not counted for rate).
    const powerSupply = (solarActive ? solarPanels : 0) + (alwaysOn ? generators : 0);
    const activeRigs  = Math.min(rigCount, powerSupply);

    // Rig requires at least one mining_rig block AND power to generate income.
    const isRunning = m.is_running && temp < MAX_TEMP && hasPower && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;
    const fuel     = parseInt(m.fuel) || 0;
    let   newFuel  = fuel;

    if (isRunning && elapsedSeconds > 0) {
      const rate = minerRate(activeRigs);   // rate scales with powered rig count
      newBalance += rate * elapsedSeconds;
      // Temperature rise is reduced by fan_block count.
      // Each fan lowers hourly rise by FAN_COOLING_PER_HOUR (default 2.5°C/hr).
      // 4 fans = zero temperature rise at base load.
      const effectiveTempRise = Math.max(0, TEMP_RISE_PER_HOUR - fans * FAN_COOLING_PER_HOUR);
      newTemp = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * elapsedSeconds);
    }

    // ── Fuel drain: always-on sources (batteries + generators) burn fuel ──
    // Each source unit drains FUEL_DRAIN_RATE units/sec while the rig has power.
    if (generators > 0 && elapsedSeconds > 0) {
      const drained = generators * FUEL_DRAIN_RATE * elapsedSeconds;
      newFuel = Math.max(0, newFuel - drained);
    }

    // ── Battery recharge: solar panels top up fuel during daylight ────────
    // This lets battery blocks charge during the day so they can run at night.
    if (solarActive && solarPanels > 0 && elapsedSeconds > 0) {
      const charged = solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds;
      newFuel = Math.min(MAX_FUEL, newFuel + charged);
    }

    newFuel = Math.round(newFuel); // store as integer

    // Rig shuts down when overheated, has no power, or has no mining_rig hardware.
    // Re-evaluate hasPower with updated fuel so we catch a just-emptied tank.
    const nowDayFactor  = getDayFactor(Date.now());
    const nowSolar      = solarPanels > 0 && nowDayFactor > 0.15;
    const nowAlwaysOn   = generators > 0 && newFuel > 0;
    const stillRunning  = newTemp < MAX_TEMP && (nowSolar || nowAlwaysOn) && rigCount > 0;

    await client.query(
      "UPDATE miners SET current_balance=$1, temperature=$2, is_running=$3, last_tick_at=$4, fuel=$5 WHERE user_id=$6",
      [newBalance.toFixed(10), newTemp.toFixed(2), stillRunning, now, newFuel, userId]
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

    // Level 9 is the hidden platform ceiling — give a vague message
    if (level >= 9) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Your rig is already operating at peak efficiency." });
      return;
    }

    const cost = MINER_UPGRADE_COSTS[level];
    if (!cost) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Upgrade unavailable." });
      return;
    }

    const walletRes = await client.query("SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE", [userId]);
    const wallet = walletRes.rows[0];

    // ── Gem cost check ────────────────────────────────────────────────────────
    if (parseInt(wallet.gems) < cost) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `You need ${cost} gems to enhance this tier.` });
      return;
    }

    // ── Loyalty / activity check ──────────────────────────────────────────────
    // Players must have earned activity points by actively mining to unlock higher
    // tiers — prevents instant max-tier upgrades with gems alone.
    const pointsRequired = UPGRADE_POINTS_REQUIRED[level] ?? 0;
    const playerPoints   = parseFloat(wallet.window_points) || 0;
    if (playerPoints < pointsRequired) {
      await client.query("ROLLBACK");
      res.status(400).json({
        error: `Keep mining to unlock this tier. Activity progress: ${Math.floor(playerPoints)}/${pointsRequired} pts.`,
      });
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

// ─────────────────────────────────────────────────────────────────────────────
// POST /miner/collect — transfer accumulated miner balance to wallet.real_balance
// and reset current_balance to zero. Players "cash out" their passive earnings.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/miner/collect", async (req, res) => {
  const parsed = GetMinerHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const minerRes = await client.query(
      "SELECT current_balance FROM miners WHERE user_id=$1 FOR UPDATE", [userId]
    );
    if (!minerRes.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Miner not found" });
      return;
    }

    const balance = parseFloat(minerRes.rows[0].current_balance);
    if (balance <= 0) {
      await client.query("ROLLBACK");
      res.json({ success: false, collected: 0, error: "No balance to collect" });
      return;
    }

    // Move accumulated sats/USD earnings into the wallet's real_balance column
    await client.query(
      "UPDATE wallets SET real_balance = real_balance + $1 WHERE user_id=$2",
      [balance.toFixed(10), userId]
    );
    // Reset miner earnings counter to zero
    await client.query(
      "UPDATE miners SET current_balance = 0 WHERE user_id=$1", [userId]
    );

    await client.query("COMMIT");
    res.json({ success: true, collected: balance });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Collect miner balance error");
    res.status(500).json({ error: "Collect failed" });
  } finally {
    client.release();
  }
});

export default router;
