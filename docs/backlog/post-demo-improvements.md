# Post-demo improvements

> Captured 2026-05-24 after the architectural reflection triggered by reviewing
> Peliqan as a competitive reference and looking at one month of Azure
> infrastructure cost. The Neopaul demo is 2026-05-26 so nothing here is acted
> on now. After the demo, walk through this list together and pick the next
> 1-2 items based on what came out of the Neopaul conversation.

## Quick wins (cost) — ~1 day total

These pay back immediately and remove operational complexity without changing
user-facing behaviour.

### 1. Container Registry cleanup (~30 min, saves €8-10/month)

ACR keeps every image tag forever by default. We've accumulated ~50+ tags.
Add a scheduled task to retain only the last 5 per repository:

```bash
az acr task create --schedule "0 0 * * 0" \
  --registry databridgeprodacr000r75 \
  --name purge-old-images \
  --cmd "acr purge --filter '.*:.*' --keep 5 --ago 30d" \
  --context /dev/null
```

### 2. Disable Redis Container App (~10 min, saves €5/month)

BullMQ already falls back to inline execution when Redis is unreachable. We
don't currently rely on scheduled jobs heavily enough to need a running Redis.
Either:
- Scale Redis Container App to zero (cold start tolerable since it's optional)
- Or remove the Container App entirely and let the env var be empty

Re-enable when scheduled email reports or background syncs become high-frequency.

### 3. Backend cold-start latency review (~1h)

Confirm that backend Container App reliably wakes from scale-to-zero within
~5-10 seconds. If users hit a noticeably slow first request after idle
periods, set `min_replicas = 1` (with corresponding cost) OR add a frontend
"warming up..." indicator on the first call.

## Architecture decisions — 2-5 days each

These are real structural changes. Each one is a focused PR.

### 4. Retire Neo4j, consolidate semantic to Postgres (~3-5 days, saves €55/month)

Today: Neo4j stores `source_tables`, `source_columns`, `table_relationships`,
`kpi_definitions`, `cross_source_views`, `quality_rules`. There's an active
dual-write contract with Postgres (documented in CLAUDE.md) — both are
written, reads go to Neo4j.

The cost in production:
- Neo4j Container App `min_replicas = 1` (forced because cold-start is ~30s)
- Currently 67% of all infrastructure spend
- One additional store to back up, monitor, schema-evolve, secure

What would change:
- Move the Cypher queries in `db/semanticGraph.ts` to equivalent Postgres
  recursive CTEs (where graph-shaped) or plain joins (where they're just
  table lookups dressed up as graph)
- Drop the dual-write contract; Postgres becomes single source of truth
- Drop the Neo4j Container App + Neo4j driver dependency
- Migrate any remaining Neo4j-only data into Postgres tables

When NOT to do this: if a strategic feature emerges where end-customers
actually use the knowledge graph for graph traversal (e.g. "show me a
dependency map of all my metrics"), then Neo4j stays. Today it's pure
internal plumbing.

### 5. Layer 2 tenant context drift — finish the cleanup (~2-3 days)

Started by the May 24 fix on `productContext.buildProductSemanticContext`
(commit be5a9ea) and the productContext audit. Still latent in services
that use bare `semanticDb` without tenant context:

- `services/aiBudget.ts` (`checkTenantAiBudget`, `recordTenantAiUsage`)
- `services/aiCallLogger.ts` (`logAiCall`)
- `services/glossaryContext.ts` (`loadGlossary`)
- `services/pipelineService.ts`
- `services/mfaService.ts`
- `services/webauthnService.ts`
- `services/queryCache.ts`
- `services/morningBriefService.ts`
- `services/busMatrixOrchestrator.ts`
- `services/busMatrixBuilder.ts`
- `services/auditService.ts`
- `services/warehouse/deltaWriter.ts`

Pattern to apply: same as `productContext` got (accept optional `trx`,
default to `semanticDb` for backward compat, callers pass `reqDb(req)`).
Or move queries to `tenantQuery()` / `tenantScopedWrite()` wrappers
introduced earlier this week.

Symptoms today: 42501 errors in App Insights from `ai_usage` and
`ai_call_log` inserts (fire-and-forget catches them, no user impact, but
the per-tenant cost dashboard sees nothing).

### 6. Eliminate `.catch(() => [])` patterns OR move to safeQuery (~1 day)

Layer 1 of the reliability work shipped the `safeQuery` helper (SAVEPOINT
wrapper) but only migrated the highest-risk callsites. Sweep the rest:

```
backend/src/routes/quality.ts:5
backend/src/routes/notebooks.ts:2
backend/src/routes/products.ts:5
backend/src/routes/conversations.ts:1
```

Each should either:
- Use `safeQuery(trx, fn, fallback)` if it's a defensive read
- Use `tenantScopedWrite(tenantId, fn)` if it's a write on a shared trx
- Get a `// SAVEPOINT-safe` or `// fire-and-forget` marker if the pattern is
  intentionally safe (e.g. Neo4j calls, service-level fire-and-forget)

The CI lint (`lint-shared-trx-catch.ts`) already enforces this for new code.

## Cost — AI tokens

### 7. Switch generateSql to Azure AI Foundry Llama (Stage B.1 from the April roadmap)

**Trigger condition**: ~5 paying customers actively using the platform. Below
that, the engineering investment doesn't pay back the per-month savings. The
strategic justification at this stage is data-sovereignty positioning for
enterprise sales, not pure cost.

**Why Foundry Llama instead of Claude for SQL generation:**

| Aspect | Anthropic Claude (current) | Azure Foundry Llama 3.3 70B |
|---|---|---|
| Input price | $3 per 1M tokens | ~$1 per 1M tokens |
| Output price | $15 per 1M tokens | ~$1 per 1M tokens |
| Per-call cost (NL→SQL) | $0.008 to $0.025 | $0.002 to $0.008 |
| Latency | ~2-5s typical | ~3-8s typical (slightly slower) |
| Data residency | US (Anthropic) | EU (Azure West Europe) |
| Quality on SQL gen | Excellent | Good (verified by Llama 3.3 benchmarks) |
| Provider risk | Single (Anthropic) | Azure-native, fits the rest of the stack |

**At current scale (1 active tenant):** monthly AI cost is probably in the
€5-15 range. Migration is not worth the work yet.

**At 5+ tenants doing real work:** monthly Claude cost likely reaches €100-300.
Switching `generateSql` (the most frequent call type) to Llama 70B cuts
~70% of that. Plus opens up the "your data never leaves Azure West Europe"
positioning for enterprise sales.

**Where Claude stays:** `starSchemaDesign`, `dashboardGeneration`, complex
reasoning calls. The model quality difference matters there; cost doesn't
yet justify the swap.

**Prerequisite work (DO FIRST before any switch):**

1. **Build the LLM eval suite.** A test set of `(question, expected-SQL /
   expected-answer-pattern)` pairs from `query_log` + human annotation. CI
   gate that fails if quality regresses beyond threshold. Without this,
   swapping models is a blind bet that could quietly degrade user experience.

2. **Provision `Llama-3.3-70B-Instruct` serverless endpoint** in Azure AI
   Foundry. Pay-per-token, no infra to manage.

3. **Introduce `LlmProvider` abstraction** in `backend/src/ai/providers/` with
   `AnthropicProvider` (existing) and `AzureFoundryProvider` (new). Router
   picks provider per call type + per tenant.

4. **Route `generateSql` only** (the highest-volume call). Keep everything
   else on Claude. Roll back via env var if quality regresses in prod.

5. **Do NOT touch `formatAnswer` / `validateQueryResult` yet** — they
   process actual customer row data; moving them is Stage B.2, gated on
   regulated enterprise demand.

### 8. Switch dashboard generation to caching templates (~1-2 days)

Today: every `generateDashboardSpec` is a fresh 16k-output-token call,
even for very common dashboards ("monthly revenue overview", "top customers",
"AR aging"). At €0.10-0.30 per generation, this is the second-highest cost
driver.

Idea: detect common dashboard archetypes via a cheap Haiku classifier (~$0.0005
per call) and serve a template-instantiated spec (zero Claude tokens) when the
request matches a known pattern. Only fall back to full Sonnet generation for
truly unique requests.

Estimated savings: 40-60% on dashboard-related token spend if half of
generation requests match an archetype.

## Feature work (after demo, picked based on Neopaul feedback)

These came out of the broader UX review earlier. Ordered by what would
likely resonate most with an SMB owner who agrees to a design partnership.

### 9. Annotations on charts (~3-4 days)

Click a data point or period on a chart, attach a note ("supplier price
increase March 2026, passed through in May"). Annotations are visible to
all users of the dashboard, capture institutional knowledge that today
exists only in someone's head.

Most strategic long-term differentiator vs Power BI / Tableau. Belongs to
data, not to a user.

### 10. Threshold alerts (~4-5 days)

Per-KPI alert configuration: "notify me when DSO > 45 days", "alert when
revenue YTD < 80% of target". Push via email / Teams / SMS. Converts
Clarion from a pull-based dashboard tool into a proactive monitor.

Requires new domain: alert definitions, scheduler, notification channels.
Reuses the existing email infrastructure (ACS).

### 11. Comparison toggles on widgets (~2 days)

Per-widget or dashboard-wide quick-toggle: "actual vs target" / "vs prior
year" / "YTD" / "rolling 12 months". Converts numbers into stories without
typing a refine request.

KPI cards already show delta vs prior period — extend the same pattern to
charts and add the user-controlled toggle.

### 12. Right-click "Why?" on KPI cards (~2 days)

The `investigateService` already exists and runs the multi-step "why?"
agent loop (max 6 steps, SSE streamed). Today only reachable from Ask AI.
Wire a right-click context menu on KPI cards that triggers Investigate
with the KPI's underlying SQL as the starting point.

Turns dashboards from a status board into an investigation tool.

### 13. Freshness indicator per widget (~1 day)

Tiny timestamp under each widget: "data of today 09:14", green/yellow/red
dot for fresh/stale/very stale. Hover for "last synced from Exact Online
at...". Trust comes from knowing data is current.

### 14. Data lineage UI (~1 week)

The `column_lineage` table already exists. Build a UI: click any number in
any widget, see "this number comes from `fact_sales_invoice_lines.AmountDC`,
which derives from `SalesInvoiceLines.AmountDC` in ExactOnline, last synced
at...". Marketed by Peliqan, missing from us.

### 15. Per-tenant usage analytics (~1 week)

For pricing-tier decisions: which features get used by which tenants, how
often, by which roles. Today this is invisible to us. Without it we're
guessing about what to charge for and what to deprecate.

### 16. Connector expansion (ongoing, ~1 connector per 2-3 weeks)

Biggest gap vs Peliqan (5 vs 250+). Belgian SMB priorities:
- Octopus (accounting)
- WinBooks (accounting)
- BOB (accounting)
- Yuki (accounting)
- Salesforce (CRM)
- HubSpot (CRM + marketing)
- Stripe (payments)
- Shopify (e-commerce)

Priority based on Neopaul + next 2-3 design partners' actual systems.

## Things I would NOT do

For the record, deliberately deprioritised:

- **Streamlit data apps** — wrong persona for Clarion (data team builds for
  business). Notebooks already cover the "I want to write Python" use case
  for the rare power user.
- **Native mobile app** — cost-prohibitive for SMB usage patterns. Responsive
  web works.
- **Federated query engine (Trino)** — overkill for SMB scale; DuckDB is
  faster and cheaper at our typical data volumes.
- **Real-time streaming** — irrelevant for accounting / CRM data which
  updates daily at most.
- **Reverse ETL** — Peliqan's territory. Not strategic for the
  owner-operator persona.
- **Multi-cloud** — Azure-only is a positioning feature, not a limitation.
- **Self-trained LLM** — economically irrational below 10K+ customers.

## Walkthrough agenda for the post-demo review

When we sit together after the Neopaul meeting, propose this flow:

1. What came out of Dries' discovery answers? Which features did he raise?
   That re-orders this list.
2. Cost quick wins (1, 2, 3) — agree go / no-go. ~1 day total.
3. Pick ONE architecture decision to tackle in the next sprint:
   - Neo4j retirement (4)
   - Layer 2 tenant context cleanup (5)
4. Pick ONE feature to ship as the "design partner bonus" for whoever
   agrees to the pilot. Most likely candidate from the list above.
5. Decide whether to start the LLM eval suite (prerequisite for any
   future model migration). Not the migration itself yet.
