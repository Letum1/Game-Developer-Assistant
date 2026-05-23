// ============================================================
// game.ts — Core game action router (break blocks / place blocks)
// Anti-cheat: fatigue system + wizard challenge for rapid clickers.
// Machine detection: after any machine block is placed/broken, scans
// the world grid with BFS to find connected Data Rig clusters and
// updates the player's miner accordingly.
// ============================================================

import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GameActionBody, GameActionHeader } from "@workspace/api-zod";
import { BLOCK_REWARDS, MACHINE_BLOCK_TYPES, MINER_RATES } from "../lib/game-constants";

const router: IRouter = Router();

// ─── Anti-cheat: rolling window of action timestamps per user ───────────────
// Stored in-memory (resets on server restart — intentional for simplicity).
// Maps userId → array of action timestamps (ms since epoch).
const actionTimestamps: Map<number, number[]> = new Map();

// ─── Self-drop blocks: break returns the block itself to inventory ───────────
// Growtopia mechanic — players collect blocks and re-place them to build worlds.
const SELF_DROP_BLOCKS = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
  // Machine blocks always return themselves so players can rearrange their rigs
  "machine_core",
  "solar_panel_block",
  "data_cable",
]);

// ============================================================
// Helper: BFS scan to find the Data Rig connected to (startX, startY).
// A Data Rig is a cluster of machine_core + solar_panel_block + data_cable
// cells that are 4-directionally adjacent to each other.
// Returns { coreCount, solarCount } for the cluster.
// ============================================================
function scanMachineCluster(
  grid: string[][],
  startX: number,
  startY: number
): { coreCount: number; solarCount: number } {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  // BFS queue and visited set
  const visited = new Set<string>();
  const queue: [number, number][] = [[startX, startY]];
  visited.add(`${startX},${startY}`);

  let coreCount  = 0;
  let solarCount = 0;

  // 4-directional neighbors: up, down, left, right
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];

  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    const blk = grid[cy]?.[cx];

    if (!blk || !MACHINE_BLOCK_TYPES.has(blk)) continue;

    // Count component types in this cluster
    if (blk === "machine_core")      coreCount++;
    if (blk === "solar_panel_block") solarCount++;
    // data_cable connects but doesn't contribute to count

    // BFS into adjacent machine blocks
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (visited.has(key)) continue;
      if (!MACHINE_BLOCK_TYPES.has(grid[ny]?.[nx] ?? "")) continue;
      visited.add(key);
      queue.push([nx, ny]);
    }
  }

  return { coreCount, solarCount };
}

// ============================================================
// Helper: After any machine block placement/removal, scan the ENTIRE
// world for all machine clusters and update the user's miner.
// The user's miner is powered by the largest connected cluster that
// contains at least one machine_core AND one solar_panel_block.
// ============================================================
async function updateMinerFromWorld(
  client: Awaited<ReturnType<typeof pool.connect>>,
  userId: number,
  grid: string[][]
) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  // Track which cells we've already BFS'd so we don't double-count clusters
  const scanned = new Set<string>();

  let bestCores  = 0;
  let bestSolars = 0;

  // Scan every cell — for machine blocks, run BFS if not already visited
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const blk = grid[y][x];
      const key = `${x},${y}`;
      if (!MACHINE_BLOCK_TYPES.has(blk) || scanned.has(key)) continue;

      // BFS this cluster
      const { coreCount, solarCount } = scanMachineCluster(grid, x, y);

      // Mark all cells in this cluster as scanned (re-run BFS for marking)
      const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
      const mark: [number, number][] = [[x, y]];
      scanned.add(key);
      while (mark.length > 0) {
        const [cx, cy] = mark.shift()!;
        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          const nk = `${nx},${ny}`;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (scanned.has(nk)) continue;
          if (!MACHINE_BLOCK_TYPES.has(grid[ny]?.[nx] ?? "")) continue;
          scanned.add(nk);
          mark.push([nx, ny]);
        }
      }

      // Track the best (largest) valid cluster
      if (coreCount > 0 && solarCount > 0) {
        if (solarCount > bestSolars || (solarCount === bestSolars && coreCount > bestCores)) {
          bestCores  = coreCount;
          bestSolars = solarCount;
        }
      }
    }
  }

  // Calculate miner level from solar panel count (capped at 10)
  const active      = bestCores > 0 && bestSolars > 0;
  const level       = Math.min(10, Math.max(1, bestSolars));
  const ratePerSec  = active ? (MINER_RATES[level] ?? MINER_RATES[1]) : 0;

  if (active) {
    // Activate or upgrade the miner
    await client.query(
      `INSERT INTO miners (user_id, unlocked, is_running, level, rate_per_second, solar_panels)
       VALUES ($1, true, true, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET unlocked = true,
             is_running = true,
             level = GREATEST(miners.level, $2),
             rate_per_second = $3,
             solar_panels = $4`,
      [userId, level, ratePerSec, bestSolars]
    );
  } else {
    // No valid cluster — deactivate miner (don't destroy it, just pause)
    await client.query(
      `UPDATE miners SET is_running = false WHERE user_id = $1`,
      [userId]
    );
  }
}

// ============================================================
// POST /api/game/action
// Handles both "break" and "place" block actions.
// ============================================================
router.post("/game/action", async (req, res) => {

  // ── Auth: require x-user-id header ──────────────────────────────────────
  const headerParsed = GameActionHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  // ── Validate request body ────────────────────────────────────────────────
  const bodyParsed = GameActionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { actionType, worldName, x, y } = bodyParsed.data;

  // ── Anti-cheat: wizard challenge if >30 actions in 2 minutes ────────────
  const now        = Date.now();
  const twoMinAgo  = now - 2 * 60 * 1000;
  const prevTs     = actionTimestamps.get(userId) ?? [];
  const recent     = prevTs.filter((t) => t > twoMinAgo);
  recent.push(now);
  actionTimestamps.set(userId, recent);
  const wizardChallenge = recent.length > 30;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Load and lock wallet to prevent race conditions ──────────────────
    const walletRes = await client.query(
      "SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE",
      [userId]
    );
    if (walletRes.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Wallet not found" });
      return;
    }
    const wallet = walletRes.rows[0];

    // ── Fatigue: reduce point rewards as player grinds more this session ──
    // Actions 1–50 = full points, 51–100 = half, 101+ = 10%
    const currentActions = parseInt(wallet.action_count) + 1;
    let multiplier  = 1.0;
    let fatigueLevel = "full";
    if (currentActions > 100) { multiplier = 0.1; fatigueLevel = "exhausted"; }
    else if (currentActions > 50) { multiplier = 0.5; fatigueLevel = "tired"; }

    // ════════════════════════════════════════════════════════════════════════
    // BREAK ACTION — player destroys a block and receives rewards
    // ════════════════════════════════════════════════════════════════════════
    if (actionType === "break") {

      // Load world grid with row lock to prevent concurrent edits
      const worldRes = await client.query(
        "SELECT * FROM worlds WHERE name = $1 FOR UPDATE",
        [worldName]
      );
      if (worldRes.rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "World not found" });
        return;
      }

      const grid: string[][] = worldRes.rows[0].block_data;
      const block = grid[y]?.[x];

      // Validate target is a real, breakable block
      if (!block || block === "air") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Invalid block" });
        return;
      }

      // Calculate rewards (machine blocks give 0 gems/points — they are tools)
      const rewards      = BLOCK_REWARDS[block] ?? { gems: 1, points: 5 };
      const gemsGained   = Math.ceil(rewards.gems);
      const pointsGained = Math.round(rewards.points * multiplier);

      // Random resource drop roll
      let dropItem: string | null = null;
      if (rewards.drop && rewards.dropChance && Math.random() < rewards.dropChance) {
        dropItem = rewards.drop;
      }

      // Whether this block type returns itself to inventory when broken
      const isMachineBlock = MACHINE_BLOCK_TYPES.has(block);

      // Remove the block from world
      grid[y][x] = "air";
      await client.query(
        "UPDATE worlds SET block_data = $1 WHERE name = $2",
        [JSON.stringify(grid), worldName]
      );

      // Award gems and window_points if this block gives rewards
      if (gemsGained > 0 || pointsGained > 0) {
        await client.query(
          `UPDATE wallets
           SET gems = gems + $1,
               window_points = window_points + $2,
               action_count = action_count + 1
           WHERE user_id = $3`,
          [gemsGained, pointsGained, userId]
        );
      } else {
        // Still increment action count for anti-cheat tracking
        await client.query(
          "UPDATE wallets SET action_count = action_count + 1 WHERE user_id = $1",
          [userId]
        );
      }

      // Return the block to inventory (for self-drop types including machine blocks)
      if (SELF_DROP_BLOCKS.has(block)) {
        await client.query(
          `INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, 1)
           ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + 1`,
          [userId, block]
        );
      }

      // Return resource drop if one was rolled
      if (dropItem) {
        await client.query(
          `INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, 1)
           ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + 1`,
          [userId, dropItem]
        );
      }

      // If a machine block was broken, re-scan the world to update miner status
      if (isMachineBlock) {
        await updateMinerFromWorld(client, userId, grid);
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        gemsGained,
        pointsAwarded: pointsGained,
        dropItem: dropItem ?? block,
        currentActions,
        fatigueLevel,
        wizardChallenge,
      });

    // ════════════════════════════════════════════════════════════════════════
    // PLACE ACTION — player places a block from their inventory into the world
    // ════════════════════════════════════════════════════════════════════════
    } else if (actionType === "place") {
      const placeBlock = bodyParsed.data.placeBlock;
      if (!placeBlock) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Missing block type to place" });
        return;
      }

      // Verify player owns at least 1 of this block
      const invRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );
      if (invRes.rows.length === 0 || parseInt(invRes.rows[0].quantity) < 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Not enough blocks in inventory" });
        return;
      }

      // Load world with lock
      const worldRes = await client.query(
        "SELECT * FROM worlds WHERE name = $1 FOR UPDATE",
        [worldName]
      );
      if (worldRes.rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "World not found" });
        return;
      }

      const grid: string[][] = worldRes.rows[0].block_data;

      // Target cell must be empty
      if (grid[y]?.[x] !== "air") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Block space is occupied" });
        return;
      }

      // Place the block
      grid[y][x] = placeBlock;
      await client.query(
        "UPDATE worlds SET block_data = $1 WHERE name = $2",
        [JSON.stringify(grid), worldName]
      );

      // Deduct 1 from inventory
      await client.query(
        "UPDATE inventories SET quantity = quantity - 1 WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );

      // If a machine block was placed, scan world and update miner
      if (MACHINE_BLOCK_TYPES.has(placeBlock)) {
        await updateMinerFromWorld(client, userId, grid);
      }

      await client.query("COMMIT");

      // Tell the client whether a machine rig is now active (for toast)
      const isMachinePlaced = MACHINE_BLOCK_TYPES.has(placeBlock);
      res.json({
        success: true,
        gemsGained: null,
        pointsAwarded: null,
        dropItem: null,
        currentActions,
        fatigueLevel,
        wizardChallenge: false,
        machineUpdated: isMachinePlaced,
      });

    } else {
      // Unknown action type
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown action type" });
    }

  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Game action error");
    res.status(500).json({ error: "Game action failed" });
  } finally {
    client.release();
  }
});

export default router;
