/**
 * Config schema for the PostgreSQL source connector — the shared SQL shape
 * with Postgres's own wording for the schema selector and SSL.
 */

import { sqlConfigSchema } from '../sql/configSchema';

export const postgresConfigSchema = sqlConfigSchema({
  id: 'postgres',
  displayName: 'PostgreSQL',
  defaultPort: 5432,
  schemaField: {
    title: 'Schema',
    description: 'Which schema to read. Defaults to "public".',
    default: 'public',
  },
  sslField: {
    title: 'Use SSL',
    description: 'Required by most managed PostgreSQL services (Azure Database, RDS, Neon, Supabase).',
  },
});
