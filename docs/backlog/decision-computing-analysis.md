# Decision Computing vs Clarion — is this our space, and what should we take?

**Date:** 2026-08-28 · **Status:** analysis, no code changed
**Subject:** https://decisioncomputing.ai/
**Method:** the site is blocked by this session's egress proxy, so their content
was reconstructed from indexed search results across their homepage, `/about`,
`/pricing`, `/use-cases`, `/insurance`, `/bid-management` and six posts under
`/news` — quoted phrases below are theirs, sourced from those pages. The Clarion
side is verified against the code on this branch, with file paths, not against
CLAUDE.md.

---

## 0. The one-sentence verdict

**Decision Computing is not a competitor. It is the other half of the same
sentence.** Clarion answers *"what is true about my business?"*; Decision
Computing does *"now go and do the work."* They share a technical substrate
(DuckDB, lakehouse, LLM-over-enterprise-data, lineage-and-audit as a first-class
feature), they share a market thesis (**the domain expert, not the engineer,
should own the AI**), and they have independently arrived at almost the same
trust vocabulary — their homepage says *"Every decision is traceable and
correctable"*, which is a fair description of Clarion's repair loop, review
queue and Verified tier. They differ on the axis that decides everything else:
**Clarion produces understanding; they produce throughput** — and Clarion sells
to a 20-person Belgian SMB while they sell up to 200 seats and 750 workflows.

There is exactly one square of real overlap: their **"Data & analytics"** use
case is Clarion's entire product. Everything else they sell, Clarion does not
do at all. Everything Clarion does upstream — connect an ERP, profile it,
derive a star schema, conform dimensions, hand a business user a topic — they
do not appear to do at all.

So: **not the same offering, same neighbourhood, and worth reading closely** —
because several things they say out loud are things Clarion's own backlog has
already independently concluded, and two of them are gaps Clarion has never
named.

---

## 1. What Decision Computing actually is

**Company.** San Francisco, ~5 employees, backed by Array Ventures and
Syndicate One. Early stage. Tagline: *"the future of work in the agentic era"*;
sub-line *"Trustworthy decisions with AI agents."*

**The product, in their words.** *"Connect your data, automate, monitor and
improve any workflow in one simple workspace."* It is an **agentic workflow
automation platform for enterprise knowledge work**, whose stated goal is to
*"scale productivity 1000x"*. Non-technical users *"create powerful AI agents
using simple drag and drop"*. Workflow inputs *"progress through a series of
analytic, traditional machine learning and agentic LLM-based steps"* — you can
drag in *"classification or clustering"* alongside LLM steps.

**Four pillars they keep returning to:**

1. **Retrieval over everything.** Their loudest technical claim. *"RAG is
   dead! Long live RAG!"* — the 2020–24 embed-and-fetch-a-chunk version is
   dead; what replaces it is a **hybrid search layer** using *"semantic,
   full-text, and advanced SQL queries across structured catalogs,
   unstructured documents, images, audio, and video"*, driven by an
   **agentic search engine** — *"orchestrated by a dedicated sub-agent that
   decides what to search for and how, and infers which queries can be run in
   parallel and which ones are sequential."* Agents *"reason over all data
   types — tables, text, images, documents, spreadsheets and audio."*

2. **Production-grade execution, not prototype.** Their explicit contrast with
   OpenAI's Agent Builder: *"transactional processing of workflows with retry
   over failures"*, *"replays of previous data through the same workflow"*,
   *"auditing of workflow outputs"*, and **time-travel** — *"instantly
   reconstruct the exact state of workflows and data at any point in the
   past"*. Stack named: **DuckDB for in-memory analytics, Arrow, lakehouse,
   Kafka.**

3. **Monitoring by domain experts, with a root-cause agent underneath.**
   Analytics is *"embedded directly into the workflow builder, since domain
   experts creating agentic workflows are best positioned to monitor
   performance."* Business metrics are *"defined by domain experts"* (their
   insurance example: claim payment amounts, claim types, fraud indicators).
   When a metric deteriorates, *"a dedicated root-cause analysis agent is
   triggered to investigate underlying data in real-time"* — and in insurance
   it *"monitors portfolios 24/7 and identifies the key drivers behind loss
   ratios in real-time."*

4. **A closed improvement loop with a number on it.** *"The iteration and
   improvement layer pushes accuracy from 95% to >99%, which can be the
   difference between manually inspecting every output and running agents
   autonomously at scale."*

**Where they sell it.** Verticals — **insurance** (submission/claims/policy
extraction, underwriting, loss-ratio monitoring) and **bid management / RFQ**
(retrieve requested items from catalogs, find substitutes, apply the customer's
contract terms and discounts, draft the response email with a quote *"in any
bespoke template"*). Horizontals — data & analytics, finance, operations,
pre-sales.

**Pricing.** Tiered, *"flexible plans for every business"*; the enterprise tier
is **up to 200 seats, up to 750 workflows**, custom templates, optional
on-premise, API access. Priced by *workflows*, which tells you what the unit of
value is.

**Their own five open problems for 2026** (from `/news/agents-in-2026`), which
is the most useful paragraph on their site:
holistic retrieval across *"inboxes, files, databases or the web"*; **hybrid
deterministic-AI workflows**; **durable execution** (agents that pause for
input and *"pick up where they left off"*); **evaluation shifting from data
scientists to domain experts**; and multi-agent orchestration / parallelism /
agent UX.

---

## 2. Are we in the same space? Three answers, because it's three questions

### Same substrate — yes, strikingly

Both bet on DuckDB over a lakehouse rather than a cloud warehouse. Both treat
**lineage and auditability as product, not compliance** — their *"inspect and
audit every step your agents take"* is Clarion's `column_lineage`,
`LineageGraph`, the receipt line under every answer, and
`product_table_refresh_history`. Both run an **LLM over a governed semantic
description of enterprise data** rather than over raw schemas. Both insist a
**non-engineer owns the definitions**.

Clarion is, if anything, further along on the trust substrate: per-tenant RLS
that is actually enforced, per-tenant AI token budgets (`services/aiBudget.ts`),
a measured-not-asserted relationship layer, a semantic provenance ladder
(`docs > curated > ai`) that refuses to guess when two candidates tie, and — not
in CLAUDE.md — an AI router (`services/ai/router.ts`) that classifies every call
as `kind: 'row' | 'schema'` and can divert row-touching calls to Azure OpenAI per
tenant. That is a data-residency story an EU SMB buyer will ask for and Decision
Computing does not appear to advertise.

### Same job — no, and the difference is the whole thing

| | Clarion | Decision Computing |
|---|---|---|
| Unit of value | an **answer** / a **topic** | a **workflow run** |
| What it changes | what you *know* | what gets *done* |
| Output | a number, a chart, a narrative | a drafted quote, a processed claim |
| Data | tabular only, from an ERP | tables + text + docs + images + audio |
| Substrate work | **builds** the model (profile → star schema → conformed dims) | **consumes** whatever you connect |
| Who authors | Clarion authors the model; user confirms | user drags the workflow together |
| Buyer | SMB owner / office analyst | enterprise ops or line-of-business lead |
| Scale sold | one company, a handful of seats | 200 seats, 750 workflows |

The asymmetry that matters: **Decision Computing assumes the data problem is
solved and sells the doing. Clarion solves the data problem and stops at the
knowing.** An SMB running Exact Online has neither a data team nor a workflow
backlog worth 750 entries — which is why they are not chasing Clarion's
customer, and why Clarion cannot become them by adding a canvas.

### Same neighbourhood — yes, and it's converging

Their *"root-cause analysis agent"* and Clarion's `investigateService.ts` are
the same idea built twice. Their *"metrics defined by domain experts, monitored
continuously, investigated automatically when they move"* is precisely
Clarion's **pulse → morning brief → investigate** chain, drawn as a finished
loop. Theirs runs 24/7 and pushes; Clarion's is three separate features and the
loop is open at both ends.

---

## 3. The mirror: what they say that Clarion has already concluded

This is the reason to read them rather than dismiss them. Four of their five
stated 2026 problems are things Clarion's own backlog already says, in almost
the same words:

| Their 2026 problem | Clarion's own prior finding |
|---|---|
| *"Hybrid deterministic-AI workflows"* | The single most-repeated lesson in this repo: connector star-schema templates beat the AI designer; lineage is **derived** from SQL, not asked of a model; FK endpoints are **measured**, not guessed; `synthesizeFkRelationships` is deterministic. Clarion is *ahead* of them here. |
| *"Evaluation shifts to domain experts"* | The Verified saved-question tier, the AI review queue, `👎 → Fix & verify → curation`, human-edit survival via snapshot-and-merge. The machinery exists — **the measurement doesn't** (see §4.3). |
| *"Durable execution — agents pause and resume"* | BullMQ + SSE + reattach + cancel already do this for *builds*. Nothing does it for *reasoning*. |
| *"Agent UX"* | The Ask AI worksheet shipped this week — steps as a tree, frozen snapshots, assumption chips as controls, explicit re-run — is a serious answer to exactly this, in the analytics domain. |
| *"Holistic retrieval across inboxes, files, databases, the web"* | **No prior finding. This is a blind spot.** |

Two of their claims are things Clarion has *not* said, and both are real:
**everything-retrieval**, and **an accuracy number you improve on purpose**.

---

## 4. What Clarion is missing, seen through this lens

Verified against the code on this branch.

### 4.1 Unstructured data: total absence — and it is the biggest one

There are **no embeddings, no vector store, no full-text index, and no
document, PDF, image or email ingestion anywhere in the repo.** The connector
package holds exactly two connectors (`packages/connectors/src/exactonline`,
`.../odoo`) plus legacy direct-DB drivers; everything lands as Parquet columns.
`xlsxBuilder.ts` *writes* spreadsheets; `lib/xlsxRead.ts` reads one in the
browser — as rows, into a grid. There is **no file upload of data at all** on the
backend: no `multer`, no OCR, no chunking, no extraction. The connector type
system even declares a `binary` class (`packages/connectors/src/columnTypes.ts`)
that nothing ever reads.

Why this matters more for Clarion than it looks: the SMB questions Clarion
currently *cannot* answer are not exotic. *"Why is this invoice disputed?"*
lives in an email. *"What did we agree with this customer?"* lives in a PDF
contract. *"What did the supplier actually quote?"* lives in an attachment.
Clarion has a beautiful answer for every question whose answer is already a
number in Exact Online, and no answer at all for the ones that aren't — and the
second kind is where the owner's actual uncertainty lives.

Their framing is the useful one: retrieval is not a chunk store bolted on, it's
a **search layer that spans the structured catalog and the documents at once**,
with the agent deciding which instrument to use. Clarion already owns the
structured half properly. It owns none of the other half.

### 4.2 Clarion still never *does* anything

Clarion's own gap analysis said it in June: *"Clarion describes what happened
but never tells anyone what to do."* Two months later the outbound surface is
still: render on a screen; write an in-app notification; and email a report or a
saved question **that a human explicitly scheduled**. `morning_briefs.emailed_at`
exists in migration 48 and is **still never written** — the daily brief is
generated by a scheduled job and dies inside the app. `services/pipelineService.ts`
is data-refresh orchestration (sync sources → transform products), not business
workflow.

The absence is structural, not incidental: **the `SourceConnector` interface has
no write verb.** `packages/connectors/src/types.ts` exposes `testConnection`,
`listEntities`, `sync`, `getKnownRelationships` — and nothing else. There is no
create, update or delete against a source system anywhere in the codebase, and no
outbound call to any system Clarion does not own. Nothing creates a task, writes
to a CRM, or drafts anything for a human to send.

This is not "Clarion should become a workflow tool." It is that between *"here
is the answer"* and *"do the work for me"* there is a step Clarion has skipped:
**the answer that arrives, addressed to someone, with the next action attached.**
Their RFQ example — retrieve, apply the terms, draft the email — is the shape;
the SMB-sized version is *"these 6 invoices are 30+ days late; here are the
chase emails, ready to send."*

### 4.3 There is no evaluation layer at all

Search the repo for eval, golden, benchmark: **nothing**. Clarion has an
extraordinary amount of *correctness machinery* — a repair loop, entity
pre-flight, `validateAndRepairSpec`, widget column contracts, containment
measurement, eight lint ratchets, 408 tests — and **not one number describing
how often the AI is right.** Every quality claim in this repo is anecdotal
("the repair loop was verified end-to-end in prod on a live wrong answer").
The dashboard plan has carried *"VisEval-style eval harness"* as open for
months.

Their *"95% → >99%, which is the difference between inspecting every output and
running autonomously"* is the argument for closing this. Clarion has the raw
material nobody else has: `query_log`, `definition_gaps`, thumbs-up/down with
comments, `saved_questions.verified`, and now `conversation_messages.meta`
holding the assumptions and the repair trail of every answer ever given. **A
golden set is sitting in the database, unassembled.**

The thumbs make the point sharply. A thumbs-down writes `feedback`,
`feedback_comment` and `feedback_at` to the message and files a definition gap
(`routes/conversations.ts`) — and **nothing ever reads it back**. No prompt is
adjusted, no answer is retrieved, no metric moves. The strongest loop Clarion has
is the opposite extreme: a *verified* saved question bypasses the model entirely
on an exact match (`routes/query.ts`). Between "bypass the AI" and "file a
ticket" there is no middle — and the middle is where an accuracy number lives.

This is the highest-leverage item in this document, and the cheapest.

### 4.4 The proactive loop is built in three pieces and connected in none

`morningBriefService.ts` (416 lines) runs daily via a repeatable BullMQ job.
`pulseService.ts` (345 lines) stores per-user watch entries **with a
`sensitivity: 'low' | 'medium' | 'high'` field whose own header comment says
*"push alerts fire on pulse entries when sensitivity threshold trips"*** — and
nothing fires. `investigateService.ts` is a genuine 6-step agent loop
(`MAX_STEPS = 6`, plan hypothesis + SQL → execute → find → decide) and its
**only caller is an HTTP route** (`routes/investigations.ts`) — a human must
click it.

Quality alerts have the same shape and the same gap: `checkAndCreateAlerts`
fires only **inside a profiling request** (`routes/quality.ts`) — nothing
schedules it — and its output is an in-app notification row. And every proactive
job in the product is a BullMQ repeatable: **with Redis unconfigured, none of
them run at all.**

So Clarion already has all three components of their headline insurance
feature — *metric watch → deterioration → automatic root-cause agent* — and has
never wired them into a sequence. This is not a build; it's a join.

### 4.5 No tool-use anywhere

`grep` for `tool_use`, `tool_result`, `input_schema`, `tools:` across
`backend/src`, `packages`, `worker` and `etl` returns **zero hits**. All ~45 AI
capabilities run through six `messages.create` / `messages.stream` call sites in
`AIService.ts`, none of which passes a `tools` param; the SDK is pinned at
`@anthropic-ai/sdk ^0.39.0`, and the one structured-output path
(`output_format: json_schema`) is env-gated **off** by default and only ever
used for the dashboard spec. Everything else is prompt → text → strip fences →
`parseJson` → Zod, with a bracket-balancing salvage routine for truncated
output. The investigate loop and the repair loop
are hand-rolled multi-turn loops where the model returns JSON describing what it
wants and Clarion executes it.

This is a defensible choice — it is more auditable than tool-use, and it is why
`assertSafeReadQuery` can sit between every model output and the database. But
it caps what an agent can do at *"one SQL query per turn, chosen from a menu the
prompt describes"*. Their *"sub-agent that decides what to search for and how,
and infers which queries can run in parallel"* is not reachable from that
architecture. If Clarion ever wants an agent that consults the catalog, then the
warehouse, then a document, then re-plans, the model needs real tools with real
schemas.

### 4.6 Their two lesser ideas Clarion should note

- **Replay / time-travel.** Clarion has this for *data* (Delta versions,
  `product_table_refresh_history`) and, as of this week, for *answers* (frozen
  step snapshots with `data_as_of`). It does **not** have it for *AI decisions*:
  you cannot re-run last month's answers against today's prompts to see what
  changed. That is the same artefact as the eval harness, viewed from the side.
- **Analytics embedded in the authoring surface.** Their argument — the person
  who defined the metric is the right person to watch it — is Clarion's Build
  chat and Manage mode, minus the watching.

---

## 5. What to incorporate — ranked, with the cheapest first

**1. An evaluation harness and one accuracy number.** (Small. Do it next.)
Assemble a golden set from `saved_questions.verified` + thumbs-up answers +
every question that survived a repair; replay it nightly against the current
prompts; report *answered / correct / repaired / refused* per release. Nothing
else on this list can be judged without it, and it turns "the AI is good" into a
number that can go up. Their 95→99 framing is the right frame.

**2. Close the pulse → alert → investigate loop.** (Small–medium. Highest
user-visible payoff.) Every part exists. Give `sensitivity` a real threshold,
have the morning-brief job compare each pulse entry against it, and on a breach
call `runInvestigation()` — the same function the route calls — and put the
finding in the brief. Then **write `emailed_at`** and let the brief leave the
app. That single chain converts Clarion from pull to push and gives it their
insurance headline feature at SMB scale.

**3. The answer that arrives with an action attached.** (Medium.) Not workflow
automation — one step past the answer. An exception list ("6 invoices 30+ days
late") with a drafted, human-approved artefact (the chase email, the reorder
list as a spreadsheet, the follow-up task). Keep the human on the send button;
that is both the honest position and the SMB-safe one.

**4. Documents as a second data type.** (Large, and the strategic one.) Start
narrow and deterministic, in the house style: **one source, one shape** — PDF
invoices or contracts attached to entities Clarion already models — so a
document is *linked to a customer/invoice row*, not floating in a vector soup.
Then a retrieval step the existing agents can call. Their *"hybrid search:
semantic + full-text + SQL over one catalog"* is the right target architecture;
Clarion's advantage is that its structured half is already governed, so
retrieval can be **scoped by the semantic layer** rather than competing with it.
Note this also unlocks the Belgian Peppol angle already sitting in the gap
analysis.

**5. Real tool-use for the two agent loops.** (Medium.) Convert
`investigateService` and the repair loop from hand-rolled JSON protocols to
Anthropic tool-use, with `assertSafeReadQuery` moved inside the tool
implementation so nothing is lost. This is a prerequisite for #4 (an agent that
chooses between "query the warehouse" and "search the documents") and it makes
parallel steps expressible.

**6. Replay of AI decisions.** (Falls out of #1 for free once the harness
exists.)

---

## 6. What NOT to take from them

- **Do not build a drag-and-drop agent canvas.** It is right for a 200-seat
  enterprise with an ops team and wrong for a 20-person SMB, and it contradicts
  this repo's own standing rule (`ask-ai-experience-assessment` §7: *"Don't
  build a wizard or multi-pane agent workspace"*). Clarion's bet is that the
  product already knows what to do; a canvas is an admission that it doesn't.
- **Do not chase their verticals.** Insurance underwriting and RFQ response are
  enterprise knowledge-work processes. Clarion's vertical is the Belgian SMB's
  whole business, across sources.
- **Do not adopt "all data types" as a slogan.** Audio and video are
  irrelevant to this customer. Documents are not.
- **Do not loosen the SQL guard or the semantic layer to make agents freer.**
  The reason Clarion can put an LLM in front of a customer's ledger is that
  everything the model emits is gated. Tool-use should move the gate, never
  remove it.
- **Do not read their "1000x productivity" as a target.** Clarion's value is
  measured in decisions made correctly, not tasks processed.

---

## 7. The strategic read

Decision Computing is a useful mirror precisely because it is *not* a threat:
it makes visible the thing Clarion has been circling for months. Clarion's
engine is genuinely ahead of its surface — that was the Ask AI assessment's
verdict in June and it is still true — but the deeper version is that **Clarion
is ahead of its own ambition.** It has an agent loop, a trust ladder, a
correction loop and a proactive skeleton, and it uses all of them to render a
page.

The three moves that follow from this analysis are, in order: **measure whether
the AI is right; let the answer arrive instead of waiting to be fetched; and
give the answer somewhere to go.** Documents are the fourth, and the one that
changes what kind of product Clarion is.

None of that requires becoming Decision Computing. It requires finishing the
sentence Clarion already started.
