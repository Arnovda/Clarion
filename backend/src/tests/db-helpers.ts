/**
 * Database helpers for tests — setup, teardown, cleanup.
 */

import knex, { Knex } from 'knex';
import path from 'path';

let _db: Knex | null = null;

/** Get a superuser connection to the test database (for migrations and cleanup) */
export function getTestDb(): Knex {
  if (!_db) {
    _db = knex({
      client: 'pg',
      connection: process.env.DATABASE_URL,
      pool: { min: 1, max: 3 },
    });
  }
  return _db;
}

/** Run all migrations on the test database */
export async function migrateTestDb() {
  const db = getTestDb();
  await db.migrate.latest({
    directory: path.resolve(__dirname, '../db/migrations'),
    extension: 'ts',
  });
}

/** Truncate all data tables (preserving schema) in correct FK order */
export async function cleanTestDb() {
  const db = getTestDb();
  // Disable triggers temporarily to avoid FK issues during truncation
  await db.raw(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
      ) LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

/** Close the test database connection */
export async function closeTestDb() {
  if (_db) {
    await _db.destroy();
    _db = null;
  }
}
