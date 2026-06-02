// ============================================================
// game.ts — Core game action router
//
// Action types:
//   break — destroy a block, earn gems + possible resource drop
//   place — put a block from inventory into the world
//   plant — consume 1 seed_oak, place block_oak_sapling on solid ground
//   grow  — convert block_oak_sapling → block_oak_log (triggered by client timer ~15s)
//
// Anti-cheat: fatigue system + wizard challenge for rapid clickers.
// Machine detection: after any machine block is placed/broken, BFS scans
// the world grid to find connected Data Rig clusters and updates miner.
// ============================================================

import { Router, type IRouter } from "express";
import type { PoolClient } from "pg";
import { pool } from "../lib/db-pool";
import { GameActionBody, GameActionHeader } from "@workspace/api-zod";
import { BLOCK_REWARDS, MACHINE_BLOCK_TYPES, MINER_RATES, DIESEL_PER_CAN, MAX_FUEL } from "../lib/game-constants";

const router: IRouter = Router();

// ─── Anti-cheat: rolling window of action timestamps per user (in-memory) ────
const actionTimestamps: Map<number, number[]> = new Map();

// ─── Self-drop resolution helper ─────────────────────────────────────────────
// Returns the number of the block itself to drop back into inventory, or 0 if
// the block does not self-drop.
// selfDropQty in BLOCK_REWARDS can be:
//   number       → fixed quantity
//   [min, max]   → random integer in the inclusive range
//   undefined    → block does not self-drop (returns 0)
function resolveSelfDropQty(block: string): number {
  const qty = BLOCK_REWARDS[block]?.selfDropQty;
  if (qty === undefined) return 0;
  if (typeof qty === "number") return qty;
  // [min, max] tuple
  const [min, max] = qty;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ─── Oak tree blocks: breaking gives oak_wood (not the block itself) ─────────
const OAK_BLOCKS = new Set(["block_oak_log", "block_oak_sapling"]);

// ============================================================
// BFS: find the Data Rig cluster connected to (startX, startY).
//
// Returns per-block-type counts for the whole connected cluster:
//   coreCount      — machine_core blocks (rig brain / dashboard)
//   rigCount       — mining_rig blocks   (ASIC hardware, each = 1 TH, needs 1 power unit)
//   fanCount       — fan_block blocks    (cooling — reduce temperature rise)
//   solarCount     — solar_panel_block   (daytime-only power, each = 1 power unit)
//   batteryCount   — battery_block       (stores solar energy; powers rigs at night)
//   generatorCount — generator_block     (diesel-powered; always on when fuelled)
//
// Power demand = rigCount. Active rigs = min(rigCount, powerSupply).
// powerSupply = solar (if day) + batteries (if charged) + generators (if fuelled)
// ============================================================
function scanMachineCluster(
  grid: string[][], startX: number, startY: number
): { coreCount: number; rigCount: number; fanCount: number; solarCount: number; batteryCount: number; generatorCount: number } {
  const rows = grid.length, cols = grid[0]?.length ?? 0;
  const visited = new Set<string>();
  const queue: [number, number][] = [[startX, startY]];
  visited.add(`${startX},${startY}`);
  let coreCount = 0, rigCount = 0, fanCount = 0, solarCount = 0, batteryCount = 0, generatorCount = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    const blk = grid[cy]?.[cx];
    if (!blk || !MACHINE_BLOCK_TYPES.has(blk)) continue;
    if (blk === "machine_core")      coreCount++;
    if (blk === "mining_rig")        rigCount++;      // 1 TH each, needs 1 power unit
    if (blk === "fan_block")         fanCount++;      // reduces temperature rise
    if (blk === "solar_panel_block") solarCount++;    // daytime-only power unit
    if (blk === "battery_block")     batteryCount++;  // stores solar → powers rigs at night
    if (blk === "generator_block")   generatorCount++;// diesel power, always on when fuelled
    for (const [dx, dy] of dirs) {
      const nx = cx+dx, ny = cy+dy, key = `${nx},${ny}`;
      if (nx<0||ny<0||nx>=cols||ny>=rows||visited.has(key)) continue;
      if (!MACHINE_BLOCK_TYPES.has(grid[ny]?.[nx]??"")) continue;
      visited.add(key); queue.push([nx,ny]);
    }
  }
  return { coreCount, rigCount, fanCount, solarCount, batteryCount, generatorCount };
}

// ============================================================
// After any machine block change, scan the whole world, find the best
// connected cluster, and update the user's miner accordingly.
// ============================================================
async function updateMinerFromWorld(
  client: PoolClient,
  userId: number, grid: string[][]
) {
  const rows = grid.length, cols = grid[0]?.length ?? 0;
  const scanned = new Set<string>();
  // Best cluster = the one with the most rig blocks (compute power).
  // Ties broken by power supply; if still tied, first cluster found wins.
  let bestCores = 0, bestRigs = 0, bestFans = 0, bestSolars = 0, bestBatteries = 0, bestGenerators = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const blk = grid[y][x], key = `${x},${y}`;
      if (!MACHINE_BLOCK_TYPES.has(blk) || scanned.has(key)) continue;
      const { coreCount, rigCount, fanCount, solarCount, batteryCount, generatorCount } = scanMachineCluster(grid, x, y);
      // Pick the cluster with the most mining_rig blocks (total compute hardware).
      // Ties broken by total available power supply (solar + battery + generator).
      const totalPower = solarCount + batteryCount + generatorCount;
      const bestTotalPower = bestSolars + bestBatteries + bestGenerators;
      if (coreCount > 0 && (rigCount > bestRigs || (rigCount === bestRigs && totalPower > bestTotalPower))) {
        bestCores = coreCount; bestRigs = rigCount; bestFans = fanCount;
        bestSolars = solarCount; bestBatteries = batteryCount; bestGenerators = generatorCount;
      }
      // Mark all cells in this cluster as visited
      const mark: [number, number][] = [[x, y]]; scanned.add(key);
      while (mark.length > 0) {
        const [cx,cy] = mark.shift()!;
        for (const [dx,dy] of dirs) {
          const nx=cx+dx,ny=cy+dy,k2=`${nx},${ny}`;
          if (nx<0||ny<0||nx>=cols||ny>=rows||scanned.has(k2)) continue;
          if (!MACHINE_BLOCK_TYPES.has(grid[ny]?.[nx]??"")) continue;
          scanned.add(k2); mark.push([nx,ny]);
        }
      }
    }
  }

  // ── Determine if the rig should be running ──────────────────────────────
  // Conditions: at least one machine_core + at least one mining_rig + some power.
  // level column now stores rigCount (total mining_rig blocks placed).
  // active rigs = min(rigCount, powerSupply) — computed in the miner tick.
  // batteries and generators are now tracked in SEPARATE columns.
  const hasPowerSource = (bestSolars + bestBatteries + bestGenerators) > 0;
  if (bestCores > 0 && bestRigs > 0 && hasPowerSource) {
    await client.query(
      `UPDATE miners
         SET unlocked=true, is_running=true,
             level=$1, solar_panels=$2, batteries=$3, generators=$4, fans=$5
       WHERE user_id=$6`,
      [bestRigs, bestSolars, bestBatteries, bestGenerators, bestFans, userId]
    );
  } else if (bestCores === 0) {
    // No machine core at all — rig fully offline.
    await client.query(
      "UPDATE miners SET is_running=false, level=0, solar_panels=0, batteries=0, generators=0, fans=0 WHERE user_id=$1",
      [userId]
    );
  } else if (bestRigs === 0) {
    // Core exists but no mining_rig blocks placed — rig has no compute hardware.
    await client.query(
      "UPDATE miners SET is_running=false, level=0, fans=$1 WHERE user_id=$2",
      [bestFans, userId]
    );
  } else {
    // Core + rigs exist but no power source connected.
    await client.query(
      "UPDATE miners SET is_running=false, level=$1, solar_panels=0, batteries=0, generators=0, fans=$2 WHERE user_id=$3",
      [bestRigs, bestFans, userId]
    );
  }
}

// ============================================================
// POST /game/action
// ============================================================
router.post("/game/action", async (req, res) => {
  const headerParsed = GameActionHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }

  const bodyParsed = GameActionBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid request" }); return; }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { actionType, worldName, x, y } = bodyParsed.data;

  // ── Anti-cheat rolling rate limit ────────────────────────────────────────
  const now = Date.now();
  const ts = actionTimestamps.get(userId) ?? [];
  const recent = ts.filter(t => now - t < 60_000);
  recent.push(now);
  actionTimestamps.set(userId, recent);
  const wizardChallenge = recent.length > 120;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const walletRes = await client.query(
      "SELECT gems, action_count FROM wallets WHERE user_id=$1 FOR UPDATE", [userId]
    );
    if (walletRes.rows.length === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Wallet not found" }); return;
    }
    const currentActions = parseInt(walletRes.rows[0].action_count) + 1;
    const multiplier = currentActions > 100 ? 0.1 : currentActions > 50 ? 0.5 : 1.0;

    // ══════════════════════════════════════════════════════════════════════
    // BREAK — destroy block, earn rewards
    // ══════════════════════════════════════════════════════════════════════
    if (actionType === "break") {
      const worldRes = await client.query("SELECT * FROM worlds WHERE name=$1 FOR UPDATE", [worldName]);
      if (!worldRes.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({ error:"World not found" }); return; }

      const grid: string[][] = worldRes.rows[0].block_data;
      const block = grid[y]?.[x];
      if (!block || block === "air") { await client.query("ROLLBACK"); res.status(400).json({ error:"Invalid block" }); return; }

      const rewards = BLOCK_REWARDS[block] ?? { gems: 1, points: 5 };
      const gemsGained = Math.ceil(rewards.gems);
      const pointsGained = Math.round(rewards.points * multiplier);

      // ── Resolve what to drop ─────────────────────────────────────────────
      // Oak blocks (log + sapling) always drop 1 oak_wood (never themselves).
      // Other blocks may self-drop a variable quantity (e.g. dirt = 1–5),
      // and may also have a secondary item drop (ores, obsidian, etc.).
      let dropItem: string | null = null;
      let dropQty  = 1; // quantity of dropItem
      let selfQty  = 0; // how many of the block itself to return

      if (OAK_BLOCKS.has(block)) {
        // Oak log / sapling → always give 1 oak_wood
        dropItem = "oak_wood";
        dropQty  = 1;
      } else {
        // Self-drop (dirt 1–5, grass/rock/machines = 1, others = 0)
        selfQty = resolveSelfDropQty(block);
        // Secondary item drop (ores, obsidian, seeds, etc.)
        if (rewards.drop && rewards.dropChance && Math.random() < rewards.dropChance) {
          dropItem = rewards.drop;
          dropQty  = 1;
        }
      }

      grid[y][x] = "air";
      await client.query("UPDATE worlds SET block_data=$1 WHERE name=$2", [JSON.stringify(grid), worldName]);

      if (gemsGained > 0 || pointsGained > 0) {
        await client.query(
          `UPDATE wallets SET gems=gems+$1, window_points=window_points+$2, action_count=action_count+1 WHERE user_id=$3`,
          [gemsGained, pointsGained, userId]
        );
      } else {
        await client.query("UPDATE wallets SET action_count=action_count+1 WHERE user_id=$1", [userId]);
      }

      // Self-drop: put the block itself back into inventory (supports qty > 1)
      if (selfQty > 0) {
        await client.query(
          `INSERT INTO inventories (user_id,item_id,quantity) VALUES($1,$2,$3)
           ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=inventories.quantity+$3`,
          [userId, block, selfQty]
        );
      }

      // Primary / secondary drop item (oak_wood, raw_iron, obsidian, etc.)
      if (dropItem) {
        await client.query(
          `INSERT INTO inventories (user_id,item_id,quantity) VALUES($1,$2,$3)
           ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=inventories.quantity+$3`,
          [userId, dropItem, dropQty]
        );
      }
      // Oak log has a 25% seed bonus (encourages replanting)
      if (block === "block_oak_log" && Math.random() < 0.25) {
        await client.query(
          `INSERT INTO inventories (user_id,item_id,quantity) VALUES($1,'seed_oak',1)
           ON CONFLICT(user_id,item_id) DO UPDATE SET quantity=inventories.quantity+1`,
          [userId]
        );
      }

      // One-machine-core-per-player: clear the flag when any machine_core is broken.
      // This frees the player's slot so they can place a new core elsewhere.
      if (block === "machine_core") {
        await client.query(
          "UPDATE miners SET has_machine_core=false WHERE user_id=$1", [userId]
        );
      }

      // updateMinerFromWorld is best-effort — any error here must NOT roll back
      // the block break. The block is already removed from the world; silently
      // log the failure and let the transaction commit regardless.
      if (MACHINE_BLOCK_TYPES.has(block)) {
        try {
          await updateMinerFromWorld(client, userId, grid);
        } catch (minerErr) {
          req.log.warn({ minerErr }, "updateMinerFromWorld failed on break — miner state not updated but break committed");
        }
      }

      await client.query("COMMIT");
      // dropQty: how many of dropItem the player received (for toast display)
      // selfQty: how many of the block itself was returned to inventory
      res.json({ success:true, gemsGained, pointsAwarded:pointsGained, dropItem, dropQty, selfQty, currentActions, wizardChallenge });

    // ══════════════════════════════════════════════════════════════════════
    // PLACE — place block from inventory into world
    // ══════════════════════════════════════════════════════════════════════
    } else if (actionType === "place") {
      const placeBlock = bodyParsed.data.placeBlock;
      if (!placeBlock) { await client.query("ROLLBACK"); res.status(400).json({ error:"Missing block" }); return; }

      const invRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id=$1 AND item_id=$2", [userId, placeBlock]
      );
      if (!invRes.rows[0] || parseInt(invRes.rows[0].quantity) < 1) {
        await client.query("ROLLBACK"); res.status(400).json({ error:"Not enough blocks" }); return;
      }

      const worldRes = await client.query("SELECT * FROM worlds WHERE name=$1 FOR UPDATE", [worldName]);
      if (!worldRes.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({ error:"World not found" }); return; }

      const grid: string[][] = worldRes.rows[0].block_data;
      if (grid[y]?.[x] !== "air") { await client.query("ROLLBACK"); res.status(400).json({ error:"Space occupied" }); return; }

      // ── One-machine-core-per-player enforcement ──────────────────────────
      // Each player is allowed exactly one machine_core placed in any world.
      // Check the has_machine_core flag in the miners table; reject if already set.
      if (placeBlock === "machine_core") {
        const coreRes = await client.query(
          "SELECT has_machine_core FROM miners WHERE user_id=$1", [userId]
        );
        if (coreRes.rows[0]?.has_machine_core === true) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "You already have a Machine Core placed. Break your existing core first to place a new one." });
          return;
        }
        // Reserve the slot — updated to true after writing to world below
      }

      grid[y][x] = placeBlock;
      await client.query("UPDATE worlds SET block_data=$1 WHERE name=$2", [JSON.stringify(grid), worldName]);
      await client.query(
        "UPDATE inventories SET quantity=quantity-1 WHERE user_id=$1 AND item_id=$2", [userId, placeBlock]
      );

      // Set the one-per-player flag now that the core is written to the world.
      if (placeBlock === "machine_core") {
        await client.query(
          "UPDATE miners SET has_machine_core=true WHERE user_id=$1", [userId]
        );
      }

      // updateMinerFromWorld is best-effort — any SQL error here must NOT roll
      // back the block placement. The block is already written to the world;
      // the miner-state sync is a bonus that cannot be allowed to undo the placement.
      // This defensive wrapper also protects against stale compiled bundles on
      // artifact preview workflows that may not have been restarted after schema fixes.
      const isMachine = MACHINE_BLOCK_TYPES.has(placeBlock);
      if (isMachine) {
        try {
          await updateMinerFromWorld(client, userId, grid);
        } catch (minerErr) {
          req.log.warn({ minerErr }, "updateMinerFromWorld failed on place — miner state not updated but placement committed");
        }
      }

      await client.query("COMMIT");
      res.json({ success:true, gemsGained:null, pointsAwarded:null, dropItem:null, currentActions, wizardChallenge:false, machineUpdated:isMachine });

    // ══════════════════════════════════════════════════════════════════════
    // PLANT — consume seed_oak, place block_oak_sapling on solid ground
    // ══════════════════════════════════════════════════════════════════════
    } else if (actionType === "plant") {
      const seedRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id=$1 AND item_id='seed_oak' FOR UPDATE", [userId]
      );
      if (!seedRes.rows[0] || parseInt(seedRes.rows[0].quantity) < 1) {
        await client.query("ROLLBACK"); res.json({ success:false, error:"No oak seeds in inventory" }); return;
      }

      const worldRes = await client.query("SELECT * FROM worlds WHERE name=$1 FOR UPDATE", [worldName]);
      if (!worldRes.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({ error:"World not found" }); return; }

      const grid: string[][] = worldRes.rows[0].block_data;
      if (grid[y]?.[x] !== "air") {
        await client.query("ROLLBACK"); res.json({ success:false, error:"Cannot plant here — space is occupied" }); return;
      }
      const below = grid[y+1]?.[x];
      if (!below || below === "air") {
        await client.query("ROLLBACK"); res.json({ success:false, error:"Must plant on solid ground" }); return;
      }

      grid[y][x] = "block_oak_sapling";
      await client.query("UPDATE worlds SET block_data=$1 WHERE name=$2", [JSON.stringify(grid), worldName]);
      await client.query(
        "UPDATE inventories SET quantity=quantity-1 WHERE user_id=$1 AND item_id='seed_oak'", [userId]
      );
      await client.query("UPDATE wallets SET action_count=action_count+1 WHERE user_id=$1", [userId]);

      await client.query("COMMIT");
      res.json({ success:true, gemsGained:0, pointsAwarded:0, dropItem:null, currentActions, wizardChallenge:false });

    // ══════════════════════════════════════════════════════════════════════
    // GROW — sapling matures into a full oak log (called by client ~15s timer)
    // Optionally also places a second log block one row above for a 2-tall tree.
    // ══════════════════════════════════════════════════════════════════════
    } else if (actionType === "grow") {
      const worldRes = await client.query("SELECT * FROM worlds WHERE name=$1 FOR UPDATE", [worldName]);
      if (!worldRes.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({ error:"World not found" }); return; }

      const grid: string[][] = worldRes.rows[0].block_data;
      if (grid[y]?.[x] !== "block_oak_sapling") {
        // Already broken or grown — silent success
        await client.query("ROLLBACK");
        res.json({ success:true, gemsGained:0, pointsAwarded:0, dropItem:null, currentActions, wizardChallenge:false });
        return;
      }

      grid[y][x] = "block_oak_log";
      // Grow an extra block above if that cell is open (2-block tree)
      if (y > 0 && grid[y-1]?.[x] === "air") {
        grid[y-1][x] = "block_oak_log";
      }

      await client.query("UPDATE worlds SET block_data=$1 WHERE name=$2", [JSON.stringify(grid), worldName]);
      await client.query("COMMIT");
      res.json({ success:true, gemsGained:0, pointsAwarded:0, dropItem:null, currentActions, wizardChallenge:false });

    // ══════════════════════════════════════════════════════════════════════
    // REFUEL — consume 1 diesel_can from inventory, add fuel to miner.
    // Player must click on a generator_block or battery_block in the world.
    // ══════════════════════════════════════════════════════════════════════
    } else if (actionType === "refuel") {
      // Verify player has at least 1 diesel_can
      const canRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id=$1 AND item_id='diesel_can' FOR UPDATE",
        [userId]
      );
      if (!canRes.rows[0] || parseInt(canRes.rows[0].quantity) < 1) {
        await client.query("ROLLBACK");
        res.json({ success: false, error: "No diesel can in inventory" });
        return;
      }

      // Verify the target block is a generator or battery
      const worldRes = await client.query("SELECT block_data FROM worlds WHERE name=$1", [worldName]);
      if (!worldRes.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "World not found" });
        return;
      }
      const grid: string[][] = worldRes.rows[0].block_data;
      const targetBlock = grid[y]?.[x];
      if (targetBlock !== "generator_block" && targetBlock !== "battery_block") {
        await client.query("ROLLBACK");
        res.json({ success: false, error: "No generator or battery at that position" });
        return;
      }

      // Consume one diesel_can from inventory
      await client.query(
        "UPDATE inventories SET quantity=quantity-1 WHERE user_id=$1 AND item_id='diesel_can'",
        [userId]
      );

      // Add DIESEL_PER_CAN fuel to miner, capped at MAX_FUEL
      await client.query(
        "UPDATE miners SET fuel = LEAST(fuel + $1, $2) WHERE user_id=$3",
        [DIESEL_PER_CAN, MAX_FUEL, userId]
      );

      await client.query("COMMIT");
      res.json({ success: true, gemsGained: null, pointsAwarded: null, dropItem: null, currentActions, wizardChallenge: false });

    } else {
      await client.query("ROLLBACK");
      res.status(400).json({ error:"Unknown action type" });
    }

  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Game action error");
    res.status(500).json({ error:"Game action failed" });
  } finally {
    client.release();
  }
});

export default router;
