import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GetInventoryHeader } from "@workspace/api-zod";
import { ITEM_DISPLAY_NAMES, ITEM_CATEGORIES, CRAFTING_RECIPES } from "../lib/game-constants";

const router: IRouter = Router();

router.get("/inventory", async (req, res) => {
  const parsed = GetInventoryHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  try {
    const result = await pool.query(
      "SELECT item_id, quantity FROM inventories WHERE user_id = $1 AND quantity > 0 ORDER BY item_id",
      [userId]
    );
    const items = result.rows.map((r: { item_id: string; quantity: string }) => ({
      itemId: r.item_id,
      quantity: parseInt(r.quantity),
      displayName: ITEM_DISPLAY_NAMES[r.item_id] ?? r.item_id,
      category: ITEM_CATEGORIES[r.item_id] ?? "misc",
    }));
    res.json(items);
  } catch (err) {
    req.log.error({ err }, "Inventory error");
    res.status(500).json({ error: "Inventory error" });
  }
});

router.post("/inventory/craft", async (req, res) => {
  const parsed = GetInventoryHeader.safeParse(req.headers);
  if (!parsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const userId = parseInt(parsed.data["x-user-id"]);

  const body = req.body as { recipe?: string };
  const recipeName = body.recipe;
  if (!recipeName || !CRAFTING_RECIPES[recipeName]) {
    res.status(400).json({ success: false, message: "Unknown recipe" });
    return;
  }

  const recipe = CRAFTING_RECIPES[recipeName];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const ing of recipe.ingredients) {
      const r = await client.query(
        "SELECT quantity FROM inventories WHERE user_id = $1 AND item_id = $2 FOR UPDATE",
        [userId, ing.itemId]
      );
      const qty = r.rows[0] ? parseInt(r.rows[0].quantity) : 0;
      if (qty < ing.quantity) {
        await client.query("ROLLBACK");
        res.json({ success: false, message: `Need ${ing.quantity}x ${ITEM_DISPLAY_NAMES[ing.itemId] ?? ing.itemId} (have ${qty})` });
        return;
      }
    }

    for (const ing of recipe.ingredients) {
      await client.query(
        "UPDATE inventories SET quantity = quantity - $1 WHERE user_id = $2 AND item_id = $3",
        [ing.quantity, userId, ing.itemId]
      );
    }

    await client.query(
      `INSERT INTO inventories (user_id, item_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + EXCLUDED.quantity`,
      [userId, recipe.result, recipe.resultQty]
    );

    if (recipe.unlocksMiner) {
      await client.query(
        "UPDATE miners SET unlocked = true, is_running = true WHERE user_id = $1",
        [userId]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: recipe.unlocksMiner
        ? "Data Center Rig installed! Your miner is now online."
        : `${recipe.displayName} crafted successfully!`,
      result: recipe.result,
      unlocksMiner: recipe.unlocksMiner ?? false,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    req.log.error({ err }, "Craft error");
    res.status(500).json({ success: false, message: "Craft failed due to server error" });
  } finally {
    client.release();
  }
});

export default router;
