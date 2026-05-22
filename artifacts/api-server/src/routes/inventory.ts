import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GetInventoryHeader } from "@workspace/api-zod";
import { ITEM_DISPLAY_NAMES, ITEM_CATEGORIES } from "../lib/game-constants";

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

export default router;
