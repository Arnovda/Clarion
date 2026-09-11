/**
 * PostgreSQL source connector.
 *
 * Everything is inherited from `SqlSourceConnector`; this file exists to bind
 * a dialect to a config schema and give the wizard a name and an icon. That is
 * the point of the kit — a new SQL source is a dialect, not a connector.
 */

import { SqlSourceConnector } from '../sql/SqlSourceConnector';
import type { SqlDialect } from '../sql/types';
import { postgresDialect } from './dialect';
import { postgresConfigSchema } from './schema';

export class PostgresConnector extends SqlSourceConnector {
  readonly type = 'postgres';
  readonly displayName = 'PostgreSQL';
  readonly configSchema = postgresConfigSchema;
  protected readonly dialect: SqlDialect = postgresDialect;

  /** The elephant, drawn as one path so it reads at 20px in the source grid. */
  readonly iconSvg =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2.4c-2.6 0-4.4.7-5.5 1.6C5.2 5 4.7 6.4 4.7 8c0 1.3.2 2.9.5 4.6.3 1.8.8 3.5 1.4 4.8.3.7.7 1.3 1.2 1.7.5.4 1.1.6 1.7.5.7-.1 1.2-.6 1.5-1.2.2-.4.3-.8.4-1.2.3.1.6.1.9.1s.6 0 .9-.1c.1.4.2.8.4 1.2.3.6.8 1.1 1.5 1.2.6.1 1.2-.1 1.7-.5.5-.4.9-1 1.2-1.7.6-1.3 1.1-3 1.4-4.8.3-1.7.5-3.3.5-4.6 0-1.6-.5-3-1.8-4C16.4 3.1 14.6 2.4 12 2.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path d="M9.3 8.4c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9Zm5.4 0c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9Z" fill="currentColor"/>' +
    '<path d="M12 12.2v5.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
}
