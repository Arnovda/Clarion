/**
 * Microsoft SQL Server source connector. Behaviour is inherited from
 * `SqlSourceConnector`; this binds the dialect to a config schema.
 */

import { SqlSourceConnector } from '../sql/SqlSourceConnector';
import type { SqlDialect } from '../sql/types';
import { mssqlDialect } from './dialect';
import { mssqlConfigSchema } from './schema';

export class MssqlConnector extends SqlSourceConnector {
  readonly type = 'mssql';
  readonly displayName = 'SQL Server';
  readonly configSchema = mssqlConfigSchema;
  protected readonly dialect: SqlDialect = mssqlDialect;

  /**
   * A database drum. Microsoft's own SQL Server mark is trademarked and their
   * brand guidelines do not permit shipping it, so this is a recognisable
   * generic stand-in — the same call the platform already made for the Excel,
   * SharePoint and SQL Server tiles in `connectorIcons.tsx`.
   */
  readonly iconSvg =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="12" cy="5.6" rx="7.2" ry="2.8" stroke="currentColor" stroke-width="1.4"/>' +
    '<path d="M4.8 5.6v12.8c0 1.5 3.2 2.8 7.2 2.8s7.2-1.3 7.2-2.8V5.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M4.8 12c0 1.5 3.2 2.8 7.2 2.8s7.2-1.3 7.2-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
}
