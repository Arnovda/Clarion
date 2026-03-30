import knex, { Knex } from 'knex';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

// Semantic layer database — PostgreSQL running in Docker
// Used for all platform metadata: definitions, KPIs, query log, gaps
export const semanticDb: Knex = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
});

// Source database — SQLite file on disk (read-only)
// Used to execute queries against the client's actual business data
export const sourceDb = (filePath: string): Knex =>
  knex({
    client: 'better-sqlite3',
    connection: { filename: path.resolve(filePath) },
    useNullAsDefault: true,
  });
