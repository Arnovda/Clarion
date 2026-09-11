/**
 * Self-registers the MySQL connector when this module is imported.
 * The package entry point (`../index.ts`) imports this file for the side effect.
 */

import { registerConnector } from '../registry';
import { MysqlConnector } from './MysqlConnector';

export { MysqlConnector } from './MysqlConnector';
export { mysqlConfigSchema } from './schema';
export { mysqlDialect } from './dialect';

registerConnector(MysqlConnector);
