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
    // Confirm this user ID belongs to the root admin username OR has is_admin flag
    const result = await pool.query(
      "SELECT username, COALESCE(is_admin, false) AS is_admin FROM users WHERE id = $1",
      [userId]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    const row = result.rows[0];
    const isRootAdmin = row.username === ADMIN_USERNAME;
    const isGrantedAdmin = row.is_admin === true;
    if (!isRootAdmin && !isGrantedAdmin) {
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
// Cast to any: Express 5 middleware typings make router.use() picky about
// overloads; the function signature is correct at runtime.
router.use("/admin", requireAdmin as any);

// ── GET /api/admin/users — list every player ──────────────────────────────
// Returns id, username, gems, miner level, and moderation flags.
router.get("/admin/users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id,
        u.username,
        COALESCE(w.gems, 0)               AS gems,
        COALESCE(m.level, 0)              AS miner_level,
        COALESCE(m.temperature, 0)        AS temperature,
        COALESCE(m.is_running, false)     AS is_running,
        COALESCE(m.unlocked, false)       AS miner_unlocked,
        COALESCE(u.adblock_detected, false) AS adblock_detected,
        COALESCE(u.is_banned, false)      AS is_banned,
        COALESCE(u.is_muted, false)       AS is_muted,
        COALESCE(u.is_admin, false)       AS is_admin
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

// ── POST /api/admin/ban-user — ban a player (blocks login) ────────────────
// Body: { userId: number }
router.post("/admin/ban-user", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_banned = true WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} banned` });
  } catch (err) {
    req.log.error({ err }, "ban-user error");
    res.status(500).json({ error: "Failed to ban user" });
  }
});

// ── POST /api/admin/unban-user — lift a ban ───────────────────────────────
router.post("/admin/unban-user", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_banned = false WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} unbanned` });
  } catch (err) {
    req.log.error({ err }, "unban-user error");
    res.status(500).json({ error: "Failed to unban user" });
  }
});

// ── POST /api/admin/mute-user — mute a player (blocks chat) ──────────────
router.post("/admin/mute-user", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_muted = true WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} muted` });
  } catch (err) {
    req.log.error({ err }, "mute-user error");
    res.status(500).json({ error: "Failed to mute user" });
  }
});

// ── POST /api/admin/unmute-user — lift a mute ─────────────────────────────
router.post("/admin/unmute-user", async (req, res) => {
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_muted = false WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} unmuted` });
  } catch (err) {
    req.log.error({ err }, "unmute-user error");
    res.status(500).json({ error: "Failed to unmute user" });
  }
});

// ── POST /api/admin/grant-admin — give admin powers to a player ───────────
// Only the root admin (ADMIN_USERNAME) can grant/revoke admin powers,
// to prevent privilege escalation chains.
router.post("/admin/grant-admin", async (req, res) => {
  // Extra guard: only root admin can grant/revoke admin
  const rawId = req.headers["x-user-id"];
  const callerRes = await pool.query("SELECT username FROM users WHERE id = $1", [parseInt(rawId as string)]);
  if (callerRes.rows[0]?.username !== ADMIN_USERNAME) {
    res.status(403).json({ error: "Only the root admin can grant/revoke admin access" });
    return;
  }
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_admin = true WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} granted admin` });
  } catch (err) {
    req.log.error({ err }, "grant-admin error");
    res.status(500).json({ error: "Failed to grant admin" });
  }
});

// ── POST /api/admin/revoke-admin — remove admin powers ───────────────────
router.post("/admin/revoke-admin", async (req, res) => {
  const rawId = req.headers["x-user-id"];
  const callerRes = await pool.query("SELECT username FROM users WHERE id = $1", [parseInt(rawId as string)]);
  if (callerRes.rows[0]?.username !== ADMIN_USERNAME) {
    res.status(403).json({ error: "Only the root admin can grant/revoke admin access" });
    return;
  }
  const { userId } = req.body as { userId?: number };
  if (!userId) { res.status(400).json({ error: "userId required" }); return; }
  try {
    await pool.query("UPDATE users SET is_admin = false WHERE id = $1", [userId]);
    res.json({ success: true, message: `User ${userId} admin revoked` });
  } catch (err) {
    req.log.error({ err }, "revoke-admin error");
    res.status(500).json({ error: "Failed to revoke admin" });
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
// Query: ?userId=N
// Returns everything in the miners row plus computed fields so the admin
// panel can display live overheat ETA, earned balance, and power source detail.
// Now returns batteries/batteryCharge (solar storage) separately from
// generators/fuel (diesel power).
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
    const m             = result.rows[0];
    const rigCount      = parseInt(m.level)          || 0;
    const fans          = parseInt(m.fans)            || 0;
    const solarPanels   = parseInt(m.solar_panels)    || 0;
    const batteries     = parseInt(m.batteries)       || 0;   // battery_block count
    const batteryCharge = parseInt(m.battery_charge)  || 0;   // current stored energy
    const generators    = parseInt(m.generators)      || 0;   // generator_block count
    const fuel          = parseInt(m.fuel)            || 0;   // diesel level
    const temp          = parseFloat(m.temperature);

    const {
      HEAT_PER_RIG_PER_HOUR,
      HEAT_PER_BATTERY_PER_HOUR,
      HEAT_PER_GENERATOR_PER_HOUR,
      FAN_COOLING_PER_HOUR,
      MIN_HEAT_PER_HOUR,
      MAX_TEMP,
      MINER_RATES,
    } = await import("../lib/game-constants");

    // Max power supply (all sources counted; actual active depends on day/night + charge/fuel)
    const generatorActive   = generators > 0 && fuel > 0;
    const powerSupply       = solarPanels + batteries + generators;
    const activeRigs        = Math.min(rigCount, powerSupply);
    const ratePerSec        = MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;

    // Per-appliance heat model — mirrors the passive-tick logic in miner.ts
    const heatFromRigs       = activeRigs * HEAT_PER_RIG_PER_HOUR;
    const heatFromBatteries  = batteries  * HEAT_PER_BATTERY_PER_HOUR;
    const heatFromGenerators = generatorActive ? generators * HEAT_PER_GENERATOR_PER_HOUR : 0;
    const rawHeat            = heatFromRigs + heatFromBatteries + heatFromGenerators;
    // MIN_HEAT_PER_HOUR ensures overheat is always eventually inevitable
    const effectiveTempRise  = Math.max(
      MIN_HEAT_PER_HOUR,
      rawHeat - fans * FAN_COOLING_PER_HOUR,
    );

    // Seconds until miner hits MAX_TEMP (null = already overheated)
    const secsToOverheat = temp < MAX_TEMP
      ? ((MAX_TEMP - temp) / effectiveTempRise) * 3600
      : null;

    const secsSinceLastTick = (Date.now() - new Date(m.last_tick_at).getTime()) / 1000;

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
      batteries,         // battery_block count
      batteryCharge,     // current battery energy (0–500)
      generators,        // generator_block count
      fuel,              // diesel tank level (0–500)
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
    } = await import("../lib/game-constants");

    const rigCount      = parseInt(m.level)          || 0;
    const fans          = parseInt(m.fans)            || 0;
    const temp          = parseFloat(m.temperature);
    const solarPanels   = parseInt(m.solar_panels)    || 0;
    const batteries     = parseInt(m.batteries)       || 0;  // battery_block count
    const generators    = parseInt(m.generators)      || 0;  // generator_block count
    let   batteryCharge = parseInt(m.battery_charge)  || 0;  // stored solar energy
    let   fuel          = parseInt(m.fuel)            || 0;  // diesel level

    // ── Solar availability ────────────────────────────────────────────────────
    const dayFactor   = getDayFactor(Date.now());
    const solarActive = solarPanels > 0 && dayFactor > 0.15;

    // ── Pre-tick power state (before any charge/drain in this window) ─────────
    const batteryActive   = batteries > 0 && batteryCharge > 0 && !solarActive;
    const generatorActive = generators > 0 && fuel > 0;
    const powerSupply     = (solarActive ? solarPanels : 0)
                          + (batteryActive ? batteries : 0)
                          + (generatorActive ? generators : 0);
    const activeRigs      = Math.min(rigCount, powerSupply);
    const isRunning       = m.is_running && temp < MAX_TEMP && powerSupply > 0 && rigCount > 0;

    let newBalance = parseFloat(m.current_balance);
    let newTemp    = temp;

    const rate = MINER_RATES[Math.min(activeRigs, 9)] ?? MINER_RATES[9] ?? 0;

    // Per-appliance heat model — mirrors the passive-tick logic in miner.ts
    const heatFromRigs       = activeRigs * HEAT_PER_RIG_PER_HOUR;
    const heatFromBatteries  = batteries  * HEAT_PER_BATTERY_PER_HOUR;
    const heatFromGenerators = generatorActive ? generators * HEAT_PER_GENERATOR_PER_HOUR : 0;
    const rawHeat            = heatFromRigs + heatFromBatteries + heatFromGenerators;
    // MIN_HEAT_PER_HOUR floor ensures overheat is always eventually inevitable
    const effectiveTempRise  = Math.max(
      MIN_HEAT_PER_HOUR,
      rawHeat - fans * FAN_COOLING_PER_HOUR,
    );

    // ── Figure out the EARLIEST stopping event within the window ─────────────
    // The miner stops when temp hits MAX_TEMP OR power runs out (fuel empty / battery dead).
    let stopReasonOverheat = false;
    let stopReasonFuel     = false;
    let runsForSeconds     = elapsedSeconds;
    let overheatsAtSecond: number | null = null;

    if (isRunning) {
      // Seconds until overheat
      if (effectiveTempRise > 0) {
        const secsUntilOverheat = ((MAX_TEMP - temp) / effectiveTempRise) * 3600;
        if (secsUntilOverheat <= elapsedSeconds) {
          runsForSeconds     = secsUntilOverheat;
          overheatsAtSecond  = parseFloat(secsUntilOverheat.toFixed(1));
          stopReasonOverheat = true;
        }
      }

      // Seconds until generator fuel empty (generators are sole power source at night)
      if (generators > 0 && !solarActive && fuel > 0 && !batteryActive) {
        const drainPerSec    = generators * FUEL_DRAIN_RATE;
        const secsUntilEmpty = fuel / drainPerSec;
        if (secsUntilEmpty < runsForSeconds) {
          runsForSeconds     = secsUntilEmpty;
          overheatsAtSecond  = null;
          stopReasonOverheat = false;
          stopReasonFuel     = true;
        }
      }

      // Seconds until battery dead (batteries are sole power source at night)
      if (batteries > 0 && !solarActive && batteryCharge > 0 && !generatorActive) {
        const drainPerSec    = batteries * BATTERY_DRAIN_RATE;
        const secsUntilDead  = batteryCharge / drainPerSec;
        if (secsUntilDead < runsForSeconds) {
          runsForSeconds     = secsUntilDead;
          overheatsAtSecond  = null;
          stopReasonOverheat = false;
          stopReasonFuel     = true; // "fuel_empty" covers both battery dead and diesel empty
        }
      }

      // Apply earnings and temp rise only for the time the miner actually ran
      newBalance += rate * runsForSeconds;
      newTemp     = Math.min(MAX_TEMP, temp + (effectiveTempRise / 3600) * runsForSeconds);
    }

    // ── Battery: charge from solar during day; discharge at night ────────────
    if (solarActive && solarPanels > 0) {
      batteryCharge = Math.min(MAX_BATTERY_CHARGE,
        batteryCharge + solarPanels * BATTERY_CHARGE_RATE * elapsedSeconds);
    }
    if (batteryActive) {
      batteryCharge = Math.max(0,
        batteryCharge - batteries * BATTERY_DRAIN_RATE * elapsedSeconds);
    }

    // ── Diesel drain: generators always burn fuel ─────────────────────────────
    if (generators > 0) {
      fuel = Math.max(0, fuel - generators * FUEL_DRAIN_RATE * elapsedSeconds);
    }

    batteryCharge = Math.round(batteryCharge);
    fuel          = Math.round(fuel);

    // Re-evaluate running state with updated values
    const nowBatteryActive   = batteries  > 0 && batteryCharge > 0 && !solarActive;
    const nowGeneratorActive = generators > 0 && fuel > 0;
    const nowSolar           = solarPanels > 0 && getDayFactor(Date.now()) > 0.15;
    const stillRunning       = newTemp < MAX_TEMP
                             && (nowSolar || nowBatteryActive || nowGeneratorActive)
                             && rigCount > 0;

    // ── Write results — keep last_tick_at unchanged so the real ticker ────────
    // continues its normal schedule from where it left off.
    await client.query(
      `UPDATE miners
       SET current_balance=$1, temperature=$2, is_running=$3,
           battery_charge=$4, fuel=$5
       WHERE user_id=$6`,
      [newBalance.toFixed(10), newTemp.toFixed(2), stillRunning, batteryCharge, fuel, userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      simulated: {
        elapsedSeconds,
        runsForSeconds: parseFloat(runsForSeconds.toFixed(1)),
        stoppedEarly:   runsForSeconds < elapsedSeconds,
        stopReason:     stopReasonOverheat ? "overheat"
                        : stopReasonFuel   ? "fuel_empty"
                        : isRunning        ? "still_running"
                        : "was_not_running",
        overheatsAtSecond,
        wasRunning:       isRunning,
        oldTemp:          temp,
        newTemp:          parseFloat(newTemp.toFixed(2)),
        overheated:       newTemp >= MAX_TEMP,
        oldBalance:       parseFloat(m.current_balance),
        newBalance:       parseFloat(newBalance.toFixed(10)),
        earned:           parseFloat((newBalance - parseFloat(m.current_balance)).toFixed(10)),
        oldFuel:          parseInt(m.fuel) || 0,
        newFuel:          fuel,
        oldBatteryCharge: parseInt(m.battery_charge) || 0,
        newBatteryCharge: batteryCharge,
        isRunning:        stillRunning,
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
