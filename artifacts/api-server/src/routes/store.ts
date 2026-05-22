import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { BuyItemHeader, BuyItemBody } from "@workspace/api-zod";
import { STORE_ITEMS } from "../lib/game-constants";

const router: IRouter = Router();

router.get("/store", (_req, res) => {
  res.json(STORE_ITEMS);
});

router.post("/store/buy", async (req, res) => {
  const headerParsed = BuyItemHeader.safeParse(req.headers);
  if (!headerParsed.success) { res.status(401).json({ error: "Missing user id" }); return; }
  const bodyParsed = BuyItemBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

  const userId = parseInt(headerParsed.data["x-user-id"]);
  const { itemId, quantity } = bodyParsed.data;

  const storeItem = STORE_ITEMS.find(i => i.itemId === itemId);
  if (!storeItem) {
    res.status(400).json({ error: "Item not found in store" });
    return;
  }

  const totalCost = storeItem.gemCost * quantity;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const walletRes = await client.query("SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE", [userId]);
    const wallet = walletRes.rows[0];

    if (parseInt(wallet.gems) < totalCost) {
      await client.query("ROLLBACK");
      res.status(400).json({
        success: false,
        message: `Need ${totalCost} gems. You have ${wallet.gems}.`,
        newGemBalance: null,
      });
      return;
    }

    await client.query("UPDATE wallets SET gems = gems - $1 WHERE user_id = $2", [totalCost, userId]);

    // Handle special items
    if (itemId === "world_lock") {
      await client.query("UPDATE wallets SET world_locks = world_locks + $1 WHERE user_id = $2", [quantity, userId]);
    } else if (itemId === "diamond_lock") {
      await client.query("UPDATE wallets SET diamond_locks = diamond_locks + $1 WHERE user_id = $2", [quantity, userId]);
    } else if (itemId === "solar_panel") {
      await client.query("UPDATE miners SET solar_panels = solar_panels + $1 WHERE user_id = $2", [quantity, userId]);
    } else if (itemId === "generator") {
      await client.query("UPDATE miners SET generators = generators + $1 WHERE user_id = $2", [quantity, userId]);
    } else {
      await client.query(
        "INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventories.quantity + $3",
        [userId, itemId, quantity]
      );
    }

    const newWallet = await client.query("SELECT gems FROM wallets WHERE user_id = $1", [userId]);
    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Bought ${quantity}x ${storeItem.displayName}`,
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
