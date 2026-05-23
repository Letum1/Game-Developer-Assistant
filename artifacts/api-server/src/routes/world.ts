import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GetWorldParams, GetWorldHeader } from "@workspace/api-zod";
import { WORLD_WIDTH, WORLD_HEIGHT } from "../lib/game-constants";

const router: IRouter = Router();

// ============================================================
// generateDefaultGrid — builds a 40×25 world with terrain layers.
//
// Rows:
//   0–3  = open sky (air)
//   4    = optional oak tree trunks (block_oak_log)
//   5    = grass surface
//   6–9  = dirt with iron veins
//   10–14 = rock with gold/iron veins
//   15–24 = deep rock with diamond/gold/lava
//
// Trees are scattered ~1 per 5–8 columns, placed at y=4 (on top of grass).
// Some trees are 2-blocks tall (log at y=3 and y=4).
// ============================================================
function generateDefaultGrid(): string[][] {
  const grid: string[][] = [];

  // Fill entire grid with air first
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    grid.push(Array(WORLD_WIDTH).fill("air"));
  }

  // ── Decide where trees go (before filling terrain so we can skip those cols)
  const treeColumns = new Set<number>();
  for (let x = 2; x < WORLD_WIDTH - 2; x += 5 + Math.floor(Math.random() * 4)) {
    treeColumns.add(x);
  }

  // ── Terrain layers ──────────────────────────────────────────────────────
  for (let x = 0; x < WORLD_WIDTH; x++) {
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      if (y < 4) {
        // Sky — stays air (trees placed separately below)
        grid[y][x] = "air";
      } else if (y === 4) {
        // Tree trunk row — place oak log at tree columns, air elsewhere
        grid[y][x] = treeColumns.has(x) ? "block_oak_log" : "air";
      } else if (y === 5) {
        // Grass surface row
        grid[y][x] = "block_grass";
      } else if (y < 10) {
        // Shallow dirt with iron veins
        const r = Math.random();
        if      (r < 0.06)  grid[y][x] = "block_iron";
        else                 grid[y][x] = "block_dirt";
      } else if (y < 15) {
        // Mid-depth rock with gold and iron
        const r = Math.random();
        if      (r < 0.06)  grid[y][x] = "block_gold";
        else if (r < 0.14)  grid[y][x] = "block_iron";
        else if (r < 0.04)  grid[y][x] = "block_lava";
        else                grid[y][x] = "block_rock";
      } else {
        // Deep rock with diamonds
        const r = Math.random();
        if      (r < 0.07)  grid[y][x] = "block_diamond";
        else if (r < 0.16)  grid[y][x] = "block_gold";
        else if (r < 0.03)  grid[y][x] = "block_lava";
        else                grid[y][x] = "block_rock";
      }
    }
  }

  // ── Tall trees: some columns get a second log block one row above (y=3) ──
  for (const x of treeColumns) {
    if (Math.random() < 0.5) {
      grid[3][x] = "block_oak_log"; // two-block-tall trunk
    }
  }

  return grid;
}

// ============================================================
// GET /world/:name
// Loads a world by name. If it doesn't exist, generates a fresh one and
// also gives the requesting user their starter items (oak seeds + wood pickaxe).
// ============================================================
router.get("/world/:name", async (req, res) => {
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
    const existing = await pool.query("SELECT * FROM worlds WHERE name = $1", [name]);
    if (existing.rows.length > 0) {
      const world = existing.rows[0];

      // ── Give starter pickaxe_wood if player has no pickaxe ────────────────
      // Checked on every load so returning players who predate the pickaxe system also get one.
      const pickaxeCheck = await pool.query(
        `SELECT 1 FROM inventories WHERE user_id = $1 AND item_id LIKE 'pickaxe_%' AND quantity > 0 LIMIT 1`,
        [userId]
      );
      if (pickaxeCheck.rows.length === 0) {
        await pool.query(
          `INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, 'pickaxe_wood', 1)
           ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = GREATEST(inventories.quantity, 1)`,
          [userId]
        );
      }

      res.json({
        id: world.id,
        name: world.name,
        ownerId: world.owner_id,
        blockData: world.block_data,
      });
      return;
    }

    // ── Brand new world: generate terrain and give starter items ───────────
    const grid = generateDefaultGrid();
    const inserted = await pool.query(
      "INSERT INTO worlds (name, owner_id, block_data) VALUES ($1, $2, $3) RETURNING *",
      [name, userId, JSON.stringify(grid)]
    );
    const world = inserted.rows[0];

    // Give new player starter items: wood pickaxe + 8 oak seeds
    await pool.query(
      `INSERT INTO inventories (user_id, item_id, quantity) VALUES
         ($1, 'pickaxe_wood', 1),
         ($1, 'seed_oak', 8)
       ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + EXCLUDED.quantity`,
      [userId]
    );

    res.json({
      id: world.id,
      name: world.name,
      ownerId: world.owner_id,
      blockData: world.block_data,
    });
  } catch (err) {
    req.log.error({ err }, "World fetch error");
    res.status(500).json({ error: "World error" });
  }
});

export default router;
