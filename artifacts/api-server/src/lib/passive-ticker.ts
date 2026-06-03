// ============================================================
// passive-ticker.ts — Server-side background job for offline passive income
//
// Runs every 60 seconds and ticks ALL active (unlocked) miners,
// so players earn passive income even when they are not in the game.
//
// Power source model (batteries and generators are separate systems):
//   • solar_panel_block — daytime-only power (dayFactor > 0.15)
//   • battery_block     — stores solar energy in battery_charge pool;
//                         discharges at night at BATTERY_DRAIN_RATE/block
//   • generator_block   — diesel-powered; always on while fuel > 0;
//                         drains fuel at FUEL_DRAIN_RATE/block continuously
//
// Tick logic:
//   • Balance  += minerRate(activeRigs) × elapsed (only while running)
//   • Temp     += max(MIN_HEAT, rigHeat + battHeat + genHeat − fans×FAN_COOLING) / 3600 × elapsed
//   • Heat is per-appliance: rigs 20°C/hr, batteries 8°C/hr, generators 30°C/hr
//   • Fans slow heat (−15°C/hr each) but can never eliminate it (floor = 5°C/hr)
//   • battery_charge charged by solar during day; drained at night by batteries
//   • fuel (diesel) drained by generators continuously
//   • is_running updated based on temp < MAX_TEMP AND hasPower AND rigCount > 0
//   • activeRigs = min(rigCount, powerSupply) — rate scales with powered rigs
// ============================================================

import { pool } from "./db-pool";
import {
  MINER_RATES,
  HEAT_PER_RIG_PER_HOUR,
  HEAT_PER_BATTERY_PER_HOUR,
  HEAT_PER_GENERATOR_PER_HOUR,
  FAN_COOLING_PER_HOUR,
  MIN_HEAT_PER_HOUR,
  MAX_TEMP,
  MAX_BATTERY_CHARGE,
  MAX_FUEL,
  FUEL_DRAIN_RATE,
  BATTERY_CHARGE_RATE,
  BATTERY_DRAIN_RATE,
  getDayFactor,
} from "./game-constants";

function minerRate(activeRigs: number): number {
  return MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;
}

async function tickMiner(userId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM miners WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const m              = result.rows[0];
    const now            = new Date();
    const lastTick       = new Date(m.last_tick_at);
    const elapsedSeconds = (now.getTime() - lastTick.getTime()) / 1000;
    // Skip if ticked very recently — prevents double-counting
    if (elapsedSeconds < 30) {
      await client.query("ROLLBACK");
      return false;
    }

    const rigCount     = parseInt(m.level)          || 0;
    const fans         = parseInt(m.fans)            || 0;
    const temp         = parseFloat(m.temperature);
    const solarPanels  = parseInt(m.solar_panels)    || 0;
    const batteries    = parseInt(m.batteries)       || 0;  // battery_block count
    const generators   = parseInt(m.generators)      || 0;  // generator_block count
    const batteryCharge = parseInt(m.battery_charge) || 0;  // stored solar energy
    const fuel          = parseInt(m.fuel)           || 0;  // diesel level
    let newBatteryCharge = batteryCharge;
    let newFuel          = fuel;

    // ── Solar availability ────────────────────────────────────────────────────
    const dayFactor   = getDayFactor(now.getTime());
    const solarActive = solarPanels > 0 && dayFactor > 0.15;

    // ── Battery: charge from solar during day; discharge at night ─────────────
    if (solarActive && solarPanels > 0 && elapsedSeconds > 0) {
      newBatteryCharge = Math.min(
        MAX_BATTERY_CHARGE,
        newBatteryCharge + solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds
      );
    }
    // Batteries discharge only when solar is insufficient and batteries are present
    const batteryActive = batteries > 0 && newBatteryCharge > 0 && !solarActive;
    if (batteryActive && elapsedSeconds > 0) {
      newBatteryCharge = Math.max(
        0,
        newBatteryCharge - batteries * BATTERY_DRAIN_RATE * elapsedSeconds
      );
    }

    // ── Generator: always drains diesel when generators are present ───────────
    if (generators > 0 && elapsedSeconds > 0) {
      newFuel = Math.max(0, newFuel - generators * FUEL_DRAIN_RATE * elapsedSeconds);
    }
    const generatorActive = generators > 0 && newFuel > 0;

    // ── Power supply: solar + active batteries + active generators ────────────
    const solarPower     = solarActive     ? solarPanels : 0;
    const batteryPower   = batteryActive   ? batteries   : 0;
    const generatorPower = generatorActive ? generators  : 0;
    const powerSupply    = solarPower + batteryPower + generatorPower;
    const hasPower       = powerSupply > 0;
    const activeRigs     = Math.min(rigCount, powerSupply);

    const isRunning = m.is_running && temp < MAX_TEMP && hasPower && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;

    if (isRunning && elapsedSeconds > 0) {
      newBalance += minerRate(activeRigs) * elapsedSeconds;
      // Per-appliance heat: mirrors miner.ts tick and formatMiner exactly
      const heatFromRigs       = activeRigs                           * HEAT_PER_RIG_PER_HOUR;
      const heatFromBatteries  = batteries                            * HEAT_PER_BATTERY_PER_HOUR;
      const heatFromGenerators = generatorActive ? generators         * HEAT_PER_GENERATOR_PER_HOUR : 0;
      const rawHeat            = heatFromRigs + heatFromBatteries + heatFromGenerators;
      // Fans slow heat rise but can never fully stop it (MIN_HEAT_PER_HOUR floor)
      const effectiveTempRise  = Math.max(MIN_HEAT_PER_HOUR, rawHeat - fans * FAN_COOLING_PER_HOUR);
      newTemp = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * elapsedSeconds);
    }

    // Re-check running state with final fuel/charge values
    const finalBatteryActive   = batteries  > 0 && newBatteryCharge > 0 && !solarActive;
    const finalGeneratorActive = generators > 0 && newFuel > 0;
    const stillHasPower = solarActive || finalBatteryActive || finalGeneratorActive;
    const stillRunning  = newTemp < MAX_TEMP && stillHasPower && rigCount > 0;

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
        Math.round(newBatteryCharge),
        Math.round(newFuel),
        userId,
      ]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[passive-ticker] Failed to tick miner for user ${userId}:`, err);
    return false;
  } finally {
    client.release();
  }
}

async function tickAllMiners(): Promise<void> {
  try {
    const result = await pool.query(
      "SELECT user_id FROM miners WHERE unlocked = true"
    );
    const userIds: number[] = result.rows.map((r: { user_id: number }) => r.user_id);
    if (userIds.length === 0) return;
    console.log(`[passive-ticker] Ticking ${userIds.length} miner(s)…`);
    let updated = 0;
    for (const userId of userIds) {
      const ok = await tickMiner(userId);
      if (ok) updated++;
    }
    console.log(`[passive-ticker] Done — ${updated}/${userIds.length} updated.`);
  } catch (err) {
    console.error("[passive-ticker] Error fetching miners:", err);
  }
}

export function startPassiveTicker(): void {
  console.log("[passive-ticker] Starting offline passive income ticker (60s interval)…");
  tickAllMiners().catch(console.error);
  setInterval(() => { tickAllMiners().catch(console.error); }, 60_000);
}
