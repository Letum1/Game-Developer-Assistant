import { Router, type IRouter } from "express";
import { pool } from "../lib/db-pool";
import { GetWorldParams, GetWorldHeader } from "@workspace/api-zod";
import { WORLD_WIDTH, WORLD_HEIGHT } from "../lib/game-constants";

const router: IRouter = Router();

function generateDefaultGrid(): string[][] {
  const grid: string[][] = [];
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    const row: string[] = [];
    for (let x = 0; x < WORLD_WIDTH; x++) {
      if (y < 5) {
        row.push("air");
      } else if (y === 5) {
        row.push("block_grass");
      } else if (y < 10) {
        const r = Math.random();
        if (r < 0.05) row.push("block_iron");
        else row.push("block_dirt");
      } else if (y < 13) {
        const r = Math.random();
        if (r < 0.08) row.push("block_gold");
        else if (r < 0.15) row.push("block_iron");
        else if (r < 0.05) row.push("block_lava");
        else row.push("block_rock");
      } else {
        const r = Math.random();
        if (r < 0.06) row.push("block_diamond");
        else if (r < 0.15) row.push("block_gold");
        else row.push("block_rock");
      }
    }
    grid.push(row);
  }
  return grid;
}

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
      res.json({
        id: world.id,
        name: world.name,
        ownerId: world.owner_id,
        blockData: world.block_data,
      });
      return;
    }

    const grid = generateDefaultGrid();
    const inserted = await pool.query(
      "INSERT INTO worlds (name, owner_id, block_data) VALUES ($1, $2, $3) RETURNING *",
      [name, userId, JSON.stringify(grid)]
    );
    const world = inserted.rows[0];
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
