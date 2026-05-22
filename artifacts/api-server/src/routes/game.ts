import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GameActionBody, GameActionHeader } from "@workspace/api-zod";
import { BLOCK_REWARDS } from "../lib/game-constants";

const router: IRouter = Router();

// ─── Anti-cheat: rolling window of action timestamps per user ───────────────
// Stored in memory (resets on server restart — intentional for simplicity)
const actionTimestamps: Map<number, number[]> = new Map();

// Which block types return themselves when broken (so players can place them back)
// Matches Growtopia's design: dirt/grass/rock are "world building" blocks
const SELF_DROP_BLOCKS = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
]);

router.post("/game/action", async (req, res) => {
  // ── Auth header check ────────────────────────────────────────────────────
  const headerParsed = GameActionHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }

  // ── Request body validation ──────────────────────────────────────────────
  const bodyParsed = GameActionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { actionType, worldName, x, y } = bodyParsed.data;

  // ── Wizard Challenge: detect rapid clicking (>30 actions in 2 minutes) ──
  const now = Date.now();
  const twoMinAgo = now - 2 * 60 * 1000;
  const prevTimestamps = actionTimestamps.get(userId) ?? [];
  // Keep only timestamps within last 2 minutes
  const recent = prevTimestamps.filter((t) => t > twoMinAgo);
  recent.push(now);
  actionTimestamps.set(userId, recent);
  // Trigger wizard challenge if player is clicking too fast
  const wizardChallenge = recent.length > 30;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Load wallet (locked for update to prevent race conditions) ──────────
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

    // ── Fatigue system: reduce points as player grinds more ─────────────────
    // Actions 1-50 = 100% points, 51-100 = 50%, 101+ = 10%
    const currentActions = parseInt(wallet.action_count) + 1;
    let multiplier = 1.0;
    let fatigueLevel = "full";
    if (currentActions > 100) {
      multiplier = 0.1;
      fatigueLevel = "exhausted";
    } else if (currentActions > 50) {
      multiplier = 0.5;
      fatigueLevel = "tired";
    }

    // ════════════════════════════════════════════════════════════════════════
    // BREAK ACTION — player punches a block until it's destroyed
    // ════════════════════════════════════════════════════════════════════════
    if (actionType === "break") {
      // Load world grid (locked for update to prevent concurrent modifications)
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

      // Validate the target block exists and isn't air
      if (!block || block === "air") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Invalid block" });
        return;
      }

      // Calculate gem/point rewards for this block type
      const rewards = BLOCK_REWARDS[block] ?? { gems: 1, points: 5 };
      const gemsGained = Math.ceil(rewards.gems);
      const pointsAwarded = Math.round(rewards.points * multiplier);

      // Check for random resource drop (e.g. raw_iron from iron ore)
      let dropItem: string | null = null;
      if (rewards.drop && rewards.dropChance && Math.random() < rewards.dropChance) {
        dropItem = rewards.drop;
      }

      // Remove the block from the world grid (set to air)
      grid[y][x] = "air";
      await client.query(
        "UPDATE worlds SET block_data = $1 WHERE name = $2",
        [JSON.stringify(grid), worldName]
      );

      // Award gems and window_points to the player's wallet
      await client.query(
        `UPDATE wallets
         SET gems = gems + $1,
             window_points = window_points + $2,
             action_count = action_count + 1
         WHERE user_id = $3`,
        [gemsGained, pointsAwarded, userId]
      );

      // ── Growtopia rule: always give the block itself back to inventory ────
      // This lets players collect blocks and re-place them to build/design worlds
      if (SELF_DROP_BLOCKS.has(block)) {
        await client.query(
          `INSERT INTO inventories (user_id, item_id, quantity)
           VALUES ($1, $2, 1)
           ON CONFLICT (user_id, item_id) DO UPDATE
           SET quantity = inventories.quantity + 1`,
          [userId, block]
        );
      }

      // ── Also give resource drop if one was rolled ─────────────────────────
      if (dropItem) {
        await client.query(
          `INSERT INTO inventories (user_id, item_id, quantity)
           VALUES ($1, $2, 1)
           ON CONFLICT (user_id, item_id) DO UPDATE
           SET quantity = inventories.quantity + 1`,
          [userId, dropItem]
        );
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        gemsGained,
        pointsAwarded,
        dropItem: dropItem ?? block,   // send drop info back to frontend
        currentActions,
        fatigueLevel,
        wizardChallenge,
      });

    // ════════════════════════════════════════════════════════════════════════
    // PLACE ACTION — player selects a block from inventory and places it
    // ════════════════════════════════════════════════════════════════════════
    } else if (actionType === "place") {
      const placeBlock = bodyParsed.data.placeBlock;
      if (!placeBlock) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Missing block type to place" });
        return;
      }

      // Verify player has at least 1 of this block in inventory
      const invRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );
      if (invRes.rows.length === 0 || parseInt(invRes.rows[0].quantity) < 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Not enough blocks in inventory" });
        return;
      }

      // Load world and verify target cell is empty (air)
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
      if (grid[y]?.[x] !== "air") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Block space is occupied" });
        return;
      }

      // Place the block and deduct 1 from inventory
      grid[y][x] = placeBlock;
      await client.query(
        "UPDATE worlds SET block_data = $1 WHERE name = $2",
        [JSON.stringify(grid), worldName]
      );
      await client.query(
        "UPDATE inventories SET quantity = quantity - 1 WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );

      await client.query("COMMIT");
      res.json({
        success: true,
        gemsGained: null,
        pointsAwarded: null,
        dropItem: null,
        currentActions,
        fatigueLevel,
        wizardChallenge: false,
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
