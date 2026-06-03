// ============================================================
// startup-migrations.ts — Safe, idempotent DB column additions
//
// Runs once at server startup via ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
// Safe to run repeatedly — Postgres silently skips columns that already exist.
//
// ADD NEW MIGRATIONS HERE (append to the array) — never remove old ones,
// since older deployments might not have run them yet.
// ============================================================

import { pool } from "./db-pool";
import { logger } from "./logger";

/** List of raw SQL migration statements to run at startup. */
const MIGRATIONS: string[] = [
  // Moderation columns — added when ban/mute/admin system was introduced
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS adblock_detected BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned         BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_muted          BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin          BOOLEAN NOT NULL DEFAULT FALSE",
];

/**
 * Runs all startup migrations in sequence.
 * Each statement is wrapped in its own try/catch so one failure doesn't
 * prevent the rest from running.
 */
export async function runStartupMigrations(): Promise<void> {
  for (const sql of MIGRATIONS) {
    try {
      await pool.query(sql);
    } catch (err) {
      // Log but don't crash — the server can still function if a column exists
      logger.error({ err, sql }, "Startup migration failed");
    }
  }
  logger.info({ count: MIGRATIONS.length }, "Startup migrations applied");
}
