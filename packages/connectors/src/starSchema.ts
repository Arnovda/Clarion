/**
 * Deterministic star-schema templates (docs/SOURCE_ONBOARDING.md Phase F).
 *
 * For Tier 1/2 sources the fact/dimension design is a property of the SOURCE
 * SYSTEM, not of the customer: every Odoo instance yields the same
 * fact_invoice_lines / dim_partner shape. Connectors ship that design once —
 * hand-written, versioned, tested — via `SourceConnector.getStarSchemaTemplate`,
 * and the platform instantiates it instead of asking the AI to re-derive it
 * per customer. Deterministic, instant, token-free, and identical across
 * tenants (which is what makes prebuilt dashboards and KPI packs portable).
 *
 * The shape deliberately mirrors the backend's bus-matrix design output
 * (conformed dimensions + facts + product groupings + relationships + KPIs)
 * so the platform can reuse its existing validation/persistence/transform
 * pipeline unchanged. Two template-specific additions:
 *
 *   • `sourceEntities` per table — the entities the table's SQL reads. This
 *     drives GRACEFUL DEGRADATION: `instantiateStarSchemaTemplate` drops any
 *     table whose upstream entities weren't synced, then repairs the
 *     surrounding structure (relationships, product groupings, dim
 *     ownership, build order).
 *   • `version` — customers keep the version they materialised until an
 *     explicit upgrade; bump it when the template's shape changes.
 *
 * SQL contract (matches the platform's transformation runner):
 *   • one standalone DuckDB `SELECT`/`WITH` per table — no DDL;
 *   • reference source tables by their BARE entity name (`FROM account_move_line`)
 *     — the runner registers a DuckDB view per synced entity under exactly
 *     that name. No dbt macros.
 *   • facts carry natural FK id columns; they never JOIN dimension tables,
 *     so a dropped dimension can't break a surviving fact.
 */

// ─── Template types ─────────────────────────────────────────────────────────

export interface TemplateColumn {
  name: string;
  /** DuckDB SQL type as produced by the table's SQL (e.g. 'BIGINT', 'VARCHAR'). */
  dataType: string;
  displayName: string;
  description: string;
  role: 'surrogate_key' | 'natural_key' | 'foreign_key' | 'measure' | 'attribute' | 'degenerate_dimension';
  fkTargetTable?: string;
  fkTargetColumn?: string;
  /** Hide from end-user surfaces (raw FK ids etc.); still joinable in NL→SQL. */
  isTechnical?: boolean;
  additivity?: 'additive' | 'semi_additive' | 'non_additive';
  /** Lineage back to the source entity/column (single-source columns). */
  sourceEntity?: string;
  sourceColumn?: string;
}

export interface TemplateDimension {
  tableName: string;
  displayName: string;
  description: string;
  /** Source entities the SQL reads. ALL must be synced or the dim is dropped. */
  sourceEntities: string[];
  sql: string;
  columns: TemplateColumn[];
}

export interface TemplateFact extends TemplateDimension {
  /** Kimball grain statement, e.g. 'One row per invoice line'. */
  grain: string;
  factTableType: 'transaction' | 'periodic_snapshot' | 'accumulating_snapshot' | 'factless';
  /** Dimension tableNames this fact joins to at query time ('dim_date' allowed). */
  dimensionsUsed: string[];
}

export interface TemplateProduct {
  name: string;
  description: string;
  /** 1 = foundation (typically dims-only), 2+ = domain products. */
  buildOrder: number;
  factTables: string[];
  ownedDimensions: string[];
}

export interface TemplateRelationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  type: 'fact_to_dim' | 'dim_to_dim';
}

export interface TemplateKpi {
  name: string;
  description: string;
  formulaPlainText: string;
  formulaSql: string;
  additivity: string;
  productName: string;
  /** Template tables the formula reads — the KPI is dropped if any is dropped. */
  requiresTables: string[];
}

export interface StarSchemaTemplate {
  /** Bump when the template's shape changes; customers upgrade explicitly. */
  version: number;
  dimensions: TemplateDimension[];
  facts: TemplateFact[];
  products: TemplateProduct[];
  relationships: TemplateRelationship[];
  kpis: TemplateKpi[];
}

// ─── Instantiation (graceful degradation) ───────────────────────────────────

/**
 * Filter a template down to the entities that were actually synced, repairing
 * the structure so what remains is internally consistent:
 *
 *   • a table survives only if ALL of its `sourceEntities` are available;
 *   • relationships survive only if both endpoints survived;
 *   • `dimensionsUsed` is trimmed to surviving dims (dim_date always allowed —
 *     the platform injects it);
 *   • products lose dropped tables; a product with nothing left is dropped;
 *   • dims orphaned by a dropped owner product are re-assigned to the first
 *     surviving product so someone still builds them;
 *   • build order is renumbered 1..N (the platform materialises shared
 *     infrastructure like dim_date in the build_order-1 product);
 *   • KPIs of dropped products are dropped.
 *
 * Returns null when NO fact survives — a dims-only instantiation isn't worth
 * bypassing the AI designer for, and the caller should fall back to it.
 */
export function instantiateStarSchemaTemplate(
  template: StarSchemaTemplate,
  availableEntities: readonly string[],
): StarSchemaTemplate | null {
  const avail = new Set(availableEntities);
  const covered = (t: TemplateDimension) => t.sourceEntities.every((e) => avail.has(e));

  const dimensions = template.dimensions.filter(covered);
  const facts = template.facts.filter(covered);
  if (facts.length === 0) return null;

  const dimNames = new Set(dimensions.map((d) => d.tableName));
  const factNames = new Set(facts.map((f) => f.tableName));
  const keptTables = new Set([...dimNames, ...factNames]);

  const trimmedFacts = facts.map((f) => ({
    ...f,
    dimensionsUsed: f.dimensionsUsed.filter((d) => dimNames.has(d) || d === 'dim_date'),
  }));

  const relationships = template.relationships.filter(
    (r) => keptTables.has(r.fromTable) && keptTables.has(r.toTable),
  );

  let products = template.products
    .map((p) => ({
      ...p,
      factTables: p.factTables.filter((f) => factNames.has(f)),
      ownedDimensions: p.ownedDimensions.filter((d) => dimNames.has(d)),
    }))
    .filter((p) => p.factTables.length > 0 || p.ownedDimensions.length > 0)
    .sort((a, b) => a.buildOrder - b.buildOrder);

  if (products.length === 0) return null;

  // Re-home dims whose owner product was dropped entirely.
  const owned = new Set(products.flatMap((p) => p.ownedDimensions));
  const orphans = [...dimNames].filter((d) => !owned.has(d));
  if (orphans.length > 0) {
    products = products.map((p, i) =>
      i === 0 ? { ...p, ownedDimensions: [...p.ownedDimensions, ...orphans] } : p,
    );
  }

  // Renumber build order 1..N — the platform keys shared-infrastructure
  // behaviour (dim_date materialisation) off build_order 1 existing.
  products = products.map((p, i) => ({ ...p, buildOrder: i + 1 }));

  const productNames = new Set(products.map((p) => p.name));
  const kpis = template.kpis.filter(
    (k) => productNames.has(k.productName) && k.requiresTables.every((t) => keptTables.has(t)),
  );

  return { version: template.version, dimensions, facts: trimmedFacts, products, relationships, kpis };
}

// ─── Static validation (conformance) ────────────────────────────────────────

const SAFE_TABLE = /^[a-z][a-z0-9_]*$/;
const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function looksLikeSql(sql: string): boolean {
  const stripped = sql.replace(/^\s*--[^\n]*\n/g, '').trimStart();
  return /^(SELECT|WITH)\b/i.test(stripped);
}

/**
 * Structural invariants every template must satisfy — run in the connector's
 * test suite against its own catalog so a malformed template is a failing
 * test, not a runtime surprise. Returns human-readable violations (empty =
 * conformant).
 */
export function validateStarSchemaTemplate(
  template: StarSchemaTemplate,
  catalogEntityNames: readonly string[],
): string[] {
  const errs: string[] = [];
  const catalog = new Set(catalogEntityNames);
  const allTables = [...template.dimensions, ...template.facts];
  const tableNames = new Set<string>();

  if (!Number.isInteger(template.version) || template.version < 1) {
    errs.push(`version must be a positive integer (got ${template.version})`);
  }

  for (const t of allTables) {
    const p = `table '${t.tableName}'`;
    if (!SAFE_TABLE.test(t.tableName)) errs.push(`${p}: name must match ${SAFE_TABLE}`);
    if (tableNames.has(t.tableName)) errs.push(`${p}: duplicate table name`);
    tableNames.add(t.tableName);
    if (t.sourceEntities.length === 0) errs.push(`${p}: sourceEntities is empty`);
    for (const e of t.sourceEntities) {
      if (!catalog.has(e)) errs.push(`${p}: sourceEntities references '${e}', not in the entity catalog`);
    }
    if (!looksLikeSql(t.sql)) errs.push(`${p}: sql must start with SELECT or WITH`);
    if (t.columns.length === 0) errs.push(`${p}: columns is empty`);
    const colNames = new Set<string>();
    for (const c of t.columns) {
      if (!SAFE_COLUMN.test(c.name)) errs.push(`${p}: column '${c.name}' unsafe name`);
      if (colNames.has(c.name)) errs.push(`${p}: duplicate column '${c.name}'`);
      colNames.add(c.name);
      if (c.role === 'foreign_key' && !c.fkTargetTable) {
        errs.push(`${p}: FK column '${c.name}' missing fkTargetTable`);
      }
    }
  }

  for (const f of template.facts) {
    const p = `fact '${f.tableName}'`;
    if (!/^One row per /i.test(f.grain)) errs.push(`${p}: grain must start with 'One row per'`);
    for (const d of f.dimensionsUsed) {
      if (d !== 'dim_date' && !template.dimensions.some((x) => x.tableName === d)) {
        errs.push(`${p}: dimensionsUsed references unknown dim '${d}'`);
      }
    }
  }

  for (const r of template.relationships) {
    const p = `relationship ${r.fromTable}.${r.fromColumn}→${r.toTable}.${r.toColumn}`;
    if (!tableNames.has(r.fromTable)) errs.push(`${p}: fromTable not in template`);
    if (!tableNames.has(r.toTable)) errs.push(`${p}: toTable not in template`);
    const from = allTables.find((t) => t.tableName === r.fromTable);
    if (from && !from.columns.some((c) => c.name === r.fromColumn)) {
      errs.push(`${p}: fromColumn not declared on ${r.fromTable}`);
    }
    const to = allTables.find((t) => t.tableName === r.toTable);
    if (to && !to.columns.some((c) => c.name === r.toColumn)) {
      errs.push(`${p}: toColumn not declared on ${r.toTable}`);
    }
  }

  const buildOrders = new Set<number>();
  const factOwners = new Set<string>();
  const dimOwners = new Set<string>();
  for (const dp of template.products) {
    const p = `product '${dp.name}'`;
    if (buildOrders.has(dp.buildOrder)) errs.push(`${p}: duplicate buildOrder ${dp.buildOrder}`);
    buildOrders.add(dp.buildOrder);
    for (const f of dp.factTables) {
      if (!template.facts.some((x) => x.tableName === f)) errs.push(`${p}: unknown fact '${f}'`);
      if (factOwners.has(f)) errs.push(`${p}: fact '${f}' owned by more than one product`);
      factOwners.add(f);
    }
    for (const d of dp.ownedDimensions) {
      if (!template.dimensions.some((x) => x.tableName === d)) errs.push(`${p}: unknown dim '${d}'`);
      if (dimOwners.has(d)) errs.push(`${p}: dim '${d}' owned by more than one product`);
      dimOwners.add(d);
    }
  }
  for (const f of template.facts) {
    if (!factOwners.has(f.tableName)) errs.push(`fact '${f.tableName}' not assigned to any product`);
  }
  for (const d of template.dimensions) {
    if (!dimOwners.has(d.tableName)) errs.push(`dim '${d.tableName}' not owned by any product`);
  }

  const productNames = new Set(template.products.map((p) => p.name));
  for (const k of template.kpis) {
    if (!productNames.has(k.productName)) {
      errs.push(`kpi '${k.name}': productName '${k.productName}' not a template product`);
    }
    for (const t of k.requiresTables) {
      if (!tableNames.has(t)) errs.push(`kpi '${k.name}': requiresTables references unknown table '${t}'`);
    }
  }

  return errs;
}
