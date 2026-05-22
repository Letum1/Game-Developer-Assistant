import { Router, type IRouter } from "express";
import crypto from "crypto";
import { pool } from "../lib/db-pool";
import { RegisterBody, LoginBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, password } = parsed.data;
  try {
    const hash = crypto.createHash("sha256").update(password).digest("hex");

    const userRes = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username, hash]
    );
    const user = userRes.rows[0];

    await pool.query("INSERT INTO wallets (user_id) VALUES ($1)", [user.id]);
    await pool.query("INSERT INTO miners (user_id) VALUES ($1)", [user.id]);

    const startingItems = [
      ["pickaxe_wood", 1],
      ["seed_oak", 5],
      ["block_dirt", 20],
    ];
    for (const [itemId, qty] of startingItems) {
      await pool.query(
        "INSERT INTO inventories (user_id, item_id, quantity) VALUES ($1, $2, $3)",
        [user.id, itemId, qty]
      );
    }

    res.json({ success: true, userId: user.id, username: user.username });
  } catch {
    res.status(400).json({ error: "Username already taken" });
  }
});

router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { username, password } = parsed.data;
  try {
    const hash = crypto.createHash("sha256").update(password).digest("hex");
    const result = await pool.query(
      "SELECT id, username FROM users WHERE username = $1 AND password_hash = $2",
      [username, hash]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const user = result.rows[0];
    res.json({ success: true, userId: user.id, username: user.username });
  } catch (err) {
    req.log.error({ err }, "Login error");
    res.status(500).json({ error: "Login failed" });
  }
});

export default router;
