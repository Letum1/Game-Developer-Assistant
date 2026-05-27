// ============================================================
// passive-ticker.ts — Server-side background job for offline passive income
//
// Runs every 60 seconds and ticks ALL active (unlocked) miners,
// so players earn passive income even when they are not in the game.
//
// The logic mirrors the manual POST /api/miner/tick endpoint:
//   • Balance  += minerRate(activeRigs) × elapsed (only while running)
//   • Temp     += max(0, TEMP_RISE - fans × FAN_COOLING) / 3600 × elapsed
//   • Fuel     decreases for generator/battery blocks
//   • is_running updated based on temp < MAX_TEMP and hasPower and rigCount > 0
//   • activeRigs = min(rigCount, powerSupply) — rate scales with powered rigs
//
// This means:
//   • A player who logged out at 20°C comes back 12 h later
//     and finds their rig at exactly 100°C — stopped, waiting for maintenance.
//   • While the rig was running it earned balance into current_balance in the DB.
//   • Calling GET /api/miner returns the fully up-to-date persisted state.
// ============================================================

import { pool } from "./db-pool";
import {
  MINER_RATES,
  TEMP_RISE_PER_HOUR,
  FAN_COOLING_PER_HOUR,
  MAX_TEMP,
  MAX_FUEL,
  FUEL_DRAIN_RATE,
  BATTERY_CHARGE_RATE,
  getDayFactor,
} from "./game-constants";

// Rate is based on ACTIVE rigs (those with power), not total rig count.
function minerRate(activeRigs: number): number {
  return MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;
}

// ─── Tick a single miner row ──────────────────────────────────────────────────
// Returns true if the update was applied, false on error.
async function tickMiner(userId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the row to prevent race conditions with the manual tick endpoint
    const result = await client.query(
      "SELECT * FROM miners WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    const m             = result.rows[0];
    const now           = new Date();
    const lastTick      = new Date(m.last_tick_at);
    // Skip if ticked very recently (within 30 seconds) to avoid double-counting
    const elapsedSeconds = (now.getTime() - lastTick.getTime()) / 1000;
    if (elapsedSeconds < 30) {
      await client.query("ROLLBACK");
      return false;
    }

    // level column = total mining_rig blocks placed (rigCount)
    // fans  column = fan_block count (cooling)
    const rigCount    = parseInt(m.level) || 0;
    const fans        = parseInt(m.fans)  || 0;
    const temp        = parseFloat(m.temperature);
    const solarPanels = parseInt(m.solar_panels) || 0;
    const generators  = parseInt(m.generators)   || 0;

    // Determine power availability at the time of the tick
    const dayFactor   = getDayFactor(now.getTime());
    const solarActive = solarPanels > 0 && dayFactor > 0.15;
    const alwaysOn    = generators > 0 && fuel > 0;  // battery/generator needs stored energy
    const hasPower    = solarActive || alwaysOn;

    // Active rigs = powered rigs only — excess rigs beyond supply are idle.
    const powerSupply = (solarActive ? solarPanels : 0) + (alwaysOn ? generators : 0);
    const activeRigs  = Math.min(rigCount, powerSupply);

    // Requires rigCount > 0 (at least one mining_rig block placed)
    const isRunning   = m.is_running && temp < MAX_TEMP && hasPower && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;
    const fuel     = parseInt(m.fuel) || 0;
    let   newFuel  = fuel;

    if (isRunning && elapsedSeconds > 0) {
      const rate  = minerRate(activeRigs);  // rate scales with active rig count
      // Accumulate earnings into current_balance (stays in DB until player collects)
      newBalance += rate * elapsedSeconds;
      // Fan blocks reduce temperature rise — 4 fans = zero net rise at base load.
      const effectiveTempRise = Math.max(0, TEMP_RISE_PER_HOUR - fans * FAN_COOLING_PER_HOUR);
      newTemp = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * elapsedSeconds);
    }

    // ── Fuel drain: always-on sources burn diesel even while overheated ──
    if (generators > 0 && elapsedSeconds > 0) {
      const drained = generators * FUEL_DRAIN_RATE * elapsedSeconds;
      newFuel       = Math.max(0, newFuel - drained);
    }

    // ── Battery recharge: solar panels top up fuel during daylight ───────
    if (solarActive && solarPanels > 0 && elapsedSeconds > 0) {
      const charged = solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds;
      newFuel       = Math.min(MAX_FUEL, newFuel + charged);
    }

    newFuel = Math.round(newFuel);

    // Re-check running state with updated values.
    // Requires rigCount > 0 — no mining_rig blocks = no compute = no income.
    const nowDay      = getDayFactor(now.getTime());
    const nowSolar    = solarPanels > 0 && nowDay > 0.15;
    const nowAlways   = generators > 0 && newFuel > 0;
    const stillRunning = newTemp < MAX_TEMP && (nowSolar || nowAlways) && rigCount > 0;

    await client.query(
      "UPDATE miners SET current_balance=$1, temperature=$2, is_running=$3, last_tick_at=$4, fuel=$5 WHERE user_id=$6",
      [newBalance.toFixed(10), newTemp.toFixed(2), stillRunning, now, newFuel, userId]
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

// ─── Tick all unlocked miners ─────────────────────────────────────────────────
async function tickAllMiners(): Promise<void> {
  try {
    // Fetch all miners that have been unlocked (active or not — they all need
    // temperature tracking so they overheat correctly while offline)
    const result = await pool.query(
      "SELECT user_id FROM miners WHERE unlocked = true"
    );
    const userIds: number[] = result.rows.map((r: { user_id: number }) => r.user_id);

    if (userIds.length === 0) return;

    console.log(`[passive-ticker] Ticking ${userIds.length} miner(s)…`);

    // Tick each miner sequentially to avoid overwhelming the DB connection pool
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

// ─── Start the background ticker ─────────────────────────────────────────────
// Call this once on server startup. The interval runs every 60 seconds.
// We also run one tick immediately on startup so offline time is caught up
// without waiting a full minute.
export function startPassiveTicker(): void {
  console.log("[passive-ticker] Starting offline passive income ticker (60s interval)…");

  // Immediate first tick — catches up any offline time from before the restart
  tickAllMiners().catch(console.error);

  // Recurring tick every 60 seconds
  setInterval(() => {
    tickAllMiners().catch(console.error);
  }, 60_000);
}
