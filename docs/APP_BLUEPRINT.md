# Clarion — App Blueprint (the intuitive revamp)

> The authoritative spec for how Clarion should work, what lives where, and how
> it's represented. Default persona: a **non-technical business data-owner** who
> is in charge of their data through business knowledge. Everything technical is
> available but never in their way. Companion to `UX_REDESIGN.md` (phased work).

---

## 1. Product in one sentence
Connect your business systems, let AI describe and model the data, then **ask
questions and build reports in plain language** — correcting meaning by talking
to the AI, never by writing SQL.

## 2. The spine (say it in business words)
**Connect → Understand → Ask → Trust.** Every surface maps to one of these.
Nothing in the default app exists outside this spine.

## 3. Two surfaces, one app
- **Workspace** — the calm default. A business owner lives here. 5 destinations.
- **Studio** — builder/technical tools, collapsed by default, opened deliberately
  by analysts/admins. Star schemas, SQL, pipelines, notebooks, sources live here.
- **Settings** — admin org config.

The rule: **no warehouse/engineering vocabulary or affordance appears in
Workspace.** If a thing needs SQL, a DAG, or the words "fact/dimension/cursor",
it belongs in Studio.

---

## 4. Surface-by-surface (what's there, what's NOT, how represented)

### Workspace

**Home** — "What needs me + what I was doing."
- Is: health-at-a-glance, an **attention inbox** (suggestions to confirm,
  stale data, failed refreshes, low-confidence questions), recent answers +
  pinned reports.
- Represented as: one calm scroll — a single health ring, then an inbox list,
  then recent cards. One primary CTA when empty: "Connect your data" (admin) or
  "Ask a question" (everyone).
- NOT: no tabs, no jargon, no config.

**Ask AI** — the conversational core.
- Is: ask in plain language → answer + chart + plain-English explanation; follow
  up; pin an answer to Home or turn it into a report.
- Represented as: a chat with a conversation list; answers show the result and a
  one-line "how I read your question", not SQL.
- Advanced (hidden behind an "Advanced"/dev toggle, analyst+ only): show SQL,
  query the raw source layer. Off by default.

**Dashboards** — reports in plain language.
- Is: describe a report → AI builds it; refine by chatting; filter; save/share.
- Represented as: gallery of saved reports + a "Describe a new report" input.
- NOT: no widget-SQL editing on the surface (that's an advanced drawer).

**Catalog** — understand & confirm your data (the merged "understand" surface).
- Is: browse everything you have, read **what each thing means**, confirm/adjust
  AI-suggested meanings, see **trust** (quality/freshness), and the **glossary**.
- Represented as one surface with light facets: **Browse · Meanings · Trust ·
  Glossary**. (Replaces today's separate /catalog, /health, /glossary.)
- Editing is **AI-first**: every definition/term has a primary "Ask AI to
  reword/define" action; manual free-text is secondary; SQL never appears here.
- NOT: no lineage DAGs as the headline (offer "Where this comes from" as a plain
  list; the diagram is a Studio detail).

**Glossary** — (folds into Catalog → Meanings/Glossary facet; kept as a
deep-link for now).

### Studio (analyst+, collapsed by default)

- **Sources** — connect + sync systems. Wizard stays; refresh is scheduled and
  mostly invisible to Workspace.
- **Data products** — the star-schema/modelling surface. This is the ONLY place
  facts/dimensions/bus-matrix/SQL are allowed. "Prepare my data" = one-click AI
  build; hand-tuning SQL is an explicit advanced affordance.
- **Refresh** — pipelines/automation. Represented to Workspace only as an
  "Updated 2h ago · Refresh" chip; the DAG lives here.
- **Suggestions** (was "AI review queue") — confirm/flag AI-proposed meanings.
  Also surfaced as Home inbox items so the owner rarely needs the full page.
- **Notebooks** — Python/Pyodide for analysts. Untouched, just relocated.

### Settings (admin)
Team & roles · Policies · AI usage.

---

## 5. Vocabulary (global rename map)
| Engineering term (today) | Business term (target) | Where |
|---|---|---|
| Build (nav) | **Data products** | done |
| AI review queue | **Suggestions** | nav + page |
| Definition gaps | *(fold into Suggestions / Home)* | — |
| Fact / dimension / bus matrix | the numbers / what you slice by / *(Studio only)* | Studio |
| Lineage / DAG | **Where this comes from** | Catalog (list) |
| Pipelines / triggers / scope | **Refresh / Automatic refresh** | Studio + chip |
| Source layer vs product layer | *(hidden; advanced toggle)* | Ask advanced |
| Transformation SQL | **How this is calculated** → "Ask AI to change it" | Studio |

## 6. Interaction patterns (consistency rules)
1. **Every page self-explains:** title + one-line "what this is for" + one
   primary action. No page should require prior knowledge.
2. **Tune by talking:** the primary edit action on any meaning/metric is "Ask
   AI…"; manual editing is the fallback; SQL is Studio-only.
3. **Progressive disclosure:** advanced/technical controls live behind a clearly
   labelled "Advanced" toggle or in Studio — never on the default surface.
4. **One job per surface; no duplicate doors.** "Your data" is exactly one place
   (Catalog), not three.
5. **Plain-language everywhere**, including errors ("We couldn't reach Odoo —
   check the URL", not a stack trace).

## 7. What changes vs. today
- Three "data" doors (Catalog/Health/Glossary) → **one Catalog** with facets.
- Two "review" surfaces (review/gaps) → **Suggestions** + Home inbox.
- Builder tools demoted to **Studio** (done) and renamed to business words.
- SQL/star-schema/DAG removed from every Workspace surface.
- Tuning becomes conversational ("Ask AI to change it").

## 8. Shippable roadmap (each step verifiable + revertible)
- **Wave 0 (DONE):** business-first nav; collapsible Studio.
- **Wave 1 (this change):** vocabulary pass (Suggestions); role-aware ⌘K command
  palette as the universal "go / create" entry.
- **Wave 2:** consistent page-header pattern (title + purpose + primary action)
  applied across pages.
- **Wave 3:** merge Catalog + Trust(quality) + Glossary into one faceted surface.
- **Wave 4:** "Ask AI to change it" tuning flow (needs backend NL-edit endpoints).
- **Wave 5:** hide Ask/Dashboards advanced (SQL/source-layer) behind a toggle;
  surface refresh as a chip; retire /gaps.

Waves 3–4 are page rewrites + backend work and should be validated against a
running instance (the dev sandbox can't run the full stack), so they ship with
review rather than blind.
