# CLAUDE.md — DataBridge
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

**Last updated:** 2026-05-02 (SourceRootPanel parity with ProductRootPanel)

**IA cleanup — 2026-04-27:**
- New tenant business glossary: `business_glossary` table (migration `20260427000040`), `/semantic/glossary` CRUD routes, `services/glossaryContext.ts` loads + formats entries for prompts, `AIService` injects the block into NL→SQL (source + cross + DuckDB), dashboard gen/refine, and schema-draft via `getTenantAiContext()`. New `Glossary` tab on `/semantic` (`components/semantic/GlossaryPanel.tsx`).
- KPIs tab removed from `/semantic`. KPIs now live only at the product layer (`/products` → KPIs tab, `product_kpis` table consumed by `productContext.kpiFormulas`). The `kpi_definitions` table and `/semantic/kpis` route are kept (notebooks still reads them; no destructive migration) but no longer have a UI surface. Source-layer KPIs are deprecated.
- `TableDetailPanel` and `ProductTableDetailPanel` now have **Definition / Quality** sub-tabs. Quality reuses `QualityPanel` scoped to the selected table — for product tables it queries `(parent connectionId, product table_name)` since `POST /quality/product/:id/profile` already writes results under that key.
- Nav rename: IconRail "Semantic" → "Catalog"; CommandPalette entry retitled. The `/semantic` route is the entity browse + detail surface (CatalogBrowser sidebar + tabbed detail panels). `/products` is the authoring surface (star-schema design, transformations, schedules, KPIs).
- **Quality removed from top-level nav.** The `/health` route still exists (orphaned; reachable by deep link only) but no longer surfaces in IconRail or ROUTE_ALIASES. Quality is consolidated under `/products` via a new **Quality** tab (`frontend/app/products/QualityTab.tsx`) that lists product tables grouped by product, sorted by score, with per-product "Profile all" and click-to-drill into `QualityPanel`. Source-table quality is reachable via the per-table Quality sub-tab on `TableDetailPanel` in `/semantic`. A cross-cutting "what's broken right now" feed (failed jobs + `quality_alerts` aggregate) is **deferred** — infrastructure exists (alerts table, AI context, notifications) but the unified UI does not.
- **Nav IA redesign — Phase A:** `IconRail` reorganized into four user-intent groups: **Discover** (Data catalog, Data products, Glossary), **Work** (Ask AI, Dashboards, Notebooks), **Curate** (Sources, AI review queue) — analyst+, **Settings** (Team & roles, Policies) — admin only. Old groups `workspace/model/admin` removed. `/setup` page role-gate widened from admin-only to admin+analyst (curators can now manage sources). `/semantic` Glossary tab extracted to standalone `/glossary` route (page renders existing `GlossaryPanel`, viewer-readable). New `/review` page (AI review queue) lists `ai_draft=true` source tables/columns with inline Confirm/Flag actions, powered by existing `GET /semantic/pending-approvals` and `PATCH /semantic/{tables,columns}/:id`. Backend `PATCH /semantic/tables/:id` and `PATCH /semantic/columns/:id` role-gates relaxed from `admin` to `admin+analyst` so analysts can confirm/flag. IconRail shows badge counts on Sources (unprofiled connections) and AI review queue (pending approvals). `/products` tab labels normalized to lowercase: "Coverage Map" → "Data tables", kept "Schema diagram" + "Data flow" as separate tabs (per user direction — they show different things: logical star structure vs upstream lineage). `/semantic` top-level Relationships tab kept (cross-cutting graph view).
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

**DataBridge** is a multi-tenant semantic data platform that allows business users to connect
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

```
databridge/
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
SMTP_FROM=DataBridge <noreply@yourdomain.com>

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

*Last updated: April 2026 — DataBridge v0.2*
