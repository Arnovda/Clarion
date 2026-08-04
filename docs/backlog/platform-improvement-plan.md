# Platform Improvement Plan

> Written 2026-08-04 after a full platform review (functional / semantic /
> technical) plus dedicated research into how the 2026 market builds AI
> dashboard generation. This is the plan of record for platform-level work.
> Phase 0 shipped with the commits that added this file.

---

## 1. Diagnosis

Thirty-odd findings reduce to **two causes**. Everything else is a symptom, and
work that does not address one of the two belongs in §7 (Not doing).

### Cause 1 — correctness rests on discipline where construction was possible

The ownership gate applied by hand per endpoint. The dual-write contract that
every write must remember to mirror. KPI formulas passed as a prompt hint
rather than an enforceable surface. A SQL gate that covered `MessageBubble`
and missed the two components rendered beside it. Each of these works exactly
as long as someone remembers.

### Cause 2 — there is no feedback loop from production

This is the more important one, and the evidence is a pattern rather than an
incident. Seven cases, all the same shape — built, believed working, actually
inert, discovered weeks or months later by accident:

| What | Inert for | How it surfaced |
|---|---|---|
| Docs channel (RLS pool bug) | months | a user compared the catalog to vendor docs |
| FK detection inventing relationships | months | only once someone measured |
| Sync worker running a stale image | weeks | a shipped fix had no effect |
| EO typed writes degrading silently | weeks | JSON-typed columns in the UI |
| `e2e/rls.spec.ts` | since it was written | the 2026-08-04 review |
| Rollup pre-aggregation | since Sprint 1.2 | the 2026-08-04 review |
| Per-tenant containers (0 writes) | since the flip | the preflight probe |

Seven repetitions is a missing system, not bad luck. It is also why Cause 1
persists: a discipline failure emits no signal.

**Therefore measurement is the spine of this plan, not a phase inside it.**
Without it, no later improvement — including the expensive ones — can be shown
to have worked.

### Assumption

A small team (possibly one person plus Claude Code). That shapes the plan:
few parallel tracks, and a preference for work that removes future work over
work that adds features. If the assumption is wrong, Phase 4 is the part that
changes.

---

## 2. Phase 0 — finish what is half-done

*Days. Shipped 2026-08-04 except where noted.*

- **SQL leak to viewers** — SHIPPED. `ThinkingBubble`/`ThinkingPanel` now take
  a required `canSeeSql`.
- **RLS isolation suite in CI** — SHIPPED, after repairing three dead tests.
- **Dependency audit as a gate** — SHIPPED. `scripts/audit-gate.mjs`.
- **Rollup detection in production** — `detectRollupTables` bails on Azure
  paths and reads the v1 local slug layout, while the default layout is v2 and
  production is Azure. Rollups are written and never advertised, so the AI
  always picks the full fact table. Rebuild on `tableCatalog`.
- **Dashboard validation fails open** — `validateAndRepairSpec` catches, logs
  and returns the unvalidated spec. Silent pass-through is the wrong default
  for a generated artefact.
- **Raw error messages to the client** — 16 route sites return `err.message`,
  leaking hosts and paths. Contradicts the stated non-negotiable.
- **FK re-measurement** — BLOCKED on a production Re-analyse of the EO
  connection; the audit reads what is stored, so running it first would
  re-measure the old baseline. Beat `UNRESOLVED 8 / TARGET-NOT-KEY 10 /
  MULTI-TARGET 14` out of 170.

## 3. Phase 1 — the one existential risk

*2–3 weeks. Do not defer.*

**Put `tenantId` into the Cypher.** `db/semanticGraph.ts` has 96 `MATCH`
clauses and zero tenant predicates; isolation rests entirely on 49 hand-applied
`denyUnlessOwned` gates covering 93 `graph.*` call sites in routes. One missed
gate on one new endpoint is a cross-tenant leak, and the gate has already
failed twice (the legacy fallback that turned every denial into a 500, and the
persist loop that was guarded while its twin was not).

The nodes now carry the property, so this is unblocked. Approach: one node type
at a time, keeping the application gate above it as a safety net (remove it
only once the Cypher is provably scoped), with the CI RLS suite as the
regression net. **Do not land a read predicate before the matching nodes carry
`tenantId`** — every catalog would read empty.

This is Cause 1 inverted: from "everyone must remember" to "it cannot go
wrong".

## 4. Phase 2 — build the measurement loop

*4–6 weeks. The keystone — Phase 3 cannot be verified without it.*

**2a. Production observability the team can actually reach.** App Insights is
wired but unreachable from where the work happens, which is why CLAUDE.md
carries ten "not verified" notes. The `.ops/` pattern already in the repo
(read-only control file, push triggers a paths-scoped workflow, output in the
log) is the right shape — extend it to the current blind spots: is the
child-process runner active, which Postgres role does production connect as,
are ownership refusals being logged.

**2b. An eval harness for AI quality.** 100–200 curated cases running on every
PR, over the three paths the product is sold on: NL→SQL, dashboard generation,
semantic profiling. The widget render gate proves the team can build this shape
of test. Today the only quality signal is a user seeing a broken dashboard.

**2c. Tests on the three core paths.** Not a coverage percentage. The goal is
that the five largest files have a safety net: `ai/AIService.ts` (2,631),
`db/semanticGraph.ts` (2,523), `routes/dashboards.ts` (2,220),
`routes/query.ts` (2,189), `semantic/SchemaProfiler.ts` (1,268). None has a
single test today.

## 5. Phase 3 — raise the AI ceiling

*6–8 weeks. Requires Phase 2 to verify anything.*

Research finding that reframes this: raw text-to-SQL sits at **64.5%**
execution accuracy, a semantic layer at **~100%** for covered queries — and
Sonnet 4.6 and GPT-5.3 Codex measured *identically*. Enterprise benchmarks are
worse still (Spider 2.0 ~21%, BIRD-Ent 39.1). **The ceiling is architectural,
not model-bound. A model upgrade does not fix SQL correctness.**

- **Metric-bound generation, in two tiers.** For covered questions the model
  picks a *metric by name* and the server substitutes the verified formula;
  free-form SQL remains only for the tail. Start with KPIs that already have a
  `formula_sql`. Incremental, and measurable thanks to 2b.
- **Then** the model upgrade (Sonnet 5 / Opus 5), per call category via the
  existing `services/ai/router.ts`, measured with `aiCallLogger`. Worth doing
  for reasoning, profiling and summarisation — expect nothing for SQL.
- **Governance before emission.** `sqlGuard` is a post-hoc denylist; the market
  direction is enforcing rules at query-compile time. Falls out of metric-bound
  generation.

Keep the rendering layer as it is — see §7.

## 6. Phase 4 — product, and Phase 5 — structural debt

**Phase 4 (parallel track, different kind of work).** Wire up the onboarding
wizard (it exists and is unreachable; `register/page.tsx` pushes `/sources`);
an i18n foundation for NL/FR; invert the trust signals (confidence and
provenance are admin-only on *successful* answers today, visible to business
users only on refusals — exactly backwards); delete dead code (`/onboarding`,
`IntegrationsPanel` at 1,024 lines imported nowhere, `/health`), which also
shrinks Phase 1's audit surface.

**Phase 5 (continuous).** Finish the dual-write contract — migrate the five
direct-Postgres aggregates to Neo4j counts and close Phase 7. Make `deploy.yml`
depend on the type-check (today a frontend type error reaches the production
image). Split CLAUDE.md into current state versus decision log.

---

## 7. Not doing

A plan without exclusions is a wish list.

- **No Next 14 → 16.** Two majors, and the advisory path is demonstrably
  unreachable — no `remotePatterns`, no `next/image` import.
- **No rendering rework, and no return to Vega-Lite.** The DSL, the column
  contracts and the browser render gate are better than most products in this
  category. The 2026 research validates the pattern: AntV's MCP chart server,
  ThoughtSpot's SpotterViz and Databricks Genie all constrain generation the
  same way. (Nuance worth recording: VegaChat reports near-zero invalid specs
  from Vega-Lite generation, so the honest lesson is that *unvalidated spec
  emission* fails, not that the library does. Going back still buys nothing.)
- **No model upgrade sold as a quality fix.** Measured: it changes nothing for
  SQL correctness.
- **No new features** in notebooks, pipelines or the star-schema designer until
  Phase 2 stands.
- **No chasing a coverage percentage.** Five files with a safety net beats 40%
  spread thin.

## 8. Decisions that are the owner's

1. **Hardening or go-to-market first?** Phases 1–3 make the platform reliable;
   Phase 4 makes it sellable. At this team size they do not really run in
   parallel. Phase 1 is not negotiable; after that, Phase 4 before Phase 3 is
   defensible if customers are waiting — provided 2a comes along, or the
   pattern in §1 repeats.
2. **How much breadth to keep?** 28 route mounts and ~25 frontend routes is a
   lot at this size. CLAUDE.md's own drift watchlist (§5) already says this and
   was never acted on. Pruning is the cheapest way to make every other phase
   smaller.

---

## 9. Ideas worth revisiting later

- **A Vision-Score-style render check.** VegaChat pairs a deterministic spec
  metric with a multimodal LLM judging the *rendered image* (Pearson 0.71 with
  human judgement). That catches "technically valid but unreadable / wrong
  chart", which no column contract can see. Sits naturally on top of the
  existing `/dev/widgets` gate.
- **MCP as the metric interface.** If metric-bound generation lands, exposing
  the metric catalogue over MCP is how 2026 agents discover and query governed
  metrics — and it is the same shape Cube and Databricks converged on.
