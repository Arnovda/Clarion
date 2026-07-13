/**
 * Clarion shared API contract — the canonical wire types exchanged between
 * the backend (producer) and the frontend (consumer).
 *
 * ══ THIS FILE EXISTS AS TWO BYTE-IDENTICAL COPIES ═══════════════════════════
 *
 *     backend/src/shared/contract.ts
 *     frontend/lib/contract.ts
 *
 * Edit them TOGETHER — any change to one copy must be applied verbatim to the
 * other. CI enforces this with `backend/scripts/lint-contract-sync.ts`, which
 * fails the build if the two copies differ by even one byte (after CRLF/LF
 * normalisation, so git autocrlf on Windows can't produce false mismatches).
 *
 * WHY two copies instead of a shared package: the frontend Docker image is
 * built with `frontend/` as its ENTIRE build context, so at build time it
 * physically cannot reach a file or workspace package outside that directory.
 * A published npm package would fix that at the cost of a publish/version/
 * install loop for every type tweak. Two lint-locked copies give the same
 * single-source-of-truth guarantee with zero build-system changes.
 *
 * Rules for this file:
 *   • Pure `export interface` / `export type` declarations ONLY.
 *   • ZERO imports and zero runtime code. Consumers use `import type`, which
 *     is fully erased at compile time — this file contributes nothing to any
 *     bundle on either side.
 *   • Optional fields (`?`) where routes legitimately vary; comments document
 *     which endpoint produces which shape.
 */

// ─── API envelope & auth ──────────────────────────────────────────────────────

/**
 * Standard response envelope every JSON endpoint uses:
 * `{ ok: true, data }` on success, `{ ok: false, error }` on failure.
 * Paginated list endpoints additionally carry a `pagination` block alongside
 * `data` (see `utils/paginate.ts` on the backend).
 */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Roles: admin = full access, analyst = query + dashboards + products, viewer = read-only. */
export type UserRole = 'admin' | 'analyst' | 'viewer';

export interface AuthUser {
  id: number;
  tenantId: number;
  email: string;
  displayName: string;
  role: UserRole;
}

/** Decoded JWT access-token payload (issued by the backend, decoded client-side too). */
export interface JwtPayload {
  sub: number;          // user id
  tenantId: number;     // tenant id
  email: string;
  displayName: string;
  name?: string;        // alias for displayName (used in route handlers)
  role: UserRole;
  iat?: number;
  exp?: number;
  [key: string]: unknown; // allow additional properties
}

// ─── AI-generated dashboard spec ──────────────────────────────────────────────
// The persisted contract: `generateDashboardSpec` (backend AI) produces it,
// `dashboards.spec` (Postgres) stores it, and the frontend dashboard renderer
// consumes it. Frontend-only VIEW state (WidgetData, DrillState, ChatMessage,
// SavedDashboard, …) intentionally does NOT live here — see
// frontend/app/dashboards/types.ts.

export interface FilterSpec {
  id: string;
  type: 'date_range' | 'select';
  label: string;
  table: string;
  column: string;
  /** Optional label for the "all values" option of a select filter. */
  allLabel?: string;
}

export interface WidgetSpec {
  id: string;
  type:
    | 'kpi_card'
    | 'bar_chart'
    | 'vertical_bar_chart'
    | 'stacked_bar_chart'
    | 'line_chart'
    | 'pie_chart'
    | 'top_list'
    | 'data_table'
    | 'combo_chart'
    | 'radar_chart'
    | 'treemap_chart'
    | 'pivot_table'
    | 'scatter_chart'
    | 'bullet_chart';
  title: string;
  sql: string;
  drillDownSql?: string;
  drillDownLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
  colSpan?: 1 | 2 | 3 | 4;
  /** Frontend layout hint: render this widget visually emphasised. */
  featured?: boolean;
  /** SQL column name emitted as {{xf_<key>}} when a bar/segment is clicked. */
  crossFilterKey?: string;
  /**
   * User-adjusted grid placement (react-grid-layout units on a 12-col grid).
   * Absent on freshly generated specs — the renderer then falls back to the
   * document-order flow layout driven by colSpan. Written when the user
   * drags/resizes in edit mode; wins over colSpan when present.
   */
  layout?: { x: number; y: number; w: number; h: number };
}

export interface DashboardSpec {
  title: string;
  description: string;
  filters: FilterSpec[];
  widgets: WidgetSpec[];
  /**
   * Which data layer the SQL was generated against. Persisted with the spec
   * so subsequent re-executions hit the same connector. Default = 'product'.
   */
  dataLayer?: 'product' | 'source';
}

// ─── Connection DTO ───────────────────────────────────────────────────────────

/**
 * A row of `GET /api/connections` — the `connections` table (`SELECT *`),
 * sanitised: `connector_config_encrypted` is stripped and any `config.password`
 * is masked before the response leaves the backend. This is the superset the
 * frontend's per-page `Connection` interfaces narrow from; adopt incrementally
 * (do not force every page onto every field).
 */
export interface ConnectionDto {
  id: number;
  tenant_id?: number;
  name: string;
  /** SQL driver used to QUERY the connection: 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'duckdb'. */
  type: string;
  /** Parsed connection config (passwords masked). May be a raw string on legacy rows. */
  config: Record<string, unknown> | string;
  created_by: string | null;
  created_at: string;
  domains?: string[];
  // Ingestion (ETL → warehouse) state
  ingestion_status?: string | null;   // null | 'pending' | 'running' | 'done' | 'error'
  ingestion_progress?: number | null; // 0–100
  ingestion_error?: string | null;
  last_ingested_at?: string | null;
  warehouse_path?: string | null;
  query_engine?: string | null;       // 'source' | 'duckdb'
  // Freshness
  last_synced_at?: string | null;
  last_profiled_at?: string | null;
  // Schema-profiling progress (recovers UI state across reloads)
  profiling_status?: string | null;   // null | 'running' | 'done' | 'error'
  profiling_message?: string | null;
  profiling_phase?: string | null;    // 'schema' | 'quality' | 'ai_draft' | 'storing' | 'neo4j' | 'done' | 'error'
  profiling_progress?: number | null; // 0–100
  profiling_started_at?: string | null;
  schema_hash?: string | null;
  // Source-connector fields (set when created via the add-source wizard)
  connector_type?: string | null;     // e.g. 'exactonline', 'odoo'; null = direct DB attach
  selected_entities?: string[] | null;
  last_sync_status?: string | null;   // 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
}

// ─── Data product DTO ─────────────────────────────────────────────────────────

/**
 * Server-derived "primary source" identity of a data product, attached by
 * `GET /api/products` and `GET /api/products/:id`. Primary = the connection
 * contributing the most source tables (fallback: `data_products.connection_id`).
 */
export interface ProductSourceRef {
  id: number | null;
  name: string | null;
  connectorType: string | null;
  /** True when the product's source tables span more than one connection. */
  multiSource: boolean;
  /** True when the resolved primary connection row no longer exists. */
  sourceDeleted: boolean;
  otherSources: Array<{ id: number; name: string; connectorType: string | null }>;
}

/**
 * An item of `GET /api/products` (paginated list) — a `data_products` row
 * enriched with count/freshness aggregates and the `source` block.
 * `GET /api/products/:id` returns the same base row + `source`, nested with
 * full star schemas instead of the list aggregates.
 */
export interface DataProductDto {
  id: number;
  tenant_id?: number;
  connection_id: number | null;
  name: string;
  description: string | null;
  status: string;               // 'draft' | 'designing' | 'approved' | 'error' | 'success'
  kind?: 'analytics' | 'reference';
  created_by?: string | null;
  created_at: string;
  updated_at?: string;
  icon_svg?: string | null;
  // List-endpoint aggregates (coerced to numbers / ISO strings server-side)
  star_schema_count?: number;
  kpi_count?: number;
  table_count?: number;
  last_refreshed_at?: string | null;
  source?: ProductSourceRef;
}
