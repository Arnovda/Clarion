/**
 * Bus matrix builder — persists an AI-designed bus matrix to the DB.
 *
 * Extracted from routes/products.ts so the same transaction can run both
 * synchronously (legacy /build-bus-matrix endpoint) and from a BullMQ
 * worker (new /bus-matrix/start job-based flow).
 */

import type { Knex } from 'knex';
import { semanticDb } from '../db/knex';
import { deleteProductGraph } from '../db/semanticGraph';
import { parseAliasMap, deriveColumnLineage, DerivedLineage } from './lineageDerivation';
import { logger as rootLogger } from '../utils/logger';
import type { BusMatrixOutput, BusMatrixRelationship, BusMatrixDimension } from '../ai/prompts/busMatrixPrompt';
import type { ProvenanceRung } from '../shared/provenance';

/** The slice of a designed table `synthesizeFkRelationships` reads. */
export interface SynthesizableTable {
  table_name: string;
  table_role: 'fact' | 'dimension';
  columns: Array<{ column_name: string; fk_target_table?: string | null; fk_target_column?: string | null }>;
}

/**
 * Derive the relationship rows the AI's `relationships[]` list is missing
 * from per-column `fk_target_table/_column` metadata.
 *
 * The design carries every join TWICE: once in the relationships list and
 * once on the FK column itself. The prompt forbids listing dim_date as a
 * table (it is auto-injected), and the model reliably omits the
 * relationships that touch it too — but the column metadata survives
 * ("fact FKs point to dim_date.date_key" is a prompt rule). Without this,
 * an AI-built topic renders its Date lookup as "not linked yet" and every
 * reader of product_relationships misses the date joins.
 *
 * Pure on purpose (unit-tested without a DB). Emits only links whose target
 * is a known table in the schema, skips self-references, and never
 * duplicates an existing (from table, from column, to table) assertion.
 */
export function synthesizeFkRelationships(
  tables: SynthesizableTable[],
  existing: Array<Pick<BusMatrixRelationship, 'from_table_name' | 'from_column_name' | 'to_table_name'>>,
  knownTables: ReadonlySet<string>,
): BusMatrixRelationship[] {
  const seen = new Set(existing.map((r) => `${r.from_table_name}|${r.from_column_name}|${r.to_table_name}`));
  const out: BusMatrixRelationship[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      const target = c.fk_target_table;
      const targetColumn = c.fk_target_column;
      if (!target || !targetColumn || target === t.table_name) continue;
      if (!knownTables.has(target)) continue;
      const key = `${t.table_name}|${c.column_name}|${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        from_table_name: t.table_name,
        from_column_name: c.column_name,
        to_table_name: target,
        to_column_name: targetColumn,
        relationship_type: t.table_role === 'fact' ? 'fact_to_dim' : 'dim_to_dim',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extension guards — make an AI-designed ADDITIVE product safe to persist.
// ---------------------------------------------------------------------------

export interface ExtensionSchemaContext {
  /** The product name the user approved — forced onto the output verbatim. */
  productName: string;
  /** Every existing product name on the tenant (case-insensitive collision check). */
  existingProductNames: string[];
  /** Every existing product table name on the connection (owners + stubs). */
  existingTableNames: string[];
  /**
   * Existing owner dimensions, shaped as BusMatrixDimension (columns + the
   * owner's transformation_sql) so they can be appended as SHADOW entries —
   * present in conformed_dimensions for the stub loop to copy columns from,
   * never in owned_dimensions, so buildBusMatrix persists them as stubs.
   */
  reusableDims: BusMatrixDimension[];
}

export interface ExtensionPrepareResult {
  errors: string[];
  /** Existing dim names the new product reuses — the caller wires
      data_product_dependencies to their owner products from this list. */
  usedExistingDims: string[];
}

/**
 * Normalise + guard an AI-designed extension in place. The prompt states the
 * rules; THIS enforces them — an addition must never be able to touch the
 * existing build:
 *
 *   - exactly ONE data product, named what the user approved, build_order 2
 *     (never 1 — build_order 1 is what materialises dim_date, and the
 *     existing build already owns that);
 *   - any AI redefinition of an existing table is DROPPED, and reused dims
 *     are re-appended as DB-derived shadows (stub path in buildBusMatrix);
 *   - any remaining NEW table name colliding with an existing one is a hard
 *     error — persisting it would either duplicate a shared lookup or, worse,
 *     let buildBusMatrix's retire-and-replace sweep fire on a name match;
 *   - a fact naming a dimension that neither exists nor is defined is a hard
 *     error (it would build a fact whose JOIN target never materialises).
 *
 * Pure on purpose — unit-tested without a DB.
 */
export function prepareExtensionMatrix(
  busMatrix: BusMatrixOutput,
  ctx: ExtensionSchemaContext,
): ExtensionPrepareResult {
  const errors: string[] = [];
  const lc = (s: string) => s.trim().toLowerCase();
  const existingTables = new Set(ctx.existingTableNames.map(lc));
  const existingProducts = new Set(ctx.existingProductNames.map(lc));
  const reusableByName = new Map(ctx.reusableDims.map((d) => [lc(d.table_name), d]));

  if (existingProducts.has(lc(ctx.productName))) {
    errors.push(`A subject named "${ctx.productName}" already exists`);
  }

  busMatrix.relationships = Array.isArray(busMatrix.relationships) ? busMatrix.relationships : [];
  busMatrix.proposed_kpis = Array.isArray(busMatrix.proposed_kpis) ? busMatrix.proposed_kpis : [];
  busMatrix.conformed_dimensions = Array.isArray(busMatrix.conformed_dimensions) ? busMatrix.conformed_dimensions : [];
  busMatrix.fact_tables = Array.isArray(busMatrix.fact_tables) ? busMatrix.fact_tables : [];
  if (!busMatrix.dim_date_range?.start || !busMatrix.dim_date_range?.end) {
    busMatrix.dim_date_range = { start: '2020-01-01', end: '2027-12-31' };
  }

  // Drop AI redefinitions of existing tables from the design entirely.
  const dropped = busMatrix.conformed_dimensions.filter((d) => existingTables.has(lc(d.table_name)));
  busMatrix.conformed_dimensions = busMatrix.conformed_dimensions.filter(
    (d) => !existingTables.has(lc(d.table_name)),
  );
  const newDimNames = busMatrix.conformed_dimensions.map((d) => d.table_name);

  // New facts must not collide either — that is the retire-sweep hazard.
  for (const f of busMatrix.fact_tables) {
    if (existingTables.has(lc(f.table_name))) {
      errors.push(`Table name "${f.table_name}" already exists in another subject`);
    }
  }

  // Every dim a fact uses must be a new dim, a reusable existing dim (append
  // its shadow), or dim_date. Anything else cannot materialise.
  const usedExisting = new Map<string, BusMatrixDimension>();
  const newDimSet = new Set(newDimNames.map(lc));
  for (const f of busMatrix.fact_tables) {
    f.dimensions_used = Array.isArray(f.dimensions_used) ? f.dimensions_used : [];
    f.dimensions_used = f.dimensions_used.map((name) => {
      if (lc(name) === 'dim_date' || newDimSet.has(lc(name))) return name;
      const reusable = reusableByName.get(lc(name));
      if (reusable) {
        usedExisting.set(reusable.table_name, reusable);
        return reusable.table_name; // canonical casing
      }
      // A dropped redefinition of a NON-reusable existing table (e.g. a fact
      // name) or a dim the AI invented out of nothing.
      if (dropped.some((d) => lc(d.table_name) === lc(name))) {
        errors.push(`"${f.table_name}" redefines existing table "${name}" — reuse it instead`);
      } else {
        errors.push(`"${f.table_name}" uses unknown dimension "${name}"`);
      }
      return name;
    });
  }

  // Append shadows so buildBusMatrix's stub loop can copy their columns.
  for (const shadow of usedExisting.values()) {
    busMatrix.conformed_dimensions.push(shadow);
  }

  // Exactly one product: the one the user approved, owning every NEW dim and
  // every fact in the output (an unowned new dim would silently never build).
  const grouping = busMatrix.data_products?.find?.(
    (dp) => lc(dp.name) === lc(ctx.productName),
  ) ?? busMatrix.data_products?.[0];
  busMatrix.data_products = [{
    name: ctx.productName,
    description: grouping?.description ?? '',
    build_order: 2,
    fact_tables: busMatrix.fact_tables.map((f) => f.table_name),
    owned_dimensions: newDimNames,
  }];

  if (busMatrix.fact_tables.length === 0) {
    errors.push('The design contains nothing to measure — no subject was created');
  }

  for (const kpi of busMatrix.proposed_kpis) kpi.product_name = ctx.productName;

  return { errors, usedExistingDims: [...usedExisting.keys()] };
}

const log = rootLogger.child({ mod: 'busMatrixBuilder' });

export interface BuildBusMatrixOptions {
  connectionId: number;
  tenantId: number | undefined;
  userEmail: string | undefined;
  busMatrix: BusMatrixOutput;
  /** Set when the matrix came from a connector star-schema template (not AI). */
  templateVersion?: number;
}

export interface BuiltProduct { name: string; id: number; status: string; build_order: number }

export interface BuildBusMatrixResult {
  products: BuiltProduct[];
}

/**
 * Decide is_technical for a column when the AI didn't set it explicitly.
 *
 * Two layers:
 *   1. If the AI provided `is_technical`, trust it.
 *   2. Otherwise fall back to heuristics — surrogate keys and foreign
 *      keys in facts are always technical; UUID-typed columns are
 *      always technical; everything else is business-visible by
 *      default.
 *
 * The flag firewalls technical IDs from chat results, narratives, and
 * default sample previews. They remain available for JOINs in NL→SQL.
 */
function inferIsTechnical(col: {
  column_name?: string;
  data_type?: string;
  column_role?: string;
  is_technical?: boolean;
}): boolean {
  if (typeof col.is_technical === 'boolean') return col.is_technical;
  if (col.column_role === 'surrogate_key' || col.column_role === 'foreign_key') return true;
  const type = (col.data_type ?? '').toUpperCase();
  if (type.includes('UUID') || type === 'BLOB' || type.startsWith('BINARY')) return true;
  // Trailing-key heuristic — `*_key` in a fact is a surrogate FK by
  // naming convention even when the AI tags it differently.
  if (/_key$/.test(col.column_name ?? '')) return true;
  return false;
}

/**
 * When the bus-matrix AI call hits max_tokens, the JSON-repair pass closes
 * unclosed brackets but the fields that come AFTER conformed_dimensions +
 * fact_tables in the schema (data_products, relationships, proposed_kpis,
 * dim_date_range) never landed in the stream. Rather than throw away the
 * dims/facts the user just waited 5-10 minutes to design, synthesize the
 * missing scaffolding from what we have so the build can proceed.
 *
 * The synthesized data_products grouping is deliberately minimal —
 * "Foundation" (all dims) + "Analytics" (all facts). The user can split
 * these into business-meaningful products in the UI after the build.
 *
 * Returns true if any recovery was applied (so the orchestrator can warn).
 */
export function recoverIncompleteBusMatrix(busMatrix: BusMatrixOutput): {
  recovered: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  const hasDims = Array.isArray(busMatrix.conformed_dimensions) && busMatrix.conformed_dimensions.length > 0;
  const hasFacts = Array.isArray(busMatrix.fact_tables) && busMatrix.fact_tables.length > 0;
  if (!hasDims || !hasFacts) return { recovered: false, notes };

  let recovered = false;

  if (!Array.isArray(busMatrix.data_products) || busMatrix.data_products.length === 0) {
    busMatrix.data_products = [
      {
        name: 'Foundation',
        description: 'Reference data — conformed dimensions (auto-grouped after AI output was truncated; rename in the UI).',
        build_order: 1,
        fact_tables: [],
        owned_dimensions: busMatrix.conformed_dimensions.map((d) => d.table_name),
      },
      {
        name: 'Analytics',
        description: 'Business facts and metrics (auto-grouped after AI output was truncated; split into business products in the UI).',
        build_order: 2,
        fact_tables: busMatrix.fact_tables.map((f) => f.table_name),
        owned_dimensions: [],
      },
    ];
    notes.push('data_products synthesized as Foundation + Analytics (rename/split in UI)');
    recovered = true;
  }

  if (!Array.isArray(busMatrix.relationships)) {
    const rels: BusMatrixOutput['relationships'] = [];
    for (const fact of busMatrix.fact_tables) {
      for (const dimName of fact.dimensions_used ?? []) {
        if (dimName === 'dim_date') continue;
        const dim = busMatrix.conformed_dimensions.find((d) => d.table_name === dimName);
        if (!dim) continue;
        const dimSk = dim.columns?.find((c) => c.column_role === 'surrogate_key');
        if (!dimSk) continue;
        const factFk =
          fact.columns?.find((c) => c.fk_target_table === dimName) ??
          fact.columns?.find((c) => c.column_name === dimSk.column_name);
        if (!factFk) continue;
        rels.push({
          from_table_name: fact.table_name,
          from_column_name: factFk.column_name,
          to_table_name: dim.table_name,
          to_column_name: dimSk.column_name,
          relationship_type: 'fact_to_dim',
        });
      }
    }
    busMatrix.relationships = rels;
    notes.push(`relationships synthesized (${rels.length} fact→dim links derived from fact columns)`);
    recovered = true;
  }

  if (!Array.isArray(busMatrix.proposed_kpis)) {
    busMatrix.proposed_kpis = [];
    notes.push('proposed_kpis defaulted to empty (add KPIs in the product page)');
    recovered = true;
  }

  if (!busMatrix.dim_date_range || !busMatrix.dim_date_range.start || !busMatrix.dim_date_range.end) {
    busMatrix.dim_date_range = { start: '2020-01-01', end: '2027-12-31' };
    notes.push('dim_date_range defaulted to 2020-01-01 → 2027-12-31');
    recovered = true;
  }

  return { recovered, notes };
}

/**
 * Expressions that mint a DIFFERENT key on every run. A key built from one
 * of these breaks every saved dashboard, drill-through, incremental load and
 * history table the moment the table refreshes — and does so silently, since
 * every run is internally consistent. Phase 1 of the ingestion assessment
 * (C1) makes the rule enforceable rather than a prompt hope: the templates
 * carry the natural key as the key, and the AI path now must too.
 */
const UNSTABLE_KEY_RE = /\b(ROW_NUMBER|UUID|GEN_RANDOM_UUID|RANDOM|NEXTVAL)\s*\(/i;

/**
 * Does this table's design mint an unstable key? Checks BOTH places the key
 * expression can live: the column's own `transformation_expression`, and
 * the `transformation_sql` (where `ROW_NUMBER() OVER (…) AS x_key` is what
 * the model actually emitted — the column expression is often a paraphrase).
 * A `ROW_NUMBER()` used for dedupe in a CTE (`WHERE rn = 1`) is legitimate
 * and passes: only an alias onto a key column is refused.
 */
export function unstableKeyViolations(
  table: { table_name: string; transformation_sql?: string | null; columns?: Array<{ column_name: string; column_role?: string | null; transformation_expression?: string | null }> | null },
): string[] {
  const out: string[] = [];
  const sql = table.transformation_sql ?? '';
  for (const col of table.columns ?? []) {
    if (col.column_role !== 'surrogate_key' && col.column_role !== 'foreign_key') continue;
    if (UNSTABLE_KEY_RE.test(col.transformation_expression ?? '')) {
      out.push(`${table.table_name}.${col.column_name}: key is minted per run (${(col.transformation_expression ?? '').slice(0, 60)}) — use the natural key`);
      continue;
    }
    // `<unstable>( … ) [OVER ( … )] AS <col>` in the SQL. Non-greedy across
    // one OVER clause is enough: the model writes the alias right after it.
    const aliased = new RegExp(
      `\\b(ROW_NUMBER|UUID|GEN_RANDOM_UUID|RANDOM|NEXTVAL)\\s*\\([^)]*\\)(\\s*OVER\\s*\\([^)]*\\))?\\s*(AS\\s+)?"?${col.column_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\b`,
      'i',
    );
    if (aliased.test(sql)) {
      out.push(`${table.table_name}.${col.column_name}: key is minted per run in the SQL — use the natural key`);
    }
  }
  return out;
}

/**
 * Validate the AI-output shape. Returns an array of human-readable errors;
 * empty array means the spec is good enough to attempt persistence.
 */
export function validateBusMatrix(busMatrix: BusMatrixOutput): string[] {
  const errors: string[] = [];
  if (!Array.isArray(busMatrix.conformed_dimensions)) errors.push('conformed_dimensions missing or not an array');
  if (!Array.isArray(busMatrix.fact_tables)) errors.push('fact_tables missing or not an array');
  if (!Array.isArray(busMatrix.data_products)) errors.push('data_products missing or not an array');
  (busMatrix.data_products ?? []).forEach((dp, i) => {
    if (!dp.name) errors.push(`data_products[${i}].name missing`);
    if (!Array.isArray(dp.owned_dimensions)) errors.push(`data_products[${i}] "${dp.name}": owned_dimensions missing`);
    if (!Array.isArray(dp.fact_tables)) errors.push(`data_products[${i}] "${dp.name}": fact_tables missing`);
    if (typeof dp.build_order !== 'number') errors.push(`data_products[${i}] "${dp.name}": build_order missing`);
  });
  // Save-time guard: when the AI returns prose where SQL should be (e.g.
  // "I need to check what tables are available…" instead of a SELECT) we
  // CANNOT persist it. Doing so kicks off a death spiral where every
  // subsequent run feeds Claude its own apology text and gets worse output.
  // Reject non-SQL here so the bus-matrix flow surfaces a clear error and
  // the user can re-run "Prepare my data" cleanly.
  const looksLikeSql = (sql: unknown): boolean => {
    if (typeof sql !== 'string' || !sql.trim()) return false;
    const stripped = sql.replace(/^\s*--[^\n]*\n/g, '').replace(/^\s+/, '').replace(/^\(+/, '').replace(/^\s+/, '');
    return /^(SELECT|WITH)\b/i.test(stripped);
  };

  (busMatrix.conformed_dimensions ?? []).forEach((d, i) => {
    if (!d.table_name) errors.push(`conformed_dimensions[${i}].table_name missing`);
    if (!Array.isArray(d.columns)) errors.push(`conformed_dimensions[${i}] "${d.table_name}": columns missing`);
    if (!Array.isArray(d.source_tables)) errors.push(`conformed_dimensions[${i}] "${d.table_name}": source_tables missing`);
    if (!d.transformation_sql) errors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql missing`);
    else if (!looksLikeSql(d.transformation_sql)) {
      errors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql is not SQL (must start with SELECT or WITH)`);
    }
    errors.push(...unstableKeyViolations(d));
  });
  (busMatrix.fact_tables ?? []).forEach((f, i) => {
    if (!f.table_name) errors.push(`fact_tables[${i}].table_name missing`);
    if (!Array.isArray(f.columns)) errors.push(`fact_tables[${i}] "${f.table_name}": columns missing`);
    if (!Array.isArray(f.source_tables)) errors.push(`fact_tables[${i}] "${f.table_name}": source_tables missing`);
    if (!Array.isArray(f.dimensions_used)) errors.push(`fact_tables[${i}] "${f.table_name}": dimensions_used missing`);
    if (!f.transformation_sql) errors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql missing`);
    else if (!looksLikeSql(f.transformation_sql)) {
      errors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql is not SQL (must start with SELECT or WITH)`);
    }
    errors.push(...unstableKeyViolations(f));
  });
  return errors;
}

/**
 * Persist a bus matrix to the DB in a single transaction. Creates data
 * products, star schemas, tables (with SQL), columns, relationships,
 * dependencies, and KPIs. dim_date is auto-injected for build_order=1
 * products.
 */
/**
 * What a person typed onto a product after it was built — and therefore what
 * a retire-and-replace rebuild must carry across, by NAME, because every id
 * changes (2026-09-06 functional-requirements evaluation, defect 4).
 *
 * Mirrors the profiler's snapshot-and-merge for source tables (migration 70,
 * `SchemaProfiler.ts`): read before the delete, merge after the insert. The
 * fields are exactly the ones only a human writes today —
 * `product_kpis.question_text`, `product_tables.plain_summary`,
 * `data_products.hidden` — plus KPIs a person AUTHORED (`ai_draft=false`
 * and not re-proposed by the new design), which are re-inserted whole: a
 * formula that no longer compiles is visible on the KPI; a KPI that
 * vanished is not.
 */
export interface ProductEditSnapshot {
  hidden: boolean | null;
  /** table_name → plain_summary */
  tableSummaries: Map<string, string>;
  /** kpi name → question_text */
  kpiQuestions: Map<string, string>;
  /** Human-authored KPIs, keyed by name, to re-insert if the new design lacks them. */
  userKpis: Map<string, { description: string | null; formula_plain_text: string | null; formula_sql: string | null; owner_name: string | null; question_text: string | null }>;
}

export async function snapshotProductEdits(
  db: Knex | Knex.Transaction,
  products: Array<{ id: number; name: string }>,
): Promise<Map<string, ProductEditSnapshot>> {
  const out = new Map<string, ProductEditSnapshot>();
  if (products.length === 0) return out;
  const ids = products.map((p) => p.id);

  const productRows: Array<{ id: number; hidden: boolean | null }> = await db('data_products')
    .whereIn('id', ids).select('id', 'hidden');
  const tableRows: Array<{ data_product_id: number; table_name: string; plain_summary: string | null }> = await db('product_tables as pt')
    .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
    .whereIn('ss.data_product_id', ids)
    .whereNotNull('pt.plain_summary')
    .select('ss.data_product_id', 'pt.table_name', 'pt.plain_summary');
  const kpiRows: Array<{ data_product_id: number; name: string; description: string | null; formula_plain_text: string | null; formula_sql: string | null; owner_name: string | null; question_text: string | null; ai_draft: boolean | null }> = await db('product_kpis')
    .whereIn('data_product_id', ids)
    .select('data_product_id', 'name', 'description', 'formula_plain_text', 'formula_sql', 'owner_name', 'question_text', 'ai_draft');

  const nameById = new Map(products.map((p) => [p.id, p.name]));
  const hiddenById = new Map(productRows.map((r) => [r.id, r.hidden]));
  for (const p of products) {
    out.set(p.name, { hidden: hiddenById.get(p.id) ?? null, tableSummaries: new Map(), kpiQuestions: new Map(), userKpis: new Map() });
  }
  for (const t of tableRows) {
    const snap = out.get(nameById.get(t.data_product_id) ?? '');
    if (snap && t.plain_summary && t.plain_summary.trim()) snap.tableSummaries.set(t.table_name, t.plain_summary);
  }
  for (const k of kpiRows) {
    const snap = out.get(nameById.get(k.data_product_id) ?? '');
    if (!snap) continue;
    if (k.question_text && k.question_text.trim()) snap.kpiQuestions.set(k.name, k.question_text);
    if (k.ai_draft === false) {
      snap.userKpis.set(k.name, {
        description: k.description, formula_plain_text: k.formula_plain_text, formula_sql: k.formula_sql,
        owner_name: k.owner_name, question_text: k.question_text,
      });
    }
  }
  return out;
}

export async function buildBusMatrix(opts: BuildBusMatrixOptions): Promise<BuildBusMatrixResult> {
  const { connectionId, tenantId, userEmail, busMatrix, templateVersion } = opts;
  const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');
  // The provenance ladder carried past the product boundary (E5): what the
  // design ASSERTED is curated when a connector template shipped it and a
  // model's draft otherwise; what Clarion DERIVED (lineage read off the SQL,
  // fact→dim joins synthesised from FK metadata) is `derived` either way.
  const designRung: ProvenanceRung = templateVersion ? 'curated' : 'ai_draft';

  // Product ids retired by the retire-and-replace sweep below — their Neo4j
  // product graphs are cleaned up after the transaction commits.
  const retiredIds: number[] = [];

  const products = await semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

    const dimByName = new Map(busMatrix.conformed_dimensions.map((d) => [d.table_name, d]));
    const factByName = new Map(busMatrix.fact_tables.map((f) => [f.table_name, f]));

    const sortedProducts = [...busMatrix.data_products].sort((a, b) => a.build_order - b.build_order);

    const productIdByName = new Map<string, number>();
    const _results: BuiltProduct[] = [];

    const allSourceTablesByProduct = new Map<string, Set<string>>();
    for (const dp of sortedProducts) {
      const srcSet = new Set<string>();
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (dim) dim.source_tables.forEach((s) => srcSet.add(s));
      }
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (fact) fact.source_tables.forEach((s) => srcSet.add(s));
      }
      allSourceTablesByProduct.set(dp.name, srcSet);
    }

    const dimOwnerProduct = new Map<string, string>();
    for (const dp of sortedProducts) {
      for (const dimName of dp.owned_dimensions) {
        dimOwnerProduct.set(dimName, dp.name);
      }
    }

    // ── Retire-and-replace ─────────────────────────────────────────────
    // Re-running "Prepare my data" must never duplicate products (the
    // 2026-07-15 assessment's launch-killer #1: unconditional inserts left
    // prod with Sales ×2 / Purchases ×2 / Reference ×2). Any existing
    // product on this connection with a name the new build is about to
    // create is deleted first — the whole tree (star_schemas →
    // product_tables → product_columns → lineage, plus sources, KPIs,
    // dependencies and refresh history) cascades from data_products, so
    // this is a complete retire. This ALSO self-heals already-duplicated
    // tenants: every same-named copy is swept before the single new row
    // goes in. Old warehouse parquet under product_<oldId> becomes
    // orphaned and is simply no longer referenced (same model as the
    // v1→v2 layout migration); the new build re-materialises fresh.
    const newNames = sortedProducts.map((p) => p.name);
    const staleProducts: Array<{ id: number; name: string }> = await trx('data_products')
      .where({ connection_id: connectionId })
      .whereIn('name', newNames)
      .select('id', 'name');
    // Human edits ride across the rebuild by name (defect 4, 2026-09-06).
    const editSnapshot = await snapshotProductEdits(trx, staleProducts);
    if (staleProducts.length > 0) {
      await trx('data_products').whereIn('id', staleProducts.map((s) => s.id)).del();
      retiredIds.push(...staleProducts.map((s) => s.id));
      log.info(
        { replaced: staleProducts.map((s) => `${s.name}#${s.id}`) },
        `bus-matrix rebuild: retired ${staleProducts.length} existing product(s) before re-create`,
      );
    }

    for (const dp of sortedProducts) {
      // Catalog split: a product with no fact tables is reference-shaped —
      // it only contains entities to slice by (Customer, Item, Date, …),
      // never anything to measure. The /catalog endpoint reads this `kind`
      // column to route the product to the right column (reference) vs
      // left column (analytics) and to unfold reference products into
      // individual entity cards. Without this flag every bus-matrix product
      // defaults to 'analytics' and dim-only products like "Reference"
      // end up in the analytics column with 0 metrics / 0 facts — exactly
      // the regression migration 20260510000054 was meant to prevent.
      const productKind = dp.fact_tables.length === 0 ? 'reference' : 'analytics';

      const [productRow] = await trx('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        kind: productKind,
        created_by: userEmail || 'ai',
        tenant_id: tenantId,
        template_version: templateVersion ?? null,
        hidden: editSnapshot.get(dp.name)?.hidden ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productRow === 'object' ? (productRow as { id: number }).id : (productRow as number);
      productIdByName.set(dp.name, pid);
      const productEdits = editSnapshot.get(dp.name);

      const depProductNames = new Set<string>();
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          const owner = dimOwnerProduct.get(dimName);
          if (owner && owner !== dp.name) depProductNames.add(owner);
        }
      }
      for (const depName of depProductNames) {
        const sourceId = productIdByName.get(depName);
        if (sourceId) {
          await trx('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      const primaryFact = dp.fact_tables[0] ? factByName.get(dp.fact_tables[0]) : null;
      const [schemaRow] = await trx('star_schemas').insert({
        data_product_id: pid,
        name: dp.name,
        description: dp.description,
        grain: primaryFact?.grain ?? 'Conformed dimensions',
        fact_table_type: primaryFact?.fact_table_type ?? 'transaction',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const schemaId = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (!dim) continue;

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: dim.table_name,
          display_name: dim.display_name,
          description: dim.description,
          table_role: 'dimension',
          // OWNER row — this product materialises the dim. Stubs in
          // downstream products that reference this dim are inserted with
          // is_shared_dimension=true (see fact-tables loop below).
          is_shared_dimension: false,
          dag_order: 0,
          transformation_sql: dim.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(dim.table_name, tableId);

        // Create notebook cell for this dimension
        if (dim.transformation_sql) {
          await trx('product_table_cells').insert({
            product_table_id: tableId,
            cell_type: 'sql',
            source: dim.transformation_sql,
            position: 0,
            is_deploy_cell: true,
          });
        }

        const colAliasMap = parseAliasMap(dim.transformation_sql ?? '');
        const colAllowed = new Set(dim.source_tables ?? []);
        const colSole = colAllowed.size === 1 ? dim.source_tables[0] : undefined;

        for (const col of dim.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            is_technical: inferIsTechnical(col),
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          let validLineage: DerivedLineage[] = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          let lineageRung: ProvenanceRung = designRung;
          if (validLineage.length === 0) {
            // The prompt tells the model to omit lineage for trivial columns
            // (a sound token rule) — but a passthrough's lineage is exactly
            // derivable from its expression. Derive it instead of leaving
            // "Where it comes from" empty for most of an AI-built topic.
            validLineage = deriveColumnLineage(col.transformation_expression, colAliasMap, colAllowed, colSole);
            lineageRung = 'derived';
          }
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
                provenance: lineageRung,
              })),
            );
          }
        }
      }

      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: fact.table_name,
          display_name: fact.display_name,
          description: fact.description,
          table_role: 'fact',
          is_shared_dimension: false,
          dag_order: 1,
          transformation_sql: fact.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(fact.table_name, tableId);

        // Create notebook cell for this fact table
        if (fact.transformation_sql) {
          await trx('product_table_cells').insert({
            product_table_id: tableId,
            cell_type: 'sql',
            source: fact.transformation_sql,
            position: 0,
            is_deploy_cell: true,
          });
        }

        const colAliasMap = parseAliasMap(fact.transformation_sql ?? '');
        const colAllowed = new Set(fact.source_tables ?? []);
        const colSole = colAllowed.size === 1 ? fact.source_tables[0] : undefined;

        for (const col of fact.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            is_technical: inferIsTechnical(col),
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          let validLineage: DerivedLineage[] = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          let lineageRung: ProvenanceRung = designRung;
          if (validLineage.length === 0) {
            // The prompt tells the model to omit lineage for trivial columns
            // (a sound token rule) — but a passthrough's lineage is exactly
            // derivable from its expression. Derive it instead of leaving
            // "Where it comes from" empty for most of an AI-built topic.
            validLineage = deriveColumnLineage(col.transformation_expression, colAliasMap, colAllowed, colSole);
            lineageRung = 'derived';
          }
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
                provenance: lineageRung,
              })),
            );
          }
        }

        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          if (dp.owned_dimensions.includes(dimName)) continue;
          const dim = dimByName.get(dimName);
          if (!dim || tableNameToId.has(dimName)) continue;

          const [stubRow] = await trx('product_tables').insert({
            star_schema_id: schemaId,
            table_name: dim.table_name,
            display_name: dim.display_name,
            description: dim.description,
            table_role: 'dimension',
            is_shared_dimension: true,
            dag_order: 0,
            transformation_sql: null,
            transformation_status: 'draft',
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).returning('id');
          const stubId = typeof stubRow === 'object' ? (stubRow as { id: number }).id : (stubRow as number);
          tableNameToId.set(dim.table_name, stubId);

          for (const col of dim.columns) {
            await trx('product_columns').insert({
              product_table_id: stubId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              is_technical: inferIsTechnical(col),
              ai_draft: true,
            });
          }
        }
      }

      const dateRange = busMatrix.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };
      const isFirstBuilder = dp.build_order === 1;
      const [dimDateRow] = await trx('product_tables').insert({
        star_schema_id: schemaId,
        table_name: 'dim_date',
        display_name: 'Date',
        description: 'Auto-generated calendar dimension',
        table_role: 'dimension',
        // Only the first product in build order materializes dim_date.
        // All later products treat it as a conformed (shared) dimension and
        // load it from the owning product's parquet at run time.
        is_shared_dimension: !isFirstBuilder,
        dag_order: 0,
        transformation_sql: isFirstBuilder ? DIM_DATE_SQL(dateRange.start, dateRange.end) : null,
        transformation_status: 'draft',
        ai_draft: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const dimDateId = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      // Create notebook cell for dim_date (only if this product materializes it)
      if (isFirstBuilder) {
        await trx('product_table_cells').insert({
          product_table_id: dimDateId,
          cell_type: 'sql',
          source: DIM_DATE_SQL(dateRange.start, dateRange.end),
          position: 0,
          is_deploy_cell: true,
        });
      }

      for (const col of DIM_DATE_COLUMNS) {
        await trx('product_columns').insert({
          product_table_id: dimDateId,
          column_name: col.column_name,
          data_type: col.data_type,
          display_name: col.display_name,
          description: col.description,
          column_role: col.column_role,
          transformation_expression: col.transformation_expression,
          scd_type: col.scd_type,
          sort_order: col.sort_order,
          ai_draft: false,
        });
      }

      // The designed relationships, PLUS the ones only the column metadata
      // asserts (the dim_date joins, chiefly — see synthesizeFkRelationships).
      // Synthesis reads FROM this product's own tables only, so a shared dim
      // stubbed into several schemas cannot re-emit its links per schema; a
      // link TO a stubbed or auto-injected table is exactly the point.
      const ownNames = new Set([...dp.fact_tables, ...dp.owned_dimensions]);
      const ownDesignTables: SynthesizableTable[] = [
        ...busMatrix.conformed_dimensions
          .filter((d) => ownNames.has(d.table_name))
          .map((d) => ({ table_name: d.table_name, table_role: 'dimension' as const, columns: d.columns })),
        ...busMatrix.fact_tables
          .filter((f) => ownNames.has(f.table_name))
          .map((f) => ({ table_name: f.table_name, table_role: 'fact' as const, columns: f.columns })),
      ];
      const synthesized = synthesizeFkRelationships(
        ownDesignTables,
        busMatrix.relationships,
        new Set(tableNameToId.keys()),
      );

      const asserted = new Set<BusMatrixRelationship>(busMatrix.relationships);
      for (const rel of [...busMatrix.relationships, ...synthesized]) {
        const fromId = tableNameToId.get(rel.from_table_name);
        const toId = tableNameToId.get(rel.to_table_name);
        if (fromId && toId) {
          await trx('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromId,
            from_column_name: rel.from_column_name,
            to_table_id: toId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
            provenance: asserted.has(rel) ? designRung : 'derived',
          });
        }
      }

      const srcSet = allSourceTablesByProduct.get(dp.name);
      if (srcSet && srcSet.size > 0) {
        const sourceTblRows = await trx('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...srcSet])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await trx('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            })),
          );
        }
      }

      const productKpis = (busMatrix.proposed_kpis ?? []).filter((k) => k.product_name === dp.name);
      if (productKpis.length > 0) {
        await trx('product_kpis').insert(
          productKpis.map((k) => ({
            data_product_id: pid,
            name: k.name,
            description: k.description,
            formula_plain_text: k.formula_plain_text,
            formula_sql: k.formula_sql,
            ai_draft: true,
          })),
        );
      }

      // Merge the snapshot back: summaries by table name, questions by KPI
      // name, and the person's own KPIs the new design did not re-propose.
      if (productEdits) {
        for (const [tableName, summary] of productEdits.tableSummaries) {
          const tableId = tableNameToId.get(tableName);
          if (tableId) await trx('product_tables').where({ id: tableId }).update({ plain_summary: summary });
        }
        for (const [kpiName, question] of productEdits.kpiQuestions) {
          await trx('product_kpis').where({ data_product_id: pid, name: kpiName }).update({ question_text: question });
        }
        const proposedNames = new Set(productKpis.map((k) => k.name));
        for (const [kpiName, kpi] of productEdits.userKpis) {
          if (proposedNames.has(kpiName)) continue;
          await trx('product_kpis').insert({
            tenant_id: tenantId,
            data_product_id: pid,
            name: kpiName,
            description: kpi.description,
            formula_plain_text: kpi.formula_plain_text,
            formula_sql: kpi.formula_sql,
            owner_name: kpi.owner_name,
            question_text: kpi.question_text,
            ai_draft: false,
          });
        }
        const carried = productEdits.tableSummaries.size + productEdits.kpiQuestions.size + productEdits.userKpis.size;
        if (carried > 0) log.info({ product: dp.name, carried }, 'bus-matrix rebuild: carried human edits across the rebuild');
      }

      await trx('data_products').where({ id: pid }).update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      });

      _results.push({ name: dp.name, id: pid, status: 'created', build_order: dp.build_order });
    }

    return _results;
  });

  // Best-effort Neo4j cleanup of the retired products' graphs — the new
  // products are synced to Neo4j by the orchestrator after transformations
  // run; without this sweep the OLD product nodes would linger and pollute
  // the AI context with duplicate schemas.
  for (const id of retiredIds) {
    try {
      await deleteProductGraph(id);
    } catch (err) {
      log.warn({ err, productId: id }, 'Neo4j cleanup of retired product failed (non-fatal)');
    }
  }

  return { products };
}
