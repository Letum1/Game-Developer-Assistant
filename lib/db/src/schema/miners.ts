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

  // ── Power sources (now tracked separately) ────────────────────────────────
  // batteries: count of battery_block pieces in the cluster.
  //   - Charged by solar panels during the day.
  //   - Discharge at night to keep rigs running. Drain from battery_charge pool.
  batteries: integer("batteries").default(0).notNull(),
  // battery_charge: current stored energy (0–500 units). Charged by solar,
  //   drained at night to provide power. Separate from diesel fuel.
  batteryCharge: integer("battery_charge").default(100).notNull(),

  // generators: count of generator_block pieces in the cluster.
  //   - Diesel-powered; always on when fuel > 0, day OR night.
  //   - Drain from the `fuel` (diesel) pool.
  generators: integer("generators").default(0).notNull(),
  // fuel: diesel fuel for generator_block pieces (0–500 units).
  //   Replenished by using a Diesel Can item in the game world.
  fuel: integer("fuel").default(100).notNull(),

  // fans: number of fan_block pieces connected to the machine cluster.
  // Each fan reduces the temperature rise rate in the miner tick.
  fans: integer("fans").default(0).notNull(),
  lastMaintenanceAt: timestamp("last_maintenance_at").defaultNow().notNull(),
  lastTickAt: timestamp("last_tick_at").defaultNow().notNull(),
});

export type Miner = typeof minersTable.$inferSelect;
