/**
 * A product table's DECLARATION — the SELECT that builds it — validated,
 * compiled and previewed the same way every time.
 *
 * The catalog is the workspace now (docs/backlog/declarative-data-engineering.md,
 * revision 2): a curator edits a table's SQL in ONE editor, and Save is the one
 * verb. This module is the part of that contract every route shares, so the
 * three doors (save, preview, the assistant's proposal) cannot disagree about
 * what "valid" means:
 *
 *   1. GUARD — `assertSafeReadQuery`, before anything else. The SQL is
 *      authored by a person or by the model, and the session it will run in
 *      holds the storage credential; a `read_parquet('az://…other tenant…')`
 *      must be refused here, not discovered in a build.
 *   2. COMPILE — `DESCRIBE` the query in a real warehouse session for the
 *      product's connection. DuckDB binds every column at plan time, so a
 *      column that does not exist, a bad join or a syntax slip fails HERE,
 *      before it is stored — the "PUT /sql writes anything, the nightly build
 *      finds out" defect (D2 in the investigation).
 *   3. PREVIEW — the first rows, so a curator can see what the declaration
 *      produces before saving it.
 *
 * Deliberately the GUARD only, never `prepareUserRead`: a declaration must
 * show what the build produces, and the transformation runner builds from
 * unmasked rows. Policies are a reader concern; this is an authoring surface
 * (the same reasoning as products/cells.ts and refineChat.ts).
 */
import type { Knex } from 'knex';
import type { Database } from 'duckdb-async';
import { buildConnectionWarehouseSession } from './productWarehouse';
import { scopeOf } from './queryScope';
import { assertSafeReadQuery } from '../utils/sqlGuard';

export interface DeclaredColumn {
  name: string;
  type: string;
}

/** Guard the SQL and strip a trailing semicolon; throws UnsafeSqlError. */
export function prepareDeclaredSql(sql: string): string {
  return assertSafeReadQuery(sql).trim().replace(/;\s*$/, '');
}

/**
 * A DuckDB error is the point of a compile step — "column X does not exist"
 * is what the curator needs to read. But the same message can carry a
 * warehouse URI or a filesystem path; those never reach a client.
 */
export function sanitizeSqlError(raw: string): string {
  return raw
    .replace(/\b(?:az|abfss?|s3|gs|file):\/\/\S+/gi, '<storage path>')
    .replace(/(?:\/[\w.-]+){2,}\/?/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** One warehouse session for a product's connection. Caller closes it. */
export async function openDeclarationSession(
  db: Knex | Knex.Transaction,
  tenantId: number,
  connectionId: number,
): Promise<Database> {
  return buildConnectionWarehouseSession(db, scopeOf(tenantId, connectionId));
}

/** Bind the query without running it: the columns it would produce. */
export async function compileDeclaredSql(session: Database, innerSql: string): Promise<DeclaredColumn[]> {
  const rows = await session.all(
    `DESCRIBE SELECT * FROM (\n${innerSql}\n) AS _declaration`,
  ) as Array<{ column_name: string; column_type: string }>;
  return rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
}

/** The first rows the declaration produces, BigInt made JSON-safe. */
export async function previewDeclaredSql(
  session: Database,
  innerSql: string,
  limit = 12,
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const raw = await session.all(`SELECT * FROM (\n${innerSql}\n) AS _preview LIMIT ${n}`) as Record<string, unknown>[];
  const rows = raw.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
    return out;
  });
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}

/**
 * Every table and view the session can see, with its columns — the model's
 * "AVAILABLE SCHEMAS" block. Schema-qualified so two systems' `Accounts`
 * stay distinguishable; the bare name is what transformation SQL uses
 * (search_path resolves it), and the line says both.
 */
export async function describeSessionSchemas(session: Database): Promise<string> {
  const tables = await session.all(`
    SELECT table_schema, table_name FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      AND NOT table_name LIKE '\\_\\_%' ESCAPE '\\'
    ORDER BY table_schema, table_name
  `) as Array<{ table_schema: string; table_name: string }>;
  const blocks: string[] = [];
  for (const t of tables) {
    try {
      const cols = await session.all(
        `DESCRIBE "${String(t.table_schema).replace(/"/g, '""')}"."${String(t.table_name).replace(/"/g, '""')}"`,
      ) as Array<{ column_name: string; column_type: string }>;
      const colList = cols.map((c) => `${c.column_name} ${c.column_type}`).join(', ');
      blocks.push(`${t.table_name} (${t.table_schema}): ${colList}`);
    } catch { /* unreadable view — skip */ }
  }
  return blocks.join('\n');
}
