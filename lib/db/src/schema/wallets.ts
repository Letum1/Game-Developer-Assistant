import { pgTable, integer, numeric } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const walletsTable = pgTable("wallets", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  gems: integer("gems").default(0).notNull(),
  worldLocks: integer("world_locks").default(0).notNull(),
  diamondLocks: integer("diamond_locks").default(0).notNull(),
  realBalance: numeric("real_balance", { precision: 16, scale: 8 }).default("0").notNull(),
  windowPoints: numeric("window_points", { precision: 12, scale: 4 }).default("0").notNull(),
  actionCount: integer("action_count").default(0).notNull(),
});

export type Wallet = typeof walletsTable.$inferSelect;
