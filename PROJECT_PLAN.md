# DataBridge — Production Launch Plan

> Track progress block by block. Updated by Claude Code at the end of every session.
> Read this file at the start of every session to know where we are.

**Target:** Production-ready SaaS for companies with 20–200 employees.
**Last updated:** 2026-04-03
**Current block:** 1.4 — Azure Deployment

---

## Block 1 — Foundation

### 1.1 Real Authentication ✅
- [x] Create `tenants` table (id, name, slug, status, created_at)
- [x] Create `users` table (id, tenant_id, email, password_hash, display_name, role, is_active, password_reset_token, password_reset_expires, created_at)
- [x] Password hashing with bcryptjs (pure JS, no native deps)
- [x] Registration endpoint: POST /api/auth/register (creates tenant + first admin user)
- [x] Login endpoint: POST /api/auth/login (email + password, returns JWT with tenant_id)
- [x] JWT now includes sub (user_id), tenantId, email, displayName, role
- [x] Password reset: POST /api/auth/forgot-password (generates hashed token, logs reset URL in dev)
- [x] Password reset: POST /api/auth/reset-password (validates token, sets new password)
- [x] Update frontend login page (email + password, logo, links to register + forgot-password)
- [x] Frontend: registration page (/register) — company name, display name, email, password
- [x] Frontend: forgot-password page (/forgot-password)
- [x] Frontend: reset-password page (/reset-password?token=&email=)
- [x] Remove hardcoded users from auth.ts — fully DB-backed
- [x] Session refresh: POST /api/auth/refresh (extend session without re-login)
- [x] Roles updated: admin, analyst, viewer (replaces epicdata_admin/client_user)
- [x] All backend routes updated to use new role names
- [x] All frontend pages updated to use new role names + JWT shape

### 1.2 Multi-tenancy ✅
- [x] Add `tenant_id` column to 27 tables with FK to tenants
- [x] Auto-fill default: `tenant_id DEFAULT current_setting('app.current_tenant')::integer` — zero code changes needed for existing INSERTs
- [x] Postgres RLS policy on every table: USING + WITH CHECK on tenant_id
- [x] FORCE ROW LEVEL SECURITY on all tables
- [x] Created `databridge_app` role (NOSUPERUSER, NOBYPASSRLS) — app connects as this role
- [x] Migrations still run as `databridge` superuser (via knexfile.ts)
- [x] `requireAuth` middleware auto-sets `SET app.current_tenant` from JWT
- [x] Backfilled existing data to tenant_id=1
- [x] Indexes on tenant_id for all 27 tables
- [x] Verified: Tenant A sees own data, Tenant B sees empty results — full isolation confirmed
- [x] Neo4j: added tenantId indexes on all node labels (full Cypher filtering deferred — Postgres RLS is the primary protection)

### 1.3 Multiple Source Connectors ✅
- [x] Refactor ConnectorFactory for plugin-style registration
- [x] PostgreSQL connector (pg driver, SSL support)
- [x] MySQL connector (mysql2 driver, SSL support)
- [x] SQL Server connector (mssql driver, Windows auth + SQL auth)
- [x] Encrypt connection credentials at rest (AES-256)
- [x] Connection test with configurable timeout
- [x] Update frontend setup wizard: connector picker (SQLite, Postgres, MySQL, SQL Server)
- [x] Schema introspection for each new connector (information_schema based)
- [x] Sample value extraction for each connector

### 1.4 Azure Deployment
- [ ] Dockerfile for backend (Node.js + ts-node)
- [ ] Dockerfile for frontend (Next.js standalone build)
- [ ] docker-compose.production.yml (all services)
- [ ] Azure Container Registry (ACR) for Docker images
- [ ] Azure Container Apps for backend + frontend
- [ ] Azure Database for PostgreSQL Flexible Server (replace local Docker Postgres)
- [ ] Azure Blob Storage for warehouse/parquet files (container per tenant)
- [ ] Replace local file paths with Blob Storage SDK (@azure/storage-blob)
- [ ] Azure Key Vault for secrets (JWT secret, Anthropic key, DB credentials)
- [ ] Azure Application Insights for monitoring
- [ ] HTTPS via Azure (automatic with Container Apps)
- [ ] Environment variables via Azure App Configuration
- [ ] GitHub Actions CI/CD: build → push to ACR → deploy to Container Apps
- [ ] Staging environment (separate Container App + separate DB)
- [ ] Custom domain + Azure DNS
- [ ] Azure Redis Cache (for job queues in Block 2.1 + caching in Block 4.3)

---

## Block 2 — Data Reliability

### 2.1 Background Job Processing
- [ ] Install BullMQ + Redis
- [ ] Job queue for schema profiling
- [ ] Job queue for transformation runs
- [ ] Job queue for data ingestion
- [ ] Job status API: GET /api/jobs/:id (status, progress, result)
- [ ] Frontend: job progress indicators (polling or SSE)
- [ ] Failed job retry logic
- [ ] Job cleanup (remove completed jobs after 7 days)

### 2.2 Scheduled Transformations
- [ ] Schedule table per product (cron expression, enabled/disabled)
- [ ] Cron runner service (node-cron or BullMQ repeatable jobs)
- [ ] Run history table (started_at, finished_at, status, error)
- [ ] API: CRUD for schedules
- [ ] Frontend: schedule picker in product settings
- [ ] Email alert on transformation failure

### 2.3 Extended Data Quality
- [ ] Null/completeness check (% of nulls per column)
- [ ] Referential integrity check (FK values exist in target)
- [ ] Value range check (configurable min/max)
- [ ] Freshness check (last modified timestamp vs threshold)
- [ ] Configurable thresholds per check
- [ ] Quality score dashboard per table
- [ ] Quality trend chart (score over time)
- [ ] Email/in-app alert when quality drops below threshold

### 2.4 Incremental Loads
- [ ] High-watermark tracking per table (last loaded value)
- [ ] Incremental ingestion: only new/changed rows
- [ ] Incremental transformation: merge new rows into existing parquet
- [ ] Full refresh still available as manual option
- [ ] API: toggle incremental vs full per table

---

## Block 3 — Functional Completeness

### 3.1 User Management UI
- [ ] Admin page: list all users in tenant
- [ ] Invite user by email (sends invitation link)
- [ ] Role assignment on invite (admin, analyst, viewer)
- [ ] Deactivate user (soft delete, revoke access)
- [ ] Profile page: change display name, password
- [ ] Avatar upload (optional)

### 3.2 Chat Improvements
- [ ] Chat history table in Postgres (per user, per tenant)
- [ ] Conversation list API: GET /api/conversations
- [ ] Persist messages server-side on each exchange
- [ ] Remove localStorage chat dependency
- [ ] Saved queries / bookmarks: star a conversation
- [ ] Feedback button: "Was this answer correct?" (thumbs up/down)
- [ ] Store feedback → use for gap detection improvement
- [ ] Export query results to CSV
- [ ] Export query results to Excel (.xlsx)

### 3.3 Dashboard Improvements
- [ ] Shared dashboards: visible to all users in tenant
- [ ] Dashboard permissions: owner, editor, viewer
- [ ] Dashboard folders / categories
- [ ] PDF export of dashboard
- [ ] Auto-refresh on configurable interval
- [ ] Duplicate dashboard button
- [ ] Dashboard templates (pre-built layouts)

### 3.4 Semantic Layer Improvements
- [ ] Definition version history table (stores every edit)
- [ ] View change history per table/column/KPI
- [ ] Diff view: compare two versions
- [ ] Approval workflow: draft → pending review → approved
- [ ] Bulk import definitions from CSV/Excel
- [ ] Data dictionary export: PDF with all definitions
- [ ] Data dictionary export: HTML (shareable link)
- [ ] Audit trail: who edited what, when (visible in UI)

### 3.5 Notification System
- [ ] Notifications table (user_id, type, message, read, created_at)
- [ ] API: GET /api/notifications, PUT /api/notifications/:id/read
- [ ] In-app notification bell with unread count
- [ ] Notification types: job complete, quality alert, new gap, invite accepted
- [ ] Email notification preferences per user
- [ ] Email sending integration (Azure Communication Services)
- [ ] Webhook support: POST to external URL on events

---

## Block 4 — Production Hardening

### 4.1 Testing
- [ ] Test framework setup (Jest or Vitest)
- [ ] API integration tests: auth endpoints
- [ ] API integration tests: connections CRUD
- [ ] API integration tests: semantic CRUD
- [ ] API integration tests: query flow
- [ ] API integration tests: products + transformations
- [ ] API integration tests: dashboards
- [ ] Tenant isolation test: verify cross-tenant data leak is impossible
- [ ] Transformation pipeline tests (DuckDB + quality checks)
- [ ] E2E tests: login → connect → profile → query → result (Playwright)
- [ ] CI: tests run on every PR

### 4.2 Observability
- [ ] Structured logging with Pino (replace all console.log)
- [ ] Request ID middleware (trace requests end-to-end)
- [ ] Azure Application Insights integration
- [ ] Error tracking: Sentry integration
- [ ] API response time logging
- [ ] Health check endpoint: GET /api/health
- [ ] Uptime monitoring (Azure Monitor or external)
- [ ] AI call latency + cost tracking dashboard

### 4.3 Performance
- [ ] Pagination on all list endpoints (limit/offset with cursor support)
- [ ] Redis caching layer for frequent queries (semantic context, connection metadata)
- [ ] Connection pooling for source databases
- [ ] Rate limiting: 100 req/min per user, 20 AI calls/min per tenant
- [ ] AI call timeout (30s) + retry with exponential backoff
- [ ] Database query optimization: add indexes where needed
- [ ] Frontend: lazy loading for large lists
- [ ] Frontend: debounced search inputs

### 4.4 Input Validation & Security
- [ ] Zod schemas on every API endpoint (request body + params)
- [ ] SQL injection audit on all dynamic queries
- [ ] CORS locked to production domain only
- [ ] Helmet.js security headers
- [ ] CSRF protection
- [ ] npm audit in CI pipeline (block deploy on high severity)
- [ ] Dependency update automation (Dependabot or Renovate)
- [ ] Content Security Policy headers
- [ ] API key rotation mechanism for Anthropic

---

## Block 5 — Compliance & Legal

### 5.1 GDPR
- [ ] Data export endpoint: GET /api/tenant/export (full JSON dump)
- [ ] Data deletion endpoint: DELETE /api/tenant (removes everything)
- [ ] Audit log table: every data access and mutation logged
- [ ] Audit log viewer in admin UI
- [ ] Privacy policy page (legal text)
- [ ] Cookie consent banner (if adding analytics)
- [ ] DPA template document for customers
- [ ] Sign Anthropic DPA
- [ ] Data Processing Register (spreadsheet documenting all data flows)
- [ ] Breach notification process document

### 5.2 SOC 2 Prep
- [ ] Sign up for Vanta or Drata
- [ ] Connect Azure + GitHub to compliance platform
- [ ] MFA enforced on Azure, GitHub, all internal tools
- [ ] GitHub branch protection: require PR reviews, no direct push to main
- [ ] Automated daily backups with tested monthly restore
- [ ] Incident response plan document
- [ ] Vendor register document (Anthropic, Azure, etc.)
- [ ] Employee security policy document
- [ ] Annual penetration test scheduled
- [ ] SOC 2 Type 1 audit engagement

### 5.3 ISO 27001
- [ ] ISMS scope document
- [ ] Risk assessment spreadsheet
- [ ] Risk treatment plan
- [ ] 15–20 security policy documents
- [ ] Statement of Applicability (Annex A mapping)
- [ ] Internal audit process
- [ ] Management review meeting cadence
- [ ] Certification body selected + audit scheduled

---

## Block 6 — Launch Readiness

### 6.1 Onboarding
- [ ] Welcome wizard for new tenants (company name, first connection)
- [ ] Sample dataset option (explore without connecting real data)
- [ ] Guided tour / tooltips on first use (setup → semantic → query)
- [ ] Help documentation / knowledge base (Notion or GitBook)
- [ ] Video walkthrough of key features
- [ ] In-app contextual help links

### 6.2 Billing
- [ ] Stripe integration
- [ ] Plan tiers: Free trial (14 days), Pro (per user/month), Enterprise (custom)
- [ ] Usage metering: AI calls, rows processed, active users
- [ ] Billing settings page in app
- [ ] Invoice history
- [ ] Upgrade/downgrade flow
- [ ] Trial expiration handling (read-only mode after 14 days)

### 6.3 Marketing Site
- [ ] Landing page with value proposition
- [ ] Pricing page
- [ ] Trust/security page (certifications, practices)
- [ ] Demo video
- [ ] Blog (optional, for SEO)
- [ ] Contact form / demo booking (Calendly)

---

## Progress Summary

| Block | Status | Items Done | Items Total |
|-------|--------|-----------|-------------|
| 1.1 Real Authentication | **Complete** | 17 | 17 |
| 1.2 Multi-tenancy | **Complete** | 11 | 11 |
| 1.3 Multiple Source Connectors | **Complete** | 9 | 9 |
| 1.4 Cloud Deployment | Not started | 0 | 12 |
| 2.1 Background Jobs | Not started | 0 | 8 |
| 2.2 Scheduled Transforms | Not started | 0 | 6 |
| 2.3 Extended Quality | Not started | 0 | 8 |
| 2.4 Incremental Loads | Not started | 0 | 5 |
| 3.1 User Management | Not started | 0 | 6 |
| 3.2 Chat Improvements | Not started | 0 | 9 |
| 3.3 Dashboard Improvements | Not started | 0 | 7 |
| 3.4 Semantic Layer | Not started | 0 | 8 |
| 3.5 Notifications | Not started | 0 | 7 |
| 4.1 Testing | Not started | 0 | 11 |
| 4.2 Observability | Not started | 0 | 8 |
| 4.3 Performance | Not started | 0 | 8 |
| 4.4 Security | Not started | 0 | 9 |
| 5.1 GDPR | Not started | 0 | 10 |
| 5.2 SOC 2 | Not started | 0 | 10 |
| 5.3 ISO 27001 | Not started | 0 | 7 |
| 6.1 Onboarding | Not started | 0 | 6 |
| 6.2 Billing | Not started | 0 | 7 |
| 6.3 Marketing Site | Not started | 0 | 6 |
| **Total** | | **37** | **189** |
