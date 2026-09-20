/**
 * The Clarion SOURCE PACKAGE — one declarative description of a source
 * system, as DATA, in the vocabulary of Apache Ossie (OSI).
 *
 * Why data and not TypeScript
 * ---------------------------
 * Until 2026-09-20 everything Clarion knew about Exact Online lived in ~4,600
 * lines of TypeScript (entity catalog, 2,613 transcribed column docs, curated
 * foreign keys, a star-schema template); Odoo in another ~1,200. That knowledge
 * is FACTS about a vendor's data model, not behaviour, and facts belong in a
 * file a reviewer can diff and a generator can write — `docs/backlog/
 * ingestion-chain-assessment.md` §7 phase 5 (E1). A source package is that
 * file set; the connector code shrinks to transport plus a thin loader.
 *
 * Why Ossie's words
 * -----------------
 * Apache Ossie (the former Open Semantic Interchange, incubating at the ASF)
 * is the open interchange spec for exactly this layer: datasets with fields,
 * relationships between them, metrics. Nobody authors IN Ossie — every tool
 * keeps its own model and exports — but a model that already uses Ossie's
 * key names exports by reformatting rather than translating. So the SHARED
 * part of a package uses Ossie's vocabulary verbatim (checked against
 * `core-spec/ossie-schema.json` on 2026-09-20, schema const `0.2.0.dev0`):
 *
 *   package:      version · name · description · datasets · relationships · metrics
 *   dataset:      name · description · source · primary_key · fields
 *   field:        name · label · description · datatype · expression
 *   relationship: name · from · from_columns · to · to_columns
 *   metric:       name · description · expression · datatype
 *
 * Everything Clarion-specific — sync cursors, API paths, the star-schema
 * template, provenance, lineage, analytics roles, soft-context notes — lives
 * under a `clarion` key on the object it describes. Ossie's own extension
 * mechanism is `custom_extensions: [{ vendor_name, data: "<json string>" }]`;
 * a JSON string inside YAML is unreviewable, so we hold the extension as a
 * plain map and let the export adapter fold it (`vendor_name: clarion`,
 * `data: JSON.stringify(clarion)`). Three SUPERSET keys sit at the object
 * level because they are the field a human reads first and Ossie has no
 * word for them: `label` on a dataset, `description` and `cardinality` on a
 * relationship. `expression` on a source field is optional here (it equals
 * the field name) and filled in on export. That adapter is deliberately NOT
 * built yet — no customer has Ossie semantics to import — but every choice
 * above makes it a formatting step when one asks.
 *
 * File layout (one directory per connector, `src/<connector>/package/`)
 * -----------
 *   package.yaml        manifest: version, name, vendor, provenance, the
 *                       curated source relationships, metrics, template products
 *   datasets/<X>.yaml   one SOURCE dataset each — the vendor's entity with
 *                       its documented fields (kind: source)
 *   model/<t>.yaml      one MODELLED dataset each — a template dimension or
 *                       fact: its SQL in `source`, its columns in `fields`
 *                       (kind: dimension | fact)
 *
 * "Author each fact once, derive the rest": a template JOIN is written once,
 * on the fact's foreign-key field (`clarion.references`), and the template's
 * relationship list is derived from it; a product's tables are derived from
 * each table's `clarion.product`; `supportsIncremental` is derived from the
 * presence of a cursor; the business key is `primary_key[0]`.
 *
 * Soft context: `clarion.notes` (Markdown) on the package, a dataset, a
 * field or a metric. A dataset's notes reach the schema profiler's prompt
 * context (`EntityDocs.notes`) — the caveats a model should read before it
 * describes a custom field or judges a relationship — and are never persisted
 * as a description.
 */

export const SOURCE_PACKAGE_FORMAT_VERSION = 1;

export type CursorType = 'timestamp' | 'integer' | 'string';
export type SourceFieldRole = 'measure' | 'dimension';
export type ModelledFieldRole =
  | 'surrogate_key' | 'natural_key' | 'foreign_key' | 'measure' | 'attribute' | 'degenerate_dimension';
export type Additivity = 'additive' | 'semi_additive' | 'non_additive';
export type Cardinality = 'many_to_one' | 'one_to_many' | 'many_to_many' | 'one_to_one';
export type FactTableType = 'transaction' | 'periodic_snapshot' | 'accumulating_snapshot' | 'factless';

/** A pointer at another dataset's field, in package name space. */
export interface FieldRef {
  dataset: string;
  field: string;
}

export interface PackageFieldExt {
  /** Analytics role. Source fields: measure | dimension. Modelled fields: the Kimball roles. */
  role?: SourceFieldRole | ModelledFieldRole;
  /**
   * Source field: the vendor-documented FK target (Exact's docs hyperlink
   * every FK property to its target entity). Modelled field: the template
   * join — the ONE place a join is written; the template's relationship list
   * is derived from these.
   */
  references?: FieldRef;
  /** Modelled: hide from end-user surfaces (raw FK ids); still joinable in NL→SQL. */
  technical?: boolean;
  additivity?: Additivity;
  /** Modelled: the source field this column is read from (single-source columns). */
  lineage?: FieldRef;
  /** Soft context (Markdown). */
  notes?: string;
}

export interface PackageField {
  name: string;
  /** Ossie `label` — the human name (Odoo's `string`, a template column's display name). */
  label?: string;
  description?: string;
  /**
   * Source field: the vendor's type verbatim (`Edm.Double`, `many2one`) —
   * kept as the source said it (E6). Modelled field: the DuckDB type the SQL
   * produces (`VARCHAR`, `DOUBLE`).
   */
  datatype?: string;
  /** Ossie requires this; for a source field it equals `name`, so it is optional here. */
  expression?: string;
  clarion?: PackageFieldExt;
}

export interface PackageDatasetExt {
  kind: 'source' | 'dimension' | 'fact';
  // ── source ──
  category?: string;
  sync?: {
    /** Present ⇒ the entity syncs incrementally on this field. */
    cursor?: { field: string; type: CursorType };
    /** Exact Online: endpoint refuses a bare listing; discover the field list first. */
    requiresSelect?: boolean;
    /**
     * Optional source-side filter applied to every pull of this entity, in
     * the source's own filter syntax (Exact: an OData `$filter` clause such
     * as `IsActive eq true`). No shipped entity sets one — the product
     * decision is to ingest ALL history — but the knob is per entity and
     * belongs with the entity, not in code.
     */
    defaultFilter?: string;
  };
  estimatedRowCount?: number;
  // ── dimension | fact ──
  /** The template product that builds this table. */
  product?: string;
  /** Source datasets the SQL reads — ALL must be synced or the table is dropped. */
  sourceEntities?: string[];
  /** fact: Kimball grain statement, 'One row per …'. */
  grain?: string;
  factTableType?: FactTableType;
  /** fact: dims joined at query time. Omit to derive from the FK fields (dim_date must be listed). */
  dimensionsUsed?: string[];
  notes?: string;
}

export interface PackageDataset {
  /** Source: the warehouse table name (= `selected_entities` value). Modelled: the product table name. */
  name: string;
  /** SUPERSET key: display name. */
  label?: string;
  description?: string;
  /**
   * Ossie `source`: the physical reference. Source dataset: the API path or
   * model name the connector pulls (`/crm/Accounts`, `res.partner`).
   * Modelled dataset: the DuckDB SELECT/WITH that builds it.
   */
  source?: string;
  /** Ossie `primary_key`. Exactly one column in this contract — the business key. */
  primary_key?: string[];
  fields?: PackageField[];
  clarion: PackageDatasetExt;
}

export interface PackageRelationship {
  name?: string;
  from: string;
  from_columns: string[];
  to: string;
  to_columns: string[];
  /** SUPERSET key. Ossie has none (from = many side, to = one side); default many_to_one. */
  cardinality?: Cardinality;
  /** SUPERSET key. */
  description?: string;
}

export interface PackageMetricExt {
  formulaPlainText: string;
  additivity: string;
  /** The template product the KPI belongs to. */
  product: string;
  /** Template tables the formula reads — the KPI is dropped if any is dropped. */
  requiresTables: string[];
  notes?: string;
}

export interface PackageMetric {
  name: string;
  description?: string;
  /** The KPI's SQL. */
  expression: string;
  datatype?: string;
  clarion: PackageMetricExt;
}

export interface PackageTemplateProduct {
  name: string;
  description: string;
  /** 1 = foundation (dims-only), 2+ = domain products. */
  buildOrder: number;
}

export interface SourcePackageExt {
  vendor?: { name: string; docs?: string; transcribed?: string };
  /**
   * Are the datasets' `fields` lists the WHOLE column set ('complete' — a
   * name not in the list does not exist, so a relationship or lineage naming
   * one is an error) or a documented SUBSET ('partial' — Odoo's curated
   * fallback beneath its live `fields_get` harvest; a missing name proves
   * nothing)? Decides which cross-checks the validator may run.
   */
  fieldCoverage: 'complete' | 'partial';
  /**
   * The order the wizard shows entity categories in, first to last. Source
   * datasets are ordered by this, then by name; a category not listed sorts
   * last. Written once here instead of numbering 61 files.
   */
  categories?: string[];
  /**
   * The rung the documented fields land on: 'curated' (transcribed from the
   * vendor's published docs at build time) or 'declared' (the vendor's own
   * metadata API, harvested at runtime — the package then holds the fallback).
   */
  provenance: 'curated' | 'declared';
  template?: { version: number; products: PackageTemplateProduct[] };
  notes?: string;
}

export interface SourcePackage {
  version: number;
  /** The connector type this package belongs to. */
  name: string;
  description?: string;
  datasets: PackageDataset[];
  /** Curated relationships between SOURCE datasets. Template joins live on fields. */
  relationships?: PackageRelationship[];
  /** Template KPIs. */
  metrics?: PackageMetric[];
  clarion: SourcePackageExt;
}

export function isSourceDataset(d: PackageDataset): boolean {
  return d.clarion.kind === 'source';
}

export function isModelledDataset(d: PackageDataset): boolean {
  return d.clarion.kind === 'dimension' || d.clarion.kind === 'fact';
}
