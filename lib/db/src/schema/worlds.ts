import { pgTable, serial, varchar, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const worldsTable = pgTable("worlds", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).unique().notNull(),
  ownerId: integer("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  // locked = true means only the owner can break/place blocks.
  // Players must spend a World Lock item to lock; owner can unlock any time.
  locked: boolean("locked").default(false).notNull(),
  blockData: jsonb("block_data").notNull(),
});

export type World = typeof worldsTable.$inferSelect;
