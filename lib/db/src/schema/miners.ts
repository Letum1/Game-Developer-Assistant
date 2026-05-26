import { pgTable, integer, numeric, boolean, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const minersTable = pgTable("miners", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  level: integer("level").default(1).notNull(),
  unlocked: boolean("unlocked").default(false).notNull(),
  currentBalance: numeric("current_balance", { precision: 20, scale: 10 }).default("0").notNull(),
  temperature: numeric("temperature", { precision: 5, scale: 2 }).default("0").notNull(),
  isRunning: boolean("is_running").default(true).notNull(),
  solarPanels: integer("solar_panels").default(0).notNull(),
  generators: integer("generators").default(0).notNull(),
  fuel: integer("fuel").default(100).notNull(),
  // fans: number of fan_block pieces connected to the machine cluster.
  // Each fan reduces the temperature rise rate in the miner tick.
  fans: integer("fans").default(0).notNull(),
  lastMaintenanceAt: timestamp("last_maintenance_at").defaultNow().notNull(),
  lastTickAt: timestamp("last_tick_at").defaultNow().notNull(),
});

export type Miner = typeof minersTable.$inferSelect;
