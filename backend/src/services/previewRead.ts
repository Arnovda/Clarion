/**
 * Sample rows for the catalog's "Sample" tabs — the ONE way a preview reads
 * a table, on either layer.
 *
 * Why this exists (2026-09-06 functional-requirements evaluation, defect 2):
 * `GET /semantic/product-preview` ran `SELECT * FROM "t" LIMIT n` for any
 * role with no data policy, so a viewer read the unmasked IBAN that Ask AI
 * masked for them one screen over. A star select cannot be masked — the
 * policy engine rewrites column REFERENCES, and `*` names none — so the
 * preview first learns the column list from a one-row probe, then runs an
 * explicit select through `prepareUserRead` (guard → the actor's row
 * filters and column masks). Masked columns keep their names (`'***' AS
 * iban`), so the table on screen has the same shape it always had.
 *
 * The probe row never leaves the process; only the policy-prepared result
 * is returned.
 */
import { prepareUserRead, type ReadActor } from './readPolicy';

export interface PreviewResult {
  rows: Record<string, unknown>[];
  columns: string[];
  /** How many of the actor's policies rewrote the query (0 for admins). */
  policiesApplied: number;
}

type ExecuteQuery = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/** Double-quote an identifier for DuckDB / Postgres / SQLite / MySQL-ANSI. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build the explicit preview select. Exported so the shape is pinned by a
 * test without a warehouse: every column named, never `*`.
 */
export function previewSql(tableName: string, columns: string[], limit: number): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 10, 50));
  return `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(tableName)} LIMIT ${safeLimit}`;
}

/**
 * Read up to `limit` rows of `tableName` as `actor` would be allowed to see
 * them. `tableName` MUST already be validated against the catalog by the
 * caller — this function quotes it but does not authorise it.
 */
export async function readPreviewRows(
  executeQuery: ExecuteQuery,
  tableName: string,
  limit: number,
  actor: ReadActor,
): Promise<PreviewResult> {
  const probe = await executeQuery(`SELECT * FROM ${quoteIdent(tableName)} LIMIT 1`);
  const columns = probe.rows.length ? Object.keys(probe.rows[0] as object) : [];
  if (columns.length === 0) return { rows: [], columns: [], policiesApplied: 0 };

  const prepared = await prepareUserRead(previewSql(tableName, columns, limit), actor);
  const result = await executeQuery(prepared.sql);
  return {
    rows: result.rows,
    columns: result.rows.length ? Object.keys(result.rows[0] as object) : columns,
    policiesApplied: prepared.policy.policiesApplied,
  };
}
