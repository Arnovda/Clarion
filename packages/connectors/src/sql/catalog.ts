/**
 * Introspection rows → the entity catalog the platform syncs.
 *
 * This is where a customer's own database becomes a Clarion source. Unlike a
 * vendor API, whose catalog is curated at build time and identical for every
 * customer, a SQL schema is bespoke — so the catalog is DISCOVERED on every
 * connect. Two consequences are designed for here:
 *
 *   • **Names must be stable across runs.** An entity name is persisted in
 *     `connections.selected_entities` and is the warehouse table name, so a
 *     name that moved between syncs would orphan everything built on it.
 *     Sanitisation is deterministic and the input is sorted before deduping,
 *     so the same schema always yields the same names.
 *
 *   • **Source names and warehouse names both have to survive.** A column
 *     called `Order Date` cannot be a Parquet header, but it is still what the
 *     SELECT must quote. Every entity therefore carries both, and the sync
 *     reads by `sourceName` and writes by `name`.
 *
 * The identifier rules are IMPORTED from the spreadsheet kit rather than
 * re-implemented: a column called `Order Date` has to land as `Order_Date`
 * whether it arrived from a CSV, an Excel sheet or a Postgres table, or the
 * same business column answers to two names depending on how it got here.
 */

import { dedupeIdentifiers, sanitiseEntityName, sanitiseIdentifier } from '../spreadsheet/tabular';
import type { EntityDescriptor, KnownRelationship } from '../types';
import { isExcludedType } from './typeMap';
import type {
  RawColumn, RawForeignKey, RawPrimaryKey, RawTable, SqlColumnInfo, SqlDialect, SqlEntity,
} from './types';

/**
 * Column names that mark when a row last CHANGED, in preference order.
 *
 * Matched case-insensitively against the source column name. The list is
 * deliberately conventional rather than clever — these are the names ORMs and
 * hand-written schemas actually use.
 *
 * **`created_at` and its synonyms are absent on purpose.** A creation stamp
 * does not move when a row is updated, so using one as a cursor would sync
 * inserts and silently miss every edit — the worst possible failure, because
 * the table looks fresh and is wrong. The playbook's rule is "never fake a
 * cursor on an unreliable field"; this is that rule as a list.
 */
const CURSOR_NAMES: readonly string[] = [
  'updated_at', 'updatedat', 'updated_on', 'updatedon', 'updated',
  'modified_at', 'modifiedat', 'modified_on', 'modifiedon', 'modified',
  'last_modified', 'lastmodified', 'last_modified_at', 'lastmodifieddate',
  'last_updated', 'lastupdated', 'last_update', 'lastupdate',
  'date_modified', 'datemodified', 'modified_date', 'modifieddate',
  'date_updated', 'dateupdated', 'updated_date', 'updateddate',
  'write_date', 'changed_at', 'changed_on', 'changedate',
  'sys_updated_at', 'row_updated_at', 'record_updated_at',
];

/** Types that can carry a time-ordered cursor. */
const CURSOR_TYPES = new Set(['TIMESTAMP', 'TIMESTAMPTZ', 'DATE']);

export interface BuildCatalogInput {
  schema: string;
  tables: readonly RawTable[];
  columns: readonly RawColumn[];
  primaryKeys: readonly RawPrimaryKey[];
  foreignKeys: readonly RawForeignKey[];
  dialect: SqlDialect;
  /** 'off' makes every table a full sync. */
  incrementalDetection?: 'auto' | 'off';
}

export interface BuiltCatalog {
  entities: SqlEntity[];
  relationships: KnownRelationship[];
  /** Tables dropped entirely, with the reason (unusable name, no columns). */
  skipped: { table: string; reason: string }[];
}

/** Build the full catalog. Pure — no I/O, so it is directly unit-testable. */
export function buildCatalog(input: BuildCatalogInput): BuiltCatalog {
  const { schema, dialect } = input;
  const skipped: { table: string; reason: string }[] = [];

  // Sort first so dedupe suffixes (`_2`) are assigned deterministically:
  // the same schema must always produce the same entity names.
  const tables = [...input.tables].sort((a, b) => a.table_name.localeCompare(b.table_name));

  const colsByTable = groupBy(input.columns, (c) => c.table_name);
  const pksByTable = groupBy(input.primaryKeys, (p) => p.table_name);

  // Entity names: sanitise, then dedupe across the whole schema.
  const candidates: { raw: RawTable; safe: string }[] = [];
  for (const t of tables) {
    const safe = sanitiseEntityName(t.table_name);
    if (!safe) {
      skipped.push({ table: t.table_name, reason: 'the name contains no characters usable as a table name' });
      continue;
    }
    candidates.push({ raw: t, safe });
  }
  const entityNames = dedupeIdentifiers(candidates.map((c) => c.safe));

  const entities: SqlEntity[] = [];
  /** source table name → warehouse entity name, for resolving FK endpoints. */
  const entityBySource = new Map<string, SqlEntity>();

  candidates.forEach((cand, i) => {
    const raw = cand.raw;
    const name = entityNames[i]!;
    const rawCols = [...(colsByTable.get(raw.table_name) ?? [])]
      .sort((a, b) => a.ordinal_position - b.ordinal_position);

    if (rawCols.length === 0) {
      skipped.push({ table: raw.table_name, reason: 'no readable columns' });
      return;
    }

    const excludedColumns: { name: string; reason: string }[] = [];
    const keep: RawColumn[] = [];
    for (const c of rawCols) {
      if (isExcludedType(c.data_type)) {
        excludedColumns.push({
          name: c.column_name,
          reason: `${c.data_type} columns hold binary data that cannot be analysed and would bloat every sync`,
        });
        continue;
      }
      const safe = sanitiseIdentifier(c.column_name);
      if (!safe) {
        excludedColumns.push({ name: c.column_name, reason: 'the name contains no characters usable as a column name' });
        continue;
      }
      keep.push(c);
    }
    if (keep.length === 0) {
      skipped.push({ table: raw.table_name, reason: 'every column was binary or unnameable' });
      return;
    }

    const safeNames = dedupeIdentifiers(keep.map((c) => sanitiseIdentifier(c.column_name)!));
    const columns: SqlColumnInfo[] = keep.map((c, ci) => ({
      name: safeNames[ci]!,
      sourceName: c.column_name,
      sqlType: dialect.toDuckDbType(c),
      sourceType: c.data_type,
      nullable: !!c.is_nullable,
      ...(c.column_comment ? { comment: c.column_comment } : {}),
    }));
    const bySource = new Map(columns.map((c) => [c.sourceName, c]));

    // ── Primary key ───────────────────────────────────────────────────
    const pk = [...(pksByTable.get(raw.table_name) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const pkColumns = pk.map((p) => p.column_name);
    // Only a SINGLE-column key can be a business key: the warehouse writer
    // merges on one column, and a composite key has no single value to merge
    // on. Such a table syncs full and overwrites, which is correct, just
    // more expensive.
    const singleKey = pkColumns.length === 1 ? bySource.get(pkColumns[0]!) : undefined;

    // ── Incremental cursor ────────────────────────────────────────────
    const cursor = input.incrementalDetection === 'off' || !singleKey
      ? undefined
      : detectCursor(columns);

    const entity: SqlEntity = {
      name,
      displayName: raw.table_name,
      ...(raw.table_comment ? { description: raw.table_comment } : {}),
      category: raw.table_type === 'view' ? 'Views' : 'Tables',
      supportsIncremental: !!cursor,
      ...(cursor ? { incrementalCursor: { field: cursor.name, type: 'timestamp' as const } } : {}),
      ...(singleKey ? { businessKey: singleKey.name, sourceKeyColumn: singleKey.sourceName } : {}),
      sourceSchema: schema,
      sourceTable: raw.table_name,
      columns,
      pkColumns,
      ...(cursor ? { sourceCursorColumn: cursor.sourceName } : {}),
      excludedColumns,
      ...(typeof raw.estimated_rows === 'number' && raw.estimated_rows >= 0
        ? { estimatedRowCount: raw.estimated_rows }
        : {}),
      isView: raw.table_type === 'view',
    };
    entities.push(entity);
    entityBySource.set(raw.table_name, entity);
  });

  return { entities, relationships: buildRelationships(input.foreignKeys, entityBySource), skipped };
}

/**
 * Pick the column that marks when a row last changed.
 *
 * Two guards, both about not lying:
 *   • the column must be a date/time type — a name alone is not evidence;
 *   • it must be NOT NULL. A nullable cursor silently loses rows forever:
 *     `WHERE updated_at >= x` never matches a NULL, so any row inserted with
 *     no stamp after the first full sync is invisible to every later sync.
 *     Refusing here costs a full re-read each time, which is slow and right.
 */
function detectCursor(columns: readonly SqlColumnInfo[]): SqlColumnInfo | undefined {
  const byLower = new Map<string, SqlColumnInfo>();
  for (const c of columns) {
    const k = c.sourceName.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, c);
  }
  for (const candidate of CURSOR_NAMES) {
    const col = byLower.get(candidate);
    if (!col) continue;
    if (!CURSOR_TYPES.has(col.sqlType)) continue;
    if (col.nullable) continue;
    return col;
  }
  return undefined;
}

/**
 * Declared FOREIGN KEY constraints → relationships at the `declared` rung.
 *
 * This is the strongest provenance the platform has. Everywhere else a
 * "relationship" is somebody's claim that two columns line up — a vendor's
 * hyperlink, a name-pattern guess, a value-overlap measurement. Here the
 * database REJECTS rows that violate it. There is nothing to verify and
 * nothing to review.
 *
 * Endpoints outside the synced catalog are dropped: a relationship pointing
 * at a table nobody selected can never match and would only clutter the graph.
 */
function buildRelationships(
  fks: readonly RawForeignKey[],
  entityBySource: ReadonlyMap<string, SqlEntity>,
): KnownRelationship[] {
  const out: KnownRelationship[] = [];
  const seen = new Set<string>();
  for (const fk of fks) {
    const from = entityBySource.get(fk.from_table);
    const to = entityBySource.get(fk.to_table);
    if (!from || !to) continue;
    const fromCol = from.columns.find((c) => c.sourceName === fk.from_column);
    const toCol = to.columns.find((c) => c.sourceName === fk.to_column);
    if (!fromCol || !toCol) continue;   // e.g. an FK on an excluded binary column
    const key = `${from.name}.${fromCol.name}->${to.name}.${toCol.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      fromTable: from.name,
      fromColumn: fromCol.name,
      toTable: to.name,
      toColumn: toCol.name,
      type: 'many_to_one',
      description: `${from.displayName ?? from.name}.${fk.from_column} references ${to.displayName ?? to.name}.${fk.to_column} (enforced foreign key).`,
    });
  }
  return out;
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Catalog entity → the descriptor the wizard and the platform see.
 *
 * The description STATES THE READING rather than describing the table. Every
 * property of a SQL entity is inferred from the customer's own schema — which
 * column identifies a row, whether there is a usable modified-timestamp,
 * whether anything was left out — and the entity picker is the last point at
 * which a person can catch a wrong reading before data lands. A description
 * saying "incremental on updated_at" is worth more there than a restatement of
 * the table's name.
 */
export function toEntityDescriptor(e: SqlEntity): EntityDescriptor {
  const notes: string[] = [];
  if (e.isView) notes.push('view');
  if (!e.businessKey) notes.push('no single-column primary key — read in full each sync');
  else if (!e.supportsIncremental) notes.push('no modified-timestamp column — read in full each sync');
  else notes.push(`incremental on ${e.sourceCursorColumn}`);
  if (e.excludedColumns.length > 0) notes.push(`${e.excludedColumns.length} binary column(s) not synced`);

  return {
    name: e.name,
    displayName: e.sourceTable,
    ...(e.category ? { category: e.category } : {}),
    description: [e.description, notes.join(' · ')].filter(Boolean).join(' — '),
    ...(typeof e.estimatedRowCount === 'number' ? { estimatedRowCount: e.estimatedRowCount } : {}),
    supportsIncremental: e.supportsIncremental,
    ...(e.incrementalCursor ? { incrementalCursor: e.incrementalCursor } : {}),
    ...(e.businessKey ? { businessKey: e.businessKey } : {}),
  };
}
