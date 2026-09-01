/**
 * The business key a SOURCE declares for one of its tables.
 *
 * Connectors have carried this on `EntityDescriptor.businessKey` since the
 * framework was built — the warehouse writer merges rows on it every sync.
 * The quality profiler was the one consumer that never asked, so it guessed
 * from the data instead and picked whichever column happened to be unique.
 * On ExactOnline's BankEntryLines that was `Created`, a timestamp, which then
 * scored 100% complete and 100% unique while identifying nothing.
 *
 * Precedence (docs/SOURCE_ONBOARDING.md's ladder, applied to keys):
 *   the user's own pick  >  the source's declaration  >  a name-shape guess
 *
 * Resolution is a static catalog lookup: no network, no AI, and a connector
 * type the registry does not know simply yields nothing.
 */
import { getConnector, type EntityBusinessKey } from '@databridge/connectors';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'declared-business-keys' });

/**
 * Every declared key for a connector type, keyed by LOWERCASED table name.
 *
 * Lowercased because the caller matches against warehouse table names, whose
 * casing can differ from the catalog's by the time a name has been through a
 * parquet header. A key that fails to match its own table is precisely the
 * failure this exists to remove, so it must not turn on casing.
 */
export function declaredBusinessKeys(connectorType: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!connectorType) return out;
  let keys: readonly EntityBusinessKey[] = [];
  try {
    const connector = getConnector(connectorType);
    // Legacy direct-database connections (SQLite/Postgres/…) have no
    // connector-framework entry and declare nothing — that is not an error,
    // it just means the fallback heuristic decides.
    if (!connector.getBusinessKeys) return out;
    keys = connector.getBusinessKeys([]);   // [] = the whole catalog
  } catch {
    return out;   // unknown connector type — nothing declared
  }
  for (const k of keys) out.set(k.entity.toLowerCase(), k.column);
  return out;
}

/** The declared key for one table, or null when the source does not say. */
export function declaredBusinessKeyFor(
  connectorType: string | null | undefined,
  tableName: string,
): string | null {
  const key = declaredBusinessKeys(connectorType).get(tableName.toLowerCase()) ?? null;
  if (key) log.debug({ connectorType, tableName, key }, 'business key resolved from the source declaration');
  return key;
}
