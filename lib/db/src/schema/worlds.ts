import { pgTable, serial, varchar, integer, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const worldsTable = pgTable("worlds", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).unique().notNull(),
  ownerId: integer("owner_id").references(() => usersTable.id, { onDelete: "set null" }),
  blockData: jsonb("block_data").notNull(),
});

export type World = typeof worldsTable.$inferSelect;
