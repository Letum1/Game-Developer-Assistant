// ============================================================
// admin.ts — God-mode cheat API for the admin user
//
// All routes require the requesting x-user-id to belong to
// the ADMIN_USERNAME (default "admin"). This lets the admin
// log in as a normal player and still access debug tools.
//
// HOW TO USE:
//   1. Register/login with username matching ADMIN_USERNAME env var
//      (defaults to "admin" if not set).
//   2. Navigate to /admin in the game — the panel only appears for
//      the admin user.
//   3. Use the buttons to cheat, debug, and test.
// ============================================================

import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "../lib/db-pool";

const router: IRouter = Router();

// ── Admin username loaded from env, falls back to "admin" ──────────────────
// Change ADMIN_USERNAME in Replit Secrets to use a different callsign.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME ?? "admin";

// ── Admin guard middleware ─────────────────────────────────────────────────
// Every /admin/* route runs this first. It looks up the x-user-id header,
// fetches the username from the DB, and rejects non-admin callers with 403.
async function requireAdmin(req: Request, res: Response, next: () => void) {
  const rawId = req.headers["x-user-id"];
  if (!rawId) {
    res.status(401).json({ error: "Missing x-user-id header" });
    return;
  }
  const userId = parseInt(rawId as string);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Invalid user id" });
    return;
  }

  try {
    // Confirm this user ID actually belongs to the configured admin username
    const result = await pool.query(
      "SELECT username FROM users WHERE id = $1",
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if (result.rows[0].username !== ADMIN_USERNAME) {
      // Return 403 so non-admins can't probe which user IDs are admin
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Admin guard error");
    res.status(500).json({ error: "Auth check failed" });
  }
}

// Apply the guard to every route in this router
router.use("/admin", requireAdmin as Parameters<typeof router.use>[0]);

// ── GET /api/admin/users — list every player ──────────────────────────────
// Returns id, username, gems, and miner level for a quick overview.
router.get("/admin/users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        COALESCE(w.gems, 0)   AS gems,
        COALESCE(m.level, 0)  AS miner_level,
        COALESCE(m.temperature, 0) AS temperature,
        COALESCE(m.is_running, false) AS is_running,
        COALESCE(m.unlocked, false) AS miner_unlocked
      FROM users u
      LEFT JOIN wallets w  ON w.user_id = u.id
      LEFT JOIN miners  m  ON m.user_id = u.id
      ORDER BY u.id
    `);
    res.json(result.rows);
  } catch (err) {
    req.log.error({ err }, "Admin list users error");
    res.status(500).json({ error: "Failed to list users" });
  }
});

// ── POST /api/admin/give-gems — add (or subtract) gems to any player ──────
// Body: { userId: number, amount: number }
// Use a negative amount to take gems away.
router.post("/admin/give-gems", async (req, res) => {
  const { userId, amount } = req.body as { userId?: number; amount?: number };
  if (!userId || amount === undefined || isNaN(amount)) {
    res.status(400).json({ error: "userId and amount required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE wallets SET gems = GREATEST(0, gems + $1) WHERE user_id = $2",
      [amount, userId]
    );
    const w = await pool.query("SELECT gems FROM wallets WHERE user_id = $1", [userId]);
    res.json({ success: true, newGems: parseInt(w.rows[0]?.gems ?? "0") });
  } catch (err) {
    req.log.error({ err }, "Admin give-gems error");
    res.status(500).json({ error: "Failed to give gems" });
  }
});

// ── POST /api/admin/set-gems — set a player's gems to an exact value ──────
// Body: { userId: number, amount: number }
router.post("/admin/set-gems", async (req, res) => {
  const { userId, amount } = req.body as { userId?: number; amount?: number };
  if (!userId || amount === undefined || isNaN(amount) || amount < 0) {
    res.status(400).json({ error: "userId and non-negative amount required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE wallets SET gems = $1 WHERE user_id = $2",
      [amount, userId]
    );
    res.json({ success: true, newGems: amount });
  } catch (err) {
    req.log.error({ err }, "Admin set-gems error");
    res.status(500).json({ error: "Failed to set gems" });
  }
});

// ── POST /api/admin/give-item — add items to any player's inventory ────────
// Body: { userId: number, itemId: string, quantity: number }
// Uses ON CONFLICT upsert so existing stacks are topped up.
router.post("/admin/give-item", async (req, res) => {
  const { userId, itemId, quantity } = req.body as {
    userId?: number;
    itemId?: string;
    quantity?: number;
  };
  if (!userId || !itemId || !quantity || quantity < 1) {
    res.status(400).json({ error: "userId, itemId, and quantity (≥1) required" });
    return;
  }
  try {
    await pool.query(
      `INSERT INTO inventories (user_id, item_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_id)
       DO UPDATE SET quantity = inventories.quantity + EXCLUDED.quantity`,
      [userId, itemId, quantity]
    );
    const inv = await pool.query(
      "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2",
      [userId, itemId]
    );
    res.json({ success: true, newQuantity: parseInt(inv.rows[0]?.quantity ?? "0") });
  } catch (err) {
    req.log.error({ err }, "Admin give-item error");
    res.status(500).json({ error: "Failed to give item" });
  }
});

// ── POST /api/admin/reset-temp — cool the miner to 0°C and restart it ────
// Body: { userId: number }
// Useful when you want to test passive income without overheating getting in the way.
router.post("/admin/reset-temp", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE miners SET temperature = 0, is_running = true WHERE user_id = $1",
      [userId]
    );
    res.json({ success: true, message: "Miner cooled to 0°C and restarted" });
  } catch (err) {
    req.log.error({ err }, "Admin reset-temp error");
    res.status(500).json({ error: "Failed to reset temperature" });
  }
});

// ── POST /api/admin/unlock-miner — unlock & start a player's miner ────────
// Body: { userId: number }
// Skips the crafting-a-Data-Center-Rig requirement.
router.post("/admin/unlock-miner", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE miners SET unlocked = true, is_running = true WHERE user_id = $1",
      [userId]
    );
    res.json({ success: true, message: "Miner unlocked and started" });
  } catch (err) {
    req.log.error({ err }, "Admin unlock-miner error");
    res.status(500).json({ error: "Failed to unlock miner" });
  }
});

// ── POST /api/admin/set-miner-level — set miner rig count directly ────────
// Body: { userId: number, level: number }
// "level" here is the total mining_rig block count stored in the level column.
router.post("/admin/set-miner-level", async (req, res) => {
  const { userId, level } = req.body as { userId?: number; level?: number };
  if (!userId || level === undefined || level < 0) {
    res.status(400).json({ error: "userId and level (≥0) required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE miners SET level = $1, unlocked = true, is_running = true WHERE user_id = $2",
      [level, userId]
    );
    res.json({ success: true, message: `Miner level set to ${level}` });
  } catch (err) {
    req.log.error({ err }, "Admin set-miner-level error");
    res.status(500).json({ error: "Failed to set miner level" });
  }
});

// ── POST /api/admin/refill-fuel — fill a player's fuel tank to max ─────────
// Body: { userId: number }
// Max fuel is 500 (MAX_FUEL in game-constants.ts).
router.post("/admin/refill-fuel", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) {
    res.status(400).json({ error: "userId required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE miners SET fuel = 500 WHERE user_id = $1",
      [userId]
    );
    res.json({ success: true, message: "Fuel tank filled to 500" });
  } catch (err) {
    req.log.error({ err }, "Admin refill-fuel error");
    res.status(500).json({ error: "Failed to refill fuel" });
  }
});

// ── POST /api/admin/reset-world — delete a world so it regenerates ─────────
// Body: { worldName: string }
// The world will be freshly generated on the next GET /api/world/:name call.
router.post("/admin/reset-world", async (req, res) => {
  const { worldName } = req.body as { worldName?: string };
  if (!worldName) {
    res.status(400).json({ error: "worldName required" });
    return;
  }
  try {
    const result = await pool.query(
      "DELETE FROM worlds WHERE name = $1",
      [worldName]
    );
    res.json({
      success: true,
      message: `World "${worldName}" reset — it will regenerate on next visit`,
      deleted: result.rowCount,
    });
  } catch (err) {
    req.log.error({ err }, "Admin reset-world error");
    res.status(500).json({ error: "Failed to reset world" });
  }
});

// ── POST /api/admin/add-points — add activity/window points to a player ────
// Body: { userId: number, points: number }
// window_points gate the miner upgrade tiers, so this bypasses the grind.
router.post("/admin/add-points", async (req, res) => {
  const { userId, points } = req.body as { userId?: number; points?: number };
  if (!userId || points === undefined || isNaN(points)) {
    res.status(400).json({ error: "userId and points required" });
    return;
  }
  try {
    await pool.query(
      "UPDATE wallets SET window_points = window_points + $1 WHERE user_id = $2",
      [points, userId]
    );
    const w = await pool.query("SELECT window_points FROM wallets WHERE user_id = $1", [userId]);
    res.json({ success: true, newPoints: parseFloat(w.rows[0]?.window_points ?? "0") });
  } catch (err) {
    req.log.error({ err }, "Admin add-points error");
    res.status(500).json({ error: "Failed to add points" });
  }
});

// ── GET /api/admin/miner-state — full miner snapshot for a player ──────────
// Body (query): ?userId=N
// Returns everything in the miners row plus computed fields so the admin
// panel can display live overheat ETA and earned balance.
router.get("/admin/miner-state", async (req, res) => {
  const userId = parseInt(req.query["userId"] as string);
  if (!userId || isNaN(userId)) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  try {
    const result = await pool.query("SELECT * FROM miners WHERE user_id = $1", [userId]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Miner not found" });
      return;
    }
    const m = result.rows[0];
    const rigCount    = parseInt(m.level) || 0;
    const fans        = parseInt(m.fans)  || 0;
    const solarPanels = parseInt(m.solar_panels) || 0;
    const generators  = parseInt(m.generators)   || 0;
    const temp        = parseFloat(m.temperature);
    const fuel        = parseInt(m.fuel) || 0;

    // Effective temperature rise per hour with current fans
    // Matches the formula in passive-ticker.ts and miner.ts
    const { TEMP_RISE_PER_HOUR, FAN_COOLING_PER_HOUR, MAX_TEMP, MINER_RATES } = await import("../lib/game-constants");
    const effectiveTempRise = Math.max(0, TEMP_RISE_PER_HOUR - fans * FAN_COOLING_PER_HOUR);

    // Seconds until miner hits MAX_TEMP (0 if already overheated or not rising)
    const remainingDegrees = MAX_TEMP - temp;
    const secsToOverheat = effectiveTempRise > 0 && temp < MAX_TEMP
      ? (remainingDegrees / effectiveTempRise) * 3600
      : null;

    // Seconds since last_tick_at
    const secsSinceLastTick = (Date.now() - new Date(m.last_tick_at).getTime()) / 1000;

    const powerSupply = solarPanels + generators;
    const activeRigs  = Math.min(rigCount, powerSupply);
    const ratePerSec  = MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;

    res.json({
      userId: m.user_id,
      temperature:       temp,
      effectiveTempRise, // °C per hour with current fans
      secsToOverheat,    // null = already overheated or no rise
      isRunning:         m.is_running,
      unlocked:          m.unlocked,
      currentBalance:    parseFloat(m.current_balance),
      ratePerSec,
      rigCount,
      fans,
      solarPanels,
      generators,
      fuel,
      lastTickAt:        m.last_tick_at,
      secsSinceLastTick: Math.floor(secsSinceLastTick),
    });
  } catch (err) {
    req.log.error({ err }, "Admin miner-state error");
    res.status(500).json({ error: "Failed to fetch miner state" });
  }
});

// ── POST /api/admin/simulate-time — fast-forward a miner by N seconds ─────
// Body: { userId: number, elapsedSeconds: number }
//
// This runs the FULL tick math (balance, temp, fuel, is_running) as if
// `elapsedSeconds` had passed since the last tick. It's the fastest way to:
//   • Watch overheating happen in seconds instead of an hour
//   • Test passive income accumulation
//   • Verify that fan cooling works
//
// The last_tick_at is NOT updated — that way the normal ticker continues
// from the real wall-clock position. Only the computed values change.
router.post("/admin/simulate-time", async (req, res) => {
  const { userId, elapsedSeconds } = req.body as {
    userId?: number;
    elapsedSeconds?: number;
  };
  if (!userId || !elapsedSeconds || elapsedSeconds <= 0) {
    res.status(400).json({ error: "userId and elapsedSeconds (>0) required" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock row to prevent race with the real passive-ticker
    const result = await client.query(
      "SELECT * FROM miners WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Miner not found" });
      return;
    }

    const m = result.rows[0];
    const {
      MINER_RATES,
      TEMP_RISE_PER_HOUR,
      FAN_COOLING_PER_HOUR,
      MAX_TEMP,
      MAX_FUEL,
      FUEL_DRAIN_RATE,
      BATTERY_CHARGE_RATE,
      getDayFactor,
    } = await import("../lib/game-constants");

    const rigCount    = parseInt(m.level) || 0;
    const fans        = parseInt(m.fans)  || 0;
    const temp        = parseFloat(m.temperature);
    const solarPanels = parseInt(m.solar_panels) || 0;
    const generators  = parseInt(m.generators)   || 0;
    const fuel        = parseInt(m.fuel) || 0;
    let   newFuel     = fuel;

    // Use current wall-clock time to evaluate solar power
    const dayFactor   = getDayFactor(Date.now());
    const solarActive = solarPanels > 0 && dayFactor > 0.15;
    const alwaysOn    = generators > 0 && fuel > 0;
    const powerSupply = (solarActive ? solarPanels : 0) + (alwaysOn ? generators : 0);
    const activeRigs  = Math.min(rigCount, powerSupply);

    // Miner must be running AND powered AND have hardware to earn/heat
    const isRunning   = m.is_running && temp < MAX_TEMP && (solarActive || alwaysOn) && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;

    if (isRunning) {
      const rate = MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;
      newBalance += rate * elapsedSeconds;

      // Temperature rises — fans reduce how fast
      const effectiveTempRise = Math.max(0, TEMP_RISE_PER_HOUR - fans * FAN_COOLING_PER_HOUR);
      newTemp = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * elapsedSeconds);
    }

    // Fuel drain (always-on sources burn diesel even when overheated)
    if (generators > 0) {
      newFuel = Math.max(0, newFuel - generators * FUEL_DRAIN_RATE * elapsedSeconds);
    }
    // Battery recharge (solar tops up fuel during the day)
    if (solarActive && solarPanels > 0) {
      newFuel = Math.min(MAX_FUEL, newFuel + solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds);
    }
    newFuel = Math.round(newFuel);

    // Re-evaluate running state with updated temp + fuel
    const nowSolar    = solarPanels > 0 && getDayFactor(Date.now()) > 0.15;
    const nowAlwaysOn = generators > 0 && newFuel > 0;
    const stillRunning = newTemp < MAX_TEMP && (nowSolar || nowAlwaysOn) && rigCount > 0;

    // ── Write results — keep last_tick_at unchanged so the real ticker ──────
    // continues its normal schedule from where it left off.
    await client.query(
      `UPDATE miners
       SET current_balance=$1, temperature=$2, is_running=$3, fuel=$4
       WHERE user_id=$5`,
      [newBalance.toFixed(10), newTemp.toFixed(2), stillRunning, newFuel, userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      simulated: {
        elapsedSeconds,
        wasRunning:   isRunning,
        oldTemp:      temp,
        newTemp:      parseFloat(newTemp.toFixed(2)),
        overheated:   newTemp >= MAX_TEMP,
        oldBalance:   parseFloat(m.current_balance),
        newBalance:   parseFloat(newBalance.toFixed(10)),
        earned:       parseFloat((newBalance - parseFloat(m.current_balance)).toFixed(10)),
        oldFuel:      fuel,
        newFuel,
        isRunning:    stillRunning,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Admin simulate-time error");
    res.status(500).json({ error: "Simulation failed" });
  } finally {
    client.release();
  }
});

export default router;
