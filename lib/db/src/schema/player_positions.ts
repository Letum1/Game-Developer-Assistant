// ============================================================
// player_positions.ts — Persists a player's (x, y) position per world.
// Allows resuming from where the player left off instead of always
// spawning at the surface of column 5.
//
// UNIQUE constraint on (user_id, world_name) so we can do an UPSERT
// (INSERT ... ON CONFLICT DO UPDATE) without a separate SELECT.
// ============================================================

import {
  pgTable,
  serial,
  integer,
  real,
  varchar,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const playerPositionsTable = pgTable(
  "player_positions",
  {
    id:        serial("id").primaryKey(),
    // Which player owns this position record
    userId:    integer("user_id")
                 .references(() => usersTable.id, { onDelete: "cascade" })
                 .notNull(),
    // Which named world the position belongs to (e.g. "START", "FARM")
    worldName: varchar("world_name", { length: 50 }).notNull(),
    // World-pixel coordinates saved when the player leaves or every 10 s
    x:         real("x").notNull().default(0),
    y:         real("y").notNull().default(0),
    // Last time this row was written — useful for analytics / stale-entry cleanup
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  // Composite unique index so ON CONFLICT (user_id, world_name) DO UPDATE works
  (t) => [unique().on(t.userId, t.worldName)],
);

export type PlayerPosition = typeof playerPositionsTable.$inferSelect;
