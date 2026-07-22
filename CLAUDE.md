# CLAUDE.md — Clarion
> AI-powered semantic data platform. Read this file at the start of every session.

---

## CLAUDE.md Maintenance Rules
> These rules apply to every single session. No exceptions.

**At the start of every session:**
- Read this entire file before writing any code
- Check the Current State section below to understand what already exists
- Do not create files or folders that already exist
- Do not reimplement logic that is already built — find it and use it

**At the end of every session:**
- Update the Current State section to reflect every file added or changed
- If any new environment variables were added, add them to the .env.example section
- If the architecture changed in any meaningful way, update the relevant section
- Do not end a session without completing this step

**When the folder structure changes:**
- Update the Folder Structure section to match what is actually on disk
- If a file moved, update every reference to it in this document
- If a file was deleted, remove it from the structure

This document must always reflect reality. If it does not, the next session starts
with false assumptions and produces broken code.

---

## Current State
> Updated by Claude Code at the end of every session. Shows what actually exists now.

**Last updated:** 2026-07-22 (EO typed writes hardened: $metadata → vendor-docs → auto-detect ladder, loud fallback)

**EO JSON-types recurrence fixed for good (2026-07-22):** The 2026-07-20
vendor-typed-writes fix ($metadata → explicit `columns`) did NOT hold in
production — a fresh 2026-07-22 sync still produced JSON-typed columns in
the catalog (all-NULL columns under DuckDB auto-detect), meaning the
`$metadata` path silently degraded (fetch failure in prod, or stale worker
image; CI builds for 480b82e all succeeded so the image SHOULD be current).
Root problem: the fallback to auto-detect was a log line nobody sees.
- **New `resolveEntityColumns` ladder** (`ExactOnlineConnector.ts`, exported):
  live `$metadata` → static vendor docs (`EXACT_ONLINE_COLUMN_DOCS.dataType`
  via `edmTypeToDuckDb`) → auto-detect. The docs rung covers ALL catalog
  entities (test-enforced), so typed writes can no longer silently degrade;
  auto-detect can only fire for an entity outside the docs catalog.
- **Loud, user-visible degradation**: `$metadata` fetch failure and any
  auto-detect fallback now push SYNC WARNINGS (surface in the sync-run UI)
  instead of buried `log.warn`s. Empty-entity parquets use the same ladder.
- **Tests**: `resolveEntityColumns.test.ts` (5, no DuckDB): Edm mapping via
  real CSDL parse, docs fallback, full catalog coverage, never-JSON
  invariant. Package `tsc` clean. DuckDB-native suites still CI-only.
- **Rollout note**: existing EO tables written before this fix keep their
  JSON types even after an incremental sync (merge unions old+new schema) —
  a clean re-sync (remove + re-add the connection, or a forced full sync)
  is needed once. If warnings then still report $metadata failure, that is
  the real prod signal to chase (auth/timeout on `/api/v1/{division}/$metadata`).

**Odoo curated core-field docs (2026-07-20, fourth session of the day):**
Odoo's docs channel is runtime `fields_get`, but many standard fields ship
without a `help` tooltip and fell through to the AI pipeline. New
`packages/connectors/src/odoo/docs.ts` (`ODOO_COLUMN_DOCS`): hand-curated
descriptions for ~242 core fields across ALL 21 allowlisted models (Odoo
16+ semantics). Precedence in `buildEntityDocs`: live instance help
(tenant customisation/language) > curated fallback > many2one synthesis >
AI. Tests: data invariants (models ⊆ allowlist, safe names, non-empty,
every model covered, ≥240 fields), precedence tests (live help beats
curated; custom fields still fall to AI). Connectors: 119 tests pass,
`tsc` clean, dist rebuilt; backend untouched.

**Prior last updated:** 2026-07-20 (semantic enrichment plan Phases 1-3: sibling context, human-edit tracking, opt-in AI enrichment)

**Semantic enrichment Phases 1-3 (2026-07-20, third session of the day):**
Implements `docs/backlog/semantic-enrichment-plan.md` in full. Backend
`npm run check` clean; both lint ratchets green (dynamic-import 92,
validate-coverage 166); prompt unit tests 3/3; RLS round-trip smoke passed
(hand-edit + confirmed relationship + approved enrichment survive re-profile,
pending enrichment wiped back to vendor text, vendor_description persisted).
- **Phase 1 — vendor sibling context**: `VendorDocsContext` threaded from
  `SchemaProfiler` (built from the describeEntities harvest) into Pass B
  (vendor TABLE definitions section) and Pass C (VENDOR-DOCUMENTED SIBLING
  COLUMNS section — custom fields described in the vendor's vocabulary).
  Caps: 40 siblings/table, descriptions truncated at 120 chars. New pure
  test `ai/prompts/schemaContextPrompt.test.ts`.
- **Phase 2 — human-edit tracking (migration 70)**: `edited_by_user` on
  source_tables/source_columns (set by PATCH /semantic/{tables,columns}/:id
  ONLY when a semantic field actually CHANGED — bare confirm ≠ authorship);
  `confirmed_by_user` on table_relationships (any PATCH). Profiler persist
  snapshots flagged rows + confirmed rels BEFORE the wipe and merges them
  into the persist maps (so PG **and** the Neo4j mirror get human values);
  confirmed rels the pipeline didn't re-derive are re-INSERTED. Missing
  source columns → snapshot dropped with log line.
- **Phase 3 — opt-in enrichment (migration 71)**: `vendor_description`
  (immutable curated base) on source_tables/source_columns, written by the
  profiler. New `POST /connections/:id/enrich-descriptions` (admin,
  `?dryRun=1` for scope preview; selection = vendor-documented AND
  (measure OR FK endpoint) AND NOT edited/enriched; caps 300/run,
  40/table) → `AIService.enrichColumnDescriptions` (Sonnet, one call per
  table; server GUARANTEES the vendor sentence leads — prepends it if the
  model drifted; no-op enrichments skipped). Persist:
  `semantic_source='ai_enriched'`, `ai_draft=true`,
  `approval_status='pending'` → existing review queue. Flagging an
  ai_enriched row in PATCH /semantic/columns/:id RESTORES the vendor text
  (new targeted `graph.updateColumnDescriptionOnly` — `updateColumn`'s
  full-SET shape would null other fields). Approved enrichments ride the
  Phase 2 snapshot (survive re-profile); pending ones don't. Frontend:
  "Enrich descriptions" button on the sources card (visible when analysed;
  dry-run count + confirm dialog before spending tokens).
- **Go-live note**: enrichment needs `vendor_description` populated — run
  Analyse once after this deploys before the button has candidates.

**Prior last updated:** 2026-07-20 (EO semantic-correctness sweep: RLS docs-channel bug, vendor-typed writes, docs-derived relationships)

**EO semantic-correctness sweep (2026-07-20, second session of the day):**
User compared Clarion's catalog against ExactOnline's REST reference and found
AI descriptions where vendor docs exist, `json` data types for `Edm.String`
columns, and missing GUID-documented relationships. All three root-caused and
fixed. Connectors: 116 tests pass, `tsc` clean, dist rebuilt; backend
`npm run check` clean; dynamic-import ratchet at 92.
- **Docs channel was DEAD IN PRODUCTION (RLS pool bug).** `SchemaProfiler`
  re-fetched the connections row on the raw `semanticDb` pool; under the
  prod `databridge_app` role a pooled connection without `app.current_tenant`
  returns ZERO rows → `connRow` undefined → connector_type null → the
  describeEntities docs harvest AND getKnownRelationships silently skipped →
  pure-AI descriptions for fully-documented EO columns (confirmed in prod
  Log Analytics: the 2026-07-20 08:56 Re-analyse of connection 17 emitted no
  describeEntities/known-relationship lines). Dev never reproduced it (owner
  role bypasses RLS). Fix: `ProfilerOptions.connection` — every caller
  (routes/connections /profile ×2, SyncOrchestrator ×2, workers, index.ts
  legacy route) now passes the row it already fetched under correct tenant
  context; the profiler's fallback fetch warns LOUDLY when it misses; the
  persist transaction pins `setTenantContext(trx, tenantId)` (kills the
  stale-pool-var cross-tenant hazard); credential-rotation persist is
  tenant-scoped. Verified with a throwaway-clone profile run against local
  Postgres AS `databridge_app` with no ambient tenant var: 455/455 curated
  columns land verbatim (`curated`/`approved`), 25 confirmed relationships.
- **Vendor-typed warehouse writes (EO).** EO synced via
  `read_json(auto_detect)` — all-NULL columns became JSON (user-visible:
  `CreatorFullName` "json" vs `Edm.String`), types could drift per sync. The
  connector already fetched OData `$metadata` every sync but only used it for
  empty tables. Now every entity write passes `columns` (Edm →
  `edmTypeToDuckDb`) — same explicit-schema path Odoo uses; metadata-fetch
  failure degrades to auto_detect. PLUS: both writers' merge paths
  (`ParquetWriter` + `BlobSasWarehouseWriter`) now CAST the EXISTING parquet
  side to the declared schema when `columns` is supplied, so legacy mistyped
  columns CONVERGE on the next incremental sync (no manual parquet surgery;
  CAST not TRY_CAST — unconvertible legacy values fail that entity loudly).
  Tested: all-NULL Edm.String lands VARCHAR; JSON→VARCHAR convergence merge.
- **Docs-derived relationships (245 vs 82 hand-curated).** EO's docs pages
  hyperlink every FK property to its target entity's page; the original
  transcription discarded the links. New PERMANENT tool
  `packages/connectors/scripts/generate-eo-docs.ts` (replaces the lost
  scratchpad script): fetches the resources index (355 endpoint mappings,
  prefers non-`Read*` entity pages; `SupplierItems`→`LogisticsSupplierItem`
  and `TimeCostTransactions`→`SyncProjectTimeCostTransactions` overrides) +
  61 details pages, and regenerates `docs.ts` with — per column —
  verbatim description, role hint, NEW `dataType` (Edm type) and NEW
  `references: {table, column}` (hyperlink target resolved to catalog
  entities; `toColumn` from the target's `data-key="True"` property — catches
  `SalesInvoices.InvoiceID` as the header PK). Regenerated docs.ts: 61
  entities, 2,613 documented columns (EXACTLY the original count — parse
  fidelity), 245 FK references. `ColumnDoc` gained `dataType?`/`references?`;
  `describeEntities` emits them as declared-rung relationships filtered to
  selected entities (profiler merges + dedupes vs the known catalog, which
  stays authoritative for special cases). New tests: reference targets ∈
  catalog + documented key columns, core-join spot checks, relationship
  emission + selection filtering.
- **Go-live runbook (after promote):** on the prod EO connection click
  Re-analyse → descriptions become verbatim vendor docs + relationships jump
  to docs coverage. Data types converge on the NEXT sync (typed writes +
  merge casts); no cursor reset needed unless a CAST failure surfaces
  (then clear `entity_sync_cursors` for the connection + delete its
  warehouse blobs to force a clean full pull).
- **Open (user-requested, not yet built):** AI ENRICHMENT of vendor
  descriptions (vendor text as base + AI extends with data context, marked
  ai_draft; do selectively — measures/FK/template columns) and passing
  documented sibling descriptions as context when AI describes custom
  fields.

**Prior last updated:** 2026-07-20 (first-sync structural catalog registration — tables visible in catalog before AI analysis)

**First-sync structural catalog registration (2026-07-20):** Fixes the
onboarding gap where "Sync complete" left the Catalog empty (source_tables is
populated only by the schema profiler, and post-sync auto-profiling is
default-off for cost reasons). Now a first sync into an empty catalog
automatically runs a FREE **structural** profiler pass — introspection +
connector docs channel (describeEntities / getKnownRelationships) only, ZERO
AI calls — so tables/columns/declared relationships appear in the catalog
immediately; the AI passes stay behind the explicit "Analyse" click. Backend
`npm run check` clean; smoke-tested end-to-end against the local dev stack
(SQLite sample DB → 5 tables / 43 cols / 5 rels registered, no ai_draft/
quality phases emitted, review queue untouched, Neo4j mirrored).
- **`SchemaProfiler.ts`**: new `ProfilerOptions { mode: 'full' | 'structural' }`
  4th param on `runSchemaProfiler`. Structural mode skips AI FK matching,
  quality profiling, and AI Passes A/B/C + verification; persists tables/
  columns with vendor docs where available (trusted rung unchanged:
  approved + declared/curated) and bare structure otherwise —
  `ai_draft=false, approval_status='draft', semantic_source=NULL` so bare
  rows stay OUT of the review queue (nothing to review yet). Persist maps
  now carry `approvalStatus` explicitly (was derived from aiDraft).
- **`SyncOrchestrator.runProfilerInBackground`**: when `!AUTO_REPROFILE_ON_SYNC`
  and the connection has ZERO source_tables (first sync), runs the structural
  pass, sets new terminal `profiling_status='structural'`, persists
  `schema_hash` (so routine re-syncs short-circuit at the steady-state gate
  instead of re-registering/re-notifying), and notifies "tables are in the
  catalog — click Analyse". Failure falls back to the old notify-only path.
  `profiling_status` values are now: null | running | **structural** | done |
  error (comment updated in both `shared/contract.ts` copies).
- **Frontend truth-telling**: `/sources` card badge for synced-but-unanalysed
  sources is now **"Synced"** (was a misleading "Ready"); hint reads "Tables
  are loaded and visible in the catalog. Click Analyse…"; the card's action
  button is **"Analyse"** (ocean-emphasised) until the first AI pass, then
  "Re-analyse". IconRail Sources badge counts 'structural' as pending action.
  `SourceRootPanel` (catalog) shows a warn strip when status='structural':
  "Tables are loaded, but this source hasn't been analysed yet" + link to
  /sources for curators.
- **Not changed**: manual Analyse (`POST /connections/:id/profile`) is the
  unchanged full pipeline; AUTO_REPROFILE_ON_SYNC=true legacy path unchanged;
  schema-drift notifications for already-registered sources unchanged.
- **Known cosmetic follow-up**: sources-sidebar caption shows raw `conn.type`
  ("DUCKDB") with a "?" avatar for connector-framework sources instead of the
  connector branding.

**Prior last updated:** 2026-07-19 (deploy flow streamlined: fixed staging URL, traffic-pinning fix, rollback workflow)

**Deploy flow streamlined (2026-07-19):** CI/CD-only change (no app code).
Cuts a typical deploy from ~13 min to ~6 min and makes the test-first model
actually hold. See `docs/DEV_FLOW.md` (rewritten Loop 2) for the user flow.
- **Neo4j-constraints job gated** (`deploy.yml`): it consistently burned ~7
  min per deploy (slow connect to the Neo4j Container App) and the backend
  ensures constraints at startup anyway. New `neo4j` paths-filter — the job
  now only runs when `backend/src/db/neo4j.ts` itself changed.
- **Traffic-pinning bug fixed** (`deploy.yml` + `promote.yml`): promote used
  `--revision-weight latest=100`; a traffic entry pinned to "latest"
  auto-follows every future revision, so after the first promote every
  subsequent push went STRAIGHT LIVE — the 0%-traffic staging model was
  silently broken (this is why "we can only test in production"). Both deploy
  steps now pin traffic to the currently-live revision BY NAME before
  creating the new revision, and promote resolves `latestReadyRevisionName`
  and promotes by name. Never set `latest=100` (CI or portal).
- **Fixed, bookmarkable test URL** (`deploy.yml`): each deploy moves the
  Azure Container Apps revision label `staging` to the new revision, so
  `https://<app>---staging.<env-domain>` (backend + frontend) is a stable URL
  that always serves the newest pushed version. Printed in the job summary.
- **New `rollback.yml` workflow**: "Rollback production" (workflow_dispatch,
  backend/frontend/both) shifts 100% traffic to the newest active revision
  older than the one currently serving — one-click undo after a bad promote.
- **Known limitation** (documented in DEV_FLOW.md): the test frontend calls
  the LIVE backend (`NEXT_PUBLIC_API_URL` baked at build). Full-stack staging
  isolation would need either a second frontend build against the backend
  staging-label URL or a runtime API proxy — deliberately not done (footgun:
  a promoted frontend must never point at the moving staging label).
- **Not yet verified live**: the first push to main after this merge should
  be watched once — confirm the new revision lands at 0% traffic, the
  staging-label URLs resolve, and Promote/Rollback behave as described.
- **Drive-by fix — validate-coverage ratchet red on main since 2026-07-14**:
  `POST /dashboards/fix-widget` (Tier-1b self-heal endpoint) shipped without
  Zod validation, pushing unvalidated mutating routes to 167 vs baseline 166.
  Added `fixWidgetSchema` (`middleware/schemas.ts`) + `validate()` on the
  route; lint back at 166, `tsc` clean (only the pre-existing knexfile
  rootDir warning).
**Prior last updated:** 2026-07-15 (product assessment — user/feature/business audit vs the "Odoo of SMB analytics" strategy)

**Product assessment (2026-07-15):** New `Clarion-Product-Assessment.docx` at the
repo root (source: `.archdoc/build-product-assessment.js`, regenerate with
`node .archdoc/build-product-assessment.js` then Word COM for TOC/PDF). Audits
the platform against the strategy doc `Clarion-Platform-Strategy.md` (user's
Downloads; the Odoo-playbook positioning). Evidence: full PROD walkthrough
(live EO tenant) + 4 parallel code investigations at 4c51a14. Doc only — no
product code changed this session. **Verdict: the engine matches the strategy;
the first fifteen minutes don't.** Four launch-killers found, all
surface/wiring-level (P0 in the doc §6):
1. **"Prepare my data" re-run duplicates every product** — `busMatrixBuilder.ts:203-254`
   inserts unconditionally, no retire/replace of the prior generation. Prod
   tenant has 9 products (Sales ×2, Purchases ×2, Reference ×2, 0 healthy);
   duplication pollutes Catalog, dashboard picker, Trust list AND the AI schema
   context (two column-casing conventions coexist).
2. **Dashboard generation shipped 6/6 broken chart widgets in prod** ("Sales
   overview" test); `validateAndRepairSpec` is fail-open (`dashboards.ts:236-245`
   ships unvalidated specs); fix-widget self-heal failed silently; $/€ mismatch
   between AI insights and KPI cards; ~100s generation vs <30s claim.
3. **Onboarding wizard is dead code** — register routes to /sources
   (`register/page.tsx:32`); `/onboarding` is presentation-only, advertises
   Snowflake/BigQuery/Redshift/CSV (none exist), omits EO/Odoo. Real funnel =
   ~6 technical decisions (OAuth app creds, entity multi-select w/ no defaults,
   manual Sync now, "Prepare my data" concept).
4. **Live thinking stream ungated** — ThinkingBubble/ThinkingPanel stream raw
   SQL + "star schema" phase strings + confidence to ALL roles incl. viewers
   (`query/page.tsx:1064-71`, `thinking.tsx:96-105`, backend phase strings
   `query.ts:1163,1236`). Makes the admin-only Show-SQL gating cosmetic.
Other key findings: trust signals (confidence/tables-used/provenance) are
admin-only on SUCCESSFUL answers (`MessageBubble.tsx:1094-99`) — business users
only see them on refusals; no export-everything / glossary export; GDPR
purge/erasure routes exist but have NO UI; formatting bugs (year "2.025", raw
ISO timestamps, alias-cased headers); missing business features ranked: metric
alerts (promised in `pulseService.ts:6`, unbuilt), Excel/CSV upload connector,
targets/budget-vs-actual UI, NL/FR i18n (UI is English-only), external sharing,
weekly digest. Drift watchlist (§5): freeze notebooks (rfc-002 targets
analysts), demote /pipelines DAG canvas, bury star-schema designer surface,
DELETE orphaned cross-views (IntegrationsPanel imported nowhere), retire /gaps.
Strong list worth protecting (§3): repair loop verified end-to-end in prod
("Corrected after investigation" on a live wrong answer), Workspace/Studio IA,
Pulse→Morning Brief proactive layer, docs-before-inference profiling +
star-schema templates, glossary as semantic moat, ~$0.75-2/mo AI cost per
tenant, security/GDPR hygiene. During the audit a temp admin user was created
and DELETED in the LOCAL dev DB (tenant 63); prod was walked through read-only
(one Ask-AI question + one discarded dashboard generation).

**Prior last updated:** 2026-07-14 (source-onboarding playbook §8 COMPLETE: items 1-5 shipped)

**EO star-schema template + §8 item 5 conformance checks (2026-07-14):**
Closes the playbook's §8 platform-gap list. Connectors package: 111 tests
pass, `tsc` clean, dist rebuilt; backend `npm run check` clean (no backend
code changes — the template path from item 4 is generic, EO just plugs in).
- **ExactOnline template v1** (`exactonline/starSchemaTemplate.ts`): 6
  conformed dims (account, item, item_group, gl_account, journal
  [code-keyed], payment_condition [code-keyed]), 6 facts
  (fact_sales_invoice_lines [joins SalesInvoiceLines+SalesInvoices],
  fact_transaction_lines, fact_sales_order_lines, fact_purchase_order_lines,
  fact_receivables, fact_payables), 4 products (Core dimensions → Finance →
  Sales → Purchasing), 25 relationships, 4 KPIs. Authored strictly from the
  docs.ts transcription — the test suite PROVES every column lineage points
  at a vendor-documented field. EO conventions: credit notes natively
  negative (no sign-flip), *DC = division currency (additive), dates
  TRY_CAST from ISO strings, GUID FKs raw VARCHAR + technical. No
  dim_gl_classification (GLAccounts has no GLClassification field per the
  vendor docs). Tested in `exactonline/starSchemaTemplate.test.ts` — same
  DuckDB-execution rigor as Odoo's (synthetic tables, DESCRIBE column
  equality, full materialisation, KPI runs, invoice+credit-note netting).
- **Conformance (item 5)**: `validateEntityCatalog` now REQUIRES a
  description on every entity; new `validateKnownRelationships` (endpoints ∈
  catalog, safe columns, valid cardinality, no dupes); `conformance.test.ts`
  runs both plus `validateStarSchemaTemplate` generically for every
  registered connector that ships a template.
- **Remaining follow-ups** (tracked, not §8): template-version UPGRADE flow
  (`data_products.template_version` makes staleness visible); human-edit
  tracking so re-profiles don't overwrite user edits; live-instance
  validation of both templates against real Odoo/EO connections.

**Deterministic star-schema templates (2026-07-14, §8 item 4):** The
"Prepare my data" bus-matrix workflow now instantiates a connector-shipped
template instead of the AI designer whenever one covers the synced entities —
the AI is officially the fallback. Connectors package: 99 tests pass, `tsc`
clean; backend `npm run check` clean, migrations applied, full backend suite
green.
- **Contract** (`packages/connectors/src/starSchema.ts`):
  `SourceConnector.getStarSchemaTemplate(): StarSchemaTemplate | null` —
  versioned template of conformed dims + facts (each with `sourceEntities`,
  SQL over BARE source-table names, full column metadata incl. roles /
  FK targets / isTechnical), product groupings (buildOrder), relationships,
  KPIs (with `requiresTables`). `instantiateStarSchemaTemplate` = graceful
  degradation (all-entities-or-drop per table; repairs relationships,
  dimensionsUsed, product groupings, orphaned-dim ownership, renumbers
  buildOrder; drops KPIs whose tables dropped; returns null when no fact
  survives → caller uses AI). `validateStarSchemaTemplate` = structural
  conformance, run in each connector's test suite.
- **Odoo template v1** (`odoo/starSchemaTemplate.ts`): 9 conformed dims
  (partner, product, product_category, account, journal, company, currency,
  payment_term, uom), 6 facts (fact_invoice_lines with credit-note
  sign-flip + display_type filter, fact_journal_items, fact_sales_order_lines,
  fact_purchase_order_lines, fact_payments, fact_stock_moves), 5 products
  (Core dimensions → Finance → Sales → Purchasing → Inventory), 33
  relationships, 5 KPIs. Facts carry natural FK ids and never JOIN dims.
  Targets modern Odoo (16+ fields). Tested in
  `odoo/starSchemaTemplate.test.ts`: structural validation vs catalog,
  degradation scenarios, and REAL DuckDB execution — synthetic Odoo source
  tables, every dim/fact SQL executed with output columns asserted equal to
  declared metadata, full template materialised, every KPI formula run.
- **Backend integration**: `services/starSchemaTemplates.ts`
  (`tryBuildBusMatrixFromTemplate`) maps the instantiated template onto
  `BusMatrixOutput`; `busMatrixOrchestrator` tries it after loading
  source_tables and skips AI Phases B/C-recovery on a hit (validation +
  `buildBusMatrix` + transformations unchanged). Migration
  `20260714000069_add_template_version.ts`: nullable
  `data_products.template_version` (NULL = AI-designed);
  `BuildBusMatrixOptions.templateVersion` threads it through. Env
  `STAR_SCHEMA_TEMPLATES_DISABLED=1` forces the AI path (documented in
  `.env.example`).
- **Not yet**: EO star-schema template (authoring job — profiler+platform
  side is generic); template-version UPGRADE flow (customers stay on their
  materialised version; `template_version` column makes it visible); no
  frontend changes (wizard flow is identical, just faster).

**ExactOnline column-docs curation (2026-07-14, §8 item 3):** All 61 EO
catalog entities transcribed from the vendor's REST reference into
`packages/connectors/src/exactonline/docs.ts` (GENERATED file — 2,613
documented columns). Transcription was DETERMINISTIC: a Node HTML-table
parser over the docs details pages (each property row's checkbox input
carries name/data-type/data-isnavigation; last `<td>` = description;
navigation properties skipped) — no model in the loop, verbatim by
construction. Role hints from Edm types (Double/Decimal → measure;
Guid/String/Boolean/DateTime → dimension; ints → none).
`ExactOnlineConnector.describeEntities` serves the map statically
(`provenance: 'curated'`, no network; relationships NOT duplicated —
`getKnownRelationships` already covers them; unknown entity names skipped).
Docs-page-name quirk: `TimeCostTransactions` has no standalone REST docs
page — transcribed from `SyncProjectTimeCostTransactions` (same model,
`Timestamp` excluded). New `exactonline/docs.test.ts` (6 tests) gates the
data: keys ⊆ catalog, safe names, non-empty descriptions, ≥40 entities /
≥1000 columns, AmountDC-is-measure spot check. Package: 81 tests pass,
`tsc` clean, dist rebuilt; backend `npm run check` clean (no backend
changes needed — the profiler side shipped with §8 item 1). Next: §8
item 4 — `getStarSchemaTemplate`.

**Trusted-tier docs channel + Odoo `fields_get` harvest (2026-07-14):** Items
1+2 of the playbook's §8 platform gaps — "documentation before inference" is
now live end-to-end for Odoo. Connectors package: 75 tests pass (12 new);
`tsc` clean. Backend: `npm run check` clean; migration applied locally.
- **Connector contract** (`packages/connectors/src/types.ts`): new optional
  `SourceConnector.describeEntities?(config, selectedEntities, ctx)` returning
  `EntityDocs[]` — per-entity `description`/`displayName`, per-column
  `ColumnDoc { name, displayName, description, role: 'measure'|'dimension' }`,
  docs-derived `relationships`, and `provenance: 'declared' | 'curated'`.
  Exported from the package index (with `KnownRelationship`).
- **Odoo harvest**: transports now request
  `['type','store','string','help','relation']` from `fields_get` (shared
  `FIELDS_GET_ATTRIBUTES` const in `transport.ts`; previously only
  type/store — the vendor's own field docs were discarded).
  `OdooConnector.describeEntities` maps `help` → column description
  (verbatim), `string` → display label, many2one `relation` → declared
  relationships (target `id`, filtered to selected entities) + synthesised FK
  descriptions ("Customer — references res_partner."), and field type → role
  hints via `odooFieldRole` (`entities.ts`). Covers customer custom fields
  (`x_...`) automatically since it runs against the connected instance.
  `ODOO_ALLOWLIST` gained curated one-line `description`s for all 21 entities
  (also shown in the wizard picker now). Pure builder `buildEntityDocs`
  exported for tests; new `odoo/docs.test.ts` (12 tests, incl. mocked JSON-2
  wiring + non-string `help: false` coercion).
- **Profiler** (`backend/src/semantic/SchemaProfiler.ts`): new step 1a decrypts
  `connections.connector_config_encrypted` and calls `describeEntities` (with
  credential-rotation persist hook; failure degrades to the AI pipeline).
  Documented columns are EXCLUDED from AI Pass C (token + review-queue win);
  docs-derived relationships merge into the `declared` FK rung (deduped
  against the static `getKnownRelationships` catalog). Persist values (display
  name, description, dim/measure flags, ai_draft, semantic_source) are
  computed ONCE in `tablePersistByName`/`colPersistByKey` maps and consumed by
  BOTH the Postgres insert and the Neo4j sync so the dual-write mirror can't
  diverge. Precedence: connector docs > AI; documented rows land
  `ai_draft=false, approval_status='approved'` (skip the review queue);
  vendor display labels beat AI guesses even on undocumented columns; role
  hints fill dim/measure only where the AI pass didn't run.
- **Migration `20260714000068_add_semantic_source.ts`**: nullable
  `semantic_source` text on `source_tables` + `source_columns`
  ('declared' | 'curated' | 'ai', NULL = pre-provenance). Mirrored to Neo4j:
  `UpsertTableInput`/`UpsertColumnInput` gained `aiDraft`/`semanticSource`;
  Cypher sets `semanticSource` on create+match, and `aiDraft` is forced false
  on match only when the incoming row is trusted (preserves user confirmations
  otherwise). Relationship EDGES in Neo4j still hardcode `aiDraft: true`
  (pre-existing divergence from PG's `ai_draft=!isKnown`; PG drives the
  review queue).
- **Known limitation** (documented in the playbook §8): re-profiling still
  rebuilds all rows, so human edits are overwritten on the next profile run —
  pre-existing behaviour; "human edit beats everything" needs edit-tracking
  (follow-up).
- **Next**: §8 item 3 — EO column-docs curation (implement `describeEntities`
  returning a static curated map, `provenance: 'curated'`; profiler side
  already live). Then item 4 — `getStarSchemaTemplate`.

**Source-onboarding playbook (2026-07-14):** New binding contract
`docs/SOURCE_ONBOARDING.md` — the way of working for every new source
connector. Core principle: *documentation before inference*. Classifies
sources into three metadata tiers (1 self-describing via runtime metadata
APIs, 2 vendor-documented → build-time curation in the connector package,
3 undocumented → AI pipeline as today), defines the semantic precedence
ladder (`declared > curated > ai_verified > ai_draft`, human edits beat
all), a phase-by-phase checklist (research brief → transport/auth → entity
catalog → sync correctness → semantic wiring → deterministic star-schema
template → tests/conformance → registration), explicit fallback rules for
missing documentation, and a Definition-of-Done merge gate. §8 lists the
platform gaps the contract depends on, in build order: (1) trusted-tier
descriptions in SchemaProfiler + provenance column, (2) Odoo `fields_get`
harvest of `string`/`help`/`relation` (today only `['type','store']` are
fetched — the vendor's own field docs are discarded), (3) EO column-docs
curation, (4) `getStarSchemaTemplate` contract, (5) new conformance
checks. Doc only — no code changed this session.


**Prior last updated:** 2026-07-13 (dashboard generation — architecture assessment + Tier-1 reliability hardening)

**Dashboard generation — architecture assessment + Tier-1 hardening (2026-07-13):**
Full review of the dashboard-generation stack (prompts, AIService, route
validation pass, productContext, ChartWidgets, the reverted Vega migration)
plus an external survey of the 2025–26 charting/AI-dashboard landscape.
**Plan of record: `docs/backlog/dashboard-architecture-plan.md`** — read it
before touching dashboard generation/rendering. Headline verdict: the
current LLM→app-owned-JSON-DSL→deterministic Recharts pattern is the
industry-winning architecture (same as Databricks Genie / Hex / Superset
MCP); do NOT return to Vega-Lite (its silent-blank failure is a documented
structural property + worst measured LLM generation accuracy); the upgrade
path is ECharts 6 as a *second* backend behind the same DSL (Tier 2),
react-grid-layout for user layout editing (Tier 3), Mosaic-style
DuckDB-WASM cross-filtering (Tier 3). Tier 1 shipped in this session
(backend typechecks clean; 11 new unit tests pass):
- **`backend/src/shared/widgetContracts.ts` (new)** — single source of truth
  for the per-widget-type required SQL column contract
  (label/value/series/row_label/…); `validateWidgetColumns()` turns the
  "mis-aliased SELECT renders an empty card" silent failure into a caught,
  repairable issue. Unit-tested (`widgetContracts.test.ts`, pure functions).
- **`/generate` validation pass hardened** (`routes/dashboards.ts`) —
  deterministic column-contract check per executed widget feeds a new
  `contractIssue` field into `hasIssues` + the repair prompt (new fix rule 8
  in `VALIDATE_DASHBOARD_SYSTEM`); swallowed validation failures are now
  logged loudly instead of silently shipping an unvalidated spec.
- **Truncation repair wired into `parseJson`** (`AIService.ts`) — a 16K-token
  spec cut at the maxTokens cap now goes through `repairTruncatedJson` +
  Zod instead of 500ing the whole request.
- **Prompt contracts for the three phantom widget types** — combo_chart /
  treemap_chart / radar_chart were legal in the Zod enum but had no spec
  block in `DASHBOARD_SYSTEM`; full blocks + decision-table rows added,
  matching the actual frontend component contracts (combo: label/value +
  optional `line` right-axis overlay).
- **`kpiFormulas` now reaches dashboard generation** — was built by
  `productContext` but only used for NL→SQL; now threaded through
  `generateDashboardSpec` → `buildDashboardUser` as a "use these formulas
  verbatim" section.
- **Tier 1b + Tier 2/3 shipped later the same day (2026-07-13, same branch):**
  - **Structured outputs** behind `AI_STRUCTURED_OUTPUTS=1` (default OFF.
    No staging env — verify with the one-shot live check
    `backend/scripts/verify-structured-outputs.ts` before flipping; pinned
    SDK predates the feature, params passed via cast). Generate/refine/validate
    dashboard calls send `DASHBOARD_SPEC_JSON_SCHEMA` (in `outputSchemas.ts`,
    widget enum derived from `REQUIRED_WIDGET_COLUMNS`) as `output_format`
    + the structured-outputs beta header. Documented in `.env.example`.
  - **refine-spec parity**: kpiFormulas in the refine prompt; the validation
    pass (extracted to `validateAndRepairSpec()` in `routes/dashboards.ts`)
    now also runs on `/refine-spec`, scoped to only the widgets the
    refinement changed.
  - **Widget self-heal**: `POST /dashboards/fix-widget` re-runs
    execute→contract-check→repair for ONE widget; frontend `WidgetCard`
    shows "Fix with AI" on errored widgets and patches the spec in place
    (marks dashboard unsaved).
  - **ECharts 6 second rendering backend** (tree-shaken `echarts/core`,
    ~100 kB gz, SVG renderer so marks are DOM-assertable, own ~40-line
    wrapper `components/EChart.tsx` — NOT echarts-for-react — with a
    visible render-error state; Observatory theme in
    `utils/echartsSetup.ts`). Two new widget types shipped on it
    full-stack: **scatter_chart** (label/x/y[/size]) and **bullet_chart**
    (label/value/target, attainment colouring) — added to the shared
    contract (both copies), Zod enum, JSON schema, prompt decision table +
    spec blocks, `REQUIRED_WIDGET_COLUMNS`, page switch.
  - **The Vega-lesson render gate, implemented**: `/dev/widgets` fixture
    gallery renders every DSL widget type (no auth/backend);
    `e2e/widgets.spec.ts` asserts in REAL Chromium that each type draws
    visible SVG marks, the ECharts types are on the ECharts engine, and no
    page errors fire. PASSING. Add every new widget type to the gallery or
    the spec fails on its count check. `playwright.config.ts` accepts
    `PLAYWRIGHT_CHROMIUM_PATH` for managed environments.
  - **Code-split chart bundle**: widget-type switch extracted to
    `components/WidgetBody.tsx`, loaded via next/dynamic —
    `/dashboards` first-load JS now **210 kB** (was ~565 kB with static
    Recharts). `next build` green.
  - **Table virtualization**: dependency-free `utils/useWindowedRows.ts`
    (spacer-row windowing, inert ≤150 rows) in `DataTableWidget`,
    `PivotTableWidget`, `DrillDetailModal`.
  - **User-adjustable layout**: "Arrange" mode on `/dashboards` via
    react-grid-layout 2.2 (drag/resize, 12-col grid, rowHeight 96;
    `useContainerWidth` for measurement). Placements persist per widget as
    `spec.widgets[].layout {x,y,w,h}` (new optional contract field); view
    mode renders explicit CSS-grid placement when every widget has a
    layout, and falls back to the legacy flow layout otherwise (so
    refine-added widgets never overlap).
  - **New frontend deps**: `echarts ^6.1.0`, `react-grid-layout ^2.2.3`.
    New root devDep usage: `@playwright/test` (already declared).
- **Still open (see plan doc §2/§3):** flip `AI_STRUCTURED_OUTPUTS` after
  running the verify script against the live API; small-multiples widget + brush/zoom on ECharts;
  dark mode; token-source consolidation; paginated PDF export; Mosaic-style
  DuckDB-WASM cross-filter graduation; VisEval-style eval harness (needs
  live API); domain-detection upgrade.

**Last updated (prior):** 2026-07-11 (storage-layer hardening — per-tenant containers + DuckDB guardrails)

**Storage-layer hardening — per-tenant warehouse containers + DuckDB compute guardrails (2026-07-11):**
Outcome of the platform professionality audit (see repo-root
`Clarion-Platform-Professionality-Audit.docx`). Two shipped changes, both
additive; the container work is feature-flagged **default-off** so this deploy
is behaviour-preserving until the flag is set. Backend typechecks clean; new
unit tests pass (19); Terraform validates + formatted.
- **Per-tenant warehouse containers (opt-in, `WAREHOUSE_CONTAINER_MODE`).**
  New `shared` (default) | `per-tenant` mode. In `per-tenant` mode each tenant
  gets its own Azure Blob container (`<AZURE_WAREHOUSE_CONTAINER_PREFIX><id>`,
  default `tenant-<id>`), turning tenant isolation on the data side from a
  code-enforced path prefix into a **hard storage boundary**: a worker SAS
  scoped to `tenant-42` physically cannot touch `tenant-43`, and offboarding a
  tenant becomes a single container delete. Backward-compatible: existing
  `delta_path`/`warehouse_path` are absolute URIs, so old data keeps reading
  after the flip; only NEW writes land in per-tenant containers (same
  incremental-migration model as v1→v2 layout).
  - `services/warehouse/paths.ts` — new `warehouseContainerMode()`,
    `warehouseContainer(tenantId?)`, `warehouseRoot(tenantId?)` (now
    tenant-aware), `sourceBasePathV2(tenantId, connectionId)`,
    `sourceWorkerPathPrefix(...)`; `productBasePathV2` drops the redundant
    `tenant_<id>/` path segment in per-tenant mode (container encodes it).
  - `services/warehouse/container.ts` (new) — `ensureWarehouseContainer(tid)`
    (createIfNotExists, memoised) called before worker SAS issuance
    (SyncOrchestrator) and before product writes (transformationRunner);
    `deleteTenantWarehouseContainer(tid)` offboarding primitive;
    `perTenantContainersActive()`.
  - `orchestrator/BlobSasTokenIssuer.ts` — warehouse SAS now scoped to
    `warehouseContainer(tenantId)` (heartbeat unchanged); `IssueArgs.tenantId`
    added. `orchestrator/AzureContainerAppsJobLauncher.ts` — passes `tenantId`,
    uses `sourceWorkerPathPrefix` (so worker write prefix + backend read path
    always agree). `orchestrator/SyncOrchestrator.ts` —
    `computeWarehousePathForDuckDB` Azure branch delegates to
    `sourceBasePathV2`; ensures the container before launch.
  - Terraform: `WAREHOUSE_CONTAINER_MODE` / `DUCKDB_MEMORY_LIMIT` /
    `DUCKDB_THREADS` env on the backend app; new vars in `infra/variables.tf`
    (default `shared` / `70%` / `2`). Per-tenant mode needs the backend
    identity to create containers — the existing `Storage Blob Data
    Contributor` role covers it. **Validate in staging before flipping.**
- **DuckDB compute guardrails (default ON).** `services/warehouse/duckdb.ts`
  `applyResourceGuardrails()` runs on every warehouse session:
  `SET memory_limit` (default `70%`, env `DUCKDB_MEMORY_LIMIT`), `SET threads`
  (default 2, `DUCKDB_THREADS`), `SET temp_directory` (spills to disk instead
  of OOM, `DUCKDB_TEMP_DIR`). Plus `capResultRows()` (default 100k, env
  `DUCKDB_MAX_RESULT_ROWS`, 0=off) wraps single SELECT/WITH reads in
  `DuckDBConnector.executeQuery` to bound the Node heap — leaves multi-statement
  scripts and notebook DDL/PRAGMA/COPY untouched. Fixes the audit's "DuckDB
  unbounded on 1 GB container" red-flag (Tier-A A2). Transformation write path
  and introspection are unaffected.
- **Tests:** `services/warehouse/paths.test.ts` (new, 19 cases) — proves
  shared-mode URIs are byte-identical to today, per-tenant URIs are correct,
  read path ↔ worker write prefix agree, local mode is container-mode-agnostic,
  and `capResultRows` caps SELECTs while leaving DDL/multi-statement alone.
  Runs without a live DB or native DuckDB (pure functions).
- **New env vars (documented in `.env.example`):** `WAREHOUSE_CONTAINER_MODE`,
  `AZURE_WAREHOUSE_CONTAINER_PREFIX`, `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS`,
  `DUCKDB_TEMP_DIR`, `DUCKDB_MAX_RESULT_ROWS`.
- **Audit docs at repo root** (untracked, generated via `.archdoc/`):
  `Clarion-Platform-Professionality-Audit.docx` (rubric + grades + Tier A/B/C
  action plan), `Clarion-AI-Analytics-Gap-Analysis.docx`,
  `Clarion-Technical-Architecture.docx`. This change closes Tier-A A2 (DuckDB
  guardrails) and delivers the storage-isolation half of the "alternatives"
  recommendation (per-tenant containers over moving to Postgres).

**Connector-framework audit fixes (2026-06-14, follow-up to the Odoo work):**
Tackled the deferred findings from the framework audit. All connector-package
changes are unit-tested (37 tests, `tsc` clean); backend changes typecheck
clean (`tsc --noEmit`, only the pre-existing `knexfile.ts` rootDir warning).
- **Egress enforcement (SSRF guard).** `HttpClient` now enforces an
  `egressAllowList`: every request (including server-provided pagination
  links) is host-checked and a request off the list is refused before it
  leaves the process. Wired into ExactOnline (its static `*.exactonline.*`
  list) and Odoo (the single configured host, so self-hosted instances aren't
  blocked). Closes the "follow a tampered next-link to exfiltrate creds" hole.
- **Error redaction.** `HttpClient` runs error-response excerpts through
  `redact()` before they reach the thrown message; the orchestrator redacts
  `error_message` / `warnings` / `log_excerpt` before persisting. Secrets in an
  error body can no longer land in the DB / UI.
- **Worker wall-clock timeout + force-kill.** Orchestrator races `handle.done`
  against `SYNC_MAX_DURATION_MS` (default 30 min) and cancels on timeout;
  `JobLauncher.cancel` now escalates SIGTERM → SIGKILL after
  `WORKER_CANCEL_GRACE_MS` (default 20s). A hung worker can no longer sit in
  `running` forever, and cancellation has teeth.
- **stdout flood guard.** The launcher caps the line-reassembly buffer (1 MB);
  a newline-less blob from the child can't exhaust memory.
- **In-flight dedupe is now a DB invariant.** New migration
  `20260614000067_source_sync_runs_inflight_unique.ts` adds a partial unique
  index on `source_sync_runs(connection_id) WHERE status IN ('queued','running')`
  (pre-cleans existing duplicates first); `triggerSync` catches the 23505
  conflict and returns the winning run — closes the TOCTOU race.
- **Retention.** The 5-min reaper now prunes terminal `source_sync_runs` older
  than `SYNC_RUN_RETENTION_DAYS` (default 90) so the table can't grow forever.
- **Tenant-context injection hardening.** All `SET app.current_tenant` string
  interpolations in the orchestrator replaced with a parameterised
  `set_config('app.current_tenant', ?, false)` helper.
- **Config validation on write.** New package export `validateConnectorConfig`
  (compiles the connector's JSON Schema); `PATCH /:id/source-config` now
  rejects a schema-invalid merged config with 400 instead of writing it to the
  encrypted cell to fail deep in the next sync.
- **ExactOnline cursor `>` → `>=`.** Applied the boundary-safe incremental
  filter to EO too (it merges by businessKey, so the re-pull is idempotent);
  removes the same second-precision watermark skip the Odoo connector already
  avoided. Cursor still only advances on a strictly-greater value.
- **Azure SAS (NOT code-fixed — honest docs only).** The warehouse SAS is
  still container-scoped; true path scoping (per-blob / HNS-directory SAS, or
  per-tenant containers) is an infra change that can't be verified without a
  live Azure account, so shipping it blind was declined. The misleading
  comments in `types.ts` + `BlobSasWarehouseWriter.ts` that claimed Azure
  returns a 403 for out-of-prefix writes are corrected to state the real
  guarantee (code-enforced pathPrefix + tenant-prefixed layout). Worker-side
  confinement (pathPrefix + `isSafeTableName`) is unchanged and remains the
  active control. **Still open:** path-scoped SAS, RLS-in-prod for
  `source_sync_runs`/`oauth_pending` + id-only IDOR `WHERE`s, worker secrets via
  stdin instead of env (local launcher), merge-via-Delta for large incremental
  tables. These remain tracked.

**Last updated (prior):** 2026-06-14 (Odoo source connector + connector-framework hardening)

**Odoo source connector + framework hardening (2026-06-14):** Added **Odoo** as
a first-class source connector built the same way as ExactOnline (the
`packages/connectors/` `SourceConnector` framework — NOT the legacy
`backend/src/connectors` + ETL path). Preceded by a critical audit of the
connector framework; the Odoo connector is built to dodge the framework's
latent bugs, and the "required hardening" subset of the audit fixes shipped
alongside it. ExactOnline behaviour is unchanged (every shared change is
additive or default-off).
- **New connector package `packages/connectors/src/odoo/`:**
  - `schema.ts` — JSON-Schema config (`url`/`db`/`username`/`apiKey`); API-key
    auth (no OAuth). `asOdooConfig` strips trailing slashes.
  - `transport.ts` — `OdooTransport` interface + `resolveOdooTransport()`
    (probes JSON-2, falls back to XML-RPC) + a strict **read-only method
    allow-list** (`assertReadOnly`: only fields_get/search/search_read/
    search_count/read/read_group — create/write/unlink impossible by
    construction) + error types (`OdooAuthError`, `OdooEndpointMissingError`).
  - `json2Transport.ts` — **PRIMARY** transport. Odoo 19+/Online `/json/2`
    REST, `Authorization: bearer <apiKey>`, `X-Odoo-Database`. Reuses the
    shared HttpClient with `requestsPerSecond: 1` (Odoo Online throttles ~1
    req/sec). The only non-deprecated path (`/xmlrpc/2` + `/jsonrpc` are
    deprecated in Odoo 19, removed earliest on Odoo Online).
  - `xmlrpcTransport.ts` + `xmlrpcCodec.ts` — **FALLBACK** for older on-prem
    (Odoo ≤ ~16). Hand-rolled XML-RPC encode + `fast-xml-parser` decode; the
    codec is fully unit-tested (`xmlrpcCodec.test.ts`) so it's not shipped
    blind. Auth in body, no Authorization header.
  - `entities.ts` — 21-model curated allowlist with **dotted→underscore
    table-name mapping** (`account.move.line` → `account_move_line`; required
    because the warehouse writer's `isSafeTableName` rejects dots). Every entity
    is incremental on `write_date` with `businessKey:'id'`. Plus
    `ODOO_KNOWN_RELATIONSHIPS` (documented many2one FKs) and
    `odooTypeToDuckDb` (Odoo field type → stable DuckDB SQL type).
  - `OdooConnector.ts` — `testConnection`/`listEntities`/`probeEntities`
    (dynamic "available tables": `search_count` per model; missing models like
    `stock.valuation.layer` on v19 surface as `not_found`)/`sync`/
    `getKnownRelationships`. Sync paginates `search_read` (PAGE 2000, order
    `id`), passes the writer an **explicit `columns` schema from `fields_get`**
    (stable types — no per-sync inference drift), flattens many2one
    `[id,name]→id` and Odoo's `false` empty-sentinel → null (type-aware: a real
    boolean `false` is preserved), and uses a **`write_date >= cursor`** filter
    (not `>`) with merge-by-`id` so boundary-second rows are never skipped
    (idempotent re-pull). Cursor advances only on strictly-greater `write_date`
    (satisfies the orchestrator's monotonicity guard).
  - `index.ts` registers the connector; `packages/connectors/src/index.ts`
    imports `./odoo`. No backend route, ETL, or migration changes — the
    `add-source` wizard + `/source-types` are registry-driven, so Odoo appears
    automatically.
- **Required framework hardening (shared, additive / default-off):**
  - **HttpClient client-side rate limiting** (`requestsPerSecond` /
    `minIntervalMs`, per-instance single-flight pacer) — default off, so EO is
    unchanged; Odoo sets 1/sec. Also fixed `Retry-After` to honour the HTTP-date
    form. Test bypass via `HTTP_CLIENT_RATE_LIMIT_DISABLED=1`.
  - **Explicit-schema writes** — `WriteTableOptions.columns` threaded through
    both `ParquetWriter` + `BlobSasWarehouseWriter` (`read_json(columns=…)`
    instead of `auto_detect`). Eliminates type drift / date-as-string /
    bigint-precision loss for connectors that know their schema. EO (no
    `columns`) keeps `auto_detect` — unchanged.
  - **`source_sync_runs` reaper** (`backend/src/index.ts`) — startup closes
    `queued`/`running` rows interrupted by a restart; the 5-min interval reaper
    fails rows stuck >30min (`COALESCE(started_at, queued_at)`). Fixes the
    "zombie running row permanently blocks a connection" blocker for ALL
    connectors. Also resets the connection's denormalised `last_sync_status`.
  - **Connector conformance suite** (`conformance.ts` + `conformance.test.ts`)
    — every registered connector is checked for metadata invariants (lower-snake
    type, compilable configSchema, non-empty egressAllowList, oauth
    preAuthFields ⊆ schema props) and every catalog for entity invariants
    (`supportsIncremental === !!incrementalCursor`, **`incrementalCursor ⇒
    businessKey`** — the table-wipe blocker — name safety, uniqueness). Runs over
    both Odoo and ExactOnline today; the gate that scales to many connectors.
- **Frontend** (`frontend/app/sources/page.tsx`): removed the stale
  `available:false` Odoo tile and added Odoo to `REGISTRY_DESCRIPTIONS` /
  `REGISTRY_COLORS`, so the live tile renders from `/source-types` and routes to
  the registry-driven `add-source` wizard — identical to how ExactOnline works.
- **Validated:** `tsc -p packages/connectors --noEmit` clean; 32 tests pass
  (`xmlrpcCodec` 11, `registry` 6, `OdooConnector` 10, `conformance` 5).
  DuckDB-dependent tests (`OdooConnector.sync.test.ts`, `ParquetWriter.test.ts`,
  `ExactOnlineConnector.test.ts`) can't run in the dev sandbox here — Node 22 has
  no DuckDB prebuilt and the native build needs toolchain/network — they run in
  CI / the backend image where DuckDB is available.
- **Deferred (tracked, NOT in this change — from the framework audit):** Azure
  warehouse SAS is container-scoped not path-scoped (cross-tenant write
  isolation rests on worker convention); `egressAllowList` is declarative-only
  (never enforced) + SSRF via followed pagination links; error
  excerpts/`log_excerpt` not redaction-scrubbed; RLS conditional on a prod-absent
  role + a few id-only `WHERE`s (cross-tenant IDOR); no worker wall-clock timeout
  / SIGKILL escalation; `source_sync_runs` unbounded growth + TOCTOU in the
  in-flight dedupe; config not validated on `PATCH /source-config`; merge path
  rewrites the whole table each incremental sync (route large incremental tables
  through the Delta sidecar). Apply the EO cursor `>`→`>=` fix too when touching
  EO (it has the same boundary-skip latent bug; deferred to avoid changing the
  working connector without explicit sign-off).

**Earlier last-updated:** 2026-06-06 (Dashboards reverted to Recharts — Vega migration backed out)

**Dashboards reverted to Recharts (2026-06-06):** The entire Vega-Lite migration
(commits `90d6970`, `f9fe7b7`, `b723884`, `a6ebba9`, `e73c887`, `aabed9f`) was
reverted in a single revert commit. Dashboards are back on the original Recharts
engine — the state working before 2026-06-06. **Why:** the Vega migration kept
producing silent blank charts in production (most recently bullet / scatter /
small-multiples rendered empty cards with NO console errors despite correct SQL
output). Multiple attempted fixes (autosize, format strings, SVG renderer,
post-render mark detection) all passed headless validation through the real
vega-lite compiler + vega.View but failed in the actual browser — i.e. the
sandbox tests didn't reproduce the browser's behaviour, so each fix shipped
blind. After several failed iterations the user (rightly) requested a rollback.
- **What was kept:** the deploy traffic-routing fix (`fb981aa` — pins 100% to
  the latest revision after `az containerapp update --image`, critical and
  unrelated to charts) and the three design-direction HTML mockups
  (`design-mockups/A-executive-brief.html`, `B-analyst-cockpit.html`,
  `C-boardroom.html` from `e16e9dd` — useful reference if/when the visual
  refresh is attempted again).
- **What's gone:** every Vega file (`utils/vegaSpecBuilder.ts`,
  `utils/vegaTheme.ts`, `components/VegaChart.tsx`), the vega/vega-lite/
  react-vega/vega-tooltip deps from `package.json`, the `canvas: false` webpack
  alias in `next.config.mjs`, the new widget types (bullet_chart, scatter_chart,
  small_multiples) from `frontend/app/dashboards/types.ts` +
  `backend/src/ai/prompts/dashboardPrompt.ts`, and the cockpit-style prompt
  changes. The Recharts-based ChartWidgets and the original prompt layout
  rules are back exactly as they were before the migration.
- **Validated:** `next build` exit 0; the production state is the one shown in
  the user's screenshot where bars, lines, and top-lists render correctly.
- **If anyone attempts the Vega migration again:** the lesson is that headless
  vega-lite/vega.View tests do NOT reproduce browser canvas/SVG rendering
  edge cases. Don't ship without verifying in a real browser (e.g. Playwright
  driving `/dashboards` and snapshotting actual rendered marks).

**Earlier last-updated:** 2026-05-07 (SCD1 foundation: Delta + Python sidecar + change-evolution chart)

**SCD1 + change tracking — Delta + Python sidecar (2026-05-07):** Replaces
the parquet-overwrite write path for product tables with Delta Lake +
a small Python sidecar that diffs new vs existing state on a business
key. Per-refresh `unchanged / updated / inserted / deleted` counts are
persisted to a new `product_table_refresh_history` table and surfaced
as a per-table change-evolution mini chart on `/products/[id]`. **Delta
is the default** — production images bake the Python venv +
deltalake/pandas/pyarrow in, so no env var is needed in Azure. Set
`STORAGE_FORMAT=parquet` to opt out (the escape hatch for local dev
where Python deps aren't installed). Sets the foundation SCD2 will
extend later — full design captured in `docs/backlog/SCD2.md`.

- **New migration `20260508000052_create_refresh_history.ts`:**
  - `product_table_refresh_history` (RLS-protected, one row per refresh
    attempt, keeps counts + status + error + storage_format)
  - `product_columns.is_technical` boolean — firewall flag that keeps
    `_row_hash` and future SCD2 columns out of every UI/AI surface.
- **Python sidecar `etl/scd2/commit_table.py`:**
  - JSON-over-stdin/stdout protocol; deltalake + pandas, no extra deps
  - md5 row-hash with ASCII unit separator; explicit NULL handling
  - Outer-merge diff on business key; falls back to "all inserted" when
    no BK is declared
  - `mode='overwrite'`, `schema_mode='merge'` so the writer widens
    schema automatically when a transformation produces new columns
  - 11 pytest cases covering hash + diff (`scd2/test_commit_table.py`)
- **Node `services/warehouse/deltaWriter.ts`:**
  - Spawns sidecar via `child_process.spawn`, 15-min timeout, SIGKILL
  - Records `product_table_refresh_history` row regardless of outcome
    (failed rows show up on the chart so users see "something tried")
  - `isSidecarReachable()` fast-fail check called from
    `transformationRunner` BEFORE the AI-generated SQL runs — turns a
    deferred "spawn failed" into an immediate "config wrong" error.
- **`transformationRunner.ts` integration:** Feature-flagged Delta
  branch runs before the legacy parquet branch; `_row_hash` filtered
  out of `syncProductColumns` so it never lands in `product_columns`.
  Same code path for dim and fact (per spec — facts overwrite each
  refresh too, change counts tracked for the chart).
- **`is_technical` firewall wired into 7 surfaces:** `productContext`
  (NL→SQL prompt context), `investigateService` + `refineService` (AI
  prompts), `routes/products.ts` GET `/:id` and `/:id/refine` (UI panel
  + refine prompt), `routes/notebooks.ts` (schema explorer + AI prompt),
  `productGraphSync` (Neo4j sync). Every read of `product_columns` for
  a user/AI-facing surface now appends
  `WHERE is_technical = false OR is_technical IS NULL`.
- **API `GET /api/products/tables/:tableId/refresh-history?limit=N`:**
  Returns chronological refresh rows under tenant RLS; default 30, max
  200.
- **Frontend mini chart (`components/products/RefreshHistoryChart.tsx`):**
  Two variants — `compact` (32px sparkline shown inline in each table
  row) and `full` (200px chart with axes, legend, "last refresh"
  summary strip, shown in the expanded view). Wired into
  `ProductRootPanel` so it surfaces on both `/products/[id]` and
  `/catalog?productId=…`.
- **Backend Dockerfile:** Production image now bakes Python venv with
  deltalake/pandas/pyarrow pinned to the same versions as
  `etl/requirements.txt`. Sidecar copied to `/app/etl/scd2/` so the
  default path resolver in `deltaWriter` finds it without env-var
  overrides.
- **New env vars (documented in `.env.example`):** `STORAGE_FORMAT`
  (default unset = parquet), `PYTHON_BIN` (default `python3`),
  `SCD2_SIDECAR_PATH` (override for non-default deployment layouts).
- **What's NOT in this commit (next ops steps):**
  - Notification on anomalous deletes (e.g. >50% rows deleted) — the
    data is there, no UI hook yet.
  - Backfill of refresh-history rows for refreshes that ran before
    this commit shipped — they're invisible on the chart until the
    next refresh of each table populates a row.
  - SCD2 itself — see `docs/backlog/SCD2.md` for the design.

**Storage layer consolidation — Phase 3 (2026-05-05):** Tenant-prefixed,
id-stable warehouse layout for product tables. Eliminates the cross-tenant
collision risk identified in the storage-layer audit (`./warehouse/product/<slug>`
was shared across tenants — two tenants with a "Sales" product would
overwrite each other's parquet on the same host). Behaviour-preserving by
default; opt-in via `WAREHOUSE_LAYOUT_VERSION=v2`.

- **New URI helpers in `services/warehouse/paths.ts`:**
  - `warehouseRoot()` — single source of truth for the warehouse base
    URI. Returns `az://<container>` in Azure mode (detected via
    `AZURE_CONTAINER_APPS_JOB_NAME`), `<repo>/warehouse` locally.
    Container name from `AZURE_WAREHOUSE_CONTAINER`, default `'warehouse'`.
  - `isAzureMode()` — environment-level Azure detection (separate from
    `isAzurePath(uri)` which tests a single string). Mirrors the
    detection logic in `SyncOrchestrator` so source + product paths
    agree on the active mode.
  - `productBasePathV2(tenantId, productId)` — new layout
    `<root>/tenant_<tid>/product_<pid>`. Stable across product renames
    because it uses `product.id` not `slug(product.name)`.
  - `warehouseLayoutVersion()` — reads `WAREHOUSE_LAYOUT_VERSION` env;
    returns `'v1'` (default) or `'v2'`.
- **Wired into `transformationRunner.runProductTransformation`:**
  When the layout flag is `'v2'` and a tenant id is present, the
  product output path is `productBasePathV2(tenantId, productId)`
  instead of `productBasePath(warehousePath, productSlug(name))`.
  All other state (the parquet write itself, the `delta_path`
  publish via the catalog, dependency loading, rollups) is unchanged
  — it just consumes the new path. v1 builds still work; the flag is
  per-deployment.
- **Migration model — naturally incremental, no data copy required:**
  - Existing rows keep their `delta_path` pointing at v1 directories.
    They continue to read fine because the catalog returns
    `delta_path` verbatim.
  - When a v2 build runs (because the operator turned the flag on),
    new writes go to the v2 location, the catalog publishes the v2
    URI, the row's `delta_path` flips to v2.
  - Every product table eventually migrates as it's re-refreshed.
    No big-bang job, no downtime. Old v1 directories become orphans
    and can be cleaned up by a maintenance job at leisure.
- **`productContext.getProductWarehousePath` rebuilt on top of catalog:**
  Was: hardcoded `./warehouse/product/<slug>` (wrong on Azure, never
  matched real paths). Now: returns `warehouseRoot()` if any product
  table for the connection has been materialised, else null. Real
  per-table URIs come from `tableCatalog.listProductTablesByConnection`
  via `createProductConnector` — `getProductWarehousePath` is only a
  cache key now. Side benefit: the `dim_account` and similar
  cross-product reads now work in Azure mode where they didn't before.
- **Sources are unchanged.** `SyncOrchestrator.computeWarehousePathForDuckDB`
  already produced `<root>/tenant_<tid>/conn_<cid>` paths — Phase 3
  brings products into alignment with that pattern.
- **What's NOT in this commit (next ops steps):**
  - Migration script to copy v1 → v2 paths in bulk (so older tables
    don't have to wait for re-refresh). Trivial: walk every
    `product_tables` row matching the v1 pattern, copy parquet, update
    `delta_path`. Will write when there's demand.
  - Switching production to v2. The flag defaults to `v1`. To opt in:
    set `WAREHOUSE_LAYOUT_VERSION=v2` in the deployed env, then trigger
    a refresh — new writes start using the new layout. Old reads keep
    working throughout.
- **New env vars:** `WAREHOUSE_LAYOUT_VERSION` (`v1`|`v2`, default
  `v1`), `AZURE_WAREHOUSE_CONTAINER` (default `warehouse`). Documented
  in `.env.example`.

**Storage layer consolidation — Phase 2 (2026-05-04):** Built the table
catalog as the single source of truth for "where does this logical
table live?" Every consumer that previously queried
`product_tables.delta_path`, `ingested_tables.delta_path`, or
`connections.warehouse_path` directly now goes through one module.
Behaviour-preserving — no schema changes, no metadata migrations.

- **New module `backend/src/services/tableCatalog.ts`** with one
  uniform API:
  - **Resolution (single):** `resolveSourceTable(tenantId, connectionId, tableName)`,
    `resolveProductTable(tenantId, productId, tableName)`,
    `resolveProductTableById(tenantId, productTableId)` — returns
    `{ tableName, uri, rowCount, lastUpdatedAt }` or null. The catalog
    encapsulates the legacy ETL → docker-host path remap and the
    source-connector-flow fallback (deriving from
    `connections.warehouse_path` + `selected_entities` when
    `ingested_tables` is empty).
  - **Listings:** `listSourceTables(tenantId, connectionId)`,
    `listProductTables(tenantId, productId)`,
    `listProductTablesByConnection(tenantId, connectionId)` — return
    arrays of resolved tables. The cross-connection listing is what
    `createProductConnector` uses to register one DuckDB session that
    can JOIN across products (conformed dimensions).
  - **Writes:** `publishProductTable(tenantId, ptId, uri, rowCount)`,
    `publishStubFromUpstream(tenantId, ptId, productId, tableName)`,
    `markProductTableRunning(tenantId, ptId)`,
    `markProductTableFailed(tenantId, ptId, msg)`. The catalog is the
    ONLY writer of `delta_path` + `transformation_status='success'` —
    the regression class "runner says SUCCESS but delta_path is null"
    is now structurally impossible (the contract is enforced at the
    function boundary, not at the schema row).
- **Migrated callers (5 surfaces, ~6 inline join queries deleted):**
  - `connectors/ConnectorFactory.createProductConnector` — replaced
    the 20-line transactional join with a one-line catalog call.
    Affects `/query`, `/dashboards`, `/notebooks`, `/quality`,
    `/semantic` (every NL→SQL surface).
  - `services/transformationRunner.runProductTransformation` — write
    path: `publishProductTable` (success), `markProductTableFailed`
    (error), `markProductTableRunning` (start),
    `publishStubFromUpstream` (skip path). All four schema writes
    routed through catalog.
  - `services/transformationRunner.loadDependencyDimensions` —
    read path: replaced bespoke join with `listProductTables(upstream)`
    + filter to `tableRole === 'dimension' && !isStub`.
  - `routes/semantic.ts` `/product-preview` — replaced direct
    `product_tables` lookup + `delta_path` checks with
    `resolveProductTableById`. Distinguishes "row doesn't exist" from
    "not materialised" in the error message.
  - `routes/notebooks.ts` `buildNamespacedDuckDB` — replaced two
    separate `ingested_tables` + `product_tables` joins with
    `listSourceTables` + `listProductTablesByConnection`.
- **What this enables next:** Phase 3 (tenant-prefixed product layout)
  becomes a single-file change — only the catalog needs to know the
  new path scheme; every caller already gets a URI back. Migration
  job can run in the background and update `delta_path` rows; readers
  pick up the new paths transparently.
- **What still queries `delta_path` directly (deferred):**
  - `services/dbtProjectBuilder.ts` — generates dbt config strings
    embedded in YAML hooks (different process, can't go through our
    catalog). Will revisit if we kill the legacy ETL path entirely.
  - `services/productContext.getProductWarehousePath` — derives a
    parent-only path for use as DuckDB warehouse root. Currently
    broken on Azure (uses `./warehouse/product/<slug>` literally);
    Phase 3 will rebuild this on top of the catalog.
- **Net diff:** ~190 lines added (the new catalog module), ~140
  removed across the 5 callers. Bigger numbers, fewer places to
  patch when something changes.

**Storage layer consolidation — Phase 1 (2026-05-04):** Extracted four
duplicated implementations of "construct a warehouse path / register a
DuckDB view / write parquet" into a single `services/warehouse/` module.
Behaviour-preserving — no metadata changes, no on-disk layout changes.
Sets up Phase 2 (centralised table catalog) and Phase 3 (tenant-prefixed
product layout) to be safe scoped refactors.

- **New module `backend/src/services/warehouse/`** with four files:
  - `paths.ts` — `isAzurePath`, `parseAzurePath`, `productBasePath`,
    `productTablePath`, `productSlug`, `sqlEscapePath`. The single
    place that constructs warehouse URIs.
  - `duckdb.ts` — `setupDuckDBForWarehouse(db, needAzure)` consolidates
    the LOAD delta / LOAD azure / curl-transport / CREATE SECRET dance.
  - `views.ts` — `createScanView(db, viewName, uri, opts?)` replaces
    four near-duplicate implementations (transformationRunner,
    DuckDBConnector, notebooks, dbtProjectBuilder). Auto-detects
    Delta vs Parquet, local vs Azure; supports schema-qualified views
    via `{schema}` opt.
  - `writer.ts` — `writeParquet(db, uri, selectSql)` replaces three
    write paths (writeParquetToAzure, two inline COPY TO sites in
    transformationRunner). Handles the Azure stage-then-upload dance
    internally so callers don't need to branch.
  - `index.ts` — re-exports public API.
- **Migrated call sites** (8 files):
  - `services/transformationRunner.ts` — removed local `isAzurePath`,
    `parseAzurePath`, `setupAzure`, `writeParquetToAzure`,
    `productBasePath`, `productTablePath`, `createScanView` (~120
    lines deleted). All inline COPY TO / read_parquet write paths now
    delegate to `writeParquet`.
  - `connectors/DuckDBConnector.ts` — `loadExtensions` is now a
    one-liner; `createDeltaView` delegates to shared `createScanView`;
    duplicate `isAzureUri` closures replaced with imported `isAzurePath`.
  - `routes/notebooks.ts` — inline `createView` closure deleted; uses
    shared `createScanView` + `setupDuckDBForWarehouse`.
  - `services/dbtProjectBuilder.ts` — local `isAzurePath` deleted (the
    raw read_parquet/COPY strings inside dbt hooks remain inline; they
    run inside dbt's own DuckDB process, not ours).
  - `routes/quality.ts` — inline product-path construction replaced
    with `productBasePath(warehousePath, productSlug(name))`.
  - `routes/ingestion.ts`, `routes/products.ts`, `routes/semantic.ts`,
    `services/productContext.ts` — leftover `startsWith('az://')`
    checks all routed through `isAzurePath`.
- **Net effect:** ~250 lines removed, ~330 added (the four new
  warehouse files). One canonical place for "is this Azure?" "where
  does this product live?" "register a view." When DuckDB's azure or
  delta extension changes behaviour, one file needs updating, not four.
- **What stayed the same:** the on-disk layout (`./warehouse/product/<slug>`
  for local, `az://<container>/products/<slug>` for Azure) — Phase 3
  will introduce a tenant-prefixed v2 layout; for now we kept the
  existing paths so this commit is purely a refactor.
- **`utils/storage.ts`** (`StorageProvider` interface) was untouched —
  it's still dead code. Its API (upload/download/list/delete/exists)
  is at a different abstraction level; if we ever need it for
  non-DuckDB blob ops it's there. Otherwise it'll be removed in a
  later cleanup pass.

**Project rename — DataBridge → Clarion (2026-05-04):** Brand-only rename across
the source tree, docs, UI strings, comments, log messages, file names, and
package.json `name` fields where they're internal-only. The persistence /
infrastructure layer was deliberately preserved as `databridge` to avoid a
destructive migration of data and live deployments. **What stayed `databridge`
(do NOT change without an ops migration plan):**
- PostgreSQL database name, superuser role `databridge`, RLS role `databridge_app`
- Postgres password defaults (`databridge:databridge` in dev, `databridge_secret`
  for Neo4j, `databridge_redis` for Redis)
- Docker volumes `databridge_pgdata`, `databridge_neo4j_data`, `databridge_neo4j_logs`
  (renaming = data loss)
- Docker container names (`databridge-postgres`, `databridge-neo4j`, etc.) and
  Azure Container App / image names (`databridge-backend`, `databridge-etl`,
  `databridge-frontend`, `databridge-sync-worker`, `databridgeacr`,
  `databridge-rg`, etc.) — recreating these in Azure is a separate, scheduled
  ops task
- npm package `@databridge/connectors` (16 import callsites; renaming cascades
  to package.json deps and every workspace), and the workspace package names
  `databridge-backend` + `databridge-sync-worker` which match the Azure image
  names above
- Project root directory on disk is still `databridge/` — rename when
  convenient; Folder Structure section below uses the brand name `clarion/`.

If/when you want to retire the `databridge` infra names: it's a coordinated
operation involving `ALTER DATABASE`, `ALTER ROLE`, Docker volume migration,
Terraform state surgery, and an npm package rename. Single, well-scoped
follow-up task; not blocking.

**Files renamed:** `databridge-overview.html` → `clarion-overview.html`,
`DataBridge_Architecture.py` → `Clarion_Architecture.py` (the generated
`DataBridge_Architecture.pdf` artifact is left in place; re-run the .py to
regenerate as `Clarion_Architecture.pdf`).

**Dual-write contract — relationship mirrors + docs (2026-05-04):** Closed three
latent count-divergence bugs in the same class as the AI review queue confirm bug
fixed last session. The relationship endpoints `POST /semantic/relationships`,
`DELETE /semantic/relationships/:id`, and `POST /semantic/relationships/re-suggest`
now mirror their Neo4j writes into Postgres `table_relationships` so Home's
"relationships approved / total" counts (and any other Postgres aggregate that
reads the table) stay accurate. `id` is kept identical across stores — routes
draw from `semantic_node_id_seq` via `graph.nextPgId()` and insert into Postgres
with the explicit pgId via `.onConflict('id').merge()`, then `setval` is called
on `table_relationships_id_seq` so a later SchemaProfiler run can't collide.
Stale comment block at top of the Relationships section in `routes/semantic.ts`
(the old "user-facing endpoints write to Neo4j ONLY" comment) replaced with a
contract-style note pointing at CLAUDE.md. New top-level CLAUDE.md section
**"Dual-write contract (Postgres ↔ Neo4j)"** documents which surfaces read
Postgres directly, which writes are mirrored, which are still un-mirrored
(revert / approve / import — the rare admin paths), and the exit criterion for
retiring the contract entirely (migrate every direct-Postgres aggregate to
Neo4j count helpers). Architectural note: the user pushed back on dropping
Neo4j entirely (textbook argument: graph DBs good for AI semantics + relations).
We agreed to keep Neo4j and stabilise the dual-write contract instead — a
reversible decision pending future scale. Files changed: `backend/src/routes/semantic.ts`, `CLAUDE.md`.

**IA cleanup — 2026-04-27:**
- New tenant business glossary: `business_glossary` table (migration `20260427000040`), `/semantic/glossary` CRUD routes, `services/glossaryContext.ts` loads + formats entries for prompts, `AIService` injects the block into NL→SQL (source + cross + DuckDB), dashboard gen/refine, and schema-draft via `getTenantAiContext()`. New `Glossary` tab on `/semantic` (`components/semantic/GlossaryPanel.tsx`).
- KPIs tab removed from `/semantic`. KPIs now live only at the product layer (`/products` → KPIs tab, `product_kpis` table consumed by `productContext.kpiFormulas`). The `kpi_definitions` table and `/semantic/kpis` route are kept (notebooks still reads them; no destructive migration) but no longer have a UI surface. Source-layer KPIs are deprecated.
- `TableDetailPanel` and `ProductTableDetailPanel` now have **Definition / Quality** sub-tabs. Quality reuses `QualityPanel` scoped to the selected table — for product tables it queries `(parent connectionId, product table_name)` since `POST /quality/product/:id/profile` already writes results under that key.
- Nav rename: IconRail "Semantic" → "Catalog"; CommandPalette entry retitled. The `/semantic` route is the entity browse + detail surface (CatalogBrowser sidebar + tabbed detail panels). `/products` is the authoring surface (star-schema design, transformations, schedules, KPIs).
- **Quality removed from top-level nav.** The `/health` route still exists (orphaned; reachable by deep link only) but no longer surfaces in IconRail or ROUTE_ALIASES. Quality is consolidated under `/products` via a new **Quality** tab (`frontend/app/products/QualityTab.tsx`) that lists product tables grouped by product, sorted by score, with per-product "Profile all" and click-to-drill into `QualityPanel`. Source-table quality is reachable via the per-table Quality sub-tab on `TableDetailPanel` in `/semantic`. A cross-cutting "what's broken right now" feed (failed jobs + `quality_alerts` aggregate) is **deferred** — infrastructure exists (alerts table, AI context, notifications) but the unified UI does not.
- **Nav IA redesign — Phase A:** `IconRail` reorganized into four user-intent groups: **Discover** (Data catalog, Data products, Glossary), **Work** (Ask AI, Dashboards, Notebooks), **Curate** (Sources, AI review queue) — analyst+, **Settings** (Team & roles, Policies) — admin only. Old groups `workspace/model/admin` removed. `/setup` page role-gate widened from admin-only to admin+analyst (curators can now manage sources). `/semantic` Glossary tab extracted to standalone `/glossary` route (page renders existing `GlossaryPanel`, viewer-readable). New `/review` page (AI review queue) lists `ai_draft=true` source tables/columns with inline Confirm/Flag actions, powered by existing `GET /semantic/pending-approvals` and `PATCH /semantic/{tables,columns}/:id`. Backend `PATCH /semantic/tables/:id` and `PATCH /semantic/columns/:id` role-gates relaxed from `admin` to `admin+analyst` so analysts can confirm/flag. IconRail shows badge counts on Sources (unprofiled connections) and AI review queue (pending approvals). `/products` tab labels normalized to lowercase: "Coverage Map" → "Data tables", kept "Schema diagram" + "Data flow" as separate tabs (per user direction — they show different things: logical star structure vs upstream lineage). `/semantic` top-level Relationships tab kept (cross-cutting graph view).
- **Pipelines: ADF-style activity dock + FK fix (2026-05-04):** Two fixes after running the first pipeline against EO + wholesale_erp.
  - **FK bug**: `runPipelineWorkflow` and `runProductRefreshWorkflow` were passing `triggeredByUserId: 0` to `triggerSync()`, which violated the FK on `source_sync_runs.triggered_by_user_id → users.id` (no user with id 0). Source syncs from pipelines / per-product refresh would silently fail with `insert or update on table "source_sync_runs" violates foreign key constraint`. Fix: pass `undefined` instead of 0 — the column is nullable and `triggerSync` handles it. Audit attribution for pipeline-driven syncs lives on `pipeline_runs.triggered_by` ('user:email' / 'cron' / 'pipeline:N'), not on the synthetic source_sync_runs row.
  - **ADF-style activity dock** replaces the slide-over toast for live run progress. New component `RunActivityDock` sits BETWEEN the DAG canvas and the Recent-runs list (so users never lose sight of either while a run is in progress). Two halves: LEFT — node status table (each source + product in scope, queued/running/ok/failed/skipped/idle pill, click to expand per-table errors), RIGHT — terminal-style cumulative output with `phase`/`log`/`error`/`done` colour-coding. Header bar shows pipeline name, overall status, live counts ("3 ok · 1 running · 2 queued · 1 failed"). Collapsible to a single-line strip; dismissable when the run completes. Seeded from the scope hint so users see queued nodes immediately, then status updates pin to specific nodes by name (`<source>: queueing sync` / `: sync OK` / `: skipped` for sources, `Running "<product>"…` for products) as SSE events arrive.

- **Pipelines as first-class entities — `/pipelines` rebuilt (2026-05-03):** Replaced the legacy product-only DAG page with a first-class refresh-pipeline surface that includes sources as nodes, supports built-in + custom pipelines, and exposes triggers per pipeline. New mental model: a pipeline is a NAMED scope on the (sources → products) graph + zero-or-more triggers; everything else (per-product refresh, "Sync source + refresh", scheduled cron, sync-then-transform chains) is just a different scope/trigger combination.
  - **New tables**: `pipelines` (name, kind: `builtin|custom`, scope JSONB, triggers JSONB, enabled, last_run_at, last_status) + `pipeline_runs` (history, node_results JSONB rolled up from sub-jobs, job_id pointing at BullMQ for live attach). Migration `20260503000045_create_pipelines.ts`. Existing `connection_sync_schedules` + `transformation_schedules` left untouched — pipelines is a parallel, higher-level concept; we'll deprecate them in a follow-up.
  - **Built-in pipelines** computed on-the-fly from the dependency graph (never stored): `Refresh everything`, `Sync sources only`, `Transform products only`, `Refresh from <source>` + `Sync <source> only` per source, `Refresh <product>` + `Rebuild <product> (transformations only)` per product. Always reflect reality, no maintenance.
  - **`backend/src/services/pipelineService.ts`** — `getDag(tenantId)` (full graph: sources + products + (source→product, product→product) edges, computed from `data_product_sources`/`source_tables.connection_id`/`data_product_dependencies` with fallback to `data_products.connection_id`); `resolveScope(scope, tenantId)` (turns a scope JSON into concrete `{ sourceIds, productIds, shouldSyncSources }`, expanding upstream/downstream + filling source ids from product picks); `topoSortProducts(ids)` (Kahn's, used by the runner); `listBuiltinPipelines(tenantId)`.
  - **`runPipelineWorkflow`** in `busMatrixOrchestrator.ts` — Phase 1 syncs every source in scope in parallel (waits for `source_sync_runs` terminal status, fail-and-continue per source). Phase 2 runs products in topo order, fail-and-continue per product (independent products keep going), per-failed-table `error_detail` events flow through the same SSE stream. Persists `node_results` to `pipeline_runs` for history.
  - **Worker mode** `pipeline` added to `BusMatrixJobData` (alongside `design` + `refresh`). Reuses the existing bus-matrix queue + SSE / cancel / active-job endpoints unchanged.
  - **Routes** under `/api/pipelines/*`: `dag` (full graph), `list` (built-in + custom), `saved` POST/PUT/DELETE (custom CRUD), `run-pipeline` (enqueue by id `builtin:…` / `custom:…` or `adhocScope`), `runs` (history). Legacy product-DAG endpoints kept intact.
  - **Frontend** `/pipelines` page rebuilt (full rewrite): two-column layout — left rail lists built-in (grouped: global / per-source / per-product) + custom; right pane shows the shared DAG with the selected pipeline's scope highlighted, plus header (run / edit / triggers shown as chips), legend, and a recent-runs panel scoped to the selected pipeline. ReactFlow LR layout (sources left → products right). Custom pipeline editor as a modal: source picker (checkboxes), product picker (checkboxes), expansion toggles (include upstream / include downstream / skip source sync), trigger CRUD (cron + on-source-sync). Live run progress streams into a slide-over toast (re-uses `/api/products/bus-matrix/:jobId/stream` SSE) — per-table errors render in red.
  - **Locked decisions on the open UX questions**: notification-not-auto-run on profile completion / source sync auto-flips dependents ON by default (refreshes don't cost Claude tokens) / no default schedule (opt-in) / fail-and-continue per item / "Prepare my data" does NOT auto-sync source.
  - **Cron firing + on-source-sync chaining**: trigger UI accepts the data today, but the BullMQ repeatable-job that fires triggers is the next ship. UI surfaces this with a "manual run works today, automated triggers in the next release" hint on the editor.

- **Per-product refresh + upstream source sync + per-failed-table errors (2026-05-03):** Three connected fixes after a user reported "Build completed with errors — Sales: 0 ok, 2 failed" with no idea WHY, no way to refresh just one product, and no way to include source sync in the rebuild.
  - **`error_detail` event added to OrchestratorEvent union** (`busMatrixOrchestrator.ts`). When a product's transformation has failures, the orchestrator now emits one event per failed table containing `tableName` + `error` (the actual SQL/transformation error message). Frontend's SSE handler in `app/products/page.tsx` renders these as red `    ✗ <table>: <error>` lines under the product summary, so the user can SEE the cause and act.
  - **New refresh mode on the bus-matrix queue.** `BusMatrixJobData` now has optional `mode: 'design' | 'refresh'` + `productId` + `syncSource` fields. The worker (`processBusMatrixJob`) dispatches: `mode='design'` (legacy default) runs the full bus-matrix workflow; `mode='refresh'` runs the new `runProductRefreshWorkflow`. Reusing the same queue keeps the existing `/bus-matrix/:jobId/stream` (SSE), `/bus-matrix/active`, `/bus-matrix/:jobId/cancel` endpoints working unchanged for both modes.
  - **`runProductRefreshWorkflow`** (new export from `busMatrixOrchestrator.ts`). Optionally triggers source connection sync via `triggerSync()`, polls `source_sync_runs` until terminal state (3s interval, 30 min timeout, cancellation-aware), then runs `runProductTransformation` for the single product. Emits the same OrchestratorEvent stream so the frontend handler doesn't change.
  - **`POST /api/products/:id/refresh-start`** — enqueues a refresh job. Body `{ syncSource?: boolean }`. Returns `{ jobId }`. Refuses to enqueue a duplicate refresh for the same product. Frontend then attaches via the existing `/bus-matrix/:jobId/stream`.
  - **Per-card refresh control on `/products`** — split-button in each card footer: clicking the icon = "Sync source + refresh" (the end-to-end pipeline); clicking the chevron opens a menu with "Sync source + refresh" + "Rebuild transformations only" so users who already synced can skip it. Reuses the existing build-log overlay for progress + errors.
  - Files changed: `backend/src/jobs/queues.ts` (BusMatrixJobData fields), `backend/src/jobs/workers.ts` (mode dispatch + OrchestratorEvent type import), `backend/src/services/busMatrixOrchestrator.ts` (error_detail event + new orchestrator), `backend/src/routes/products.ts` (refresh-start route), `frontend/app/products/page.tsx` (handleRefreshProduct + per-card UI + error_detail rendering).

- **Products grouped by primary source — Phase 2 (2026-05-03):** Extends Phase 1's grouping to two more surfaces using the same `<SourceBadge>` primitive + helpers.
  - **`/dashboards` product picker** (`app/dashboards/page.tsx`) — flat product-button row → grouped sections per source. When the user has products from a single source, headers are suppressed (no visual noise); with ≥2 sources, each gets its own subsection with a small ocean-coloured eyebrow. Multi-source products carry an inline `+N` chip on the button (matching the badge's framing) with a hover tooltip listing the other contributors. Uses the shared `productSourceGroupKey()` / `productSourceGroupLabel()` helpers — selection-state recolouring kept the badge from being directly reusable on the buttons themselves, but the grouping rule is identical to /catalog and /products.
  - **`ProductRootPanel` header** (`components/products/ProductRootPanel.tsx`) — added `<SourceBadge size="compact">` next to the product name + status pill. Visible from both `/products/[id]` and `/catalog?productId=…` since both routes mount this panel. Backend `GET /api/products/:id` now returns the same `source` block as `GET /api/products`.
  - **Skipped** `/query` (the source selector's items ARE sources — adding source-grouping there would be circular) and `/notebooks` (each notebook is already pinned to a single connection with a chip; no products in the picker).

- **Products grouped by primary source — Phase 1 (2026-05-03):** Every data product now has a derived "primary source" — the connection contributing the most source tables, falling back to `data_products.connection_id`, with a `multiSource` flag when contributors span >1 connection. No migration; computed at the API boundary in two places:
  - `GET /api/products` enriched with `source: { id, name, connectorType, multiSource, sourceDeleted, otherSources[] }` per product
  - `GET /api/catalog/products` schemas enriched with `meta.sourceConnectionId / sourceConnectionName / sourceConnectorType / multiSource / sourceDeleted`
  Frontend treatment shared across surfaces:
  - **`frontend/components/SourceBadge.tsx`** — single visual primitive (Lucide Database icon + source name + optional `+N` chip with hover tooltip listing the other sources). Three states: normal, multi-source, source-deleted. Plus exported helpers `productSourceGroupKey()` + `productSourceGroupLabel()` so URL params and grouping keys stay consistent across pages.
  - **`/catalog` tree** (`CatalogBrowser`) — products no longer flat. Sub-grouped under their primary source: `Data Products → Exact Online → [products]`. Multi-source / Source deleted / Unassigned synthetic groups sink to the bottom and only render when non-empty. Sort: alphabetical by source name. Bucket headers are collapsible (default open).
  - **`/products` page** — source filter chip row above the grid (`All N · Exact Online 2 · wholesale_erp 1 · Multi-source 1`). When no filter active → grouped sections with source-name eyebrow and a per-group "Design your first <Source> product →" ghost card for sources with zero products (the killer feature: converts "browsing" into "doing"). When filtered → flat grid of one bucket. Each card now carries a `<SourceBadge size="compact">` in the top-right.
  - The "design from <source>" CTA pre-selects that connection in the existing build flow (`setBuildConnId`) so users land one click into "designing from this source".
  Edge cases handled: deleted source connection → faded "Source deleted" pill, product still openable; no resolvable source → "Unassigned" group; cross-source product → counted once under "Multi-source", `+N` chip shows the other sources on hover.
  Phase 2 (dashboards, query, notebooks) reuses the same `<SourceBadge>` primitive — same grouping rule, same vocabulary.

- **3-pass schema profiler + connector-declared relationships (2026-05-03):** Diagnosed why ExactOnline syncs were producing only one relationship across 7 tables / 511 columns: heuristic FK detection was completely dead on PascalCase API columns (Layer 2 only matched `_id` snake_case, Layer 4 INT-filtered out GUID FKs, declared-FK introspection is a no-op on Parquet), and the post-hoc AI relationship pass was running on cold per-table column descriptions written without cross-table awareness. Rewrite of the profiling pipeline:
  - **`SourceConnector.getKnownRelationships?(selectedEntities)`** — new optional method on the connector framework (`packages/connectors/src/types.ts`). API-style sources expose the documented FKs from their data model so the profiler doesn't have to re-discover them. ExactOnline now ships a 14-relationship catalog (`packages/connectors/src/exactonline/entities.ts → EXACT_ONLINE_KNOWN_RELATIONSHIPS`) covering invoice header↔lines, account roles (InvoiceTo / OrderedBy / DeliverTo → Accounts), Item↔GL accounts, GL classification hierarchy, transaction lines → ledger / accounts / journals, and the Parent self-references on Accounts + GLClassifications. Filtered to selected entities at runtime so unsynced relationships drop out cleanly.
  - **Generalised heuristic detector** (`backend/src/connectors/BaseConnector.ts`) — added `getKeyStem()` + `tokenizeTableName()` helpers handling both snake_case AND PascalCase / camelCase suffixes (`InvoiceID` → stem `invoice`, then matched to `SalesInvoices` via tokenisation `['sales', 'invoice']`). Layer 4's INT-only filter dropped — value-overlap verification handles precision.
  - **3-pass AI pipeline** (`backend/src/ai/prompts/schemaContextPrompt.ts` + `AIService.ts`):
    1. **`detectSchemaConventions`** — Haiku call, single short prompt. Asks "what naming convention does this source use?" Returns `{ naming_style, pk_pattern, fk_pattern, fk_target_inference, common_fk_columns_without_suffix, id_data_type, confidence }`. Cheap, drives the next two prompts.
    2. **`generateTableContext`** — Sonnet, single call, all tables. Input: column NAMES + samples + stats + conventions + pre-detected FKs (now actually populated). Output: per-table description / grain, **plus every relationship Claude can infer**. Prompt is explicitly biased towards generosity ("be liberal — every suggestion is value-verified afterwards"). Empty-pre-detected case has its own prompt branch nudging Claude not to be conservative.
    3. **`generateColumnDescriptions`** — Sonnet, per-batch. Input: this batch's columns + table descriptions + relationships from pass B. Now Claude knows `SalesInvoices.InvoiceTo` references `Accounts` and writes "Which customer is being billed for this invoice" instead of "Account reference". Same column-budget batching + recursive split as the legacy draft path.
  - **Value-overlap verification of AI relationships** — after pass B, the profiler runs a JOIN against the live data for every AI-suggested relationship that didn't come from a trusted source (declared / known / heuristic-verified). 50% overlap threshold. Lets the AI prompt be bolder while keeping precision honest.
  - **Case-insensitive table-name resolution** — pre-existing silent merge bug fixed: AI returning `salesinvoicelines` when the schema has `SalesInvoiceLines` would silently drop the relationship. Now canonicalised + dropped suggestions logged.
  - **Domain-primed prompts** — `connector_type` (ExactOnline / NetSuite / Salesforce / …) is plumbed into all three prompts so Claude can apply source-specific data-model knowledge without us teaching it.
  - **Net effect on ExactOnline**: relationship count goes from 1 (a self-reference) to ~14 just from the connector registry, plus whatever the AI pass adds on top via verified inference.
  - Files changed: `packages/connectors/src/{types,exactonline/{entities,ExactOnlineConnector}}.ts`, `backend/src/connectors/BaseConnector.ts`, `backend/src/ai/AIService.ts`, `backend/src/ai/prompts/schemaContextPrompt.ts` (new), `backend/src/semantic/SchemaProfiler.ts` (full rewrite of the AI section).
- **Source detail parity (2026-05-02):** `frontend/components/catalog/SourceRootPanel.tsx` rebuilt to mirror `ProductRootPanel`'s tabbed surface so clicking a data source in `/catalog` opens a rich detail view (was a single-purpose Relationships pane). Tabs: **Overview**, **Tables**, **Schema diagram**, **Data flow**, **Quality**, **SQL** (KPIs intentionally dropped — KPIs are a product-layer concept). Header surfaces connection name, source type, sync status pill, last-synced relative time, and AI-draft warnings. Overview = description / 4 stats / pending-drafts cards / "Used in — data products" via `GET /api/products/by-source-table/:id`. Tables = expandable list with column previews + dim/measure tags. Schema diagram = retains the existing three-way switch (Diagram / List / Review queue) with `RelationshipsDiagramView` + `RelationshipsListView` + `ReviewQueueView` — this stays the most important surface, with the original `RelationshipCanvas` editing affordances intact. Data flow = inverse-lineage list (which products consume each table, plus an "Unused source tables" callout). Quality = `connectionId`-scoped `/quality/tables` view, click-through to `<QualityPanel>` plus a "Profile all" button calling `POST /quality/:connId/:table/profile`. SQL = paste-ready `SELECT … FROM <table> LIMIT 100;` snippets per table for analyst reference. No backend changes — every endpoint already existed.
- **Nav IA redesign — Phase B:** `TableDetailPanel` restructured from 2 sub-tabs (Definition / Quality) to **5 tabs**: **Overview**, **Columns**, **Relationships**, **Quality**, **History**. Overview surfaces an AI-suggested banner with prominent inline Confirm/Flag buttons whenever `ai_draft && approval_status !== 'approved'` (PATCHes `ai_draft=false, approval_status=approved` or `approval_status=flagged`). Overview also shows a new **Used in — data products** card listing every product that references this source table, powered by new endpoint `GET /api/products/by-source-table/:sourceTableId` (joins `data_product_sources` → `data_products`, returns `id/name/status`). Relationships tab fetches `/semantic/relationships?connectionId=` and filters to rels where `from_table` or `to_table` matches the current table; shows IN/OUT direction badges. Quality tab still renders `<QualityPanel />`. History tab now always-visible (was a hide/show button). Floating "Save table" bar removed — save button is inline on Overview tab. Frontend `ApprovalStatus` type and `SourceTable.approval_status` widened to include `'flagged'` (backend already accepted the value). `ProductTableDetailPanel` not yet restructured — left for a follow-up if needed.

**Status:** All original POC build steps (1–11) are complete. The platform has grown significantly beyond the initial POC into a multi-tenant, multi-connector data platform with ETL ingestion, star schema products, quality profiling, background job queues, user management, and Azure production deployment.

**SMB competitive speed layer — Sprint 1.1–1.3 (April 2026):**
- Sprint 1.1a: `POST /api/dashboards/batch-execute` — single request for all widgets, `Promise.all` execution, one DuckDB connector shared across all widgets. Frontend `executeAllWidgets` replaced per-widget calls with one batch call. `executeSpecForValidation` also parallelised.
- Sprint 1.1b: After transformation success, DuckDB pool is immediately re-warmed (fire-and-forget `connect()`/`disconnect()`) so the next dashboard load hits a hot pool.
- Sprint 1.1c: `backend/src/services/widgetCache.ts` — 5-minute in-memory widget result cache keyed on `(tenantId, sha256(resolvedSql))`. Cache is invalidated on transformation and ingestion success. Integrated into `batch-execute` endpoint.
- Sprint 1.2: `generateMonthlyRollup()` in `transformationRunner.ts` — after each fact table materialises, a `rollup_monthly_<fact>` Parquet is auto-generated (monthly grain, SUM measures, FK dims, surrogate keys excluded via `product_columns` query). Detected by `detectRollupTables()` in `productContext.ts` and injected into semantic context. Dashboard prompt updated to always prefer rollup tables for aggregate/time-series queries.
- Sprint 1.3: Client-side filter cache via `widgetCacheRef` in `dashboards/page.tsx`.
- Sprint 2.2: Quality alerts enriched with Claude Haiku–written 2-sentence business context. New `ai_context` column on `quality_alerts`. Fires fire-and-forget after each critical/rule_fail alert insert. `QualityAlertBanner` shows it as italic text below the raw metric.
- Sprint 2.3: `pivot_table` widget type — cross-tab matrix.
- Sprint 2.4: KPI drill-to-detail — `DrillDetailModal.tsx` (overlay data table, Escape to close, row count footer). `KpiCard` shows "View detail →" when `spec.drillDownSql` exists; click calls `openDrillDetail()` in `page.tsx` which executes drill SQL via batch-execute and opens modal. Dashboard prompt updated: KPI cards now always include `drillDownSql`. Calculated measures in `DataTableWidget`: "+ formula" button opens inline form, formula evaluated safely via `new Function()` with column names as args, calc columns rendered in ocean colour with row-level computed values. — cross-tab matrix (row_label × col_label → value), heat-mapped cells, auto row/col totals. Wired end-to-end: `types.ts`, `ChartWidgets.tsx` (`PivotTableWidget`), `page.tsx` switch, `dashboardPrompt.ts` (type decision table + full example SQL). KPI delta (`value` + `delta` + `delta_label`) was already in the prompt and KpiCard — no changes needed. Stale-while-revalidate: filter changes show cached data instantly, server revalidates in background. For SELECT filters where `filter.column === widget.crossFilterKey`: pure JavaScript label-match filtering with zero server round-trips. `WidgetData` extended with `revalidating?: boolean`; `WidgetCard` shows a subtle pulse dot while stale data is shown.

**Recent frontend refactor (April 2026 — "Observatory" design system):**
- Full visual overhaul: editorial serif display font (Source Serif 4), mono eyebrows (Geist Mono), neutral light surfaces, single `ocean` accent. Replaces earlier Material-ish / glass / gradient styles. Tokens live in `frontend/lib/observatory.ts` (JS/SVG mirror) and `frontend/app/globals.css` (CSS variables).
- New shared primitives in `frontend/components/ui/` (Toast + global `<Toaster />`, NotificationBell, JobProgressBanner, ChartCard, EmptyState).
- Shell chrome is `AppShell` + `IconRail` + `TopBar` + optional `ContextPanel`; pages slot content via `children`/`contextPanel` props.
- `/query` page split across 7 files: `page.tsx` (orchestrator), `types.ts`, `utils.ts`, `components.tsx` (leaf UI), `MessageBubble.tsx`, `thinking.tsx`, `ChatSidebar.tsx`, `EmptyState.tsx`. Dropped from 2267 → 859 lines.
- `/dashboards` page modularized into `./components/` (10 widget files + header + KPI card + filter bar + CreateInput + EmptyDashboardHero), `./utils/` (format, motion, chart-theme, download), `./types.ts`. `page.tsx` is 1471 lines of mode-driven orchestration.
- `/products` page extracted to `./types.ts`, `./helpers.ts`, `./badges.tsx`; tabs (Schema/Lineage/Bus-Matrix/Kpis) remain inline. `page.tsx` is 1449 lines.
- `/semantic` table/product detail panels de-duplicated into `components/semantic/shared.tsx` (parseDomains, parseExamples, classifyType, completenessBucket, PreviewTable).
- Legacy CSS removed from `globals.css`: `.glass-card*`, `.gradient-mesh`, `.gradient-primary`, `.glass-sidebar`, `.widget-card*`, `.dashboard-topbar`, `.ghost-border*`, `.pill-active/inactive`, `.focus-teal/primary`, `.tonal-shift`, `.accent-bar`, `.glow-*`. Went from ~461 → 320 lines.
- Icon system: `lucide-react` added (v1.8.0). Migrated ~40 inline `<svg>` blocks across shared layout chrome (IconRail, TopBar, NotificationBell, CommandPalette), `/query`, `/dashboards`, `/health`, `/products` to named Lucide components. Remaining inline SVGs are diagram geometry (RelationshipCanvas, StarSchemaFlow, LineageFlow) or legacy panels not yet touched.
- Auth gating: `components/RequireRole.tsx` wraps admin pages (`/setup`, `/users`, `/gaps`, `/policies`, `/products`); shows a "Restricted" card rather than router-push to avoid disruption.
- Date formatting consolidated: `frontend/lib/dates.ts` (formatDate/formatDateTime/formatRelative/formatRelativeShort, `en-GB` locale).
- Tenant chip in TopBar fetches real org name from `/users/profile` (cached in sessionStorage), no longer derived from email domain.
- Deleted routes: `/connect`, `/cross-views`, `/dictionary`, `/quality`, `/reports`, `/review`, `/team` (consolidated into `/setup`, `/semantic`, `/users`, `/health`).
- New routes: `/dev/*` (internal playground), `/onboarding` (new-user wizard).

**Neo4j integration status:**
- All phases complete (0–6). Phase 7 (drop Postgres semantic tables) deferred.
- Neo4j is the source of truth for: source_tables, source_columns, table_relationships, kpi_definitions, cross_source_views, quality_rules.
- Postgres still stores: connections, query_log, definition_gaps, dashboards, rule_executions, quality_failures, quality_score_history, dataset_profiles, field_profiles, tenants, users, conversations, notifications, data_products, transformation_schedules, transformation_checks.
- quality_rules remain dual-written (Postgres primary for rule_executions FK integrity; Neo4j for AI context traversal).

**To start locally:**
1. `docker compose up -d` (starts Postgres, Neo4j, ETL)
2. `cd backend && npx knex migrate:latest` (run all 30 migrations)
3. `npm run neo4j:migrate` (seed Neo4j from Postgres, if data exists)
4. `npm run dev` in backend/ (Express on port 3001)
5. `npm run dev` in frontend/ (Next.js on port 3000)
Or use `start.bat` / `start.sh` to do all of the above in one command.

**Known issues / blockers:**
- `better-sqlite3` v9.x does not compile on Node 24 — pinned to `latest` (v11+) which has Node 24 prebuilt binaries
- Neo4j container takes ~30s to start — backend retries constraint creation automatically for up to 30s
- Backend must be restarted after any changes to `backend/src/**` (no hot-reload)
- Redis is optional for local dev — if not configured, jobs execute inline (synchronous)
- quality_rules are dual-written (Postgres + Neo4j) — rule_executions FK still points to Postgres quality_rules.id

**Key architectural decisions made during build:**
- Entity pre-flight check in `query.ts`: extracts string literals from generated SQL, checks exact match count in source dimension columns before executing. Count 0 → fuzzy suggestions. Count 2–15 → disambiguation picker. Count 16+ → treated as category value, proceeds normally.
- Repair loop in `query.ts`: SSE stream, max 5 turns, Claude fires diagnostic queries and reconstructs SQL. Auto-triggered when validator flags a suspicious result.
- Dashboard spec format: JSON with `filters[]` and `widgets[]`. Filters use `{{id_from}}`/`{{id_to}}` for date ranges and `('{{id}}' = 'all' OR col = '{{id}}')` pattern for select filters. Widget SQL contains placeholders; backend substitutes before executing.
- Dashboard refinement: `POST /api/dashboards/refine` generates 3–4 schema-aware clarifying questions with suggestion chips before generation.
- Multi-tenancy: PostgreSQL Row-Level Security (RLS) policies on all tables, tenant context set via `SET app.current_tenant` in every request.
- Star schema products: AI designs fact/dimension tables from source schema, DuckDB materializes them as Parquet files in a data warehouse (local or Azure Blob).
- Background jobs: BullMQ queues (schema-profiling, ingestion, transformation) with Redis; falls back to inline execution when Redis is unavailable.

---

## Project Overview

**Clarion** is a multi-tenant semantic data platform that allows business users to connect
to their source databases, enrich them with AI-assisted semantic definitions (table/column
descriptions, relationships, KPI formulas), and then query that data using conversational
AI — without ever writing SQL.

The platform supports the full data lifecycle:
1. **Connect** — plug in source databases (SQLite, PostgreSQL, MySQL, SQL Server)
2. **Profile** — AI generates draft definitions; quality profiling scores data health
3. **Ingest** — ETL pipeline loads source data into a Delta Lake warehouse
4. **Model** — AI designs star schemas (fact/dimension tables) from source data
5. **Query** — natural language questions converted to SQL via Claude
6. **Visualize** — AI-generated dashboards, reports with executive summaries
7. **Govern** — definition gaps, quality alerts, audit trails, approval workflows

**Target users:**
- **Admin** — data team or consultants who set up sources and curate definitions
- **Analyst** — power users who query, build dashboards, and explore data
- **Viewer** — business users who consume dashboards and ask questions

---

## Non-Negotiables

- **Never show raw SQL to a business user.** A "show query" toggle is allowed for
  admin/analyst roles, but never visible by default.
- **Never expose API keys or credentials in the frontend.**
- **Never query the source database without first passing through the semantic layer context.**
- **Never guess a KPI definition.** If context is insufficient, ask a clarifying
  question instead of executing.
- **All AI calls go through a single AIService module.** No direct fetch() to the
  Claude API anywhere else in the codebase.
- **Every AI-generated SQL query must carry a confidence score** before execution.
  Queries below 0.70 confidence are blocked and logged as definition gaps.
- **Stored credentials are encrypted** with AES-256-GCM before persisting to Postgres.

---

## Tech Stack

### Backend
- **Runtime:** Node.js 20+ with TypeScript
- **Framework:** Express.js with Helmet (security headers), CORS, rate limiting
- **Query builder:** Knex.js for PostgreSQL (semantic layer) and SQLite (source)
- **Semantic layer database:** PostgreSQL 16 (Docker locally, Azure Flexible Server in prod)
- **Knowledge graph:** Neo4j 5 Community — stores semantic relationships, cross-source views
- **Source connectors:** SQLite, PostgreSQL, MySQL, SQL Server (via `connectors/` abstraction)
- **Query engine:** DuckDB — used to query ingested Parquet files (star schema products)
- **AI:** Anthropic Claude API (`claude-sonnet-4-6`) via `@anthropic-ai/sdk`
- **Auth:** JWT-based with bcrypt password hashing; three roles: admin, analyst, viewer
- **Job queue:** BullMQ + Redis (optional — falls back to inline execution)
- **Logging:** Pino (structured JSON logging)
- **Monitoring:** Azure Application Insights (optional)
- **Storage:** Local filesystem or Azure Blob Storage (auto-detected)
- **Secrets:** AES-256-GCM encryption for stored credentials; Azure Key Vault in production
- **Validation:** Zod schemas for request validation
- **Testing:** Vitest with PostgreSQL service container

### Frontend
- **Framework:** Next.js 14 (App Router)
- **Styling:** Tailwind CSS 3.4
- **Charts / Dashboards:** Recharts for data visualisation
- **Graph visualization:** ReactFlow + Dagre (star schema diagrams, lineage flows)
- **Export:** html2canvas + jsPDF for dashboard PDF export
- **API calls:** Axios with a central `api.ts` client (JWT interceptor, 401 auto-redirect)
- **Custom fonts:** Geist / Geist Mono

### ETL Pipeline
- **Runtime:** Python 3.12 (FastAPI)
- **Storage format:** Delta Lake (Apache Parquet-based)
- **Supported sources:** SQLite, PostgreSQL, MySQL, SQL Server
- **Output:** Local filesystem or Azure Blob Storage
- **Incremental loading:** Watermark-based CDC

### Infrastructure
- **Local dev:** Docker Compose (Postgres, Neo4j, ETL; Redis optional)
- **Production:** Azure Container Apps with scale-to-zero
- **IaC:** Terraform (Azure: PostgreSQL Flexible Server, Container Apps, ACR, Blob Storage, Key Vault, App Insights)
- **CI/CD:** GitHub Actions (test on PR, deploy on push to main/staging)
- **E2E:** Playwright (Chrome, headless)

---

## Folder Structure

> Note: the on-disk root directory is still `databridge/`. The brand was renamed
> to Clarion but the directory wasn't moved (would require updating every shell
> script + dev launcher). Rename when convenient.

```
clarion/                              ← on disk: databridge/
├── CLAUDE.md                         ← you are here
├── .env                              ← local only, gitignored
├── .env.example                      ← committed, no secrets
├── .gitignore
├── docker-compose.yml                ← dev: Postgres + Neo4j + ETL
├── docker-compose.production.yml     ← prod-like: adds Redis + backend + frontend
├── package.json                      ← root workspace (minimal)
├── playwright.config.ts              ← E2E test config
├── start.bat / start.sh              ← one-command startup scripts
├── start-backend.bat / start-frontend.bat / start-docker.bat / stop-docker.bat
├── run-migrations.bat / run-seed.bat / rebuild-etl.bat
├── PROJECT_PLAN.md / DEPLOY.md       ← planning and deployment docs
│
├── shared/
│   └── types.ts                      ← UserRole, AuthUser, JwtPayload, ApiResponse<T>
│
├── e2e/
│   └── smoke.spec.ts                 ← Playwright: register, login, navigate pages
│
├── etl/
│   ├── main.py                       ← FastAPI ETL service (discover, ingest endpoints)
│   ├── Dockerfile                    ← Python 3.12-slim
│   └── requirements.txt              ← fastapi, deltalake, pyarrow, pandas, etc.
│
├── infra/
│   ├── main.tf                       ← Azure resources (Postgres, Container Apps, ACR, etc.)
│   ├── variables.tf                  ← Terraform variables
│   ├── outputs.tf                    ← Terraform outputs
│   └── prod.tfvars.example           ← Example production variables
│
├── .github/workflows/
│   ├── deploy.yml                    ← Build + push images + deploy to Container Apps
│   ├── test.yml                      ← Run vitest + security audit on PR
│   └── dependabot.yml                ← Weekly dependency updates
│
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   ├── knexfile.ts
│   ├── Dockerfile                    ← Node.js backend container
│   └── src/
│       ├── index.ts                  ← Express app: routes, middleware, startup, shutdown
│       ├── seed.ts                   ← creates data/sample.db (Belgian SMB data)
│       ├── seed-hr.ts                ← creates sample HR database (hr.db)
│       ├── seed-postgres.ts          ← populates Azure Postgres with sample data
│       ├── migrate-sqlite-to-postgres.ts  ← one-time SQLite→Postgres migration tool
│       │
│       ├── ai/
│       │   ├── AIService.ts          ← single entry point for ALL Claude API calls
│       │   └── prompts/
│       │       ├── schemaDraftPrompt.ts      ← schema profiling prompts
│       │       ├── nlToSqlPrompt.ts          ← NL→SQL for source databases
│       │       ├── nlToSqlPromptDuckDB.ts    ← NL→SQL for DuckDB (warehouse queries)
│       │       ├── dashboardPrompt.ts        ← dashboard generation + refinement
│       │       ├── starSchemaPrompt.ts       ← star schema design + transformation SQL
│       │       ├── answerFormatterPrompt.ts   ← report narrative generation
│       │       ├── repairPrompt.ts           ← agentic SQL repair loop
│       │       └── qualityAlertPrompt.ts     ← 2-sentence business context for quality alerts (Haiku)
│       │
│       ├── connectors/
│       │   ├── BaseConnector.ts      ← abstract interface + FK detection + table classification
│       │   ├── ConnectorFactory.ts   ← creates correct connector from connection config
│       │   ├── ConnectorPool.ts      ← connection pooling + shutdown drain
│       │   ├── SqliteConnector.ts    ← better-sqlite3
│       │   ├── PostgresConnector.ts  ← pg
│       │   ├── MysqlConnector.ts     ← mysql2
│       │   ├── MssqlConnector.ts     ← mssql
│       │   └── DuckDBConnector.ts    ← duckdb-async (warehouse query engine)
│       │
│       ├── db/
│       │   ├── knex.ts               ← PostgreSQL semantic DB (with RLS role switching)
│       │   ├── neo4j.ts              ← Neo4j driver singleton + constraints + shutdown
│       │   ├── semanticGraph.ts      ← ALL Cypher queries (only file with Cypher)
│       │   ├── migrateSemanticToNeo4j.ts  ← one-shot migration script
│       │   └── migrations/           ← 30 Knex migrations (see list below)
│       │
│       ├── jobs/
│       │   ├── redis.ts              ← IORedis singleton (optional)
│       │   ├── queues.ts             ← BullMQ queue definitions (4 queues: profiling, ingestion, transformation, email-report)
│       │   ├── workers.ts            ← schema-profiling, ingestion, transformation, email-report workers
│       │   ├── scheduler.ts          ← repeatable job manager for cron-based transformation schedules
│       │   └── emailScheduler.ts     ← repeatable job manager for email report schedules
│       │
│       ├── middleware/
│       │   ├── auth.ts               ← JWT verify, password hash, role checks (admin/analyst/viewer)
│       │   ├── tenant.ts             ← multi-tenant isolation (SET app.current_tenant)
│       │   ├── validate.ts           ← Zod request validation middleware
│       │   ├── schemas.ts            ← Zod schemas for auth, invites, etc.
│       │   ├── requestLogger.ts      ← structured request logging with request IDs
│       │   └── errorHandler.ts       ← global error handler, never leak internals
│       │
│       ├── routes/
│       │   ├── auth.ts               ← register, login, forgot-password, reset, refresh token
│       │   ├── connections.ts        ← CRUD connections; trigger profiling; manage ingestion
│       │   ├── semantic.ts           ← confirm/edit table/column definitions from AI draft
│       │   ├── query.ts              ← NL→SQL; execute; repair loop (SSE); entity pre-flight
│       │   ├── reports.ts            ← CRUD reports; AI narrative generation
│       │   ├── dashboards.ts         ← CRUD dashboards; execute widget SQL; refinement
│       │   ├── cross-views.ts        ← admin-only cross-source views (Neo4j graph)
│       │   ├── quality.ts            ← quality profiling; alerts; trends
│       │   ├── ingestion.ts          ← trigger ETL ingestion to Delta Lake warehouse
│       │   ├── products.ts           ← CRUD data products (star schema definitions)
│       │   ├── jobs.ts               ← check background job status
│       │   ├── schedules.ts          ← CRUD transformation schedules (cron); manual triggers
│       │   ├── users.ts              ← admin-only user management; invites; role updates
│       │   ├── conversations.ts      ← chat history persistence; export results
│       │   ├── notifications.ts      ← user notifications (job complete, quality alerts, invites)
│       │   └── emailSchedules.ts     ← CRUD dashboard email schedules; send-now trigger
│       │
│       ├── services/
│       │   ├── notificationService.ts      ← notify(), notifyTenant()
│       │   ├── productContext.ts           ← build star schema semantic context for NL→SQL; detects rollup tables
│       │   ├── transformationRunner.ts     ← DuckDB transformation materialization (Parquet) + monthly rollup generation
│       │   ├── transformationChecks.ts     ← BK uniqueness + fan-out quality gates
│       │   ├── widgetCache.ts             ← 5-min in-memory widget result cache (tenantId + sql_hash keyed)
│       │   ├── emailService.ts            ← nodemailer wrapper; no-op when SMTP_HOST not configured
│       │   └── reportEmailService.ts      ← execute dashboard widgets + AI summary + HTML email builder
│       │
│       ├── quality/
│       │   └── QualityProfiler.ts    ← per-field stats: nulls, distinct, min/max, histograms
│       │
│       ├── semantic/
│       │   └── SchemaProfiler.ts     ← full profiling workflow: introspect → AI draft → store
│       │
│       ├── utils/
│       │   ├── logger.ts             ← Pino structured logging
│       │   ├── crypto.ts             ← AES-256-GCM credential encryption/decryption
│       │   ├── cache.ts              ← in-memory cache utility
│       │   ├── monitoring.ts         ← Azure App Insights telemetry
│       │   ├── paginate.ts           ← pagination helper
│       │   ├── secrets.ts            ← Azure Key Vault secret retrieval
│       │   └── storage.ts            ← Azure Blob Storage helpers
│       │
│       ├── shared/
│       │   └── types.ts              ← backend-internal shared types
│       │
│       └── tests/
│           ├── setup.ts              ← Vitest global setup
│           ├── helpers.ts            ← test utilities
│           ├── db-helpers.ts         ← database test helpers
│           ├── auth.test.ts
│           ├── connections.test.ts
│           ├── dashboards.test.ts
│           ├── health.test.ts
│           ├── notifications.test.ts
│           ├── tenant-isolation.test.ts
│           └── users.test.ts
│
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── next.config.mjs
    ├── tailwind.config.ts
    ├── postcss.config.mjs
    ├── .eslintrc.json
    ├── Dockerfile                    ← Next.js frontend container
    ├── public/
    │   └── logo.svg
    ├── app/
    │   ├── layout.tsx                ← root layout + <Toaster /> mount
    │   ├── globals.css               ← Observatory CSS variables, scrollbar utilities, orbs, heatmap
    │   ├── page.tsx                  ← login / landing page
    │   ├── register/page.tsx         ← new user registration form
    │   ├── forgot-password/page.tsx  ← password reset request
    │   ├── reset-password/page.tsx   ← password reset confirmation (token-based)
    │   ├── profile/page.tsx          ← user profile: display name, password change
    │   ├── onboarding/page.tsx       ← new-user onboarding wizard
    │   ├── setup/page.tsx            ← admin: connect sources, trigger AI schema profiling (RequireRole)
    │   ├── semantic/page.tsx         ← definitions: tables/columns/relationships/glossary tabs (KPIs moved to /products)
    │   ├── products/                 ← admin-only data products (star schemas, lineage)
    │   │   ├── page.tsx              ← orchestrator + tabs (overview, bus-matrix, schema, lineage, kpis)
    │   │   ├── types.ts              ← Connection, DataProduct, StarSchema, ProductTable/Column/Relationship, KPI, ActiveTab
    │   │   ├── helpers.ts            ← statusBorderColor, productIcon, cleanTopicName
    │   │   └── badges.tsx            ← StatusDot, StatusBadge, RoleBadge, ColumnRoleBadge, Spinner
    │   ├── query/                    ← NL chat with repair loop + disambiguation
    │   │   ├── page.tsx              ← stateful orchestrator
    │   │   ├── types.ts              ← Message, DebugInfo, Conversation, RepairState, EntityMismatch/Ambiguity, ForecastData
    │   │   ├── utils.ts              ← formatSql, formatCellValue
    │   │   ├── components.tsx        ← SourceSelector, BoldText, ConfidenceBadge, QueryLayerBadge
    │   │   ├── MessageBubble.tsx     ← main bubble + ResultVisualizer + ForecastChart + LowConfidenceGuide + AdminDebugPanel
    │   │   ├── thinking.tsx          ← ThinkingBubble (live reasoning) + ThinkingPanel (repair-loop events)
    │   │   ├── ChatSidebar.tsx       ← conversation list (slots into AppShell contextPanel)
    │   │   └── EmptyState.tsx        ← pre-chat landing with STARTERS
    │   ├── dashboards/               ← AI dashboard builder with filters + drill-down
    │   │   ├── page.tsx              ← orchestrator (mode: empty | choosing | refining | creating | viewing)
    │   │   ├── layout.tsx            ← app shell wrap
    │   │   ├── types.ts              ← FilterSpec, WidgetSpec, DashboardSpec, SavedDashboard, DashboardTemplate, DrillState, RefinementQuestion, ChatMessage, WidgetData
    │   │   ├── utils/
    │   │   │   ├── format.ts         ← buildDefaultFilters, relTime, formatValue
    │   │   │   ├── motion.ts         ← Framer Motion variants (containerVariants, slideUp, shimmerClass)
    │   │   │   ├── chart-theme.ts    ← Recharts palette + style helpers
    │   │   │   └── download.ts       ← authenticated file-download helper (CSV/XLSX/PDF)
    │   │   └── components/
    │   │       ├── CreateInput.tsx           ← reusable text-input + Go button
    │   │       ├── EmptyDashboardHero.tsx    ← empty-state hero + suggestion chips
    │   │       ├── DashboardHeader.tsx       ← title + save/discard + dark-mode toggle
    │   │       ├── FilterBar.tsx             ← dashboard filter row
    │   │       ├── MarkdownAnswer.tsx        ← streaming markdown renderer
    │   │       ├── KpiCard.tsx               ← KPI tile with trend + sparkline
    │   │       ├── ChartWidgets.tsx          ← Bar/Line/Pie/Stacked/Combo/Radar/Treemap/TopList/DataTable
    │   │       ├── WidgetCard.tsx            ← widget container (header + body + error state)
    │   │       ├── WidgetSkeletons.tsx       ← shimmer placeholders while loading
    │   │       ├── Sparkline.tsx             ← compact trend line for KPI cards
    │   │       ├── PremiumTooltip.tsx        ← styled Recharts tooltip
    │   │       ├── AnimatedNumber.tsx        ← counting animation for KPI values
    │   │       └── EmailSchedulePanel.tsx    ← dashboard email report schedules (CRUD + send-now; slotted into settings dropdown)
    │   ├── health/page.tsx           ← data-quality dashboard (split-pane: sidebar + overview/detail pills)
    │   ├── gaps/page.tsx             ← admin: definition gaps + query log tabs (RequireRole)
    │   ├── users/page.tsx            ← admin: team management, invites, roles (RequireRole)
    │   ├── policies/page.tsx        ← admin: data policies (RequireRole)
    │   ├── notebooks/                ← interactive Python notebooks (Pyodide)
    │   │   ├── page.tsx              ← list + create notebook
    │   │   └── [id]/page.tsx         ← editor with cells, schema explorer
    │   └── dev/                      ← internal-only playground (UI, tokens, icons)
    │       └── ui/page.tsx
    │
    ├── components/
    │   ├── Nav.tsx                   ← legacy role-aware nav (kept for non-shell pages)
    │   ├── RequireRole.tsx           ← admin gate wrapper (shows "Restricted" card instead of redirecting)
    │   ├── IngestionWizard.tsx       ← step-by-step data ingestion setup
    │   ├── IntegrationsPanel.tsx     ← integration management UI
    │   ├── JobProgressBanner.tsx     ← (legacy) background job progress (prefer components/ui/JobProgressBanner)
    │   ├── NotificationBell.tsx      ← notification icon + dropdown (used by TopBar)
    │   ├── Pagination.tsx            ← generic pagination component
    │   ├── QualityAlertBanner.tsx    ← data quality issue alerts
    │   ├── QualityPanel.tsx          ← quality profiling dashboard
    │   ├── EmptyState.tsx            ← Observatory empty state (eyebrow/title/description/actions)
    │   ├── SchedulePanel.tsx         ← transformation schedule management
    │   ├── layout/
    │   │   ├── AppShell.tsx          ← Observatory chrome (IconRail + TopBar + ContextPanel + children)
    │   │   ├── AuthLayout.tsx        ← auth-page chrome (login/register/reset)
    │   │   ├── ShellLayout.tsx       ← legacy shell (superseded by AppShell)
    │   │   ├── IconRail.tsx          ← leftmost icon nav (Lucide icons, role-aware)
    │   │   ├── TopBar.tsx            ← header: wordmark + tenant chip + search + notifications + avatar menu
    │   │   ├── ContextPanel.tsx      ← optional left context panel (sits between IconRail and main)
    │   │   ├── CommandPalette.tsx    ← Cmd+K palette (nav + actions)
    │   │   └── PillNav.tsx           ← pill-style tab switcher
    │   ├── products/
    │   │   ├── StarSchemaFlow.tsx    ← ReactFlow star schema diagram (Observatory palette)
    │   │   └── LineageFlow.tsx       ← ReactFlow data lineage visualization (Observatory palette)
    │   ├── semantic/
    │   │   ├── ApprovalBadge.tsx     ← approval status indicator
    │   │   ├── AuditPanel.tsx        ← audit trail viewer
    │   │   ├── BulkImportModal.tsx   ← bulk definition import
    │   │   ├── DatabaseTree.tsx      ← database schema tree (Observatory light tokens)
    │   │   ├── HistoryPanel.tsx      ← change history tracking
    │   │   ├── KpiPanel.tsx          ← KPI definitions management
    │   │   ├── PathFinderPanel.tsx   ← relationship path finder
    │   │   ├── RelationshipCanvas.tsx ← relationship mapping visualization
    │   │   ├── TableDetailPanel.tsx  ← source-layer table detail panel
    │   │   ├── ProductTableDetailPanel.tsx ← product-layer table detail panel
    │   │   ├── shared.tsx            ← de-duplicated helpers: parseDomains/parseExamples/classifyType/completenessBucket/PreviewTable
    │   │   └── types.ts             ← shared TypeScript types for semantic components
    │   ├── notebooks/
    │   │   ├── SchemaExplorer.tsx    ← left sidebar table/schema tree
    │   │   └── usePyodide.ts         ← Pyodide runtime hook (loads from CDN)
    │   └── ui/                       ← Observatory primitives (preferred callsites)
    │       ├── Toast.tsx             ← <Toast> + <Toaster /> + useToast() hook (module-level dispatch queue)
    │       ├── NotificationBell.tsx  ← (newer variant, dev use)
    │       ├── JobProgressBanner.tsx ← background job progress (Observatory tokens)
    │       └── ChartCard.tsx         ← card wrapper for Recharts embeds
    │
    └── lib/
        ├── api.ts                   ← Axios client; JWT interceptor; 401 → redirect to /
        ├── auth.ts                  ← JWT storage, getTokenPayload, isAdmin, setToken
        ├── cn.ts                    ← classnames helper (clsx + tailwind-merge)
        ├── dates.ts                 ← formatDate/formatDateTime/formatRelative/formatRelativeShort (en-GB)
        ├── observatory.ts           ← JS/SVG mirror of globals.css tokens + SERIES chart palette
        ├── freshness.ts             ← data-freshness helpers (formatRelativeTime, getFreshnessStatus)
        └── hooks/
            └── useDebounce.ts       ← custom debounce hook
```

### Database Migrations (30 files)

```
20260328000001  create_connections
20260328000002  create_source_tables
20260328000003  create_source_columns
20260328000004  create_table_relationships
20260328000005  create_kpi_definitions
20260328000006  create_query_log
20260328000007  create_definition_gaps
20260329000008  create_dashboards
20260329000009  create_cross_views
20260329000010  create_quality_tables
20260329000011  add_business_key_column
20260329000012  add_domains_to_source_tables
20260329000013  add_domains_to_connections
20260330000014  create_semantic_id_seq
20260331000015  add_gap_hit_tracking
20260402000016  add_ingestion_support
20260402000017  create_data_products
20260402000018  create_transformation_checks
20260403000019  create_tenants_and_users
20260403000020  add_tenant_id_and_rls
20260403000021  create_schedules_and_run_history
20260403000022  create_quality_alerts
20260403000023  add_incremental_load_support
20260403000024  add_user_avatar
20260403000025  create_conversations
20260403000026  dashboard_improvements
20260403000027  semantic_layer_improvements
20260403000028  create_notifications
20260404000029  performance_indexes
20260407000030  add_profiling_status
20260421000037  create_email_schedules
20260421000038  add_ai_context_to_quality_alerts
```

---

## AI Architecture — How Claude Is Used

All AI calls go through `backend/src/ai/AIService.ts` — no exceptions.
The model is `claude-sonnet-4-6` for all call types.

### Call Type 1 — Schema Draft (setup phase)
**When:** After a source database is connected and schema is read.
**Purpose:** Generate first-draft definitions for every table and column.
**Also:** `suggestFkMatches()` — Claude validates FK candidate pairs detected by heuristics.
All output stored with `ai_draft: true` until a human confirms.

### Call Type 2 — Natural Language to SQL (every user question)
**When:** A user types any question in the chat interface.
**Two modes:**
- `nlToSql()` — generates SQL for source databases (SQLite/Postgres/MySQL/MSSQL dialect)
- `nlToSqlCross()` — generates cross-source SQL using Neo4j graph context

**Confidence gating:** If confidence < 0.70, SQL is NOT executed. Question logged as a definition gap.

**Repair loop:** If the result looks suspicious, an SSE-streamed repair cycle (max 5 turns) runs diagnostic queries and reconstructs the SQL.

### Call Type 3 — Report Narrative
**When:** A user generates a report with selected KPIs.
**Purpose:** Write a short executive summary tying together KPI results.

### Call Type 4 — Dashboard Generation
**When:** A user creates or refines an AI-generated dashboard.
- `generateDashboardSpec()` — NL → JSON dashboard spec (widgets, filters, SQL)
- `refineDashboard()` — iterates on an existing spec
- `validateDashboard()` — checks widget SQL and data types

### Call Type 5 — Star Schema Design
**When:** Admin designs a data product from source tables.
- `designStarSchema()` — Claude designs fact/dimension tables + transformations
- `generateTransformationSql()` — generates DuckDB SQL for each table

### Call Type 6 — Answer Formatting
**When:** After a query executes successfully.
**Purpose:** Summarize the result in 1–3 plain-language sentences for business users.

---

## Key Workflows

### Source Connection & Profiling (Admin)
1. Admin adds a data source (SQLite file path, or Postgres/MySQL/MSSQL credentials)
2. Connection test validates reachability
3. Schema profiling job queued (BullMQ or inline):
   - Introspects tables, columns, types, sample values
   - Runs quality profiling (null%, distinct%, min/max, histograms)
   - Claude generates draft definitions + FK suggestions
   - Results stored with `ai_draft: true`
4. Admin reviews and confirms definitions in /semantic

### Data Ingestion (Admin)
1. Admin triggers ingestion for selected tables
2. ETL service (Python/FastAPI) reads source data
3. Writes Delta Lake tables (Parquet) to warehouse (local or Azure Blob)
4. Supports full and incremental (watermark-based) load modes

### Star Schema Products (Admin)
1. Admin selects source tables to model
2. Claude designs star schema: fact tables, dimension tables, transformation SQL
3. Admin reviews and adjusts the design
4. Transformation runs via DuckDB — materializes Parquet files
5. Quality gates check BK uniqueness and fan-out
6. Scheduled transformations via cron (BullMQ repeatable jobs)

### Query Flow (All Users)
1. User types a question in the chat interface
2. Backend builds semantic context (source or product layer)
3. Claude generates SQL + confidence score
4. If confidence >= 0.70: SQL executes → Claude formats answer in plain language
5. If confidence < 0.70: clarifying message shown, gap logged silently
6. Repair loop auto-triggers if result looks suspicious
7. "Show query" toggle visible to admin/analyst only

### Dashboard Builder (All Users)
1. User describes desired dashboard in natural language
2. Optional refinement: 3–4 schema-aware clarifying questions with suggestion chips
3. Claude generates dashboard spec (JSON: widgets + filters + SQL)
4. Backend executes widget SQL with filter substitution
5. Frontend renders interactive dashboard (Recharts)
6. Save/favorite/delete per user

### Report Builder (All Users)
1. User selects KPIs + time period
2. KPI SQL queries run in parallel
3. Results rendered as bar charts (Recharts)
4. Claude writes executive summary paragraph

---

## Roles & Permissions

| Feature                          | admin | analyst | viewer |
|---------------------------------|-------|---------|--------|
| Connect / manage data sources    | YES   | NO      | NO     |
| Run schema profiling             | YES   | NO      | NO     |
| Review / confirm definitions     | YES   | NO      | NO     |
| Add / edit KPI definitions       | YES   | NO      | NO     |
| View definition gaps             | YES   | NO      | NO     |
| Manage team (users / invites)    | YES   | NO      | NO     |
| Design star schema products      | YES   | YES     | NO     |
| Manage transformation schedules  | YES   | YES     | NO     |
| Ask questions (chat)             | YES   | YES     | YES    |
| Build and view dashboards        | YES   | YES     | YES    |
| Build and view reports           | YES   | YES     | YES    |
| View full query log              | YES   | YES     | NO     |
| See "show query" SQL toggle      | YES   | YES     | NO     |

---

## Multi-Tenancy

- Every table has a `tenant_id` column (added in migration 20260403000020)
- PostgreSQL Row-Level Security (RLS) enforced via policies
- `requireAuth` middleware sets `app.current_tenant` session variable on every request
- `knex.ts` switches between `databridge_app` role (with RLS) and `databridge` role (for migrations)
- Tenant context flows through to job workers via job data

---

## Dual-write contract (Postgres ↔ Neo4j)

**Status:** Phase 7 of the Neo4j migration (drop Postgres semantic tables) is deferred.
Until then, the system runs a deliberate, scoped dual-write between Neo4j (source of
truth for AI context + traversal queries) and Postgres `source_tables` /
`source_columns` / `table_relationships` (still queried directly by a handful of
aggregate surfaces). This section is the contract — read it before touching any
write to those three tables.

**The rule:**
- All semantic READS go through `db/semanticGraph.ts` (Neo4j-backed). Postgres reads
  of `source_tables` / `source_columns` / `table_relationships` are tolerated only in
  the "aggregate surfaces" list below, and only because rewriting them would require
  Neo4j count helpers we haven't built yet.
- Every WRITE that mutates one of those three tables in Neo4j MUST mirror the same
  change to Postgres in the same request, OR the consuming aggregate must be
  rewritten to read from Neo4j. No exceptions, no "we'll fix it next sprint."
- The `id` is identical on both sides. Routes that create new rows pull an id from
  `semantic_node_id_seq` via `graph.nextPgId()` and insert into Postgres with
  `id = pgId` (using `.onConflict('id').merge()` for safety), then bump the Postgres
  table's own sequence via `setval` so future Postgres-first inserts don't collide.

**Aggregate surfaces that read Postgres directly (the reason the contract exists):**
- `routes/home.ts` — Home health-score COUNTs of tables/columns/relationships and
  pending-review queues.
- `routes/quality.ts` — source-table quality dashboard joins.
- `routes/products.ts` — FK derivation in product-design flows joins
  `table_relationships`.
- `routes/query.ts` — relationship lookup for cross-source NL→SQL.
- `routes/notebooks.ts` — schema explorer.

**Mirrored write surfaces today:**
- `SchemaProfiler.ts` — Postgres-first (gets auto-increment id), then Neo4j with
  that id as `pgId`. The original pattern; sets the id-alignment invariant.
- `PATCH /semantic/tables/:id` — mirrors confirm/edit to `source_tables`.
- `PATCH /semantic/columns/:id` — mirrors confirm/edit to `source_columns`.
- `PATCH /semantic/relationships/:id` — mirrors confirm/edit to `table_relationships`.
- `POST /semantic/relationships` — mirrors create with explicit `id = pgId`.
- `DELETE /semantic/relationships/:id` — mirrors delete.
- `POST /semantic/relationships/re-suggest` — mirrors the bulk wipe of AI drafts +
  bulk insert.

**Known un-mirrored writes (latent bugs of the same class — fix when a user reports):**
- `POST /semantic/revert` — revert-to-version writes Neo4j only.
- `POST /semantic/approve` — generic approval flow writes Neo4j only.
- `POST /semantic/import` — bulk CSV import writes Neo4j only.

**If you add a new write to any of those three tables, you have two options:**
1. Mirror it (preferred — follow the pattern in `PATCH /semantic/tables/:id`).
2. Rewrite the relevant aggregate read in `routes/home.ts` etc. to use a Neo4j
   count helper. This is the long-term fix and the path to retiring this contract.

**When can we drop this?** When every entry in "Aggregate surfaces that read Postgres
directly" has been migrated to Neo4j. At that point the Postgres tables become
write-side-only legacy and we can finish Phase 7.

---

## Error Handling Rules

- All connector errors must return a user-friendly message. Never expose file paths,
  SQL errors, or stack traces to the frontend.
- All AI call failures must be caught and logged server-side. Return a graceful
  fallback message to the user: "Something went wrong. Please try again."
- Definition gaps must be silently logged without alarming the client user.
  Return: "I don't have enough context to answer that confidently yet.
  This question has been noted for review."
- Never let a raw SQL error reach the frontend under any circumstances.
- Rate limiting: 200 req/min global, 20 req/min auth endpoints, 30 req/min AI-intensive.

---

## Environment Variables (.env.example)

```bash
# Backend
PORT=3001
NODE_ENV=development

# Semantic layer DB — PostgreSQL running in Docker
DATABASE_URL=postgresql://databridge:databridge@localhost:5432/databridge

# JWT auth
JWT_SECRET=change_me_in_production
JWT_EXPIRES_IN=8h

# Claude API (get key from console.anthropic.com)
ANTHROPIC_API_KEY=your_key_here
CLAUDE_MODEL=claude-sonnet-4-6

# SQLite source database (optional — for local sample data)
SQLITE_DB_PATH=./data/sample.db

# Neo4j — semantic knowledge graph (runs in Docker alongside Postgres)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=databridge_secret
NEO4J_DATABASE=neo4j

# Credential encryption key (32-byte hex string for AES-256-GCM)
CREDENTIALS_ENCRYPTION_KEY=generate_a_32_byte_hex_key_here

# ETL service URL (Python FastAPI, runs in Docker)
ETL_URL=http://localhost:8000

# CORS — allowed frontend origins
CORS_ORIGINS=http://localhost:3000

# Redis — optional; enables BullMQ job queues + caching
# If not set, jobs execute inline (synchronous)
REDIS_URL=redis://localhost:6379

# SMTP — Scheduled email reports (Sprint 2.1)
# Leave SMTP_HOST blank to disable email sending (no-op in dev)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=Clarion <noreply@yourdomain.com>

# Storage format for product tables. Delta Lake + Python sidecar is the
# DEFAULT — production images bake Python + deltalake in. Set
# STORAGE_FORMAT=parquet to opt out (e.g. local dev without Python deps).
STORAGE_FORMAT=

# Python interpreter the SCD1/SCD2 sidecar runs under. Defaults to `python3`.
PYTHON_BIN=

# Override sidecar script path. Defaults to <repo>/etl/scd2/commit_table.py.
SCD2_SIDECAR_PATH=

# Azure (optional — only needed for production / Azure deployment)
# AZURE_STORAGE_CONNECTION_STRING=
# AZURE_KEY_VAULT_URL=
# APPLICATIONINSIGHTS_CONNECTION_STRING=
```

---

## Docker Services

### Development (`docker-compose.yml`)
| Service    | Image              | Port(s)          | Purpose                         |
|------------|--------------------|-----------------|---------------------------------|
| postgres   | postgres:16-alpine | 5432            | Semantic layer DB               |
| neo4j      | neo4j:5-community  | 7474, 7687      | Knowledge graph                 |
| etl        | ./etl (Dockerfile) | 8000            | Python ETL service              |

### Production (`docker-compose.production.yml`)
Adds:
| Service    | Image              | Port(s)          | Purpose                         |
|------------|--------------------|-----------------|---------------------------------|
| redis      | redis:7-alpine     | 6379            | Job queues + caching            |
| backend    | ./backend          | 3001            | Express API                     |
| frontend   | ./frontend         | 3000            | Next.js UI                      |

---

## CI/CD

### GitHub Actions Workflows
- **test.yml** — runs on PR + push to main: Vitest tests against PostgreSQL service container, security audits
- **deploy.yml** — runs on push to main/staging: builds Docker images → pushes to ACR → deploys to Azure Container Apps → runs migrations
- **dependabot.yml** — weekly dependency updates for backend, frontend, GitHub Actions

### Azure Production Architecture
- PostgreSQL Flexible Server (always-on, B_Standard_B1ms)
- 4 Container Apps: Neo4j (min=1), ETL (scale-to-zero), Backend (0–3 replicas), Frontend (0–3 replicas)
- Azure Blob Storage for data warehouse
- Azure Key Vault for secrets
- Application Insights + Log Analytics for monitoring
- ACR (Azure Container Registry) for Docker images
- Estimated cost: ~30 EUR/month idle, ~50-60 EUR/month active

---

## Session Closing Prompt
> Copy and paste this at the end of every Claude Code session.

```
We are done for this session. Before we close:

1. Update the Current State section in CLAUDE.md:
   - Set "Last updated" to today's date
   - List every file that now exists on disk under "Files that exist on disk"
   - Note any known issues or blockers we discovered
   - Set "Next session should start with" if there is pending work

2. If the folder structure changed, update the Folder Structure section to match
   what is actually on disk right now.

3. If any architectural decision changed from what was planned, update the
   relevant section and add a short note explaining why it changed.

Do not summarise what you did in chat — write everything directly into CLAUDE.md.
```

---

*Last updated: April 2026 — Clarion v0.2*
