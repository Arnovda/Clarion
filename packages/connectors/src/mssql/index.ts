/**
 * Self-registers the SQL Server connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { MssqlConnector } from './MssqlConnector';

export { MssqlConnector } from './MssqlConnector';
export { mssqlConfigSchema } from './schema';
export { mssqlDialect } from './dialect';

registerConnector(MssqlConnector);
