/**
 * Schema loss on the topic layer — the D3 half of the ingestion assessment
 * that phase 1 delivers: a transformation that fails because a SOURCE column
 * vanished is not a bug in the SQL, it is a fact about the source that a
 * person must see. The AI repair may still run — for THIS run, in memory —
 * but the stored SQL stays as it was and the table carries the missing
 * column's name until someone decides.
 *
 * Why this file is pure: telling "the source lost a column" apart from "the
 * model wrote a column that never existed" is the whole decision, and it
 * has to be testable without DuckDB. The runner feeds it three facts:
 *
 *   • the DuckDB error text (which names the column),
 *   • whether the table had PUBLISHED before with this SQL — a query that
 *     compiled and ran on the previous refresh and fails to bind today did
 *     not change; its inputs did,
 *   • whether a column of that name still exists on ANY view in the session
 *     — a bookkeeping slip references a column that exists on a different
 *     alias; a vanished column exists nowhere.
 *
 * Both of the last two must hold. A first-ever run with a missing column is
 * a design slip (persist the repair, as before); a previously-good query
 * whose column is still present somewhere is an alias mistake (same).
 */

/** The column DuckDB could not bind, read off its error text. */
export function missingColumnFromError(message: string): string | null {
  const m = String(message ?? '');
  // Binder Error: Referenced column "Phone" not found in FROM clause!
  // Binder Error: Table "a" does not have a column named "Phone"
  // Binder Error: Values list "pe" does not have a column named "AccountCode"
  // Catalog Error: Column with name Phone does not exist!
  const patterns = [
    /Referenced column "([^"]+)" not found/i,
    // The shape DuckDB emits when the vanished column is also a SELECT
    // alias (`Country AS country`): "…referenced that exists in the SELECT
    // clause - but this column cannot be referenced before it is defined".
    // Met on the first real run of the core-loop test, not recalled.
    /Column "([^"]+)" referenced that exists in the SELECT clause/i,
    /does not have a column named "([^"]+)"/i,
    /Column with name ([A-Za-z_][A-Za-z0-9_]*) does not exist/i,
    /column "([^"]+)" (?:does not exist|not found)/i,
  ];
  for (const re of patterns) {
    const hit = re.exec(m);
    if (hit?.[1]) return hit[1];
  }
  return null;
}

export type FailureKind = 'schema_loss' | 'design_slip';

export interface FailureFacts {
  errorMessage: string;
  /** `delta_path` set: this SQL published at least once before. */
  publishedBefore: boolean;
  /** A column of that name exists on some registered view right now. */
  columnExistsSomewhere: boolean;
}

/**
 * The decision. `null` when the error names no column at all (a parse
 * error, a type conversion) — those keep the old repair-and-persist path.
 */
export function classifyBindFailure(f: FailureFacts): { kind: FailureKind; column: string } | null {
  const column = missingColumnFromError(f.errorMessage);
  if (!column) return null;
  if (f.publishedBefore && !f.columnExistsSomewhere) return { kind: 'schema_loss', column };
  return { kind: 'design_slip', column };
}

/** The sentence stored on the table and shown to the person who owns it. */
export function degradedReason(column: string, tableName: string): string {
  return `The source no longer provides the column "${column}", so ${tableName} was rebuilt without it. `
    + 'The stored SQL is unchanged: fix the query, or restore the column at the source, and run it again.';
}
