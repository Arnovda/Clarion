export interface SourceTable {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string;
  description: string;
  ai_draft: boolean;
  is_active: boolean;
  domains?: string[];
  grain?: string;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'flagged';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

export interface SourceColumn {
  id: number;
  table_id: number;
  column_name: string;
  display_name: string;
  description: string;
  data_type: string;
  example_values: string | string[] | null;
  is_dimension: boolean;
  is_measure: boolean;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

export interface Relationship {
  id: number;
  from_table_id: number;
  from_column_id: number | null;
  to_table_id: number;
  to_column_id: number | null;
  from_table_name: string;
  to_table_name: string;
  relationship_type: string;
  description: string;
  ai_draft: boolean;
}

export interface CrossSourceView {
  id: number;
  name: string;
  description: string | null;
  connection_id: number | null;
}

export interface ProductTable {
  id: number;
  data_product_id: number;
  star_schema_id: number | null;
  table_name: string;
  display_name: string;
  description: string;
  table_role: 'fact' | 'dimension' | 'bridge' | 'junk';
  dag_order: number;
  row_count: number | null;
  transformation_status: string | null;
  owner_name: string | null;
  domains: string | string[];
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'flagged';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  column_count?: number;
  last_run_at?: string;
  /** Postgres product_tables.id (the tree's own `id` is the graph id). */
  pg_table_id?: number | null;
  /** A COPY of a shared lookup another subject builds — never shown as a
   *  table of its own; the catalog opens the original instead. */
  is_copy?: boolean;
  owner_pg_table_id?: number | null;
  owner_graph_id?: number | null;
}

export interface ProductColumn {
  id: number;
  table_id: number;
  table_name: string;
  column_name: string;
  data_type: string;
  display_name: string;
  description: string;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
  transformation_expression: string | null;
  additivity: string | null;
  scd_type: number;
  sort_order: number;
  owner_name: string | null;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'flagged';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  /**
   * A join key (surrogate / foreign key). Served to curators only, from
   * Postgres, with a NEGATIVE id — read-only: the graph mirror never holds
   * keys, so no edit route accepts them.
   */
  is_technical?: boolean;
}

export interface ProductTreeItem {
  productId: number;
  productName: string;
  connectionId: number | null;
  status: string;
  starSchemas: {
    schemaId: number;
    schemaName: string;
    tables: ProductTable[];
  }[];
}

export interface KpiDefinition {
  id: number;
  connection_id: number;
  name: string;
  description: string;
  formula_plain_text: string;
  formula_sql: string;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

// ─── Glossary links ─────────────────────────────────────────────────────────
// A business term's ADDRESS in the topic layer: a product column, a whole
// table, or a KPI — stored by NAME so a rebuild that renames the target makes
// the term visibly point at nothing rather than silently drift.
export type GlossaryLinkKind = 'column' | 'table' | 'kpi';

export interface GlossaryLink {
  kind: GlossaryLinkKind;
  table?: string;
  column?: string;
  kpi?: string;
}

/** A stored link as the API returns it: checked against the catalog. */
export interface ResolvedGlossaryLink extends GlossaryLink {
  /** false = the target is no longer in the catalog — "pick it again". */
  resolved: boolean;
  topic: string | null;
  label: string | null;
}

/** GET /semantic/glossary/link-targets — what a term may be linked to. */
export interface GlossaryLinkTargets {
  tables: Array<{
    topic: string;
    tableName: string;
    displayName: string | null;
    role: string | null;
    columns: Array<{ name: string; displayName: string | null; role: string | null }>;
  }>;
  kpis: Array<{ name: string; topic: string; description: string | null }>;
}

/** Identity of a link — the same rule the backend uses. */
export function glossaryLinkKey(l: GlossaryLink): string {
  if (l.kind === 'column') return `column:${l.table}.${l.column}`;
  if (l.kind === 'table') return `table:${l.table}`;
  return `kpi:${l.kpi}`;
}

/** Strip the resolution fields so a stored link can be sent back unchanged. */
export function bareGlossaryLink(l: GlossaryLink): GlossaryLink {
  if (l.kind === 'column') return { kind: 'column', table: l.table, column: l.column };
  if (l.kind === 'table') return { kind: 'table', table: l.table };
  return { kind: 'kpi', kpi: l.kpi };
}
