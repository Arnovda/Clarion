/**
 * Odoo field RULES — the code half of the connector's knowledge.
 *
 * The FACTS (the 21-model allowlist, curated field descriptions, documented
 * many2one foreign keys, the star-schema template) live in the source package
 * under `./package/` and are loaded by `catalog.ts`. What stays here is
 * behaviour a package cannot express: which field types never to ingest, how
 * an Odoo type lands in DuckDB, and the analytics-role hint per type.
 */

// ─── Field selection rules ────────────────────────────────────────────────
/**
 * Field types we never ingest:
 *   • binary       — attachments / images, huge, not analytics-relevant
 *   • one2many / many2many — variable-length relations; would bloat parquet.
 *     Model these via the relationship/graph layer, not raw columns.
 */
export const EXCLUDE_FIELD_TYPES: ReadonlySet<string> = new Set(['binary', 'one2many', 'many2many']);

/**
 * Noisy technical field name prefixes. Odoo decorates every model with chatter
 * (`message_*`), activities (`activity_*`), images (`image_*`), and dunder
 * internals (`__last_update`). None are useful for analytics.
 */
export const EXCLUDE_FIELD_PREFIXES: readonly string[] = ['message_', 'activity_', 'image_', '__'];

/** Always keep these even if a rule above would drop them. `id` is the PK,
 * `write_date` is the incremental cursor. */
export const ALWAYS_KEEP_FIELDS: readonly string[] = ['id', 'write_date'];

/** Page size for `search_read`. Odoo Online throttles ~1 req/sec, so larger
 * pages mean fewer requests; 2000 is comfortably under Odoo's response limits. */
export const PAGE_SIZE = 2000;

/**
 * Map an Odoo field type to a DuckDB SQL type, used to build the writer's
 * explicit `columns` schema (stable types, no per-sync inference drift).
 *
 *   • many2one — we flatten `[id, name]` to the integer id, so it's BIGINT.
 *   • monetary — keep 4dp; Odoo rounds to currency precision server-side.
 *   • integer  — BIGINT (Odoo ids and counters can exceed INT32).
 *
 * Anything unmapped falls back to VARCHAR (lossy but safe). The writer
 * re-validates types against its own allow-list before they reach SQL.
 */
export function odooTypeToDuckDb(odooType: string): string {
  switch (odooType) {
    case 'integer':
    case 'many2one':       return 'BIGINT';
    case 'float':          return 'DOUBLE';
    case 'monetary':       return 'DECIMAL(18,4)';
    case 'boolean':        return 'BOOLEAN';
    case 'date':           return 'DATE';
    case 'datetime':       return 'TIMESTAMP';
    case 'char':
    case 'text':
    case 'html':
    case 'selection':
    default:               return 'VARCHAR';
  }
}

/**
 * Analytics-role hint from Odoo's field type system, used for documented
 * columns that skip the AI classification pass:
 *
 *   • monetary / float — quantities and amounts → measure
 *   • many2one / selection / char / boolean / date / datetime — attributes
 *     you group or filter by → dimension
 *   • integer / text / html — ambiguous (an integer can be a count OR a
 *     sequence/colour index) → no hint, flags default to false
 */
export function odooFieldRole(name: string, odooType: string): 'measure' | 'dimension' | undefined {
  if (name === 'id') return undefined;
  switch (odooType) {
    case 'monetary':
    case 'float':      return 'measure';
    case 'many2one':
    case 'selection':
    case 'char':
    case 'boolean':
    case 'date':
    case 'datetime':   return 'dimension';
    default:           return undefined;
  }
}
