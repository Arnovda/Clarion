import knex, { Knex } from 'knex';
import path from 'path';
import dotenv from 'dotenv';

// Don't override env vars in test mode — setup.ts sets DATABASE_URL to test DB
if (!process.env.VITEST) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });
}

/**
 * Semantic layer database — PostgreSQL
 *
 * Uses `databridge_app` role (non-superuser, NOBYPASSRLS) so that
 * Row-Level Security policies are enforced. The superuser `databridge`
 * role is only used for migrations (via knexfile.ts).
 *
 * NB: the Postgres role is named `databridge` for historical reasons
 * (the project was originally called DataBridge). The brand was renamed
 * to Clarion but the role + DB names + Docker volumes were kept to avoid
 * a destructive rename of persisted state. See CLAUDE.md.
 *
 * The app.current_tenant session variable is set by requireAuth middleware,
 * and RLS policies filter all queries to the authenticated tenant.
 */

const baseUrl = process.env.DATABASE_URL ?? 'postgresql://databridge:databridge@localhost:5432/databridge';

// In production (Azure), use the admin role directly — databridge_app role
// is only created when RLS setup script runs. Locally, try app role if available.
const useAppRole = process.env.NODE_ENV !== 'production';
const connectionUrl = useAppRole
  ? baseUrl.replace(/^postgresql:\/\/[^:]+:[^@]+@/, 'postgresql://databridge_app:databridge@')
  : baseUrl;

// Azure Postgres requires SSL
const needsSsl = baseUrl.includes('azure.com') || baseUrl.includes('sslmode=require');

export const semanticDb: Knex = knex({
  client: 'pg',
  connection: needsSsl
    ? { connectionString: connectionUrl, ssl: { rejectUnauthorized: false } }
    : connectionUrl,
});

// Source database — SQLite file on disk (read-only)
// Used to execute queries against the client's actual business data
export const sourceDb = (filePath: string): Knex =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: path.resolve(filePath) },
    useNullAsDefault: true,
  });
