/**
 * Self-registers the PostgreSQL connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { PostgresConnector } from './PostgresConnector';

export { PostgresConnector } from './PostgresConnector';
export { postgresConfigSchema } from './schema';
export { postgresDialect } from './dialect';

registerConnector(PostgresConnector);
