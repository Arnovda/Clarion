/**
 * Cross-source DuckDB session.
 *
 * Split out of matchMeasure so the measurement itself can be imported — and
 * unit-tested — without pulling in DuckDBConnector and, through it, the native
 * binding. Exactly the same reason semantic/fkVerification was split out of
 * SchemaProfiler: a pure function should not be reachable only through the
 * connector layer.
 */

import { DuckDBConnector } from '../connectors/DuckDBConnector';
import { listSourceTables } from './tableCatalog';
import { LEFT_VIEW, RIGHT_VIEW } from './matchMeasure';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'crossSourceSession' });

/**
 * Resolve two source tables that may live in different connections into ONE
 * DuckDB session.
 *
 * This is the piece that did not exist before: every other warehouse surface is
 * connection-scoped, because a single connection's tables were always enough.
 * Views get fixed neutral names rather than their real ones, so two sources that
 * both have a table called `Accounts` cannot collide.
 *
 * Ephemeral on purpose — this session is a one-off with scratch views, and
 * putting it in the shared pool would let its key collide with the
 * single-connection sessions every other surface reuses.
 */
export async function buildTwoSourceConnector(
  tenantId: number | undefined,
  left: { connectionId: number; tableName: string },
  right: { connectionId: number; tableName: string },
): Promise<DuckDBConnector | null> {
  const [leftTables, rightTables] = await Promise.all([
    listSourceTables(tenantId, left.connectionId),
    listSourceTables(tenantId, right.connectionId),
  ]);

  const l = leftTables.find((t) => t.tableName === left.tableName);
  const r = rightTables.find((t) => t.tableName === right.tableName);
  if (!l || !r) {
    log.warn({ left, right, foundLeft: !!l, foundRight: !!r }, 'cross-source table not materialised');
    return null;
  }

  const paths = new Map<string, string>([[LEFT_VIEW, l.uri], [RIGHT_VIEW, r.uri]]);
  return DuckDBConnector.ephemeral(l.uri, [LEFT_VIEW, RIGHT_VIEW], paths);
}
