# Clarion UX/IA redesign — business-data-owner first

> Status: **in progress.** Phase 1 (navigation IA) shipped 2026-06-14. Later
> phases are proposed and gated on user feedback. Everything is on a feature
> branch and revertible via git.

## Goal
Clarion should be a joy for a **non-technical business data-owner** who is "in
charge of their data" through business knowledge. They should only ever tune a
few necessary things — **definitions, business glossary, and metrics/
transformations — by asking the AI**, never by writing SQL or designing star
schemas. The app must feel calm and uncluttered, closer to dScribe's focus and
Peliqan's single spine than to a dense, many-tabbed BI/eng tool.

## The five irreducible jobs
1. Connect a source (mostly an admin job).
2. Confirm what things mean (definitions + glossary) — AI-first, confirm.
3. Ask questions / see dashboards.
4. Occasionally correct a meaning or a metric **in plain language**.
5. Trust + refresh (refresh should be automatic/invisible).

Everything else (star-schema modelling, lineage DAGs, pipeline orchestration,
notebooks, definition-gap analytics, SQL editing) is in service of 3–4 and
should NOT be a first-class destination for the business owner.

## Competitor lessons
- **Peliqan** — one spine (Connect → Explore → Activate), spreadsheet metaphor,
  technical escalation lives one level down, not on the main canvas.
- **dScribe** — deliberately narrow ("most intuitive data catalog"), calm,
  business vocabulary, refuses to be an ETL tool.
- Both win on **one clear spine + scope discipline + plain words**. Clarion's
  visual system ("Observatory") is already calm; the problem was IA + vocabulary
  + builder-tool leakage onto business surfaces.

## Target IA
**Default app = the business owner's surface (Workspace):**
- Home — "what needs you" inbox + recent answers
- Ask AI — conversational answers
- Dashboards — reports in plain language
- Catalog — browse + understand + confirm meanings (later: + Quality + Glossary)
- Glossary — business terms (later: folded into Catalog)

**Studio = builder/technical tools (analyst+), demoted + separated:**
- Sources, Data products (modelling), Refresh (pipelines), AI review queue,
  Notebooks.

**Settings (admin):** Team & roles, Policies, AI usage.

## Vocabulary translation (default app)
| Today | Proposed |
|---|---|
| data product / fact / dimension / bus matrix | dataset / the numbers / what you slice by / *(Studio only)* |
| AI review queue / definition gaps / AI draft | "Suggestions to confirm" / fold into Home "Needs you" |
| lineage / DAG | "Where this comes from" |
| pipelines / triggers / scope | "Automatic refresh" |
| source layer vs product layer | *(hidden; advanced toggle in Studio)* |
| transformation SQL | "How this is calculated" → **"Ask AI to change it"** |

## Phased plan
- **Phase 1 — Navigation IA (DONE 2026-06-14).** `IconRail` regrouped from 6
  groups into business-first **Workspace** (Home, Ask AI, Dashboards, Catalog,
  Glossary; no eyebrow — the calm default) + **Studio** (Sources, Data products,
  Refresh, AI review queue, Notebooks; analyst+) + **Settings** (admin). Every
  route preserved — pure regrouping, fully revertible. `/products` relabelled
  "Build" → "Data products".
- **Phase 2 — Home as a "Needs you" inbox.** Merge the useful parts of `/review`
  + `/gaps` into Home cards ("suggestions to confirm", low-confidence questions,
  stale data). *Gated on feedback.*
- **Phase 3 — Merge Catalog + Quality + Glossary** into one "understand your
  data" surface with Browse / Meanings / Trust / Glossary facets. *Gated.*
- **Phase 4 — "Ask AI to change it"** as the primary tuning affordance on every
  definition / metric / dataset; raw SQL editing moves to Studio only. *Gated.*
- **Phase 5 — Studio as an opt-in mode** (toggle) rather than always-visible
  rail groups; invisible automatic refresh for owners. *Gated.*
- **Phase 6 — Decommission** standalone `/gaps`; redirect cruft; remove the
  source-layer toggle from the default app. *Gated.*

## Keep (Clarion's real advantages)
Conversational NL→SQL with confidence + repair, AI-drafted definitions, the AI
dashboard builder, and the Observatory visual language.
