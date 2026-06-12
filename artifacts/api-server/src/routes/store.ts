// ============================================================
// store.ts — Rotating "Black Market" shop with rarity tiers
//
// Items restock every 10 minutes. Rare items (Mining Rig, power
// blocks) have a low chance of appearing and limited quantities,
// creating a Grow-a-Garden-style FOMO engagement loop.
//
// The restock state is persisted in the `store_stock` table so
// server restarts resume the timer correctly.
//
// Flow:
//   initStoreRestock()  — called from app.ts after DB migrations
//   doRestock()         — rolls new items, writes to store_stock
//   GET  /api/store     — returns current stock + nextRestockAt
//   POST /api/store/buy — atomically decrements stock + charges gems
// ============================================================

import { Router, type Request, type Response, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── Rarity tiers ─────────────────────────────────────────────────────────────
type Rarity = "common" | "uncommon" | "rare" | "ultra";

interface ShopEntry {
  displayName: string;
  rarity:      Rarity;
  gemCost:     number;
  minQty:      number;   // minimum stock quantity when item rolls in
  maxQty:      number;   // maximum stock quantity
  chance:      number;   // 0–1 probability of appearing per restock cycle
  description: string;
  category:    string;
}

// ─── Shop catalog ─────────────────────────────────────────────────────────────
// Design intent:
//   ULTRA  → Mining Rig (~18% per cycle, qty 1–2). The "rare seed" moment
//             that keeps players checking back obsessively.
//   RARE   → Power blocks (28–42%). Secondary excitement layer.
//   UNCOMMON → Support blocks & cooling (50–65%). Reliably in rotation.
//   COMMON → Cables, fuel, tools (80–100%). Always something to buy.
//
// Machine blocks are NOT craftable anymore — the shop is the only source.
export const SHOP_CATALOG: Record<string, ShopEntry> = {

  // ── ULTRA RARE ──────────────────────────────────────────────────────────────
  mining_rig: {
    displayName: "Mining Rig",
    rarity:      "ultra",
    gemCost:     800,
    minQty: 1, maxQty: 2,
    chance:      0.18,
    description: "ASIC mining hardware. Each block placed = 1 TH. Needs 1 power unit connected via cables to a Machine Core.",
    category:    "machines",
  },

  // ── RARE ────────────────────────────────────────────────────────────────────
  generator_block: {
    displayName: "Generator Block",
    rarity:      "rare",
    gemCost:     600,
    minQty: 1, maxQty: 2,
    chance:      0.28,
    description: "Always-on diesel power. Works day AND night. Refuel with Diesel Cans. Connect to Machine Core via cables.",
    category:    "machines",
  },
  battery_block: {
    displayName: "Battery Block",
    rarity:      "rare",
    gemCost:     450,
    minQty: 1, maxQty: 3,
    chance:      0.35,
    description: "Stores solar energy during the day. Keeps the rig running through the night automatically.",
    category:    "machines",
  },
  solar_panel_block: {
    displayName: "Solar Panel Block",
    rarity:      "rare",
    gemCost:     300,
    minQty: 1, maxQty: 4,
    chance:      0.42,
    description: "Daytime power source — 1 power unit per panel. Place where sunlight reaches, connect via cables.",
    category:    "machines",
  },

  // ── UNCOMMON ────────────────────────────────────────────────────────────────
  fan_block: {
    displayName: "Cooling Fan",
    rarity:      "uncommon",
    gemCost:     180,
    minQty: 2, maxQty: 7,
    chance:      0.65,
    description: "Each fan reduces heat rise by 15 °C/hr. 4+ fans prevent overheating at base rig load.",
    category:    "machines",
  },
  world_lock: {
    displayName: "World Lock",
    rarity:      "uncommon",
    gemCost:     500,
    minQty: 1, maxQty: 3,
    chance:      0.50,
    description: "Lock a world so only you can build and mine in it.",
    category:    "locks",
  },
  thermal_paste: {
    displayName: "Thermal Paste",
    rarity:      "uncommon",
    gemCost:     300,
    minQty: 2, maxQty: 8,
    chance:      0.60,
    description: "Reduces miner temperature. Equip from hotbar, then tap Machine Core to apply.",
    category:    "cooling",
  },
  water_bucket: {
    displayName: "Water Bucket",
    rarity:      "uncommon",
    gemCost:     300,
    minQty: 2, maxQty: 8,
    chance:      0.60,
    description: "Flushes coolant to reset temperature. Equip from hotbar, then tap Machine Core.",
    category:    "cooling",
  },

  // ── COMMON ──────────────────────────────────────────────────────────────────
  data_cable: {
    displayName: "Data Cable",
    rarity:      "common",
    gemCost:     15,
    minQty: 10, maxQty: 30,
    chance:      1.00,
    description: "Connects machine blocks. Routes power and data between Core, solar panels, batteries and rigs.",
    category:    "machines",
  },
  lamp_block: {
    displayName: "Lamp Block",
    rarity:      "common",
    gemCost:     15,
    minQty: 8, maxQty: 25,
    chance:      1.00,
    description: "Place underground and connect to your solar rig via Data Cables to illuminate caverns.",
    category:    "lighting",
  },
  diesel_can: {
    displayName: "Diesel Can",
    rarity:      "common",
    gemCost:     20,
    minQty: 8, maxQty: 25,
    chance:      1.00,
    description: "+100 litres of diesel per can. Equip from hotbar, tap a Generator Block to refuel.",
    category:    "fuel",
  },
  pickaxe_stone: {
    displayName: "Stone Pickaxe",
    rarity:      "common",
    gemCost:     80,
    minQty: 5, maxQty: 15,
    chance:      1.00,
    description: "1.8× faster mining than bare hands.",
    category:    "tools",
  },
  pickaxe_iron: {
    displayName: "Iron Pickaxe",
    rarity:      "common",
    gemCost:     200,
    minQty: 3, maxQty: 10,
    chance:      1.00,
    description: "2.8× mining speed — breaks iron blocks fast.",
    category:    "tools",
  },
  pickaxe_gold: {
    displayName: "Gold Pickaxe",
    rarity:      "common",
    gemCost:     400,
    minQty: 2, maxQty: 8,
    chance:      0.90,
    description: "4.5× mining speed.",
    category:    "tools",
  },
  pickaxe_diamond: {
    displayName: "Diamond Pickaxe",
    rarity:      "common",
    gemCost:     800,
    minQty: 1, maxQty: 4,
    chance:      0.80,
    description: "7× mining speed — the ultimate tool.",
    category:    "tools",
  },
};

// ─── Restock state (in-memory, like the revenue pool timer) ───────────────────
// Resets on server restart, but recovered from DB via initStoreRestock().
export const RESTOCK_INTERVAL_MS = 10 * 60 * 1000; // 10-minute cycle

let restockNumber  = 0;                                // increments on each restock
let nextRestockAt  = Date.now() + RESTOCK_INTERVAL_MS; // unix-ms of next restock
let restockTimer: ReturnType<typeof setTimeout> | null = null;

// ─── doRestock: roll new items into store_stock ────────────────────────────────
async function doRestock(): Promise<void> {
  restockNumber++;
  const now = new Date();
  nextRestockAt = Date.now() + RESTOCK_INTERVAL_MS;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Wipe previous stock — fresh slate each cycle
    await client.query("DELETE FROM store_stock");

    // Roll each catalog item independently using its chance probability
    for (const [itemId, cfg] of Object.entries(SHOP_CATALOG)) {
      if (Math.random() < cfg.chance) {
        const qty = cfg.minQty + Math.floor(Math.random() * (cfg.maxQty - cfg.minQty + 1));
        await client.query(
          `INSERT INTO store_stock (item_id, quantity, restock_number, restocked_at)
           VALUES ($1, $2, $3, $4)`,
          [itemId, qty, restockNumber, now],
        );
      }
    }

    await client.query("COMMIT");
    logger.info({ restockNumber, nextRestockAt }, "[store] Restock complete");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ err }, "[store] Restock DB write failed");
  } finally {
    client.release();
  }

  // Queue next restock
  if (restockTimer) clearTimeout(restockTimer);
  restockTimer = setTimeout(doRestock, RESTOCK_INTERVAL_MS);
}

// ─── initStoreRestock — call once from app.ts after startup migrations ────────
// Reads the last restock time from the DB and either resumes the timer or
// triggers an immediate restock if the cycle is overdue.
export async function initStoreRestock(): Promise<void> {
  try {
    const result = await pool.query(
      "SELECT MAX(restock_number) AS num, MAX(restocked_at) AS last_at FROM store_stock",
    );
    const row    = result.rows[0];
    const lastNum = row?.num      ? parseInt(row.num)                      : 0;
    const lastAt  = row?.last_at  ? new Date(row.last_at as string).getTime() : 0;
    const elapsed = Date.now() - lastAt;

    restockNumber = lastNum;

    if (lastAt === 0 || elapsed >= RESTOCK_INTERVAL_MS) {
      // First-ever run or overdue — restock now
      logger.info("[store] Performing initial restock…");
      await doRestock();
    } else {
      // Resume existing cycle
      const msUntilNext = RESTOCK_INTERVAL_MS - elapsed;
      nextRestockAt     = Date.now() + msUntilNext;
      restockTimer      = setTimeout(doRestock, msUntilNext);
      logger.info({ restockNumber, msUntilNext }, "[store] Timer resumed");
    }
  } catch (err) {
    // store_stock table might not exist yet on the very first boot —
    // retry after 3 s to let startup migrations finish.
    logger.warn({ err }, "[store] Init failed — retrying in 3 s");
    setTimeout(() => initStoreRestock(), 3000);
  }
}

// ─── GET /api/store — return current rotating stock ───────────────────────────
router.get("/store", async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT item_id, quantity, restock_number, restocked_at
       FROM store_stock
       WHERE quantity > 0
       ORDER BY item_id`,
    );

    const items = result.rows
      .map((row) => {
        const cfg = SHOP_CATALOG[row.item_id as string];
        if (!cfg) return null;
        return {
          itemId:        row.item_id      as string,
          displayName:   cfg.displayName,
          rarity:        cfg.rarity,
          gemCost:       cfg.gemCost,
          quantity:      parseInt(row.quantity       as string),
          restockNumber: parseInt(row.restock_number as string),
          restockedAt:   row.restocked_at as string,
          description:   cfg.description,
          category:      cfg.category,
        };
      })
      .filter(Boolean);

    res.json({ items, restockNumber, nextRestockAt, restockIntervalMs: RESTOCK_INTERVAL_MS });
  } catch (err) {
    req.log.error({ err }, "Get store error");
    res.status(500).json({ error: "Failed to load store" });
  }
});

// ─── POST /api/store/buy — purchase from current rotating stock ───────────────
// Stock is decremented atomically. Returns 400 if the item sold out.
router.post("/store/buy", async (req: Request, res: Response) => {
  const userId = parseInt(req.headers["x-user-id"] as string);
  if (!userId || isNaN(userId)) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  const { itemId, quantity } = req.body as { itemId?: string; quantity?: number };
  if (!itemId) {
    res.status(400).json({ error: "itemId required" });
    return;
  }

  const cfg = SHOP_CATALOG[itemId];
  if (!cfg) {
    res.status(400).json({ error: "Item not found in shop" });
    return;
  }

  const qty       = Math.max(1, Math.floor(Number(quantity) || 1));
  const totalCost = cfg.gemCost * qty;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Decrement stock atomically (prevents race conditions) ──────────────────
    const stockRes = await client.query(
      `UPDATE store_stock
       SET quantity = quantity - $1
       WHERE item_id = $2 AND quantity >= $1
       RETURNING quantity`,
      [qty, itemId],
    );
    if (stockRes.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: `${cfg.displayName} is sold out!` });
      return;
    }

    // ── Check player gems ──────────────────────────────────────────────────────
    const walletRes = await client.query(
      "SELECT gems FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    const gems = parseInt(walletRes.rows[0]?.gems ?? "0");
    if (gems < totalCost) {
      await client.query("ROLLBACK");
      res.status(400).json({ success: false, message: `Need ${totalCost} gems. You have ${gems}.` });
      return;
    }

    // ── Deduct gems ────────────────────────────────────────────────────────────
    await client.query(
      "UPDATE wallets SET gems = gems - $1 WHERE user_id = $2",
      [totalCost, userId],
    );

    // ── Grant item ─────────────────────────────────────────────────────────────
    // world_lock / diamond_lock are wallet meta; everything else goes to inventory
    if (itemId === "world_lock") {
      await client.query(
        "UPDATE wallets SET world_locks = world_locks + $1 WHERE user_id = $2",
        [qty, userId],
      );
    } else if (itemId === "diamond_lock") {
      await client.query(
        "UPDATE wallets SET diamond_locks = diamond_locks + $1 WHERE user_id = $2",
        [qty, userId],
      );
    } else {
      await client.query(
        `INSERT INTO inventories (user_id, item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, item_id)
         DO UPDATE SET quantity = inventories.quantity + $3`,
        [userId, itemId, qty],
      );
    }

    const newWallet = await client.query(
      "SELECT gems FROM wallets WHERE user_id = $1",
      [userId],
    );
    await client.query("COMMIT");

    res.json({
      success:       true,
      message:       `Acquired ${qty}× ${cfg.displayName}`,
      newGemBalance: parseInt(newWallet.rows[0].gems),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Buy item error");
    res.status(500).json({ error: "Purchase failed" });
  } finally {
    client.release();
  }
});

export default router;
