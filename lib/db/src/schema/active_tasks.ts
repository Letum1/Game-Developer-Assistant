import { pgTable, integer, varchar, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const activeTasksTable = pgTable("active_tasks", {
  userId: integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  taskType: varchar("task_type", { length: 50 }).notNull(),
  startedAt: timestamp("started_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
});

export type ActiveTask = typeof activeTasksTable.$inferSelect;
