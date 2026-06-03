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
  HEAT_PER_RIG_PER_HOUR,
  HEAT_PER_BATTERY_PER_HOUR,
  HEAT_PER_GENERATOR_PER_HOUR,
  FAN_COOLING_PER_HOUR,
  MIN_HEAT_PER_HOUR,
  MAX_TEMP,
  MAX_FUEL,
  MAX_BATTERY_CHARGE,
  FUEL_DRAIN_RATE,
  BATTERY_CHARGE_RATE,
  BATTERY_DRAIN_RATE,
  DRILL_BOOST_RATE_BONUS,
  DRILL_BOOST_MAX_PER_DAY,
  getDayFactor,
} from "../lib/game-constants";

const router: IRouter = Router();

// Rate scales with active (powered) rig count; clamped to tier 9.
function minerRate(activeRigs: number): number {
  return MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;
}

// ─── Format DB row → API response shape ──────────────────────────────────────
// Power sources — each has strict day/night/fuel rules:
//   Solar panels  → power only when dayFactor > 0.15 (daytime); also charge batteries
//   Batteries     → store solar energy; discharge to power rigs at night only
//   Generators    → always-on diesel power while fuel > 0
// formatMiner mirrors the same power logic as the tick so the dashboard is never wrong.
function formatMiner(m: Record<string, unknown>) {
  const rigCount      = parseInt(m.level          as string) || 0;
  const fanCount      = parseInt(m.fans           as string) || 0;
  const solarPanels   = parseInt(m.solar_panels   as string) || 0;
  const batteries     = parseInt(m.batteries      as string) || 0;
  const batteryCharge = parseInt(m.battery_charge as string) || 0;
  const generators    = parseInt(m.generators     as string) || 0;
  const fuelLevel     = parseInt(m.fuel           as string) || 0;

  // ── Power supply — must mirror tick logic exactly ────────────────────────
  // BUG FIX: the old code used solarPanels+batteries+generators unconditionally,
  // so the dashboard showed solar panels providing power even at night. Now we
  // apply the same day/night + fuel checks that the tick uses.
  const dayFactor        = getDayFactor(Date.now());
  const solarActive      = solarPanels   > 0 && dayFactor > 0.15;
  const batteryActive    = batteries     > 0 && batteryCharge > 0 && !solarActive;
  const generatorActive  = generators    > 0 && fuelLevel > 0;

  const solarPower       = solarActive     ? solarPanels   : 0;
  const batteryPower     = batteryActive   ? batteries     : 0;
  const generatorPower   = generatorActive ? generators    : 0;
  const powerSupply      = solarPower + batteryPower + generatorPower;
  const activeRigs       = Math.min(rigCount, powerSupply);

  const nextUpgradeCost   = MINER_UPGRADE_COSTS[rigCount] ?? null;
  const nextUpgradePoints = UPGRADE_POINTS_REQUIRED[rigCount] ?? null;

  // ── Drill boost state ──────────────────────────────────────────────────────
  const drillBoostUntil = m.drill_boost_until
    ? new Date(m.drill_boost_until as string)
    : null;
  const now              = new Date();
  const isDrillBoosted   = drillBoostUntil !== null && drillBoostUntil > now;
  const boostRateBonus   = isDrillBoosted ? DRILL_BOOST_RATE_BONUS : 0;
  const drillBoostToday  = parseInt(m.drill_boost_today as string) || 0;

  // ── Per-appliance heat production ─────────────────────────────────────────
  // Heat is produced by each running appliance independently.
  // Fans SLOW DOWN the rate but never eliminate it — overheat is inevitable.
  // Only count generator heat when it actually has fuel (otherwise it's off).
  const heatFromRigs       = activeRigs  * HEAT_PER_RIG_PER_HOUR;
  const heatFromBatteries  = batteries   * HEAT_PER_BATTERY_PER_HOUR;          // batteries always warm
  const heatFromGenerators = generatorActive ? generators * HEAT_PER_GENERATOR_PER_HOUR : 0;
  const rawHeatPerHour     = heatFromRigs + heatFromBatteries + heatFromGenerators;
  const coolingPerHour     = fanCount * FAN_COOLING_PER_HOUR;
  // MIN_HEAT_PER_HOUR is the floor — heat can never be reduced to 0
  const netHeatPerHour     = Math.max(MIN_HEAT_PER_HOUR, rawHeatPerHour - coolingPerHour);

  return {
    userId: m.user_id,
    level:        rigCount,
    rigCount,
    fanCount,
    solarPanels,
    batteries,
    batteryCharge,
    generators,
    fuel: fuelLevel,
    powerSupply,
    powerDemand: rigCount,
    activeRigs,
    // Per-source power breakdown for dashboard display
    solarPower,
    batteryPower,
    generatorPower,
    solarActive,
    batteryActive,
    generatorActive,
    unlocked: m.unlocked,
    currentBalance: parseFloat(m.current_balance as string),
    temperature: parseFloat(m.temperature as string),
    isRunning: m.is_running,
    lastMaintenanceAt: (m.last_maintenance_at as Date).toISOString(),
    lastTickAt: (m.last_tick_at as Date).toISOString(),
    ratePerSecond: minerRate(activeRigs) + boostRateBonus,
    nextUpgradeCost,
    nextUpgradePoints,
    isDrillBoosted,
    drillBoostUntil: drillBoostUntil?.toISOString() ?? null,
    drillBoostToday,
    drillBoostMaxPerDay: DRILL_BOOST_MAX_PER_DAY,
    // Per-appliance heat breakdown — shown on dashboard so players understand their temps
    heatFromRigs,
    heatFromBatteries,
    heatFromGenerators,
    rawHeatPerHour,
    coolingPerHour,
    netHeatPerHour,
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
    const now    = new Date();
    const lastTick = new Date(m.last_tick_at);
    const elapsedSeconds = (now.getTime() - lastTick.getTime()) / 1000;

    const rigCount      = parseInt(m.level)          || 0;
    const fans          = parseInt(m.fans)            || 0;
    const temp          = parseFloat(m.temperature);
    const solarPanels   = parseInt(m.solar_panels)    || 0;
    const batteries     = parseInt(m.batteries)       || 0;
    const generators    = parseInt(m.generators)      || 0;
    let batteryCharge   = parseInt(m.battery_charge)  || 0;
    let fuelLevel       = parseInt(m.fuel)            || 0;

    // ── Solar availability ──────────────────────────────────────────────────
    const dayFactor   = getDayFactor(Date.now());
    const solarActive = solarPanels > 0 && dayFactor > 0.15;

    // ── Battery: charge from solar during day ───────────────────────────────
    if (solarActive && solarPanels > 0 && elapsedSeconds > 0) {
      batteryCharge = Math.min(
        MAX_BATTERY_CHARGE,
        batteryCharge + solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds
      );
    }
    // Battery discharge: provides power at night when solar is off
    const batteryActive = batteries > 0 && batteryCharge > 0 && !solarActive;
    if (batteryActive && elapsedSeconds > 0) {
      batteryCharge = Math.max(
        0,
        batteryCharge - batteries * BATTERY_DRAIN_RATE * elapsedSeconds
      );
    }

    // ── Generator: always drains diesel ────────────────────────────────────
    if (generators > 0 && elapsedSeconds > 0) {
      fuelLevel = Math.max(0, fuelLevel - generators * FUEL_DRAIN_RATE * elapsedSeconds);
    }
    const generatorActive = generators > 0 && fuelLevel > 0;

    // ── Power supply ────────────────────────────────────────────────────────
    const powerSupply = (solarActive ? solarPanels : 0)
                      + (batteryActive ? batteries : 0)
                      + (generatorActive ? generators : 0);
    const hasPower   = powerSupply > 0;
    const activeRigs = Math.min(rigCount, powerSupply);

    const isRunning = m.is_running && temp < MAX_TEMP && hasPower && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;

    // ── Drill boost — additive +0.50 TH rate bonus ──────────────────────────
    // If drill_boost_until is in the future, add DRILL_BOOST_RATE_BONUS to the
    // per-second rate (additive, NOT a percentage multiplier).
    // When the boost expires mid-tick the full bonus still applies for that tick.
    const drillBoostUntilTick = m.drill_boost_until
      ? new Date(m.drill_boost_until as string)
      : null;
    const isDrillBoosted  = drillBoostUntilTick !== null && drillBoostUntilTick > now;
    const boostRateBonus  = isDrillBoosted ? DRILL_BOOST_RATE_BONUS : 0;

    if (isRunning && elapsedSeconds > 0) {
      newBalance += (minerRate(activeRigs) + boostRateBonus) * elapsedSeconds;

      // ── Per-appliance heat — mirrors formatMiner logic exactly ──────────────
      // Heat is produced by each running appliance; fans slow it but never stop it.
      const heatFromRigs       = activeRigs                           * HEAT_PER_RIG_PER_HOUR;
      const heatFromBatteries  = batteries                            * HEAT_PER_BATTERY_PER_HOUR;
      const heatFromGenerators = generatorActive ? generators         * HEAT_PER_GENERATOR_PER_HOUR : 0;
      const rawHeat            = heatFromRigs + heatFromBatteries + heatFromGenerators;
      // Fans reduce the rate; MIN_HEAT_PER_HOUR is the floor (overheat is always inevitable)
      const effectiveTempRise  = Math.max(MIN_HEAT_PER_HOUR, rawHeat - fans * FAN_COOLING_PER_HOUR);
      newTemp = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * elapsedSeconds);
    }

    // Re-evaluate power with final charge/fuel to catch a just-emptied tank
    const finalBatteryActive   = batteries  > 0 && batteryCharge > 0 && !solarActive;
    const finalGeneratorActive = generators > 0 && fuelLevel > 0;
    const stillHasPower  = solarActive || finalBatteryActive || finalGeneratorActive;
    const stillRunning   = newTemp < MAX_TEMP && stillHasPower && rigCount > 0;

    await client.query(
      `UPDATE miners
       SET current_balance=$1, temperature=$2, is_running=$3,
           last_tick_at=$4, battery_charge=$5, fuel=$6
       WHERE user_id=$7`,
      [
        newBalance.toFixed(10),
        newTemp.toFixed(2),
        stillRunning,
        now,
        Math.round(batteryCharge),
        Math.round(fuelLevel),
        userId,
      ]
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
    const m     = minerRes.rows[0];
    const level = parseInt(m.level);

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
    const wallet    = walletRes.rows[0];

    if (parseInt(wallet.gems) < cost) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: `You need ${cost} gems to enhance this tier.` });
      return;
    }

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

    await client.query(
      "UPDATE wallets SET real_balance = real_balance + $1 WHERE user_id=$2",
      [balance.toFixed(10), userId]
    );
    await client.query("UPDATE miners SET current_balance = 0 WHERE user_id=$1", [userId]);

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
