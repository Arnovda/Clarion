import knex, { Knex } from 'knex';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

/**
 * Semantic layer database — PostgreSQL
 *
 * Uses `databridge_app` role (non-superuser, NOBYPASSRLS) so that
 * Row-Level Security policies are enforced. The superuser `databridge`
 * role is only used for migrations (via knexfile.ts).
 *
 * The app.current_tenant session variable is set by requireAuth middleware,
 * and RLS policies filter all queries to the authenticated tenant.
 */

const baseUrl = process.env.DATABASE_URL ?? 'postgresql://databridge:databridge@localhost:5432/databridge';

// Replace the superuser credentials with the app role for runtime queries
const appUrl = baseUrl.replace(
  /^postgresql:\/\/[^:]+:[^@]+@/,
  'postgresql://databridge_app:databridge@',
);

export const semanticDb: Knex = knex({
  client: 'pg',
  connection: appUrl,
});

// Source database — SQLite file on disk (read-only)
// Used to execute queries against the client's actual business data
export const sourceDb = (filePath: string): Knex =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: path.resolve(filePath) },
    useNullAsDefault: true,
  });
