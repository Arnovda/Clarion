# Platform coherence review — nine surfaces, one product?

**Date:** 2026-09-07 · **Tree audited:** `848ea94` (branch `claude/platform-coherence-ux-review-befn4n`, CSV connector merged) · **Method:** each surface read end to end — the page, the route, the service, the prompt — and traced to the thing it actually queries. Every claim carries `file:line` and was verified by reading that code, not by inference from these notes. Nothing was run against a live tenant; where a claim depends on runtime behaviour it says so.

**Scope:** the nine surfaces the owner named — Ask AI, Dashboards, Notebooks, Home, Subjects, Cross-source questions, Building subjects, Adapting subjects, and the case where a question needs a field the subject does not carry. Three cross-cutting questions run through all of them: *is it logical, is it best practice, and is it one product?*

This document does not replace `functional-requirements-evaluation.md` (does the product do what the marketing says) or `functionality-gap-analysis.md` (what a user's daily loop needs that we lack). It asks a narrower and, right now, more useful question: **do the parts we have already built fit together, and where do they contradict each other?**

---

## 0. Verdict in six sentences

**The engine is excellent and the surfaces around it are excellent; what is missing is that they were each built well and never made to agree.** The platform renamed its central noun to **Subject** and told the whole product to speak business language — but the unit of work in Ask AI, Dashboards, Notebooks and Build is still a **connection**, and in Ask AI that connection is *invisible, unchangeable and remembered from last time* (`frontend/app/query/page.tsx:69-70`, never rendered), so the Subjects page deep-links a question without setting it and the answer can silently run against a different source (`TopicLayer.tsx:36-47` passes `productId` but no `connectionId`; `page.tsx:369-380` then falls back to localStorage or the first connection). **Cross-source questions are not merely unbuilt — they are structurally forbidden by one line** (`tableCatalog.ts:275`, `.where('dp.connection_id', connectionId)`) **while three separate half-mechanisms advertise them**: grids join tenant-wide, the CSV connector that just shipped cannot join anything, and the Relations canvas lets you draw and measure a cross-source match that changes nothing downstream. **Adapting a subject has eight doors, of which three are dead code, two are broken by a `/api/api` path bug, and none reasons about columns** — which is why the owner's ninth question ("what if a question needs an extra field from the source?") has no answer in the product: the only escape is an unexplained admin-only checkbox called *Query source data* (`page.tsx:1602-1611`) with no path back. **Two shipped features are dead on every request** — dashboard email schedules and the "Ask AI to change this subject" panel both call `/api/…` on a client whose base URL already ends in `/api` (7 call sites against 374 that get it right) — and three more surfaces (Notebooks, the refinement preview, the per-table SQL cells) read the warehouse catalog with `tenantId: undefined`, which under the production RLS role registers **zero tables**. **The right move is not more surfaces: it is to make the Subject the unit of work everywhere, un-scope the query layer from the connection, and build the one loop no competitor has — "I could not answer that because your Sales subject does not carry VAT number; shall I add it?"** — and to delete the four authoring paths nobody can reach.

---

## 1. The coherence problem, stated once

Every surface in this product resolves, eventually, to a DuckDB session over Parquet. The interesting question is **what decides which tables are in that session**. There are four different answers, and they do not agree:

| Surface | Session built by | Scoped to | Sees grids? | Sees rollups? |
|---|---|---|---|---|
| Ask AI, Dashboards, Forecast, Briefs, Add-in | `createProductConnector` (`ConnectorFactory.ts:165`) | **one connection** | ✅ tenant-wide | ✅ |
| Notebooks | `buildNamespacedDuckDB` (`routes/notebooks.ts:51`) | **one connection** | ❌ | ❌ |
| Refinement preview, per-table SQL cells | `buildConnectionWarehouseSession` (`services/productWarehouse.ts:21`) | **one connection** | ❌ | ❌ |
| Relations → measure a match | `buildTwoSourceConnector` (`services/crossSourceSession.ts`) | **two connections** | ❌ | ❌ |

Four builders, four capability sets, for one job. The fourth one is the only thing in the product that can put two sources in one session — and it exists solely to compute a match percentage for a panel. It cannot answer a question.

**The unit of work is the connection, everywhere except the pages the user reads.** That is the whole finding. Subjects, the topic page and the Build page speak *Subject*; Ask AI, Dashboards, Notebooks and every warehouse session speak *connection*. The product renamed its noun and never moved its plumbing.

---

## 2. Ask AI

### What a user wants
Type a question in their own words, get a trustworthy answer, understand where it came from, and — when it is wrong or incomplete — be able to *say so and have something change*.

### What we have
Genuinely ahead of the market, and worth protecting. The answer card's categorical trust ladder (`★ Verified by your team` / `✓ Checked & corrected` / `△ Take with care`), the per-answer freshness line, the plain-language "How I got this" receipt with catalog links, the compile-error self-heal (`services/sqlSelfHeal.ts`), the multi-turn repair loop, the assumption chips that *branch* rather than merely explain, and the worksheet step-tree are, collectively, better than Genie, Spotter or Cortex Analyst on the axis that matters: a business user can tell whether to believe the number.

### Where it breaks

**(a) The most consequential piece of state is invisible.** `selectedSource` is declared at `page.tsx:70` and never rendered anywhere — the comment at line 69 says so outright (*"Data source selection (silent — no UI picker shown)"*). It is restored from `localStorage` (`page.tsx:374-377`), falls back to the first connection returned (`:378`), and at the request boundary falls back to the literal `1` (`:912`). With one source this is invisible and correct. With two — which the CSV connector has just made the common case — a user's question runs against whichever source they last used, with no way to see or change it.

**(b) Subjects → question is cross-wired.** `TopicLayer.askHref` (`frontend/components/topics/TopicLayer.tsx:36-47`) builds `/query?productId=N&productName=…&q=…&autoSubmit=1`. It does not pass `connectionId`. So the page uses whatever it remembered. If that connection does not own the product, `buildProductSemanticContext(connectionId, [productId])` filters `connection_id = X AND id IN (N)` (`services/productContext.ts:121-132`), gets zero rows, returns `null` — and `resolveDataLayer` silently drops the user onto the **source layer of an unrelated connection**. The topic page's stated promise ("clicking a question answers it") fails, and fails quietly.

**(c) Warehouse vocabulary reaches the screen.** `QueryLayerBadge` renders `⭐ Data Model` / `📦 Source` (`frontend/app/query/components.tsx:87-99`). It is gated to admin+analyst, so this is a nit, not a violation — but "Data Model" is exactly the register the Subjects rename was meant to abolish, and analysts are business users too.

**(d) There is no way to change the subject you are asking about.** A user on Ask AI cannot say "ask this of Purchasing instead". The only route is to go to `/subjects`, open a topic, and click a question — which then hits (b).

### Modify / delete / add
- **Modify:** pass `connectionId` alongside `productId` in `askHref` — a one-line fix for a wrong-answer bug.
- **Add:** a visible **Subject** picker in the composer (not a source picker). It sets `productId` *and* derives `connectionId`. This is the single highest-leverage change on this page: it makes the invisible state visible, fixes the cross-wire, and puts the product's own noun in front of the user.
- **Modify:** rename `⭐ Data Model` → the subject's own name.

---

## 3. Dashboards

### What a user wants
Describe it, get it, adjust it by talking, keep their own filters, and have it *arrive* — in their inbox, on their phone, in front of the board — without opening Clarion.

### What we have
The generation → validate → repair → refine pipeline is strong, and the tiered edit engine (deterministic ops for filters/chart-types, scoped model calls only where needed, a CHECK stage that reverts a broken widget) is genuinely good engineering. Per-user saved views, cross-filtering, drill-to-detail, XLSX/CSV export, pin-from-Ask-AI, and the assistant panel that reports its own progress are all real.

### Where it breaks

**(a) Scheduled email is dead on every request.** `EmailSchedulePanel.tsx` makes five calls, all prefixed `/api/` against a client whose `baseURL` already ends in `/api` (`frontend/lib/api.ts:6`): lines 51, 78, 101, 111, 120 → `…/api/api/email-schedules` → 404. The backend router is mounted correctly at `/api/email-schedules` (`index.ts:296`) and **the same feature works from Ask AI's empty state**, which uses the bare path (`frontend/app/query/EmptyState.tsx:139`). So: two doors to one feature, one alive, one dead. Across the frontend, **374 call sites use the bare convention and 7 use the doubled one** — the two cannot both be right.

Consequence: P3 of the product overview ("any dashboard scheduled as an HTML email") is not merely unmeasured, it is **unreachable from the dashboard**.

**(b) There is no external share.** Repo-wide there is no share link, share token, or public-link concept (`grep -riE "share_?link|public_?link|share_?token"` over `backend/src` → nothing). A dashboard cannot leave the tenant except as a file a human downloads and attaches.

**(c) No thresholds.** Nothing lets a user say "tell me when this crosses X". The only thresholds in the codebase are quality-rule pass rates and the morning brief's `sensitivity` band (`services/morningBriefService.ts:329`). The overview's P10 has no entity behind it.

### Modify / delete / add
- **Modify:** fix the 5 paths. One character each. This turns a shipped-but-dead feature on.
- **Add:** a share link (read-only, expiring, tenant-scoped) — the cheapest thing that makes a dashboard useful to someone without a seat.
- **Add:** thresholds on a KPI, reusing the notification + email plumbing that already exists.

---

## 4. Notebooks

### What a user wants
An escape hatch: when the modelled subject cannot express something, drop to SQL/Python against the same data, with the same table names, and get the answer.

### What we have
A real notebook — SQL and Python cells, Pyodide self-hosted, schema explorer, an assistant that *proposes* a diff you Keep or Discard (the Databricks pattern, correctly implemented), namespaced schemas so SQL is copy-pasteable from Ask AI.

### Where it breaks

**(a) It very likely registers zero tables in production.** `buildNamespacedDuckDB` calls `listSourceTables(undefined, connectionId)` (`routes/notebooks.ts:78`) and `listProductTablesByConnection(undefined, connectionId)` (`:95`). Passing `undefined` means `tenantQuery` sets **no tenant context** (`services/tenantQuery.ts:26-28`) and opens its own transaction on the root pool. Under the production `databridge_app` role (NOBYPASSRLS since 2026-08-06), the very first read — `connections WHERE id = …` — returns nothing, so `listSourceTables` short-circuits at `tableCatalog.ts:210` and the notebook gets an **empty schema**.

It is not deterministically broken: `middleware/auth.ts:176` still does a session-level `SET app.current_tenant` on the pool, so a pooled connection *may* carry the right tenant. That makes this **racy** — sometimes the notebook works, sometimes every cell fails with "table does not exist", depending on which pooled connection is handed out. It fails closed (no cross-tenant read), but it is exactly the P0-2 defect shape this codebase has already been bitten by twice.

Same bug, same two lines, in `services/productWarehouse.ts:39,43` and `routes/products/cells.ts:299-300` — which means **the refinement preview and the per-table SQL cells are affected too** (see §9).

**(b) It is not the same data as Ask AI.** Notebooks register source + product tables. They do **not** register managed grids or monthly rollups (`ConnectorFactory.ts:196-208` does; `notebooks.ts` does not). So `grid_budget_2026` — a table Ask AI will happily join — does not exist in a notebook. The escape hatch is *less* capable than the thing it is an escape from, which inverts its purpose.

**(c) It is connection-scoped like everything else**, so it cannot answer the cross-source question either.

### Modify / delete / add
- **Modify:** pass the tenant id at all six sites. This is the fix for three surfaces at once.
- **Modify:** register grids and rollups in the notebook session — or better, **collapse the four session builders into one** (`createProductConnector` already does the most; make the others call it).
- **Do not delete.** The owner's standing position is right: notebooks earn their keep as the analyst's escape hatch. But an escape hatch that sees less than the front door is not an escape hatch.

---

## 5. Home

### What a user wants
"What happened in my business since yesterday, and what should I do about it?"

### What we have
Two shapes from one endpoint (`routes/home.ts:28`), which is the right architecture. The **viewer** home is close to correct: greeting, one honest freshness line, a question box, the morning brief, dashboards, subjects (`frontend/app/home/ViewerHome.tsx`).

### Where it breaks

**The operator home is a platform-health dashboard, not a business one.** The payload (`routes/home.ts:324-368`) is: a 0–100 health score, freshness counts, definitions-approved counts, pipeline success rate, quality pass rates, pending-review queues. Those are answers to *"is Clarion working?"* — a question only the person who installed it asks, and only for the first month. An owner or analyst opening Home on a Tuesday learns nothing about their business until they scroll to the brief.

The brief itself is the one thing on the page that answers the real question, and **it never leaves the app**: `morning_briefs.emailed_at` exists in migration 48 with the comment *"populated when email phase ships"* and is written **nowhere** in `backend/src`.

**So the platform has no working outbound channel at all.** The brief does not email; dashboard schedules 404. Clarion can only be used by someone who remembers to open it — which, for the owner persona whose loop is daily and push-shaped, is the difference between a product and a tab.

### Modify / delete / add
- **Modify:** lead the operator home with the brief and the exceptions, and demote the health ring to a strip or a Studio page. Keep the health model — it is good — but it is Studio's subject, not Home's.
- **Add:** send the brief. `emailed_at` is a column waiting for a writer, and `reportEmailService` already knows how to build and send an HTML email.

---

## 6. Subjects

### What a user wants
"What can I ask about, and can I trust it?"

### What we have
**The best-designed surface in the product.** The hub (`frontend/app/subjects/page.tsx`) and the topic page (`routes/products/topic.ts` + `components/topics/TopicLayer.tsx`) answer four questions in order — what can I ask, what can I break it down by, how current is it, can I trust it — in business language, with a hard rule against warehouse vocabulary, and a single read model that returns exactly what the screen needs rather than a product payload with 95% thrown away. The `question_text` column stores the KPI as a first-person question rather than deriving it. The dimension sentence carries the tenant's own label for its calendar. This is the register the whole product should be in.

### Where it breaks
- The deep-link bug in §2(b) — the one thing this page promises is the one thing that can silently go wrong.
- `rowsTotal: 0` renders as "waiting for data from your source", which is honest, but there is no next step on the page for the person who can fix it.
- Nothing on the page can *change* the subject except entering Manage mode, which is a different register entirely (see §8).

### Modify / delete / add
- **Modify:** fix `askHref`.
- **Add:** the one thing missing from the four questions — **"what can I *not* ask?"**. A subject that names its own boundary ("this does not carry supplier contact details or anything about stock") is the most trust-building sentence on the page, and it is the entry point for §9.

---

## 7. Cross-source questions

### What a user wants
"Connect accounting and my webshop and ask questions that span both." (The product overview promises exactly this — P7.)

### What we have — and this is the sharpest finding in the review

**Three mechanisms, none of which compose, and one hard structural block.**

**The block:** `listProductTablesByConnection` filters `.where('dp.connection_id', connectionId)` (`services/tableCatalog.ts:275`). Every product-layer session is built from that call. A question therefore cannot see two sources' subjects, no matter how they are related. `/query`, `/think`, `/repair`, `/forecast`, dashboards, briefs and the add-in all inherit it.

**Mechanism 1 — grids join tenant-wide.** `listManagedGridTables(tenantId)` is registered in *every* connection's session (`ConnectorFactory.ts:203-208`) precisely so a budget can be joined against whichever connection holds the actuals. This works, and it is the only cross-boundary join in the product.

**Mechanism 2 — the CSV connector, shipped last commit, cannot join anything.** A CSV upload creates a **connection**. So the newest and cheapest second source lands on the wrong side of the block: a customer who uploads `Budget 2026.csv` gets a table they cannot join to their ERP, while the same numbers pasted into a *grid* join fine. **Two doors for one job — bring a spreadsheet in — with opposite capabilities and nothing on either screen explaining the difference.**

**Mechanism 3 — the Relations canvas measures matches that change nothing.** You can draw a cross-source match, `buildTwoSourceConnector` puts both sources in one DuckDB session, and it reports a match rate with unmatched samples (`services/crossSourceSession.ts`, `routes/relationships.ts:309`). Confirmed matches then reach `getMatchAssertions` — which is called from exactly one place, `routes/semantic.ts:710`, the **source-layer** context. The product layer never sees them (`services/productContext.ts` has no match concept). And the source layer is connection-scoped too. So a confirmed match is phrased for a model that could not act on it even if it wanted to.

The `POST /query/cross-view` path and the `/api/cross-views` router were correctly deleted on 2026-09-06 (they were SQLite-only and unguarded). Deleting them was right. Nothing replaced them.

### Modify / delete / add
- **This is the item that most deserves to be built, and it is one architectural change, not a feature.** Replace `listProductTablesByConnection(tenantId, connectionId)` with a tenant-scoped listing plus an *explicit* scope (the subjects in play), and make the scope a first-class part of the request instead of an implicit connection. Everything else — the DuckDB session builder, the view registration, the prompt context, the grids precedent — already works tenant-wide.
- **Decide the spreadsheet story.** A CSV and a grid should not be different kinds of thing. Recommendation: keep the CSV connector as the *ingest* path and materialise it where grids live (tenant-level), so both join. Or state on the upload screen that a CSV is per-source and a grid is shared — but silence is the one option that is wrong.
- **Add:** once matches can be acted on, feed them to the **product**-layer context, not just the source layer.
- **Until then:** stop promising it. P7 is currently the largest gap between the overview and the code.

---

## 8. Building subjects

### What a user wants
"Point at my data and give me something I can ask questions about, without me learning what a dimension is."

### What we have
Strong. `/build` is a genuinely good screen: it shows the **plan before the build** by instantiating the real connector template against the real synced table names (`routes/products/buildOverview.ts`) — so the promise shown is exactly what gets built, not a hand-maintained copy. The deterministic star-schema templates for Exact Online and Odoo beat the AI designer and are correctly preferred. The run panel names each topic as a card and streams honest progress. Show/hide is activation, not determination. Rebuild is a separate, warned action.

### Where it breaks

**(a) A rebuild is retire-and-replace and nothing tells you what will break.** `buildBusMatrix` deletes stale products (`services/busMatrixBuilder.ts:513-516`). `snapshotProductEdits` (`:412-437`) carries across `hidden`, `plain_summary`, KPI `question_text` and human-authored KPIs — good, and a real improvement. It does **not** carry product **column** descriptions or display names, which the Catalog is the only surface that can edit. And nothing anywhere checks what depends on the tables about to be renamed: `grep -inE "impact|dependents|will break"` across the builder, orchestrator and build routes returns nothing.

The data to do this **already exists**: `saved_questions.tables_used` is stored (`routes/savedQuestions.ts:87`) and dashboards compute `tablesUsed` in `widget-context` (`routes/dashboards.ts:2757`). A rebuild could say *"3 dashboards and 5 saved questions use tables this rebuild will rename"* with a join and no new schema.

**(b) The first fifteen minutes still are not chained.** `/build` points at `/sources` when a prerequisite is missing rather than doing it. Connect → sync → analyse → build → first answer is still four manual navigations.

### Modify / delete / add
- **Add:** an impact check before rebuild, from data already stored.
- **Add:** column descriptions to the snapshot — the Catalog is the only place they can be authored and a rebuild throws them away.
- **Add:** chain the first run.

---

## 9. Adapting subjects

### What a user wants
"This is nearly right. Change it by telling it what I mean."

### What we have — eight doors to one job

| # | Path | Reachable? | Role | Register |
|---|---|---|---|---|
| 1 | Build chat → `build-chat` + `bus-matrix/extend-start` | ✅ `/build` | admin+analyst | plain language, additive, safe |
| 2 | RefineChat → `:id/refinements` + approve/reject/preview | ✅ Manage mode | admin+analyst | plain language, proposal → approve |
| 3 | AskAIPanel → `products/refine` + `refine/apply` | ⚠️ mounted, **404s** | any | plain language, metadata only |
| 4 | Per-table SQL cells → `tables/:id/cells/*` + deploy | ✅ Manage mode | admin+analyst | raw SQL, notebook |
| 5 | `PUT tables/:id/sql` | ✅ ManageTables | admin | raw SQL, direct |
| 6 | `propose` / `propose-single` / `propose-stream` / `build-proposed` | ❌ **no caller** | admin | — |
| 7 | `:id/design` / `:id/design-stream` | ❌ **no caller** | admin | — |
| 8 | Rebuild from `/build` | ✅ | admin+analyst | retire-and-replace |

**Three of the eight are dead code.** `propose-single`, `propose-stream`, `propose`, `build-proposed`, `design-stream`, `design`, `bus-matrix-stream`, `build-bus-matrix`, `tables/:id/approve`, `tables/:id/load-mode` and `columns/:columnId` have **zero frontend callers** (verified by grep across `frontend/`). That is several hundred lines of authoring surface in `routes/products/build.ts` and `design.ts` that can only be reached with a REST client.

**One of the eight is broken.** `AskAIPanel` — the "Ask AI to change it" panel, mounted from both `/products` and `ProductRootPanel:681` — calls `/api/products/refine`, `/api/products/:id/refine` and `/api/products/:id/refine/apply` (lines 139, 142, 189). Same doubled-prefix bug as §3(a). Every request 404s. The panel renders, accepts input, and reports "Something went wrong."

**Two more are silently degraded.** The RefineChat **preview** and the per-table **cell execute** both build their session through `buildConnectionWarehouseSession`, which passes `tenantId: undefined` (`services/productWarehouse.ts:39,43`) — so under RLS they register zero views and every preview/execute fails with "table does not exist", racily (see §4(a)).

**Net:** of eight ways to adapt a subject, **two work reliably** (the Build chat and the RefineChat approve path), and the two that work are in different places, use different vocabularies and cannot see each other's history.

### Modify / delete / add
- **Delete:** the four dead authoring paths and their prompts. They are not "not yet wired" — `propose`/`design` predate the bus-matrix flow and were superseded by it.
- **Modify:** the three broken paths (7 path characters + 6 tenant arguments).
- **Modify — the real one:** there should be **one** conversation about a subject, not two. The Build chat ("what is covered, add something") and the RefineChat ("change this subject") are the same conversation at different scopes. Merge them into one assistant that is available from the topic page, knows which subject it is in, and can both refine and extend.

---

## 10. When a question needs a field the subject does not carry

This was the owner's ninth question, and it is the one the platform has **no mechanism for at all** — not a missing screen, a missing model.

### What exists today
1. **A checkbox.** `Query source data` (`frontend/app/query/page.tsx:1602-1611`) — admin+analyst only, unlabelled beyond three words, no explanation, no indication of when to use it. Ticking it sends `dataLayer: 'source'`, which `layerForRole` honours for curators and ignores for viewers (`routes/query.ts:61`). A viewer simply gets a worse answer with no way to know why.
2. **A confidence gate.** Below 0.70 the query is blocked and a gap is logged (`routes/query.ts:102-116`, `355-388`). The gap is a **free-text description**, deduped by ≥2 words of keyword overlap.
3. **A gaps page** whose only two outcomes are *"Fix & verify"* (save the SQL as a verified question) and *"Mark resolved"* (`frontend/app/gaps/page.tsx:114-148`). Neither changes the subject.

### Why none of it works

**Nothing in the platform reasons at column granularity about coverage.** `buildCoverageContext` — the context behind the Build chat, the only place a human can talk about what a subject contains — is built entirely from **table** names, row counts and `used by: Sales` / `not part of any subject yet` (`services/buildChatContext.ts:131-136`). It contains **no columns at all**. So when a user asks the Build chat "can I see the customer's VAT number?", the assistant does not know whether `vat_number` exists in the source, whether it is already in the subject, or which table it would go on.

The same blindness runs through everything: the entity pre-flight checks string **values**, not columns; the gap record is prose; the confidence gate reports a number, not a missing field.

**So the actual user journey today is:** ask → get a vague or blocked answer → no explanation → (if admin) discover the checkbox → get an answer from raw source tables in the source system's own naming → and **no path back**: nothing captures "this question needed a field the subject lacks", nothing proposes adding it, nothing tells the person who could.

### What to build — and this is the recommendation the review most wants to make

This is the loop that would genuinely differentiate Clarion. Every competitor can answer a question. **None of them can say "I could not answer that because your Sales subject does not carry VAT number — shall I add it?" and then do it.** The pieces are all here; they have never been connected.

1. **Give the platform column-level coverage.** For each subject: which source columns feed it, and which of its source tables' columns do *not*. `column_lineage` already stores the first half (`services/lineageDerivation.ts` derives it deterministically at build time). The second half is one query.
2. **Detect the miss.** When a question mentions a term matching a source column that is *not* in the resolved subject, that is a specific, actionable diagnosis — far better than a confidence score. Emit it as a first-class outcome alongside `clarify` and `blocked`.
3. **Answer it anyway, honestly.** Auto-fall back to the source layer for that one question with an explicit line — *"Your Sales subject does not carry VAT number, so I answered from the raw Exact Online data. This has not been checked the way your subject has."* That is strictly better than today's silent checkbox, and it works for viewers, who currently get nothing.
4. **Close the loop.** One button: **"Add VAT number to Sales."** It routes to the extend flow that already exists (`bus-matrix/extend-start`), scoped to one column. For a viewer it files a request to the curator instead.
5. **Feed the gap record.** Store the missing column, not prose, so `/review` becomes a ranked list of "the fields your team keeps asking for".

Steps 1–3 are the slice worth doing first: they turn the most common failure in the product from a dead end into a diagnosis, and they need no new authoring surface.

---

## 11. Cross-cutting defects found (evidence)

| # | Defect | Evidence | Impact |
|---|---|---|---|
| D1 | 7 frontend call sites double the `/api` prefix; 374 do not | `EmailSchedulePanel.tsx:51,78,101,111,120`; `AskAIPanel.tsx:139,142,189` vs `lib/api.ts:6` | Dashboard email schedules and the "Ask AI to change it" panel 404 on every request |
| D2 | Warehouse catalog read with `tenantId: undefined` at 6 sites | `notebooks.ts:78,95`; `productWarehouse.ts:39,43`; `cells.ts:299,300` → `tenantQuery.ts:26-28` | Notebooks, refinement preview and per-table SQL cells register zero tables under RLS, racily |
| D3 | Topic → Ask AI passes `productId` without `connectionId` | `TopicLayer.tsx:36-47` vs `query/page.tsx:369-380`, `productContext.ts:121-132` | A subject's question can silently run against a different source, on the source layer |
| D4 | Ask AI's connection is never rendered | `query/page.tsx:69-70` (declared, never used in JSX), fallback `:912` | The user cannot see or change the most consequential state in the product |
| D5 | ~4 authoring paths with zero callers | `products/build.ts` propose*/build-proposed/bus-matrix-stream/build-bus-matrix; `design.ts` design/design-stream; `tables.ts` approve; `build.ts` load-mode; `tables.ts` columns/:columnId | Several hundred lines of unreachable, unmaintained AI-calling surface |
| D6 | Notebooks see neither grids nor rollups | `notebooks.ts:51-104` vs `ConnectorFactory.ts:188-208` | The escape hatch is less capable than the front door |
| D7 | Confirmed cross-source matches reach only the source-layer prompt | `getMatchAssertions` called once, `semantic.ts:710`; absent from `productContext.ts` | Matching is a measurement toy; nothing downstream can act on it |
| D8 | `morning_briefs.emailed_at` written nowhere | migration 48; `grep emailed_at backend/src` | The brief never leaves the app — combined with D1, no working outbound channel exists |
| D9 | Rebuild has no impact check, though the data exists | `busMatrixBuilder.ts:513-516`; `saved_questions.tables_used`, `dashboards.ts:2757` | A rebuild can silently break dashboards and saved questions |
| D10 | Column descriptions are not in the rebuild snapshot | `busMatrixBuilder.ts:412-437` | The Catalog is the only place to author them and a rebuild discards them |

D1–D3 are user-visible today. D1 and D3 are one-line fixes each.

---

## 12. What to do, ranked

**Tier 0 — the five one-liners (hours).** Fix D1 (7 paths), D2 (6 tenant arguments), D3 (one query param). Two shipped features start working, three surfaces stop failing racily, and the platform's headline flow stops cross-wiring. Nothing here needs a design decision.

**Tier 1 — make the Subject the unit of work (days).**
- A **Subject picker** in Ask AI's composer, replacing the invisible connection. Sets `productId` and derives `connectionId`.
- **One warehouse session builder.** Collapse the four into `createProductConnector`; notebooks and previews inherit grids and rollups for free.
- **Delete** the four dead authoring paths (D5).
- **Merge** the Build chat and the RefineChat into one subject conversation, reachable from the topic page.

**Tier 2 — the loop nobody else has (a slice).** §10 steps 1–3: column-level coverage, missing-column detection, and an honest automatic source-layer fallback with a plain-language explanation. Then step 4, the one-button extend.

**Tier 3 — make it arrive (a slice).** Send the brief (D8). Thresholds on a KPI. A share link. Lead Home with the brief and demote the health ring to Studio.

**Tier 4 — un-scope the query layer (the real project).** Replace connection-scoping with an explicit subject scope; decide the CSV-vs-grid question; feed matches to the product layer. This is P7 of the overview and it is a genuine architectural change — but it is *one* change, and grids already prove the rest of the stack works tenant-wide.

**Explicitly do not do:** do not add a sixth AI assistant panel (there are five: Ask AI, the dashboard assistant, the notebook assistant, the Build chat, the RefineChat — plus the broken AskAIPanel). Do not build cross-source before Tier 0, or the bugs will be blamed on it. Do not delete Notebooks. Do not rebuild the answer card — it is the best thing in the product.

---

## 13. Honest limits of this review

- Nothing was run against a live tenant. D2's severity in particular depends on pool behaviour at runtime: the session-level `SET` at `middleware/auth.ts:176` means it may work intermittently rather than never. **The one production check that settles it:** open a notebook and expand the schema explorer — an empty tree is the signature.
- D1 is asserted on the code alone. It is airtight in the sense that the two conventions cannot both be right and 374 sites disagree with 7 — but which side is broken depends on the value of the `PROD_API_URL` secret, which is not readable from here. If that secret does *not* end in `/api`, then the 374 are broken instead, which would be a much larger incident.
- Endpoints were classed "dead" by grepping the frontend. An external caller (the Excel add-in, an API token holder, a script) would not show up — though none of these is documented as public.
- No competitor was re-benchmarked; the market claims in §2 and §10 rest on `clarion-vs-peliqan.md` and the Ask-AI assessment.
