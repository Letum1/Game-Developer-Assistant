import { pgTable, integer, varchar, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const inventoriesTable = pgTable("inventories", {
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  itemId: varchar("item_id", { length: 50 }).notNull(),
  quantity: integer("quantity").default(0).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.itemId] }),
]);

export type InventoryItem = typeof inventoriesTable.$inferSelect;
