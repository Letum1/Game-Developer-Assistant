// ============================================================
// world.ts — World CRUD, seeded procedural generation, and player-position persistence.
//
// Routes registered under /api (see routes/index.ts):
//   GET  /api/worlds              — list all world names (for WorldSelect UI)
//   GET  /api/world/:name         — load (or create) a world; returns saved player pos
//   POST /api/world/:name/position — upsert player's (x, y) position in a world
//   POST /api/world/:name/action   — handled in game.ts (break / place / plant etc.)
//
// World expand route has been REMOVED.  Worlds are now unlimited and free — players
// create new named worlds instead of paying gems to widen a single world.
// ============================================================

import { Router, type IRouter } from "express";
import { pool }                 from "../lib/db-pool";
import { GetWorldParams, GetWorldHeader } from "@workspace/api-zod";
import { WORLD_WIDTH, WORLD_HEIGHT }      from "../lib/game-constants";

const router: IRouter = Router();

// ── Seeded pseudo-random number generator ──────────────────────────────────
// Using FNV-1a to hash the world name into a 32-bit seed, then mulberry32
// as the PRNG.  Same world name → identical terrain every time, on any server.

function hashSeed(str: string): number {
  // FNV-1a offset basis and prime (32-bit)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

function makeRng(seed: number): () => number {
  // mulberry32 — fast, good distribution, deterministic
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// generateSeededGrid — builds a WORLD_WIDTH × WORLD_HEIGHT terrain grid.
//
// Row layout (same as the old random generator, but now reproducible):
//   y 0–3   = open sky
//   y 4     = tree trunks (sparse, seeded)
//   y 5     = grass surface
//   y 6–9   = dirt with iron veins
//   y 10–14 = rock with gold / iron / lava pockets
//   y 15+   = deep rock with diamond / gold / lava
// ============================================================
function generateSeededGrid(worldName: string): string[][] {
  // Always hash the UPPER-CASE name so "farm" and "FARM" produce the same world.
  const rng  = makeRng(hashSeed(worldName.toUpperCase()));
  const grid: string[][] = [];

  // Initialise with air
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    grid.push(new Array(WORLD_WIDTH).fill("air") as string[]);
  }

  // Choose tree column positions using the seeded RNG
  const treeColumns = new Set<number>();
  let tc = 2;
  while (tc < WORLD_WIDTH - 2) {
    treeColumns.add(tc);
    tc += 5 + Math.floor(rng() * 4);  // 5–8 column gap between trees
  }

  // Fill terrain column by column
  for (let x = 0; x < WORLD_WIDTH; x++) {
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (y < 4) {
        grid[y][x] = "air";
      } else if (y === 4) {
        // Tree trunk row — oak log where a tree was chosen, air otherwise
        grid[y][x] = treeColumns.has(x) ? "block_oak_log" : "air";
      } else if (y === 5) {
        grid[y][x] = "block_grass";
      } else if (y < 10) {
        // Shallow dirt layer with occasional iron
        const r = rng();
        grid[y][x] = r < 0.06 ? "block_iron" : "block_dirt";
      } else if (y < 15) {
        // Mid-depth rock — lava check FIRST so it is not shadowed by the iron check
        const r = rng();
        grid[y][x] = r < 0.04 ? "block_lava"
          : r < 0.10            ? "block_gold"
          : r < 0.22            ? "block_iron"
          :                       "block_rock";
      } else {
        // Deep layer — rare diamonds, moderate gold, occasional lava
        const r = rng();
        grid[y][x] = r < 0.03 ? "block_lava"
          : r < 0.10            ? "block_diamond"
          : r < 0.19            ? "block_gold"
          :                       "block_rock";
      }
    }
  }

  // Some trees get a second log block one row higher (two-block-tall trunk)
  for (const x of treeColumns) {
    if (rng() < 0.5) grid[3][x] = "block_oak_log";
  }

  return grid;
}

// ============================================================
// GET /worlds
// Returns all worlds with name, lock status, and ownerId so the
// WorldSelect UI can show active worlds and indicate which are locked.
// ============================================================
router.get("/worlds", async (req, res) => {
  try {
    const result = await pool.query<{ name: string; locked: boolean; owner_id: number | null }>(
      "SELECT name, locked, owner_id FROM worlds ORDER BY id ASC LIMIT 100"
    );
    res.json({
      worlds: result.rows.map((r) => ({
        name:    r.name,
        locked:  r.locked,
        ownerId: r.owner_id,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "World list error");
    res.status(500).json({ error: "Failed to list worlds" });
  }
});

// ============================================================
// GET /world/:name
// Loads a world by name.  Creates one with seeded terrain if it doesn't exist.
// Also returns the requesting player's last saved (x, y) position in that world
// (null if never visited) so the client can resume from where they left off.
// ============================================================
router.get("/world/:name", async (req, res) => {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const headerParsed = GetWorldHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }
  const paramsParsed = GetWorldParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid world name" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { name } = paramsParsed.data;

  try {
    // ── Load or create world ─────────────────────────────────────────────────
    let worldRow: { id: number; name: string; owner_id: number | null; locked: boolean; block_data: string[][] };

    const existing = await pool.query(
      "SELECT id, name, owner_id, locked, block_data FROM worlds WHERE name = $1",
      [name]
    );

    if (existing.rows.length > 0) {
      worldRow = existing.rows[0];

      // Give starter wood pickaxe to players who don't have one yet
      // (runs on every load so returning players before the pickaxe system also get one)
      const pickaxeCheck = await pool.query(
        `SELECT 1 FROM inventories
         WHERE user_id = $1 AND item_id LIKE 'pickaxe_%' AND quantity > 0 LIMIT 1`,
        [userId]
      );
      if (pickaxeCheck.rows.length === 0) {
        await pool.query(
          `INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, 'pickaxe_wood', 1)
           ON CONFLICT (user_id, item_id)
           DO UPDATE SET quantity = GREATEST(inventories.quantity, 1)`,
          [userId]
        );
      }
    } else {
      // ── Brand new world — generate terrain from world name seed ─────────────
      const grid = generateSeededGrid(name);
      const inserted = await pool.query(
        `INSERT INTO worlds (name, owner_id, block_data) VALUES ($1, $2, $3) RETURNING
           id, name, owner_id, block_data`,
        [name, userId, JSON.stringify(grid)]
      );
      worldRow = inserted.rows[0];

      // Give the first visitor starter items: wood pickaxe + 8 oak seeds
      await pool.query(
        `INSERT INTO inventories (user_id, item_id, quantity) VALUES
           ($1, 'pickaxe_wood', 1),
           ($1, 'seed_oak', 8)
         ON CONFLICT (user_id, item_id)
         DO UPDATE SET quantity = inventories.quantity + EXCLUDED.quantity`,
        [userId]
      );
    }

    // ── Load this player's saved position in the world ───────────────────────
    const posRes = await pool.query<{ x: number; y: number }>(
      "SELECT x, y FROM player_positions WHERE user_id = $1 AND world_name = $2",
      [userId, name]
    );
    const savedPosition = posRes.rows.length > 0
      ? { x: posRes.rows[0].x, y: posRes.rows[0].y }
      : null;

    res.json({
      id:            worldRow.id,
      name:          worldRow.name,
      ownerId:       worldRow.owner_id,
      locked:        (worldRow as any).locked ?? false,
      blockData:     worldRow.block_data,
      savedPosition, // null → client spawns at surface; {x,y} → client resumes position
    });
  } catch (err) {
    req.log.error({ err }, "World fetch error");
    res.status(500).json({ error: "World error" });
  }
});

// ============================================================
// POST /world/:name/lock
// Locks a world so only the owner can break/place blocks.
// Costs 1 World Lock (or Diamond Lock) item from the player's inventory.
// The caller automatically becomes the world owner if they created it first.
// ============================================================
router.post("/world/:name/lock", async (req, res) => {
  const headerParsed = GetWorldHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }

  const userId    = parseInt(headerParsed.data["x-user-id"]);
  const worldName = req.params.name as string;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch world — must exist
    const worldRes = await client.query(
      "SELECT id, owner_id, locked FROM worlds WHERE name = $1 FOR UPDATE",
      [worldName]
    );
    if (worldRes.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "World not found" });
      return;
    }
    const world = worldRes.rows[0];

    // If the world already has an owner and it's not this player, reject
    if (world.owner_id !== null && world.owner_id !== userId) {
      await client.query("ROLLBACK");
      res.status(403).json({ error: "Only the world owner can lock this world." });
      return;
    }

    if (world.locked) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "World is already locked." });
      return;
    }

    // Consume one World Lock or Diamond Lock from inventory
    const lockItem = await client.query(
      `SELECT item_id, quantity FROM inventories
       WHERE user_id = $1 AND item_id IN ('world_lock','diamond_lock') AND quantity > 0
       ORDER BY item_id ASC LIMIT 1`,
      [userId]
    );
    if (lockItem.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "You need a World Lock (500 💎) from the Store to lock this world." });
      return;
    }
    const lockRow = lockItem.rows[0];
    if (lockRow.quantity === 1) {
      await client.query("DELETE FROM inventories WHERE user_id=$1 AND item_id=$2", [userId, lockRow.item_id]);
    } else {
      await client.query("UPDATE inventories SET quantity=quantity-1 WHERE user_id=$1 AND item_id=$2", [userId, lockRow.item_id]);
    }

    // Lock the world and assign owner
    await client.query(
      "UPDATE worlds SET locked=TRUE, owner_id=$2 WHERE id=$1",
      [world.id, userId]
    );
    await client.query("COMMIT");
    res.json({ success: true, locked: true, message: "World locked! Only you can build here now." });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "World lock error");
    res.status(500).json({ error: "Failed to lock world" });
  } finally {
    client.release();
  }
});

// ============================================================
// POST /world/:name/unlock
// Unlocks a world. Only the owner can unlock it.
// The lock item is NOT refunded.
// ============================================================
router.post("/world/:name/unlock", async (req, res) => {
  const headerParsed = GetWorldHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }

  const userId    = parseInt(headerParsed.data["x-user-id"]);
  const worldName = req.params.name as string;

  try {
    const worldRes = await pool.query(
      "SELECT id, owner_id, locked FROM worlds WHERE name = $1",
      [worldName]
    );
    if (worldRes.rows.length === 0) {
      res.status(404).json({ error: "World not found" }); return;
    }
    const world = worldRes.rows[0];
    if (world.owner_id !== userId) {
      res.status(403).json({ error: "Only the world owner can unlock it." }); return;
    }
    if (!world.locked) {
      res.status(400).json({ error: "World is not locked." }); return;
    }
    await pool.query("UPDATE worlds SET locked=FALSE WHERE id=$1", [world.id]);
    res.json({ success: true, locked: false, message: "World unlocked. Everyone can build here again." });
  } catch (err) {
    req.log.error({ err }, "World unlock error");
    res.status(500).json({ error: "Failed to unlock world" });
  }
});

// ============================================================
// POST /world/:name/position
// Upserts the player's (x, y) world-pixel position for the named world.
// Called every 10 s while in-game and once on component unmount.
// ============================================================
router.post("/world/:name/position", async (req, res) => {
  const headerParsed = GetWorldHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  const userId    = parseInt(headerParsed.data["x-user-id"]);
  const worldName = req.params.name as string;
  const { x, y } = req.body as { x: unknown; y: unknown };

  // Basic validation — coordinates must be finite numbers
  if (typeof x !== "number" || typeof y !== "number" || !isFinite(x) || !isFinite(y)) {
    res.status(400).json({ error: "x and y must be finite numbers" });
    return;
  }

  try {
    await pool.query(
      `INSERT INTO player_positions (user_id, world_name, x, y, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, world_name)
       DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()`,
      [userId, worldName, x, y]
    );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Position save error");
    res.status(500).json({ error: "Failed to save position" });
  }
});

export default router;
