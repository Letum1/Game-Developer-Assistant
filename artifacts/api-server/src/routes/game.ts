import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GameActionBody, GameActionHeader } from "@workspace/api-zod";
import { BLOCK_REWARDS } from "../lib/game-constants";

const router: IRouter = Router();

// Rolling window for wizard challenge detection (userId -> timestamps)
const actionTimestamps: Map<number, number[]> = new Map();

router.post("/game/action", async (req, res) => {
  const headerParsed = GameActionHeader.safeParse(req.headers);
  if (!headerParsed.success) {
    res.status(401).json({ error: "Missing user id" });
    return;
  }
  const bodyParsed = GameActionBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid action" });
    return;
  }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { actionType, worldName, x, y } = bodyParsed.data;

  // Rapid-fire detection: rolling 2-minute window
  const now = Date.now();
  const timestamps = actionTimestamps.get(userId) || [];
  const twoMinAgo = now - 2 * 60 * 1000;
  const recent = timestamps.filter(t => t > twoMinAgo);
  recent.push(now);
  actionTimestamps.set(userId, recent);

  let wizardChallenge = false;
  if (recent.length > 30) {
    // 30+ actions in 2 minutes = suspicious
    wizardChallenge = true;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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

    // Fatigue system
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

    if (actionType === "break") {
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

      if (!block || block === "air") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Invalid block" });
        return;
      }

      const rewards = BLOCK_REWARDS[block] || { gems: 1, points: 5 };
      const gemsGained = Math.ceil(rewards.gems);
      const pointsAwarded = Math.round(rewards.points * multiplier);

      let dropItem: string | null = null;
      if (rewards.drop && rewards.dropChance && Math.random() < rewards.dropChance) {
        dropItem = rewards.drop;
      }

      grid[y][x] = "air";
      await client.query(
        "UPDATE worlds SET block_data = $1 WHERE name = $2",
        [JSON.stringify(grid), worldName]
      );

      await client.query(
        "UPDATE wallets SET gems = gems + $1, window_points = window_points + $2, action_count = action_count + 1 WHERE user_id = $3",
        [gemsGained, pointsAwarded, userId]
      );

      if (dropItem) {
        await client.query(
          "INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, 1) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + 1",
          [userId, dropItem]
        );
      }

      await client.query("COMMIT");
      res.json({
        success: true,
        gemsGained,
        pointsAwarded,
        dropItem,
        currentActions,
        fatigueLevel,
        wizardChallenge,
      });
    } else if (actionType === "place") {
      const placeBlock = bodyParsed.data.placeBlock;
      if (!placeBlock) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Missing block type" });
        return;
      }

      // Check inventory
      const invRes = await client.query(
        "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );
      if (invRes.rows.length === 0 || invRes.rows[0].quantity < 1) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Not enough blocks in inventory" });
        return;
      }

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
        res.status(400).json({ error: "Block space occupied" });
        return;
      }

      grid[y][x] = placeBlock;
      await client.query("UPDATE worlds SET block_data = $1 WHERE name = $2", [JSON.stringify(grid), worldName]);
      await client.query(
        "UPDATE inventories SET quantity = quantity - 1 WHERE user_id = $1 AND item_id = $2",
        [userId, placeBlock]
      );

      await client.query("COMMIT");
      res.json({ success: true, gemsGained: null, pointsAwarded: null, dropItem: null, currentActions, fatigueLevel, wizardChallenge: false });
    } else {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown action" });
    }
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Game action error");
    res.status(500).json({ error: "Action failed" });
  } finally {
    client.release();
  }
});

export default router;
