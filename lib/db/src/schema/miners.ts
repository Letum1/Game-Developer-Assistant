import { pgTable, integer, numeric, boolean, timestamp, date } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const minersTable = pgTable("miners", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  level: integer("level").default(1).notNull(),
  unlocked: boolean("unlocked").default(false).notNull(),
  currentBalance: numeric("current_balance", { precision: 20, scale: 10 }).default("0").notNull(),
  temperature: numeric("temperature", { precision: 5, scale: 2 }).default("0").notNull(),
  isRunning: boolean("is_running").default(true).notNull(),
  solarPanels: integer("solar_panels").default(0).notNull(),

  // ── Power sources (tracked separately) ───────────────────────────────────
  batteries: integer("batteries").default(0).notNull(),
  batteryCharge: integer("battery_charge").default(100).notNull(),
  generators: integer("generators").default(0).notNull(),
  fuel: integer("fuel").default(100).notNull(),

  // ── Cooling fans ─────────────────────────────────────────────────────────
  fans: integer("fans").default(0).notNull(),
  lastMaintenanceAt: timestamp("last_maintenance_at").defaultNow().notNull(),
  lastTickAt: timestamp("last_tick_at").defaultNow().notNull(),

  // ── Overcharge Drill boost ────────────────────────────────────────────────
  // drillBoostUntil: when set and in the future, ratePerSecond is multiplied by 1.5.
  // drillBoostToday: number of times the drill has been boosted today.
  // drillBoostReset: the calendar date when drillBoostToday was last reset.
  drillBoostUntil: timestamp("drill_boost_until"),
  drillBoostToday: integer("drill_boost_today").default(0).notNull(),
  drillBoostReset: date("drill_boost_reset"),

  // ── One-machine-core-per-player enforcement ───────────────────────────────
  // Set to true when the player places a machine_core; cleared when they break it.
  // Server rejects any attempt to place a second machine_core while this is true.
  hasMachineCore: boolean("has_machine_core").default(false).notNull(),
});

export type Miner = typeof minersTable.$inferSelect;
