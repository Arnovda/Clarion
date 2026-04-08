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

**Last updated:** 2026-04-08

**Status:** All original POC build steps (1–11) are complete. The platform has grown significantly beyond the initial POC into a multi-tenant, multi-connector data platform with ETL ingestion, star schema products, quality profiling, background job queues, user management, and Azure production deployment.

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
│       │       └── repairPrompt.ts           ← agentic SQL repair loop
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
│       │   ├── queues.ts             ← BullMQ queue definitions (3 queues)
│       │   ├── workers.ts            ← schema-profiling, ingestion, transformation workers
│       │   └── scheduler.ts          ← repeatable job manager for cron-based schedules
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
│       │   └── notifications.ts      ← user notifications (job complete, quality alerts, invites)
│       │
│       ├── services/
│       │   ├── notificationService.ts      ← notify(), notifyTenant()
│       │   ├── productContext.ts           ← build star schema semantic context for NL→SQL
│       │   ├── transformationRunner.ts     ← DuckDB transformation materialization (Parquet)
│       │   └── transformationChecks.ts     ← BK uniqueness + fan-out quality gates
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
    │   ├── layout.tsx                ← root layout
    │   ├── globals.css
    │   ├── page.tsx                  ← login / landing page
    │   ├── register/page.tsx         ← new user registration form
    │   ├── forgot-password/page.tsx  ← password reset request
    │   ├── reset-password/page.tsx   ← password reset confirmation (token-based)
    │   ├── profile/page.tsx          ← user profile: display name, password change
    │   ├── setup/page.tsx            ← connect sources, trigger AI schema profiling
    │   ├── semantic/page.tsx         ← definitions: tables/columns/relationships/KPIs
    │   │                                (also hosts Quality + Integrations as tabs)
    │   ├── products/page.tsx         ← data products: star schema design, lineage, quality
    │   ├── query/page.tsx            ← NL chat interface, repair loop, disambiguation
    │   ├── dashboards/page.tsx       ← AI dashboard builder, filters, drill-down
    │   ├── reports/page.tsx          ← KPI selector, bar chart, executive summary
    │   ├── gaps/page.tsx             ← admin: definition gaps + query log tabs
    │   ├── users/page.tsx            ← admin: team management, invites, roles
    │   ├── cross-views/page.tsx      ← redirect → /semantic (consolidated)
    │   └── quality/page.tsx          ← redirect → /semantic (consolidated)
    │
    ├── components/
    │   ├── Nav.tsx                   ← role-aware nav (admin: Sources, Semantics, Products,
    │   │                                Gaps, Team; all: Ask, Dashboards) + NotificationBell
    │   ├── IngestionWizard.tsx       ← step-by-step data ingestion setup
    │   ├── IntegrationsPanel.tsx     ← integration management UI
    │   ├── JobProgressBanner.tsx     ← background job progress display
    │   ├── NotificationBell.tsx      ← notification icon + dropdown
    │   ├── Pagination.tsx            ← generic pagination component
    │   ├── QualityAlertBanner.tsx    ← data quality issue alerts
    │   ├── QualityPanel.tsx          ← quality profiling dashboard
    │   ├── SchedulePanel.tsx         ← transformation schedule management
    │   ├── products/
    │   │   ├── StarSchemaFlow.tsx    ← ReactFlow star schema diagram
    │   │   └── LineageFlow.tsx       ← ReactFlow data lineage visualization
    │   └── semantic/
    │       ├── ApprovalBadge.tsx     ← approval status indicator
    │       ├── AuditPanel.tsx        ← audit trail viewer
    │       ├── BulkImportModal.tsx   ← bulk definition import
    │       ├── DatabaseTree.tsx      ← database schema tree view
    │       ├── HistoryPanel.tsx      ← change history tracking
    │       ├── KpiPanel.tsx          ← KPI definitions management
    │       ├── PathFinderPanel.tsx   ← relationship path finder
    │       ├── RelationshipCanvas.tsx ← relationship mapping visualization
    │       ├── TableDetailPanel.tsx  ← table metadata/details panel
    │       └── types.ts             ← shared TypeScript types for semantic components
    │
    └── lib/
        ├── api.ts                   ← Axios client; JWT interceptor; 401 → redirect to /
        ├── auth.ts                  ← JWT storage, getTokenPayload, isAdmin, setToken
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
