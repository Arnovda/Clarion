# Semantic enrichment plan — sibling context, human-edit protection, AI enrichment

> Plan of record, drafted 2026-07-20. Extends `docs/SOURCE_ONBOARDING.md`
> ("documentation before inference"). Read that first — this plan implements
> the missing top rung of its precedence ladder (`human > declared/curated >
> ai_verified > ai_draft`) and adds a controlled way for AI to build ON TOP of
> vendor documentation instead of being locked out of it.
>
> Build order is deliberate: **Phase 1 → Phase 2 → Phase 3**. Phase 2
> (edit tracking) MUST ship before Phase 3 (enrichment): enrichment produces
> human-approved text, and until edits survive a re-profile, every approval
> is wiped by the next Analyse click.

---

## Phase 1 — Vendor sibling context for AI descriptions (small, no schema change)

**Problem.** AI Pass C describes undocumented columns (custom fields, columns
added by the vendor post-transcription) with no knowledge of the vendor's own
descriptions of the neighbouring columns. The docs are already in memory in
`runSchemaProfiler` (`colDocByKey` / `tableDocByName`) — they just never reach
the prompt.

**Change.**
- `backend/src/ai/prompts/schemaContextPrompt.ts` — `generateColumnDescriptions`
  input gains, per table, a `documentedSiblings: Array<{ name, description }>`
  block. Prompt section (per table batch):
  `"The source vendor documents these sibling columns as follows — match their
  vocabulary and domain terms: …"`. Cap at ~40 siblings/table, truncate each
  description to ~120 chars (token budget; the goal is vocabulary anchoring,
  not full recall).
- `backend/src/semantic/SchemaProfiler.ts` — when building `uncoveredTables`
  for Pass C, attach each table's documented columns from `colDocByKey`.
- Same for Pass B (`generateTableContext`): pass vendor TABLE descriptions
  (`tableDocByName`) so relationship inference knows what the vendor says each
  entity is. One extra prompt section, same shape.

**Not in scope:** no behaviour change for documented columns (still verbatim,
still skip AI).

**Tests.** Prompt-builder unit test: siblings section present when docs exist,
absent otherwise; truncation applied. No live-AI test needed.

**Acceptance.** Profile a connection with a mix of documented + custom columns
(local Odoo or the EO spike + a synthetic extra column): the Pass C prompt
(log at debug) contains the sibling block.

**Effort.** ~half a day. No migration, no API change, no frontend change.

---

## Phase 2 — Human-edit tracking: the missing top rung (foundation)

**Problem.** The profiler's persist step is wipe-and-reinsert; curator edits
(descriptions, display names, dim/measure flags, confirmed relationships) are
lost on every re-profile. The precedence ladder's top rung ("human edits beat
all") was never implemented. The persist transaction ALREADY snapshots and
restores `cross_view_tables`/`cross_view_relationships` across the wipe — the
same pattern, applied to human edits, is the fix.

**Change.**
1. **Migration** `add_human_edit_tracking`:
   - `source_tables.edited_by_user boolean default false`, plus
     `source_columns` same. (No new rung value in `semantic_source` — the
     provenance of the TEXT stays what it was; `edited_by_user` marks that a
     human took ownership of the row's semantics. Simpler than widening the
     enum, and queryable independently.)
   - `table_relationships.confirmed_by_user boolean default false`.
2. **Write paths** (per the dual-write contract, mirror every one to Neo4j):
   - `PATCH /semantic/tables/:id` and `PATCH /semantic/columns/:id`
     (routes/semantic.ts): when the request changes `description`,
     `display_name`, `is_dimension`, or `is_measure`, set
     `edited_by_user = true`. A pure confirm (approval only) does NOT set it —
     confirming an AI draft is approval of machine text, not authorship.
   - Relationship confirm (`PATCH /semantic/relationships/:id` with
     `ai_draft=false`) sets `confirmed_by_user = true`.
3. **Profiler persist** (SchemaProfiler step 7, inside the same transaction):
   - BEFORE the wipe: snapshot rows where `edited_by_user = true` keyed by
     `table_name` / `(table_name, column_name)` → description, display_name,
     is_dimension, is_measure, approval_status. Snapshot relationships where
     `confirmed_by_user = true` keyed by
     `(from_table, from_column, to_table, to_column)`.
   - AFTER reinsert: re-apply snapshots onto rows that still exist (column
     dropped at the source → snapshot is dropped with a log line, matching
     schema reality). Re-applied rows keep `edited_by_user = true`,
     `ai_draft = false`, `approval_status = 'approved'`.
   - Precedence order becomes: human snapshot > connector docs > AI.
4. **Neo4j mirror**: `UpsertTableInput`/`UpsertColumnInput` gain
   `editedByUser`; Cypher preserves it the same way `aiDraft` is preserved on
   match today.
5. **UI (small)**: TableDetailPanel/columns show an "edited" affordance (e.g.
   a small pencil chip) sourced from `edited_by_user`, so curators can see
   which rows are theirs. Optional in v1.

**Tests.** Profiler round-trip test against local Postgres (pattern of the
2026-07-20 RLS smoke): edit a column description + confirm a relationship →
re-profile → edits survive; drop the source column → snapshot is discarded;
non-edited columns still refresh from docs/AI.

**Acceptance.** Re-analyse on a connection with hand-edited rows leaves those
rows byte-identical, while un-edited rows update normally.

**Effort.** ~1–2 days including tests. One migration.

---

## Phase 3 — Opt-in AI enrichment of vendor descriptions

**Problem.** Vendor text is trusted but often terse ("Division code"). Users
want business meaning grounded in their OWN data — without ever corrupting
the verbatim vendor text that makes the catalog auditable against the
vendor's docs.

**Design invariants** (why this shape):
- The vendor's verbatim text is IMMUTABLE and always recoverable. Enrichment
  is a proposal layered on top, never a mutation of the base.
- Enriched text goes through the existing review queue (`ai_draft = true`)
  — trust is granted by a human, never assumed.
- Rejecting an enrichment restores the vendor text exactly.
- Selective by default: enriching all 2,613 EO columns is token waste; the
  columns that matter are measures, FK columns, and columns used by the
  star-schema template.

**Change.**
1. **Migration** `add_vendor_description`:
   - `source_columns.vendor_description text` (nullable) — the immutable
     curated base. `source_tables` same (table-level docs are also terse).
   - Profiler persist: for documented columns, write BOTH
     `vendor_description = <verbatim>` and `description = <verbatim>`.
2. **New AI call type** in `AIService.ts` (single entry point rule):
   `enrichColumnDescriptions(...)`, Sonnet, batched per table. Prompt inputs:
   vendor description (base), sample values, quality stats (null %, distinct,
   top values), relationships touching the column, sibling vendor docs
   (Phase 1 block reused), tenant glossary via `getTenantAiContext()`.
   Prompt contract: output MUST begin with the vendor sentence verbatim, then
   extend with observed-data context; never contradict the base; ≤2 added
   sentences. Structured output, per-column
   `{ column, enriched_description }`.
3. **Selection rule** (server-side, not prompt-side): candidate columns =
   documented AND (is_measure OR endpoint of a relationship OR referenced in
   the connection's star-schema template lineage) AND NOT `edited_by_user`.
   Cap per run (e.g. 300 columns) with a "N of M enriched" report.
4. **Persist**: `description = enriched`, `semantic_source = 'ai_enriched'`
   (new rung value between `curated` and `ai`), `ai_draft = true`,
   `approval_status = 'pending'` → rows appear in the existing review queue.
   Confirm → `ai_draft = false`, `approval_status = 'approved'` (queue flow
   unchanged). NEW reject path: restore `description = vendor_description`,
   `semantic_source = 'curated'`, approved. Mirror all writes to Neo4j.
5. **Trigger**: explicit button on the source card / SourceRootPanel —
   "Enrich descriptions (AI)" — admin-only, with a pre-run count + rough cost
   estimate. NOT part of Analyse; never automatic. Re-running skips
   already-enriched and human-edited rows.
6. **Re-profile interplay** (why Phase 2 first): approved enrichments are
   human-approved text. Re-profile re-derives `description` from docs — an
   approved enrichment would be silently reverted. Rule: approved enrichment
   rows are snapshotted/re-applied exactly like human edits (add
   `semantic_source = 'ai_enriched' AND approval_status = 'approved'` to the
   Phase 2 snapshot predicate). Pending (unreviewed) enrichments do NOT
   survive a re-profile — they're drafts.

**Tests.** Selection-rule unit test; persist/restore unit test (enrich →
reject → vendor text back verbatim); profiler round-trip (approved enrichment
survives re-profile, pending one doesn't); prompt-builder test (base sentence
included verbatim).

**Acceptance.** On the EO connection: enrich → review queue shows drafts whose
text starts with the exact vendor sentence; confirm some, reject one →
rejected column shows verbatim vendor text; Re-analyse → confirmed
enrichments survive.

**Effort.** ~2–3 days including UI button + review-queue reject path. One
migration. Token cost per full EO run at the selection rule: roughly
300 columns ≈ a few dollars, one-off per connection, admin-triggered.

---

## Connector-agnostic by construction

Nothing above is EO-specific. Phase 1 reads the generic `EntityDocs` channel
(works for Odoo's `fields_get` docs today). Phase 2 operates on catalog rows
regardless of source tier. Phase 3's base/enriched split works for any
Tier-1/Tier-2 source; Tier-3 (undocumented) sources have no
`vendor_description` and simply never enter the enrichment selection. New
connectors get all three behaviours for free by implementing the existing
`describeEntities`/`getKnownRelationships` contract.

## Rollout order + gates

1. Phase 1 — ship alone (prompt-only, zero risk).
2. Phase 2 — ship + verify with the round-trip test before ANY curation
   campaign is encouraged.
3. Phase 3 — ship behind the explicit button; flip nothing on by default.

Update `docs/SOURCE_ONBOARDING.md` §Precedence when Phase 2 lands (the
`human` rung becomes real) and again when Phase 3 lands (`ai_enriched` rung).
