/**
 * MySQL / MariaDB source connector. Behaviour is inherited from
 * `SqlSourceConnector`; this binds the dialect to a config schema.
 */

import { SqlSourceConnector } from '../sql/SqlSourceConnector';
import type { SqlDialect } from '../sql/types';
import { mysqlDialect } from './dialect';
import { mysqlConfigSchema } from './schema';

export class MysqlConnector extends SqlSourceConnector {
  readonly type = 'mysql';
  readonly displayName = 'MySQL';
  readonly configSchema = mysqlConfigSchema;
  protected readonly dialect: SqlDialect = mysqlDialect;

  /** The dolphin, reduced to one stroke so it reads at 20px. */
  readonly iconSvg =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2.6 15.6c2.5.3 4.6-.5 6.2-2.1 1.2-1.2 2-2.7 2.6-4.2.5 1.4 1.3 2.6 2.5 3.4 1.4 1 3 1.3 4.6 1.1-.5 1.5-1.5 2.8-2.9 3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M11.4 9.3c.9-2 2.4-3.5 4.4-4.2 1.3-.5 2.6-.5 3.9-.2.5.1.8.6.7 1.1-.1.5-.6.8-1.1.7-1-.2-1.9-.2-2.8.2-1.6.6-2.7 1.8-3.4 3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="17.3" cy="7.4" r="0.9" fill="currentColor"/></svg>';
}
