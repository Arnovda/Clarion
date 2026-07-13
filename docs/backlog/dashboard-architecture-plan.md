# Dashboard Generation — Architecture Assessment & Roadmap

> Written 2026-07-13, following a full review of the generation pipeline
> (prompts, AIService, routes/dashboards, productContext, ChartWidgets, the
> reverted Vega-Lite migration) plus an external survey of the 2025–2026
> charting/AI-dashboard landscape. This document is the plan of record for
> dashboard work. Tier 1 shipped with the commit that added this file.

---

## 1. Verdict on the current architecture

**The core pattern is correct and should be kept.** Claude emits a small,
app-owned JSON widget DSL (`shared/contract.ts`: 12 widget types + SQL +
filters + coarse layout) and the app compiles it deterministically into
hand-built Recharts widgets. This is the same architecture used by Databricks
AI/BI Genie, Hex Magic, ThoughtSpot's Liveboard agent, and Superset's MCP
integration. No leading product lets the LLM emit a raw chart-library spec.

**The Vega-Lite revert (2026-06-06) is externally validated.** The silent
blank-chart failure is a *documented structural property* of Vega-Lite
(a spec referencing a field not present in the data produces zero marks and
no error — vega-lite issues #4123 / #1752 / #7560; Altair's official
troubleshooting guide). Measured LLM generation accuracy on Vega-Lite is the
worst of the major libraries (~70% GPT-4o, ~24% Gemini vs ~87% on simpler
targets — *Computers & Graphics* 2026 study). Apache's own ECharts team
routes around raw-option generation with an MCP server + a Mermaid-like
intermediate DSL. **Do not return to Vega-Lite.**

Three patterns exist for LLM→dashboard:
1. LLM emits full chart-library spec — worst measured reliability; nobody
   serious ships it raw.
2. LLM emits constrained app-owned DSL; app compiles deterministically —
   **the industry-winning pattern; ours.**
3. LLM emits React code (v0/Artifacts style) — wrong for a governed
   multi-tenant product (no spec persistence/diffing, injection surface).

## 2. Weaknesses found (and their status)

### Generation reliability
| # | Finding | Status |
|---|---------|--------|
| 1 | `parseJson` had no truncation repair — a 16K-token spec cut at maxTokens 500'd `/generate` | **FIXED (Tier 1)** — `repairTruncatedJson` fallback wired into `parseJson`, Zod still guards structure |
| 2 | `combo_chart`/`radar_chart`/`treemap_chart` were legal in the Zod enum + layout rules but had **no prompt contract** | **FIXED (Tier 1)** — full spec blocks + decision-table rows added, matching the frontend components' actual `label`/`value`(/`line`) contracts |
| 3 | Widget column contracts (`label`/`value`/`series`/`row_label`…) were implicit — a mis-aliased SELECT rendered an empty card, not an error (the Vega failure class in miniature) | **FIXED (Tier 1)** — `shared/widgetContracts.ts` + deterministic check in the `/generate` validation pass; violations flow into the repair call as `contractIssue` (fix rule 8) |
| 4 | `kpiFormulas` computed by `productContext` but never fed to dashboard generation | **FIXED (Tier 1)** — passed through `generateDashboardSpec` → `buildDashboardUser` |
| 5 | Validation pass failures silently swallowed (`catch {}`) — spec could ship unvalidated with no trace | **FIXED (Tier 1)** — logged loudly (still best-effort by design) |
| 6 | No render-time self-healing: a saved dashboard broken by schema drift shows "Try regenerating" forever | Open — Tier 2 candidate (re-run the validate/fix call on demand from the widget error state) |
| 7 | Domain detection (`detectDomain`) is first-match-wins regex; only one domain block ever injected | Open — low priority; consider multi-domain injection or a Haiku classifier |
| 8 | `{{xf_*}}` cross-filter placeholders still mandated in the prompt although server-side `injectCrossFilter` handles non-CTE widgets deterministically | Open — deliberate: placeholders remain the only cross-filter path for CTE widgets (injection bails on `WITH`). Revisit if injection learns CTEs |
| 9 | **Structured outputs**: Claude strict tool-use / `output_format` (GA for Sonnet 4.6) can guarantee schema-valid specs at decode time, deleting the malformed-JSON class entirely | Open — Tier 1b. Needs a live API key to verify; ship behind an env flag (e.g. `DASHBOARD_STRUCTURED_OUTPUT=1`), default off, validate in staging. Note: guarantees *shape not semantics* — the deterministic column-contract gate stays |

### Rendering & UX (all open)
| # | Finding | Planned response |
|---|---------|------------------|
| 10 | No user layout editing (order + quarter-width spans only, AI-owned) | Tier 3: react-grid-layout 2.x; LLM emits `{x,y,w,h}` per widget (schema-constrained), persisted in the existing `spec` jsonb |
| 11 | Recharts ceiling: SVG-only, ~2–10k point practical limit, basic brush, no linked zoom; blocks the analyst-cockpit chart vocabulary (bullet, scatter, small multiples) from the retained design mockups | Tier 2: add **ECharts 6** as a *second rendering backend behind the same DSL* (see §3) |
| 12 | Recharts statically imported → ~565 kB first load (Vega branch proved 304 kB via code-split) | Tier 2: dynamic-import the widget module |
| 13 | No dark mode (single `:root`; PDF export hardcodes white) | Tier 2: with ECharts 6 dynamic theming charts are nearly free; CSS variables are the bulk |
| 14 | No virtualization — tables/pivots/drill modals mount every row | Tier 2: TanStack Virtual on `DataTableWidget`, `PivotTableWidget`, `DrillDetailModal` |
| 15 | Three duplicated color-token sources (`globals.css`, `chart-theme.ts`, `observatory.ts`) | Tier 2: generate the JS mirrors from one source at build time |
| 16 | PDF export is a single unpaginated html2canvas screenshot | Tier 3: server-side render or paginated export |
| 17 | No browser-level render verification (the recorded Vega lesson) | Tier 1b: Playwright smoke test — render every widget type against fixture rows, assert marks > 0 |

## 3. Roadmap

### Tier 1 — reliability hardening (SHIPPED with this commit)
Items 1–5 above: truncation repair, prompt contracts for the three phantom
widget types, deterministic column-contract validation
(`backend/src/shared/widgetContracts.ts`, unit-tested), KPI formulas into the
generation prompt, loud logging on swallowed validation failures.

### Tier 1b — reliability, needs live verification (next)
- **Structured outputs** behind an env flag (item 9). Verify against the real
  API in staging; then delete the truncation-repair path's raison d'être.
- **Playwright widget smoke test** (item 17): fixture rows per widget type →
  `/dashboards` render → assert non-empty marks. This is the exact gap that
  let the Vega blanks ship.
- Consider extending `kpiFormulas` + contract validation to the
  `refine-spec` path (same latent gaps, lower traffic).

### Tier 2 — rendering upgrade ("fast + beautiful")
- **ECharts 6 as a second backend behind the same widget DSL.** Not a
  migration — an addition, reversible per widget type (the opposite of the
  all-or-nothing Vega bet). Route new/heavy types (scatter, bullet, small
  multiples, dense time-series) to a thin ~30-line wrapper around
  `echarts.init` (do NOT depend on `echarts-for-react`), themed once from
  Observatory tokens, tree-shaken via `echarts/core` (~100 kB gz). Keep
  Recharts for the proven KPI/bar/line/pie widgets initially. The AI never
  sees the library — only the DSL grows. Every new type ships with: prompt
  block + `REQUIRED_WIDGET_COLUMNS` entry + Playwright fixture.
- Code-split the chart bundle; virtualize tables; consolidate tokens; dark
  mode.
- Render-time self-heal (item 6): "Fix this widget" action that re-runs the
  validate/fix call for a single broken widget.

### Tier 3 — product differentiation
- **User-adjustable layout** via react-grid-layout 2.x (item 10) — largest
  competitive gap.
- **Mosaic-style client-side interactivity**: graduate the DuckDB-WASM "fast
  mode" toward predicate pushdown over per-dashboard rollup extracts
  (UW IDL's Mosaic demonstrates 10M-row cross-filter in-browser). Caveats:
  ~9.6 MB WASM payload, 4 GB browser memory cap, tenant data in the browser.
- Optional Perspective-based pivot/explore widget for the analyst persona
  (now OpenJS-governed).
- Evaluation harness modeled on **VisEval** (validity / legality /
  readability) run against a golden set of generation requests, so prompt
  changes are measured, not vibes.

### Explicitly rejected
- Returning to Vega-Lite (documented silent-blank class, worst LLM accuracy).
- Tremor as a foundation (post-Vercel-acquisition limbo).
- Observable Plot (no pan/zoom, ~17 months without a release, pre-1.0).
- LLM-generated React code for dashboards.
- Letting the LLM write raw ECharts options — widen our DSL instead; never
  expose the library surface to the model.

## 4. Prompt & semantic-context assessment (detail)

What's already good and should be preserved:
- Rule-dense system prompt with a chart-type decision table, one few-shot
  JSON example per widget type, dialect-specific SQL blocks (the DuckDB
  "these functions DO NOT EXIST" list), human-readable-label rules, rollup
  preference, inverted-pyramid layout rules. Cached via `cache_control`
  (~90% input discount on repeat), temperature 0, compact-JSON user payloads.
- `productContext`'s compact column encoding (`[m,additive]`, `→dim_x` FK
  arrows, `[JOIN-ONLY]` technical-column firewall, shared cross-product
  dimensions, rollup section). This is genuinely dense — every char carries
  semantic load — and is the right shape for grounding.

Remaining prompt-layer improvements (beyond the shipped fixes):
- The 7 hard-coded domain blocks + regex `detectDomain` work but are crude
  (first-match-wins, single domain). A Haiku classifier or multi-domain
  injection is the upgrade path; measure with the eval harness first.
- `REFINEMENT_SYSTEM` output (clarifying questions) is not Zod-validated —
  low stakes (transient, not persisted) but cheap to add.
- The validate/repair call re-sends the full spec + all sample rows; if cost
  becomes visible, send only broken widgets + a spec skeleton.
