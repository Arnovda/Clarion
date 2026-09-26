# Beyond the tables: what Clarion should add next

> **Status:** research and recommendation. No code has changed. Written 2026-09-26.
>
> **The owner's question:** *"Check the capabilities of Clarion thoroughly. I think the basics are right. What other requirements or capabilities do we need to think of in such a platform? Maybe add documents as context, or emails, or something else? See what Clarion can already do, and what else we can add to become a platform businesses really need."*
>
> **How this was done:**
> - **Code audit.** Every capability claim was checked against the code, not against CLAUDE.md, with file:line evidence (§1).
> - **Two market scans:**
>   - how the leading AI/BI platforms combine tables with documents, email and other text;
>   - what SMB owners, finance leads and their accountants actually pay for in 2025–26.
> - **How to read the evidence:**
>   - Each external claim is labelled **evidence** (a regulator, benchmark or filing) or **vendor** (marketing).
>   - Some pages were blocked by this environment's egress proxy: nbb.be, fathomhq.com, blog.xero.com, thoughtspot.com, databricks.com/blog and arxiv.org. Claims about those rest on search snippets, and say so.
>
> **Relation to earlier documents:**
> - This is the successor to `functionality-gap-analysis.md` (2026-08-21) and does not replace it.
> - §2 records what has shipped since that document and what has not.

---

## 0. Verdict

**The basics are right.** The owner's instinct holds: Clarion's engine is ahead of most of its market. It turns an ERP into a governed star schema, answers questions with visible trust signals, keeps a real glossary, and runs an investigation agent. Exact Online still labels its own analysis agents *beta*.

**The instinct about documents and email is half right.** Split it three ways:

1. **Company knowledge as text: yes, and it is the cheapest high-value addition available.** Clarion has nowhere to write down things like:
   - "our fiscal year starts in April";
   - "a key account is anyone above €50k";
   - "prices went up 8% on 1 July";
   - "the Antwerp warehouse closed in March".

   Every leading platform now has this layer (Databricks, Power BI, Snowflake, Omni, Hex). None of them uses a PDF as the rulebook: it is short, curated, owned text.
2. **Documents as data: later, and narrowly.** A contract becomes a row (counterparty, value, renewal date, notice deadline) that a person confirms. It is then answered through the normal SQL path. **Chat over PDFs is not the goal.** Mixed document-plus-SQL answering scores roughly 30–40% on 2025–26 enterprise benchmarks (§3.3), while Clarion's whole promise is trust.
3. **Mailboxes: no.** Scanning employee mail runs into:
   - Belgian GDPR enforcement and CAO/CCT nr. 81 (the Belgian collective agreement on monitoring employees' electronic communications);
   - prompt-injection risk;
   - no evidence of value.

   **Email as a delivery channel is the opposite: it is the most important thing Clarion is missing.** The morning brief is still never sent: `morning_briefs.emailed_at` exists and nothing writes it.

**The larger point, and the honest part.** The ideas that make Clarion a platform businesses *need* are mostly not about new inputs. They are about where an answer goes and what it makes someone do:
- a brief that arrives;
- a threshold that fires;
- a target to be behind;
- a forward view of cash;
- an accountant who sees which of their 200 clients needs a call;
- an MCP endpoint, so the customer's own Copilot or Claude can use Clarion's numbers.

The 2026-08-21 gap analysis said this, ranked it first, and called it one release ("Clarion comes to you"). **Since then, five weeks of work went into curator surfaces** (the coworker, the Catalog workspace, keys, lineage). That work is good. But the push loop that a business owner would feel is still unbuilt. **That should change before anything in this document starts.**

---

## 1. What Clarion can do today (checked against the code)

### 1.1 Strong: the parts to protect

| Area | What exists |
|---|---|
| Sources | Exact Online, Odoo, Postgres, MySQL, SQL Server, CSV, Excel upload, SharePoint (workbooks). Source packages hold the vendor's own documentation as data. |
| Model | AI or template-designed star schemas; stable `clarion_key` keys; shared lookups; column-level lineage; the Relations canvas with measured joins. |
| Semantic layer | Glossary with links into the model; KPIs with formulas; verified saved questions (approved SQL reused verbatim); vendor notes; the provenance ladder. |
| Ask | Plain-language answers with trust marks, self-repair, clarifying questions, cross-source (opt-in), forecasting (linear or moving average), worksheet steps. |
| Push, partly | Pulse watchlists, a daily brief with an overnight "why", scheduled dashboard and saved-question emails, freshness and sync-failure notices. |
| Planning, partly | Managed grids ("Your tables") with a `budget` kind, joinable in Ask AI and dashboards. |
| Govern | Row filters and column masks on every read path; audit trail and CSV export; MFA and passkeys; tenant export; AI can be switched off per tenant. |
| Reach, partly | Excel add-in on personal API tokens (three read-only endpoints). |

### 1.2 Absent or partial: verified gaps

| Capability | Status | Evidence |
|---|---|---|
| Documents (PDF/DOCX/TXT), embeddings, retrieval | **Absent** | No parser, no vector store. Uploads accept `.xlsx`/`.csv` only (`frontend/app/sources/add-source/page.tsx:929`). SharePoint reads workbooks only (`packages/connectors/src/sharepoint/entities.ts:37`). |
| Free-text company knowledge or AI instructions | **Absent** | The glossary (term + meaning), KPI descriptions and table descriptions are the only places. There are no tenant-level or subject-level instructions. |
| Inbound email | **Absent** | No IMAP, Gmail or Graph mail code. |
| Brief delivered by email | **Absent** | `morning_briefs.emailed_at` (migration 48) is written nowhere. The brief is an in-app notification only (`morningBriefService.ts:456`). |
| User thresholds and anomaly detection | **Partial** | Pulse has three fixed bands: any change, ±5%, ±10% (`morningBriefService.ts:400-403`). No user-set value, no seasonality. The header of `pulseService.ts` says "push alerts fire". None do. |
| Targets / budget vs actual | **Partial** | No target on a KPI (`product_kpis` has no target column). Budgets live in grids but nothing compares them. |
| Forward view (cash, AR aging) | **Absent** | `forecastEngine.ts` extrapolates history. There is no roll-forward of open items by due date. |
| Comments, @mentions, share links, Slack/Teams | **Absent** | Sharing is only within a tenant (`dashboards.is_shared`). |
| MCP / public API | **Partial** | API tokens reach `/api/addin` only. MCP is named in comments as "the next caller" (`routes/addin.ts:11`). |
| SSO (Entra/OIDC/SAML), SCIM | **Absent** | Email and password, plus MFA and passkeys. |
| Mobile / PWA, NL/FR interface | **Absent** | No manifest or service worker. English UI, `nl-BE` number formatting. |
| Accountant portfolio (one user, many tenants) | **Absent** | `users.tenant_id NOT NULL`, no membership table. |
| Actions / writeback | **Absent (correct)** | Connectors are read-only by construction. |
| OCR / vision / audio / transcripts | **Absent** | — |

---

## 2. What changed since the 2026-08-21 gap analysis

**Shipped:**
- **G5** spreadsheets: Excel, CSV, SharePoint and managed grids.
- **G14** saved and verified questions with schedules.
- **G10** Investigate on the rail.
- **G16** cross-source questions, first half: opt-in scope with the collision rule. The identity crosswalk is still open.

**Still open, in the same ranked order:**
- **G1** push loop: the brief is not emailed and there are no thresholds.
- **G2** mobile.
- **G3** exception lists and forward view.
- **G4** targets.
- **G6** share links and PDF pack.
- **G8** NL/FR.
- **G12** portfolio tier.
- **G13** comments.

**Why this matters.** Everything in §4 builds on those open items. A "company notes" layer makes a better brief, but only if the brief reaches someone. An MCP endpoint makes numbers reachable, but only if the numbers can be compared to a target.

---

## 3. The owner's two ideas, examined

### 3.1 Documents as context: split into three separate things

**(a) Company knowledge: yes. Call it *Company notes*, or *guides* in the market's term.**

This is what "documents as context" usually *means* when a business says it. Examples:
- "We report revenue excluding intercompany."
- "Fiscal year starts 1 April."
- "Segment A = customers with more than 3 orders a year."
- "Returns are booked in journal 70."
- "The price list changed on 1 July."

The market has converged on one shape (evidence: vendor docs, but the shape is consistent across all of them):
- **Databricks Genie:** text instructions (≤100) plus knowledge-store snippets (≤200) plus trusted SQL. A trusted answer gets a *verified* badge. ([docs](https://docs.databricks.com/aws/en/genie-agents/tune-quality))
- **Power BI / Fabric "Prep data for AI":** AI instructions, AI data schema and verified answers, stored *with the semantic model*. ([MS Learn](https://learn.microsoft.com/en-us/fabric/data-science/semantic-model-best-practices))
- **Snowflake semantic views:** plain-language custom instructions (including when to refuse or clarify) plus a verified query repository. ([docs](https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-repository))
- **Omni** AI context per field, topic or globally; **Hex** a rules file plus a library of markdown guides pulled in only when relevant. ([Omni](https://omni.co/blog/improving-ai-quality-with-context), [Hex](https://learn.hex.tech/docs/agent-management/context-management/guides))

**Clarion already has two of the three pieces** (verified answers and a linked glossary). It lacks the third: short rule text with an owner and a scope. Proposed design, deliberately small:
- **Storage.** A `company_notes` table (RLS), each row with:
  - title and body (markdown, capped around 2,000 characters, because a rule that long is a spec, not a rule);
  - scope: tenant-wide, a subject, or a table;
  - owner and `updated_at`;
  - status draft/active, with only active notes read by the AI.
- **How it reaches the AI.**
  - Tenant-wide notes go into every prompt, the way the glossary does.
  - Scoped notes are added only when their subject or table is in the question's scope.
  - That is **the same selection rule `productContext` already uses**, so no retrieval system is needed.
  - Past ~50 notes, add simple keyword matching. Embeddings only if a tenant proves it needs them.
- **The model must say when a note shaped the answer.** The receipt gets one line, "Applied your note: *Fiscal year starts in April*". This is the same principle as "Verified by your team": a human rule changed the number, so the human must be able to see which rule did it.
- **The coworker can propose notes** through the existing propose/Keep pattern. For example, after someone corrects an answer: "Shall I remember that returns sit in journal 70?". This closes the feedback loop the gaps page never closed.
- **Where it lives in the UI:** a fourth tab on `/definitions` (Terms · Metrics · Verified answers · **Notes**). It is the same kind of object: documented once, read by the AI.

**A variant with outsized value: dated events, or "known events".**
- A note with a date or date range, such as:
  - "price increase 8%, from 2026-07-01";
  - "lost customer Van Damme, 2026-03";
  - "warehouse strike 12–14 May".
- **Where they show:**
  - as markers on dashboard time axes;
  - in the morning brief ("revenue −12% vs last week; you noted a warehouse strike on 12–14 May");
  - as the **first thing the investigation agent checks** before running SQL.
- **Why it matters.** The investigation agent today can only explain a movement with what is in the tables. The most common real explanations are not in the tables: a price change, a lost customer, a holiday, a strike. This is the "why" context that businesses have and warehouses do not. It is structured enough to be trustworthy: a date, a sentence, an author.
- **Nobody in Clarion's SMB segment does this well.** Tableau and Power BI have manual chart annotations, but those do not feed the AI.

**(b) Documents as data: later, and narrowly.**
- The useful form is extraction into a governed table a person confirms. Examples:
  - contracts: counterparty, value, start, renewal date, notice deadline;
  - supplier price lists.
- The result lands as a managed grid, so it joins, is policy-protected, and its rows are editable. The review pattern already exists.
- Vendors in contract extraction say renewal logic and amendments "require human review" (vendor: [ContractSafe](https://www.contractsafe.com/blog/ai-contract-data-accuracy-guide), [Sirion](https://www.sirion.ai/library/contract-insights/contract-renewal-and-expiration-management-with-ai/)). This matches Clarion's propose-then-Keep design.
- **Rank: behind everything in §4 Tier 1–2.** The table it produces ("which contracts renew in the next 90 days, and what are they worth") is a real question. It is not a daily one.

**(c) Chat over PDFs and document search: no.** The evidence:
- **Stanford RegLab:** retrieval-based legal tools marketed as hallucination-free were wrong on **17% (Lexis+ AI) to ~33% (Westlaw)** of queries. Many answers were *misgrounded*: a real citation that does not support the claim. ([paper](https://dho.stanford.edu/wp-content/uploads/Legal_RAG_Hallucinations.pdf)) — evidence
- **Salesforce HERB** (EMNLP 2025): the best agentic method averages **~33** over docs, transcripts, Slack and GitHub. ([GitHub](https://github.com/SalesforceAIResearch/HERB)) — evidence
- **Berkeley DAB** (March 2026, multi-database with messy joins and free text): best model **38% on the first attempt**. ([DAB](https://ucbepic.github.io/DataAgentBench/)) — evidence
- **What the big vendors do.** Snowflake, Databricks and Microsoft keep the SQL engine and the document retriever as *separate tools* behind an orchestrator:
  - Snowflake Intelligence, generally available since Nov 2025;
  - Databricks Agent Bricks supervisor;
  - Fabric: Azure AI Search as a data-agent source, in preview.

  Google and Microsoft push documents to their suite assistants (Gemini Enterprise, M365 Copilot) and reach BI *through MCP*.

**The right move for Clarion is not to become the document search engine. It is to be the trustworthy numbers the customer's own assistant calls** (§4, MCP).

### 3.2 Email: yes as a channel, no as a data source

**Inbound mailboxes: no.**
- **Belgian GDPR enforcement.** The Belgian DPA has fined an employer (€8,500) for unlawfully processing an ex-employee's mailbox. ([DataGuidance](https://www.dataguidance.com/jurisdictions/belgium)) — evidence
- **Consent does not work here.** EDPB guidance holds that consent is rarely valid in employment. CAO/CCT nr. 81 on monitoring electronic communications adds purpose limitation and prior information to staff. (The CAO 81 detail is from general knowledge and was not re-verified here.)
- **Prompt injection.** Email is untrusted text arriving next to privileged access. That is exactly the pattern of the 2025 Supabase/Cursor incident ([Checkmarx](https://checkmarx.com/learn/mcp-security-risks-real-world-incidents-and-security-controls/)). Clarion's coworker holds the user's session. Feeding it customer mail would give a stranger's words a path to it.
- **No value case.** No SMB analytics product was found showing measurable value from mailbox ingestion. Where "why" explanations from text do work commercially (Gong, Clari), they run on CRM notes and call transcripts for sales teams. Even there the pattern is *classify text into dimensions* (Tableau Next's `AI_CLASSIFY` / `AI_SENTIMENT`), not answering from free text.

**Invoice inboxes (invoices@, OCR): no.**
- Belgian B2B e-invoicing over Peppol has been **mandatory since 1 January 2026**. Penalties apply since 1 April 2026 (€1,500 / €3,000 / €5,000), and e-reporting follows in 2028. ([Loyens & Loeff](https://www.loyensloeff.com/insights/news--events/news/e-invoicing-in-belgium-as-from-1-january-2026-key-provisions-of-the-long-awaited-royal-decree/)) — evidence
- Invoices now arrive structured and land in the ERP, which Clarion already syncs.
- Scanning is a commoditised and shrinking niche (Dext, Hubdoc, Exact's own Scan & Herken at about €0.45 per document).

**Email as a channel: yes, first.**
1. **Send the morning brief.** It is the single biggest unbuilt item: everything is in place except the send.
2. **Reply to ask.** A reply to the brief ("why did Antwerp drop?") becomes a question, and the answer comes back as a mail with a link to the step in Ask AI.
   - It needs an inbound address per tenant.
   - It accepts mail only from the **registered sender** of that brief, a user of the tenant.
   - It treats the body as a question, never as an instruction.
   - It runs on the same guarded path as the rest of Ask AI.

   This is small, and it matches how the owner's primary user actually works: in an inbox, on a phone.
3. **Threshold alerts by email**, and later Teams, which matters more than Slack for Belgian SMBs on Microsoft 365.

---

## 4. The other capabilities, ranked

Ranked by how often they would change someone's week, weighed against cost. Each item is tagged by what it is: **reach** (answers leave Clarion), **consequence** (answers make someone act), **context** (the AI knows more), **data** (new inputs) or **trust** (the platform is safe to buy).

### Tier 1: make it arrive and make it matter (the unfinished "Clarion comes to you" release)

1. **Delivered brief plus user thresholds plus immediate alerts** *(reach, consequence)*.
   - Email the brief, per user, at the user's own time.
   - Let a pulse entry carry "tell me when below X", or "when it moves more than N% against its usual".
   - Fire immediately after the sync that crosses it.
   - **Seasonality-aware comparison is essential.** Compare against the same weekday or same period last year, not just "vs yesterday". Fixed ±5% bands on an SMB's lumpy daily revenue will fire every Monday, and alert fatigue kills this feature faster than no alerts at all.
   - The plumbing exists (pulse, brief, email schedules, `emailService`).
   - The market's revealed answer is the same: Tableau Pulse, Xero JAX and QuickBooks agents all ship notifications and actions, not more charts. (vendor)
2. **Company notes plus dated events** *(context)*, as specified in §3.1(a). Cheap, no new infrastructure. It improves Ask AI, the brief and Investigate at once, and gives the coworker something to learn into.
3. **Targets on any KPI, plus budget vs actual** *(consequence)*.
   - Budgets already live in grids. What is missing is a *target* concept that says "this KPI's target comes from this grid column, by month".
   - Every surface then renders "against plan": the KPI card, the brief line, the alert.
   - Budget-vs-actual is the most-paid-for job in this segment (see pricing below).
4. **Mobile-respectable pass plus PWA** *(reach)*. The brief and alerts land on a phone. If the link opens a desktop layout, the push loop breaks at its last step.

### Tier 2: the forward view and the accountant

5. **Exception lists and a forward view** *(consequence, data)*.
   - The first instances are AR aging / "who to chase this week" and a **13-week cash roll-forward** from open items by due date (not regression).
   - The receivables and payables facts already exist in both connector templates.
   - This is the canonical accountant advisory product.
   - **Peppol makes it cleaner over time:** structured invoices with due dates and counterparty VAT numbers, independent of the ERP.
   - **Stay out of the ERPs' lane.** Do not build the collection *agent*. Xero, Intuit, Exact and Odoo are all shipping payment follow-up inside the books. Clarion's job is *which* invoices and *why*, not sending the reminder.
6. **Accountant portfolio tier** *(reach)*.
   - One user, many tenants (a membership table and a tenant switcher). A portfolio home answers: "which of my clients needs a call this week", from cross-client exceptions.
   - An AI-drafted monthly commentary pack per client that the accountant edits and sends.
   - Accountants' own top complaint is the manual time spent on forecasting, commentary and reports. (vendor survey: Fathom, n unknown)
   - **The competitive facts:**
     - **Silverfin** (Ghent, owned by Visma) already sells portfolio queries, cross-client benchmarks and alerts to 1,000+ firms.
     - **Pennylane** raised €175M in Jan 2026 and named Belgium as an expansion market.
     - Silverfin lives on year-end and compliance data. Clarion's edge is **live, daily ERP data plus plain-language Q&A**.
   - **Pricing expectation in this channel:** roughly €20–120 per client entity per month (Syft, Spotlight, Fathom tiers; aggregator sources).
7. **Read-only MCP server over the semantic layer** *(reach)*.
   - It is fast becoming a procurement checkbox:
     - Snowflake-managed MCP has been generally available since Nov 2025;
     - Databricks, dbt and Qlik (GA Feb 2026) ship one;
     - Power BI and Looker are in preview.
   - The tokens and the guarded, policy-applied read path already exist for the Excel add-in. MCP is the "next caller" the code comments already name.
   - **Tools:**
     - list subjects and metrics;
     - describe a metric;
     - ask a question, which returns the answer plus trust mark plus sources;
     - run a verified question.
   - **Guardrails:** read-only, per-user token, role and policies applied, audited.
   - **Why it matters strategically:** this is how the customer's own M365 Copilot or Claude combines *their* documents and email with *Clarion's* numbers. Clarion stays the governed source of truth and never runs a mailbox. It is the answer to "documents and email" that fits both the evidence and the architecture.
8. **NL/FR interface** *(trust / adoption)*. Answers already mirror the question's language. The chrome is still English in a Dutch/French market. Retrofitting copy extraction only gets more expensive.

### Tier 3: enrichment and trust signals that cost little

9. **External reference data** *(data)*. Deterministic public sources, not AI:
   - **ECB FX rates**, for multi-currency Odoo tenants and later consolidation.
   - **Belgian public holidays / a calendar table**. Seasonality-aware alerts need it, and `dim_date` is the natural home.
   - **NBB Central Balance Sheet Office (CBSO)**, which has web services (register on developer.cbso.nbb.be; some products free, "Improved Data" paid). This gives two things:
     - annual sector ratio benchmarks by NACE code (margin, solvency, DSO proxies), usable as a first benchmarking feature *without* needing a pool of Clarion clients;
     - **counterparty health** for a customer or supplier looked up by KBO/VAT number ("3 of your top 10 customers filed a loss last year").
   - **Caveats:** annual only, filings lag by months, and abbreviated and micro schemes omit revenue. Treat it as annual context, never as monthly benchmarks. (search snippets; nbb.be was blocked)
10. **Entra ID SSO** *(trust)*. Most Belgian SMBs run on Microsoft 365. "Sign in with Microsoft" removes a password and is often asked for in procurement. SCIM can wait.
11. **Comments on numbers, and share links / PDF pack** *(reach)*. Unchanged from the gap analysis, G13 and G6. A thread on a KPI card is where a company note is usually born ("this dip is the strike"). Wire the two together.
12. **EU AI Act Art. 50 transparency** *(trust)*.
    - The transparency duties apply from 2 August 2026 and were *not* moved by the July 2026 Omnibus. (law-firm secondary sources: [Gibson Dunn](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/), [FPF](https://fpf.org/blog/the-ai-act-implementation-timeline-what-changes-under-the-ai-omnibus/))
    - Clarion already labels AI answers heavily. What remains:
      - a one-line "this answer was produced by AI" on emailed and exported content;
      - a short AI-use statement in the (still draft) legal documents.
    - A finance-analytics assistant is not high-risk. It would become so only if the product ever scored employees, which is one more reason to keep HR connectors report-only.

### Tier 4: optional, when asked for

13. **VSME sustainability template** *(data)*.
    - Omnibus I took most SMBs out of CSRD. The Commission adopted the voluntary **VSME** standard in July 2026 as the ceiling on what large customers and banks may ask of SME suppliers. ([EC](https://finance.ec.europa.eu/publications/commission-presents-voluntary-sustainability-reporting-standard-ease-burden-smes_en))
    - Demand is real but indirect (questionnaires from customers and banks, from 2026–27).
    - A grid template for the basic-module metrics (energy, scope 1/2, headcount) is enough. It fits the accountant channel as an add-on, not as a purchase driver.
14. **Documents as data (contracts)**, per §3.1(b).

---

## 5. What not to build

| Don't | Why |
|---|---|
| Chat over PDFs / a document search engine | Mixed document-plus-SQL answers score ~30–40% on realistic benchmarks, and misgrounded citations are common. The suite assistants own this layer; MCP is how Clarion joins it. |
| Mailbox ingestion | GDPR/CAO 81, prompt-injection surface, no value evidence. |
| Invoice OCR / an invoices@ inbox | Peppol is mandatory since 2026. The ERPs and Dext already do it. |
| Collection agents, payment reminders, writeback | The ERPs are shipping these inside the books. Writing into a customer's accounting system is a different risk class. Clarion analyses, alerts and hands over. |
| GraphRAG / embeddings "because AI" | No gain over plain selection at Clarion's context sizes. Revisit only if a tenant's notes outgrow simple scope selection. |
| Meeting transcripts, audio, vision | No evidence of value in this segment. It widens the trust gap. |
| Driver-based three-way forecasting | Fathom and Jirav's whole product, and a different buyer. The 13-week cash roll-forward is the SMB-sized version. |

---

## 6. Suggested order

1. **Release "Clarion comes to you"**: items 1, 2, 4. Email the brief, thresholds with seasonality, immediate alerts, company notes plus dated events, a mobile pass. Everything reuses existing plumbing.
2. **Release "Against plan"**: items 3, 5. Targets on KPIs from grids; AR exceptions and a 13-week cash view on the existing receivables and payables facts.
3. **Release "Reachable"**: items 7, 10, 8. Read-only MCP, Entra SSO, NL interface. Together these make Clarion buyable by a Microsoft 365 shop and usable from their Copilot.
4. **Release "Accountant"**: item 6 plus the NBB benchmark from item 9. Portfolio tier, commentary packs, sector benchmarks. This is the channel play; it needs 1–3 underneath it to have anything to show.
5. The rest when a customer asks.

**One decision is needed from the owner.** Is the accountant channel the go-to-market? If yes, pull release 4 forward behind release 1, and treat Silverfin and Pennylane as the named competition in every design choice. If no, release 3 (MCP and SSO) comes second, because a direct SMB buyer on Microsoft 365 will ask for it first.

---

## 7. Sources

**Platforms and context layers**
- Databricks Genie tuning: https://docs.databricks.com/aws/en/genie-agents/tune-quality
- Databricks trusted assets: https://learn.microsoft.com/en-us/azure/databricks/genie/trusted-assets
- Power BI / Fabric semantic model for AI: https://learn.microsoft.com/en-us/fabric/data-science/semantic-model-best-practices
- Fabric data agent with AI Search (preview): https://learn.microsoft.com/en-us/fabric/data-science/data-agent-ai-search-index
- Snowflake verified query repository: https://docs.snowflake.com/en/user-guide/views-semantic/verified-query-repository
- Snowflake Cortex Agents GA: https://docs.snowflake.com/en/release-notes/2025/other/2025-11-04-cortex-agents
- Omni AI context: https://omni.co/blog/improving-ai-quality-with-context
- Hex guides: https://learn.hex.tech/docs/agent-management/context-management/guides
- Looker and Gemini Enterprise: https://cloud.google.com/blog/products/business-intelligence/integrating-looker-and-gemini-enterprise
- ThoughtSpot Spotter 3 (secondary): https://diginomica.com/thoughtspots-spotter-3-targets-enterprise-ais-biggest-problem-90-data-blind-spot

**Benchmarks**
- Stanford RegLab legal RAG: https://dho.stanford.edu/wp-content/uploads/Legal_RAG_Hallucinations.pdf
- Salesforce HERB: https://github.com/SalesforceAIResearch/HERB
- Berkeley Data Agent Benchmark: https://ucbepic.github.io/DataAgentBench/
- TAG-Bench: https://arxiv.org/abs/2408.14717
- Spider 2.0: https://spider2-sql.github.io/

**MCP**
- Snowflake managed MCP: https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp
- Databricks managed MCP: https://docs.databricks.com/aws/en/generative-ai/mcp/managed-mcp
- dbt MCP: https://docs.getdbt.com/docs/dbt-ai/about-mcp
- Power BI remote MCP (preview): https://learn.microsoft.com/en-us/power-bi/developer/mcp/remote-mcp-server-get-started
- MCP security incidents: https://checkmarx.com/learn/mcp-security-risks-real-world-incidents-and-security-controls/

**SMB finance market**
- Pennylane raise and Belgium: https://www.eu-startups.com/2026/01/sequoia-backed-french-accounting-unicorn-pennylane-secures-e175-million-as-it-approaches-profitability/
- Silverfin insights: https://silverfin.com/en-gb/feature/insights/
- Intuit AI agents (with FY2025 filing): https://investors.intuit.com/news-events/press-releases/detail/1258/intuit-introduces-ground-breaking-virtual-team-of-ai-agents-to-fuel-growth-for-businesses
- Xero JAX: https://www.xero.com/us/media-releases/xeros-ai-financial-superagent-jax-launches-powerful-new-features/
- Odoo 19 release notes: https://www.odoo.com/odoo-19-release-notes
- Fathom pricing (blocked; aggregator): https://eightx.co/blog/fathom-vs-jirav-vs-liveflow-reporting
- Agicap pricing: https://www.g2.com/products/agicap/pricing

**Belgium and EU regulation**
- Peppol mandate Belgium: https://www.loyensloeff.com/insights/news--events/news/e-invoicing-in-belgium-as-from-1-january-2026-key-provisions-of-the-long-awaited-royal-decree/
- NBB CBSO web services: https://www.nbb.be/en/central-balance-sheet-office/consultation-data/web-services
- AI Act Omnibus timeline: https://fpf.org/blog/the-ai-act-implementation-timeline-what-changes-under-the-ai-omnibus/
- VSME: https://finance.ec.europa.eu/publications/commission-presents-voluntary-sustainability-reporting-standard-ease-burden-smes_en
- Belgian DPA enforcement overview: https://www.dataguidance.com/jurisdictions/belgium
- Tableau Pulse digests: https://www.tableau.com/blog/top-new-tableau-pulse-feature-releases-know
