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
 * The DATABASE_URL env var is the single source of truth — in every
 * environment it should point at the `databridge_app` role with the
 * appropriate password. See docs/runbooks/db-role-flip.md for the
 * one-time production cutover (Key Vault env update + restart).
 *
 * Earlier, this file rewrote the URL to swap the role to
 * `databridge_app` only in non-prod (NODE_ENV !== 'production'). That
 * was a transition shim while prod still ran as the admin role.
 * Removed now so the invariant "the backend always connects with
 * least privilege" holds at the code level too.
 *
 * NB: the Postgres role is named `databridge` for historical reasons
 * (the project was originally called DataBridge). The brand was renamed
 * to Clarion but the role + DB names + Docker volumes were kept to avoid
 * a destructive rename of persisted state. See CLAUDE.md.
 *
 * The app.current_tenant session variable is set by requireAuth middleware,
 * and RLS policies filter all queries to the authenticated tenant.
 */

const connectionUrl = process.env.DATABASE_URL
  ?? 'postgresql://databridge_app:databridge@localhost:5432/databridge';

// Azure Postgres requires SSL
const needsSsl = connectionUrl.includes('azure.com') || connectionUrl.includes('sslmode=require');

// Connection-pool sizing. Each backend replica AND each worker holds its own
// pool, so the sum across replicas must stay under Postgres max_connections
// (~50 on the B1ms tier). `KNEX_POOL_MAX` lets ops tune the per-process
// ceiling per environment; `acquireTimeoutMillis` makes a saturated pool
// FAIL FAST (a clear 500) instead of hanging the request indefinitely.
const poolMax = Number(process.env.KNEX_POOL_MAX ?? 10);
const poolMin = Number(process.env.KNEX_POOL_MIN ?? 2);

export const semanticDb: Knex = knex({
  client: 'pg',
  connection: needsSsl
    ? { connectionString: connectionUrl, ssl: { rejectUnauthorized: false } }
    : connectionUrl,
  pool: {
    min: Number.isFinite(poolMin) && poolMin >= 0 ? poolMin : 2,
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
    acquireTimeoutMillis: Number(process.env.KNEX_POOL_ACQUIRE_TIMEOUT_MS ?? 30000),
  },
});

// Source database — SQLite file on disk (read-only)
// Used to execute queries against the client's actual business data
export const sourceDb = (filePath: string): Knex =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: path.resolve(filePath) },
    useNullAsDefault: true,
  });
