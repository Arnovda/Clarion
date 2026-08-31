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
  /**
   * Default time window for a date_range filter. Emitted by the AI ONLY when
   * the user stated a window (e.g. a refinement answer of "Last 30 days");
   * honoured by the frontend's buildDefaultFilters. Absent = the app default
   * (last 12 months). Meaningless on select filters.
   */
  defaultPreset?:
    | 'last_7_days'
    | 'last_30_days'
    | 'last_90_days'
    | 'last_3_months'
    | 'last_6_months'
    | 'last_12_months'
    | 'this_year'
    | 'all_time'
    // Tolerated superset: this is MODEL OUTPUT, and the enum is only enforced
    // when structured outputs are on. buildDefaultFilters parses any string
    // tolerantly and falls back to the 12-month default — an off-list value
    // must never crash the render path.
    | (string & {});
  /**
   * Default selected value for a select filter — set ONLY when the user asked
   * to focus on one specific value of the column. Absent = 'all'.
   */
  defaultValue?: string;
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
  /**
   * Product scope the spec was generated against. Persisted so that opening a
   * saved dashboard restores the SAME semantic context for refinements —
   * without it a refine falls back to every approved product on the
   * connection, a wider (different) schema than generation saw.
   */
  productIds?: number[];
  /**
   * The AI summary strip ("things to notice"). Generated once when the
   * dashboard is created and again ONLY on an explicit user trigger — never
   * automatically on open, so viewing a saved dashboard costs zero AI calls.
   * Cleared by a refinement (the items describe the pre-refine dashboard).
   */
  insights?: {
    items: string[];
    generatedAt: string;
  };
  /**
   * Set ONLY when the post-generation validation pass could not run to
   * completion — the widgets were never executed, column-contract checked or
   * repaired, so this spec is the model's raw output.
   *
   * The pass is deliberately best-effort: a transient warehouse timeout should
   * not throw away a dashboard that is probably fine. But it used to return the
   * unvalidated spec indistinguishably from a validated one, which left the
   * user unable to tell "checked and good" from "never checked". For a
   * generated artefact that silence is the wrong default — an unverified
   * dashboard has to say so.
   *
   * Absent means the pass ran. It does not mean every widget is correct.
   */
  validation?: {
    ok: false;
    reason: string;
  };
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
  profiling_status?: string | null;   // null | 'running' | 'structural' | 'done' | 'error'
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

// ---------------------------------------------------------------------------
// Feature flags — the deploy/release split
// ---------------------------------------------------------------------------
//
// A flag EXISTS in code (the registry below) and its ROLLOUT lives in the
// database. That split is deliberate: adding a flag is a reviewed code change,
// so a typo can never silently create a second flag that is off forever, and a
// flag nobody references shows up as dead code. Changing WHO sees it is a row
// update — instant, no deploy, no revision.
//
// Rollout is a ladder, not a boolean:
//   'off'     — nobody, including you. The state a flag is born in.
//   'tenants' — only the tenants listed on the flag. The test-tenant ring.
//   'all'     — everyone. The flag is now dead code: delete it and its checks.
//
// Deleting a shipped flag is part of shipping the feature. A flag left on
// 'all' forever is a branch in the code that no longer means anything.

export type FeatureRollout = 'off' | 'tenants' | 'all';

/**
 * What can be released to a chosen set of customers, separately from the code
 * that contains it.
 *
 * ⚠ NO RELEASE TRAIN IS OPEN RIGHT NOW, AND THAT IS A DELIBERATE STANDING
 * DECISION, not neglect. There are no customers yet, so there is no audience to
 * protect: new work ships to everyone the moment it is deployed, which is the
 * fastest correct thing to do and what every pre-revenue product does. A switch
 * guarding nobody is not free — it is a second code path that can only ever be
 * wrong, and one more thing to remember per change.
 *
 * THE DAY THE FIRST CUSTOMER SIGNS, THIS FLIPS BACK, and the flip is small:
 * declare a train here, point `CURRENT_RELEASE` at it, and gate the next
 * user-visible change with `isReleaseEnabled`. Everything that made that work
 * is still here and still tested — the console, the ladder, the audience, the
 * lifecycle reporting. Only the audience is missing. `docs/DEV_FLOW.md` Loop 3
 * has the four steps.
 *
 * THE UNIT IS A RELEASE, NOT A FEATURE. When a train is open, everything
 * user-visible that ships in one batch hangs off ONE key, so the person
 * choosing an audience ticks a customer once per release and gets the whole
 * batch, instead of hunting through a switch per feature. That was the owner's
 * ask in as many words: "I don't want it per feature, just the latest version
 * I promoted."
 *
 * `kind: 'feature'` is the exception, not the rule: a standing capability that
 * is deliberately NOT tied to a release train and stays switchable on its own
 * (today only the preview marker). Reach for it rarely — every extra entry is
 * another switch the operator has to reason about.
 *
 * WHAT DOES NOT BELONG BEHIND ANY OF THESE: a bug fix. Gating a fix means
 * choosing who keeps the broken behaviour, so fixes to existing behaviour ship
 * to everyone and always have. The release gate is for behaviour that is NEW.
 *
 * `name` is what the person choosing an audience reads — write it the way you
 * would say it out loud, never as a system term. `description` says what
 * turning it on actually does for a customer.
 *
 * DELETING A SHIPPED RELEASE IS PART OF FINISHING IT, and the console tells you
 * when: once a train has been on Everyone for `RELEASE_STALE_AFTER_DAYS` it is
 * reported as removable. The removal is mechanical rather than a hunt — delete
 * the key here and `tsc` names every gate that referenced it, because
 * `isReleaseEnabled` takes a `ReleaseKey`. Delete those branches, keep the new
 * behaviour, and the row in `feature_flags` is left behind as a harmless orphan
 * the console already ignores.
 *
 * WHEN ONE FEATURE IN A TRAIN NEEDS ITS OWN SWITCH, declare it as
 * `kind: 'feature'` instead. A train is a batch, so switching it off withdraws
 * everything in it — fine while a month's work is one or two changes you would
 * happily withdraw together, wrong the moment it carries something you would
 * not. That is the signal to give that one thing a key of its own, not to go
 * back to a switch per feature.
 */
export const FEATURE_FLAGS = {
  // Empty, and that is the current state of the product rather than an
  // oversight: nothing is gated, so there is nothing for anyone to switch.
  // The console renders "nothing waiting to be released", which is true.
  //
  // The preview marker lived here until the last train was retired. A badge
  // whose whole job is to say "this account sees things customers cannot" is
  // noise once every account sees everything, so it went with the gates it
  // described. Bring it back with the first ring.
} as const;

export type FeatureKey = keyof typeof FEATURE_FLAGS;

/** One flag's declaration, or undefined for a key the code does not know. */
export interface FeatureMeta {
  kind: 'release' | 'feature';
  name: string;
  description: string;
}

/**
 * Look up a flag's declaration by a key that is only known at run time — a row
 * read from the database, say. Typed rather than indexed directly, because
 * with an empty registry `FEATURE_FLAGS[k]` narrows to `never` and every field
 * access becomes a compile error; this keeps the console compiling whether
 * there are no flags, one, or ten.
 */
export function featureMeta(key: string): FeatureMeta | undefined {
  return (FEATURE_FLAGS as Record<string, FeatureMeta | undefined>)[key];
}

/**
 * Just the release trains — the only keys a release gate may name. With no
 * train declared this is `never`, so `isReleaseEnabled` cannot be called at
 * all: you cannot gate on a release that does not exist, which is the right
 * error to get if you reach for a gate before opening a train.
 */
export type ReleaseKey = {
  [K in FeatureKey]: (typeof FEATURE_FLAGS)[K]['kind'] extends 'release' ? K : never;
}[FeatureKey];

/**
 * The train NEW work joins, or null when none is open — which is the case
 * today, on purpose: with no customers, work ships to everyone and nothing is
 * gated. See the registry comment above for the decision and how to reverse it.
 *
 * When a train IS open this is documentation for the next person writing a
 * gate, and it is NOT what a running gate reads.
 *
 * That distinction is the whole point, and the first version got it backwards.
 * Gates used to call `isCurrentReleaseEnabled()` — no key named — on the
 * reasoning that opening the next train should then be a single edit here. It
 * would have been, and it would have taken August's already-released work
 * offline in the same edit: every live gate would have started reading
 * September's audience, which is empty by definition on the day it opens. The
 * Excel and SharePoint tiles would have vanished for tenants that already had
 * them, the fast dashboard edits would have reverted to the slow path, and
 * nothing anywhere would have raised an error. A gate must go on answering for
 * the release it shipped in, forever, until someone deletes it on purpose.
 *
 * So a gate names its own release: `isReleaseEnabled(tenantId, 'release_2026_08')`.
 * That keeps the property the owner actually asked for — one switch per batch,
 * not one per feature — because every gate from the same batch names the same
 * key.
 *
 * THE TYPE HERE IS WIDENED TO `string` DELIBERATELY. `isReleaseEnabled` takes a
 * `ReleaseKey`, so passing this constant fails to compile. The mistake above
 * cannot be made again by hand; it is not a rule anyone has to remember.
 */
export const CURRENT_RELEASE: string | null = null;

/**
 * How long a release may sit on Everyone before its gate counts as dead code.
 *
 * Fourteen days is the industry default for calling a flag stale, and it is the
 * right shape of number here: long enough that a monthly train has been through
 * a full cycle of real use, short enough that the branch is still fresh in
 * mind. The console says so out loud rather than trusting anyone to remember —
 * unremoved release toggles are the standard way a flag system rots.
 */
export const RELEASE_STALE_AFTER_DAYS = 14;

/** The shape both halves of the app already have for a flag row. */
interface FlagLifecycleInput {
  kind: 'release' | 'feature';
  rollout: FeatureRollout;
  updated_at: string | null;
}

/**
 * Days this release has been switched on for EVERYONE, or null when it is not.
 *
 * Any change to the rollout restarts the clock, because `updated_at` is the
 * only timestamp there is. That errs toward waiting longer before advising
 * removal, which is the safe direction: the cost of advising too early is
 * deleting a gate someone still wanted.
 */
export function daysFullyReleased(flag: FlagLifecycleInput, now: Date = new Date()): number | null {
  if (flag.kind !== 'release' || flag.rollout !== 'all' || !flag.updated_at) return null;
  const since = new Date(flag.updated_at).getTime();
  if (Number.isNaN(since)) return null;
  return Math.max(0, Math.floor((now.getTime() - since) / 86_400_000));
}

/** Everyone has had it long enough that the gate is now just dead code. */
export function gateIsRemovable(flag: FlagLifecycleInput, now: Date = new Date()): boolean {
  const days = daysFullyReleased(flag, now);
  return days !== null && days >= RELEASE_STALE_AFTER_DAYS;
}

/**
 * Every declared key, read at call time rather than snapshotted at import.
 *
 * A frozen copy of `Object.keys(FEATURE_FLAGS)` is the same information twice
 * and the two can disagree — which is exactly what happens in the flag suite,
 * where the tests declare their own key so the mechanism stays testable when
 * nothing is shipping behind a flag. Deriving costs a handful of string keys
 * per call and cannot go stale.
 */
export function featureKeys(): FeatureKey[] {
  return Object.keys(FEATURE_FLAGS) as FeatureKey[];
}

/** One flag's rollout state, as the operator console renders it. */
export interface FeatureFlagDto {
  key: FeatureKey;
  /** 'release' = a batch of work; 'feature' = a standing capability. */
  kind: 'release' | 'feature';
  /** Human name — what the console shows. */
  name: string;
  description: string;
  rollout: FeatureRollout;
  /** Tenants that see it while rollout is 'tenants'. Ignored in the other two states. */
  tenants: Array<{ id: number; name: string }>;
  updated_at: string | null;
  updated_by: string | null;
}

/** What `GET /api/features` answers for the calling user. */
export interface FeaturesResponse {
  /** Resolved on/off per flag for the caller's tenant. */
  features: Record<string, boolean>;
  /** True when this user may change rollouts (platform operator, not tenant admin). */
  isOperator: boolean;
}
