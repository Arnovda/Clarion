# Source Onboarding Playbook
> The contract for how Clarion onboards a new source system. Read this
> BEFORE writing the first line of a new connector. It is binding the same
> way the dual-write contract in CLAUDE.md is binding: deviations need a
> written reason in the connector's package README, not a silent shortcut.

**Core principle:** *documentation before inference.* Every piece of the
semantic layer (table descriptions, column descriptions, relationships,
types, and eventually the star schema itself) comes from the most
authoritative source available, and AI only fills the gaps that remain.
The AI pipeline is the fallback, never the default, for sources whose
vendors document their data model.

---

## 0. Classify the source before anything else

Every source system falls into one of three metadata tiers. The tier
decides which phases below are mandatory and which fallbacks apply.
A source can be mixed-tier (Odoo is Tier 1 for field docs but Tier 2 for
relationships); classify each metadata kind separately.

| Tier | Definition | Examples | Semantic strategy |
|------|-----------|----------|-------------------|
| **1 — Self-describing** | The source exposes machine-readable metadata *at runtime*: field labels/descriptions, types, relations. | Odoo (`fields_get` returns `string`, `help`, `type`, `relation` per field), OData `$metadata` (EO partially), GraphQL introspection, SQL sources with `information_schema` + column comments | Harvest metadata during profiling. Covers **custom fields** and per-instance translations that static docs never can. Highest trust. |
| **2 — Documented** | The vendor publishes a stable, human-readable data-model reference, but there is no (complete) runtime metadata API. | ExactOnline REST reference, Stripe API docs, Salesforce object reference | **Build-time curation**: descriptions + relationships are hand-transcribed from the docs into the connector package (`entities.ts`), reviewed once, conformance-tested, shipped to every customer. |
| **3 — Undocumented** | No vendor docs exist — the schema is bespoke per customer. | A customer's own Postgres/MySQL/SQL Server/SQLite database, CSV drops | AI pipeline is the primary mechanism (3-pass profiler + heuristic FK detection + value-overlap verification). Everything lands as `ai_draft` for human review. |

Rules that follow from the tier:

- **Tier 1:** harvesting runtime metadata is MANDATORY. Do not discard
  metadata the transport already fetches (the original Odoo connector
  requested only `['type','store']` from `fields_get` and threw away the
  vendor's `string`/`help` texts — that class of waste is now a
  contract violation).
- **Tier 2:** a curated entity catalog with descriptions and a
  `getKnownRelationships` implementation are MANDATORY. "The AI will
  figure it out" is not an acceptable reason to skip transcription work
  for a documented source.
- **Tier 3:** the AI pipeline runs as today. Do not fake curation —
  guessing docs for an undocumented source and marking them trusted is
  worse than an honest AI draft.
- **Never scrape vendor doc sites at runtime.** Curation happens at
  build time, in the repo, under review and tests. Runtime fetching of
  HTML docs is fragile, unversioned, rate-limited, and licensing-murky.
  Runtime harvesting is only allowed from *metadata APIs the customer's
  own credentials access* (Tier 1).

---

## 1. The semantic precedence ladder

Every semantic fact (a description, a relationship, a type) carries a
provenance, and higher provenance always wins. The profiler must skip
lower rungs for anything already covered by a higher rung — the AI is a
gap-filler, not a second opinion.

```
1. declared   — harvested at runtime from the source's own metadata API (Tier 1)
2. curated    — transcribed from vendor documentation into the connector package (Tier 2)
3. ai_verified — AI-inferred AND mechanically verified (e.g. relationship value-overlap ≥ 50%)
4. ai_draft   — AI-inferred, unverified; requires human review
```

Trust consequences:

- `declared` and `curated` facts land with `ai_draft = false` and
  `approval_status = 'approved'`. They do NOT enter the review queue.
  (Today this is true for relationships via `source: 'declared'` in
  `SchemaProfiler.ts`; extending it to descriptions is a platform gap —
  see §8.)
- `ai_verified` and `ai_draft` behave as today (draft flag, review
  queue, confidence gating).
- A human edit beats everything: once a user has edited a description,
  a re-profile must not overwrite it regardless of provenance.
- Provenance is stored, not implied — every semantic row records which
  rung it came from, so the UI can show "from Odoo" vs "AI suggestion"
  and re-profiles know what they may overwrite (only their own rung or
  lower).

---

## 2. Phase-by-phase way of working

Work through the phases in order. Each phase has a deliverable; the
Definition of Done in §7 is the merge gate.

### Phase A — Research brief (no code yet)

Produce a short connector brief (markdown in the connector's package
directory, e.g. `packages/connectors/src/<type>/README.md`) answering:

1. **Metadata tier** per kind: field docs / relationships / types
   (see §0). Link the vendor documentation you'll curate from,
   including its version/date.
2. **Auth model:** OAuth 2.0 auth-code (→ implement `OAuthSpec`),
   API key, basic? Does the provider *rotate* refresh tokens
   (→ `onCredentialRotated` is mandatory)?
3. **API surface:** which endpoint family is non-deprecated and will
   exist in 3 years? (Odoo taught us: `/xmlrpc/2` is deprecated —
   primary transport is `/json/2` with XML-RPC only as legacy
   fallback. Pick the future-proof path as primary.)
4. **Rate limits:** documented requests/sec or burst rules →
   `HttpClient` `requestsPerSecond` setting.
5. **Incremental story:** which field marks row modification
   (`Modified`, `write_date`, an LSN)? What is its precision
   (seconds → the `>=`-with-merge rule in Phase D applies)? Is there
   delete detection?
6. **Entity allowlist:** the 15–25 business-relevant entities we will
   support at launch (finance, sales, purchases, inventory, CRM as
   applicable). We curate a focused allowlist, we do NOT mirror the
   whole API. Every entity must have a plausible analytics use.
7. **Known relationships:** enumerate the documented FKs between
   allowlisted entities from the vendor's data model.
8. **Egress:** the exact FQDNs (or wildcards) the connector needs.

### Phase B — Transport & auth

- Reuse the shared `HttpClient` (rate limiting, retries, `Retry-After`,
  redaction, `egressAllowList` SSRF enforcement). Do not hand-roll HTTP.
- `egressAllowList` is exact and minimal. For self-hosted sources
  (Odoo-style) it is the single configured host.
- **Read-only by construction** where the API allows it: if the source
  has generic method dispatch (RPC-style), enforce a method allowlist
  the way `assertReadOnly` does for Odoo — writes must be impossible,
  not merely avoided.
- OAuth connectors: implement `OAuthSpec` (preAuthFields ⊆ configSchema
  properties — conformance-enforced) and call `onCredentialRotated` on
  every token rotation, including from probe paths.
- `configSchema` is a strict JSON Schema; it gates every config write
  (`validateConnectorConfig` runs on `PATCH /source-config`).

### Phase C — Entity catalog (`entities.ts`)

Every entity in the allowlist gets an `EntityDescriptor` with:

- `name` — warehouse-safe (`^[A-Za-z0-9_-]+$`); map source naming to
  safe names in the connector (Odoo's `account.move.line` →
  `account_move_line`).
- `displayName`, `category`, `description` — REQUIRED for new
  connectors (Tier 1: may be filled/overridden at runtime; Tier 2:
  transcribed from docs). An empty description on a documented source
  is a review blocker.
- `incrementalCursor` + `businessKey` — declare incremental wherever
  the source supports it. The conformance suite enforces
  `supportsIncremental === !!incrementalCursor` and
  `incrementalCursor ⇒ businessKey` (the table-wipe invariant).
- **Explicit column schema:** new connectors MUST pass
  `WriteTableOptions.columns` (source types mapped to stable DuckDB
  types) instead of relying on `auto_detect`. Sample-based inference
  causes type drift between syncs; only Tier 3 sources with no type
  metadata may fall back to inference.

### Phase D — Sync correctness (the non-negotiables)

These rules exist because each one is a bug we shipped once:

1. **Cursor filter is `>=`, not `>`, with merge-by-businessKey.**
   Second-precision watermarks skip boundary rows under `>`; the
   re-pull is idempotent because the writer merges by key. The cursor
   value itself only advances on a strictly-greater value (orchestrator
   enforces monotonicity).
2. **Flattening rules are type-aware.** Source sentinel values (Odoo's
   `false`-means-empty) map to NULL only where the declared type says
   so; a real boolean `false` survives. Relation tuples (`[id, name]`)
   flatten to the id.
3. **Paginate with a stable order** (typically by id) so pages don't
   shift under concurrent writes.
4. **Stream, don't buffer:** rows go to `ctx.warehouseWriter` as an
   async iterable. Check `ctx.cancellationToken` between pages.
5. **Progress + redaction:** emit `ctx.progress` per entity/page; log
   only through `ctx.log`. Credentials must be structurally unable to
   reach logs, error messages, or the DB.
6. Errors thrown to the orchestrator carry a user-facing message —
   never raw HTTP bodies (the orchestrator redacts, but don't rely on it).

### Phase E — Semantic layer wiring (the heart of this playbook)

**E1. Relationships.** Implement `getKnownRelationships` with every
documented FK between allowlisted entities (Tier 1: derive from runtime
metadata, e.g. Odoo `fields_get`'s `relation` attribute; Tier 2:
transcribe from docs). Each entry gets a plain-English `description`.
Column casing must match the Parquet headers exactly. The profiler
merges these as `source: 'declared'` before heuristics and AI run.

**E1a. The target column is almost never documented — treat it as an
inference, and check it.** A source's docs normally mark a foreign key by
linking the property to the *target entity*. That link is a vendor fact. The
*target column* is not stated there, and whatever you resolve it to — the
entity's primary key, its first key-marked property — is **your inference
wearing the vendor's authority**, which is the most dangerous kind of claim
this platform can make. It shows up as "laid by the source" on the
relationship canvas, where the UI explicitly tells people not to second-guess
it.

Exact Online is the worked example. `TransactionLines.JournalCode` is an
`Edm.String` holding a journal code; the docs link it to the `Journals` entity,
whose key-marked property is `ID`, an `Edm.Guid`. The transcription therefore
produced `JournalCode → Journals.ID`, which measures **0%** containment against
real data. `Journals.Code` — same type, same meaning — measures **100%**. 35 of
that connector's 245 documented references crossed a type boundary like this.

Two rules follow, both enforced by `validateKnownRelationships` and
`validateDocumentedRelationships` in `conformance.ts`:

1. **Both endpoint columns must exist** in whatever column documentation the
   connector ships. A relationship naming a column the source does not have
   fails silently today — the profiler drops the unresolvable endpoint and the
   link simply never appears, with nothing saying why. 15 of Exact Online's 81
   curated relationships were in that state.
2. **The two endpoints' declared types must be able to be one key**
   (`typesJoinable` in `columnTypes.ts`). A GUID and a code column are not two
   ends of the same key, however alike they look once both land in the
   warehouse as `VARCHAR`. When either side declares no type the check is
   skipped — it may only ever reject on positive evidence, never on silence.

When a documented reference fails rule 2, **refuse it at the documented rung
rather than guessing at a better column.** Do not invent a second inference to
patch the first. The relationship is not lost: the ordinary value-overlap
detector can still surface it into *To review*, where the data decides and a
person confirms — which is the correct home for a claim we cannot stand behind.

**E2. Table + column descriptions.**
- Tier 1: harvest labels/descriptions during profiling from the
  metadata endpoint using the customer's own credentials. This covers
  custom fields (`x_...` in Odoo) automatically.
- Tier 2: ship a curated per-column docs map in the connector package
  alongside `entities.ts`.
- Either way, they enter the profiler at the `declared`/`curated` rung:
  stored approved, skipped by the AI passes, immune to AI overwrite.
- The AI's 3-pass pipeline then runs ONLY over the uncovered remainder
  (custom fields on Tier 2 sources, undocumented columns, tenant
  glossary nuance) — this is the token-cost and review-queue win.

**E3. Fallback ladder when documentation is missing or partial** (this
is the "what if the descriptions don't exist" contract):

| Missing piece | Fallback |
|---|---|
| No description for a column in a Tier 1/2 source | AI pass C writes it as `ai_draft`, flagged for review — same as today. Do not invent a curated one. |
| No documented relationships | Heuristic FK detection (name-stem matching) + AI inference, both value-overlap-verified (≥50% join overlap) before rising to `ai_verified`; below threshold → `ai_draft`. |
| No runtime metadata endpoint on a supposedly Tier 1 source (old version, disabled module) | Degrade that connection to Tier 2/3 behaviour at profile time; log the degradation; never fail the profile because docs were unavailable. |
| No incremental field on an entity | Declare it full-sync (`supportsIncremental: false`, no cursor). Never fake a cursor on an unreliable field. |
| No type metadata | `auto_detect` fallback is allowed (Tier 3 only), accepting the drift risk. |
| Vendor docs ambiguous or contradictory to observed data | Observed data wins for types; docs win for meaning; write the discrepancy into the connector README. |

### Phase F — Deterministic star schema (the destination)

For Tier 1/2 sources the fact/dimension design is a property of the
*source system*, not of the customer. Once the platform's template
contract exists (§8), every new connector ships:

- `getStarSchemaTemplate(selectedEntities)` — a versioned, hand-written
  template: fact tables, dimensions, grain, tested transformation SQL,
  and the KPIs that make sense for that source (e.g. Odoo →
  `fact_invoice_lines`, `fact_sale_order_lines`, `dim_partner`,
  `dim_product`, `dim_account`, `dim_date`).
- **Graceful degradation:** the template instantiates only the tables
  whose upstream entities were actually synced; a missing dimension
  degrades that FK to a plain column rather than failing the build.
- **AI as extension, not replacement:** AI-driven design remains for
  Tier 3 sources, for customer-specific derived measures, and for
  extending a template with custom fields. A customer can always fork
  from the template.
- **Versioned:** templates carry a version; existing customers stay on
  their materialised version until an explicit upgrade (same
  incremental-migration philosophy as the warehouse layout v1→v2).

Until the template contract ships, Phase F for a new connector means:
document the intended star schema in the connector README (facts, dims,
grain, measures) so the AI-designed products can be checked against it
and the template can be written later without re-research.

### Phase G — Tests & conformance

- **Conformance suite** (`conformance.ts`) runs over every registered
  connector in CI — it is how this contract stays enforced rather than
  aspirational. When this playbook adds a new rule that is mechanically
  checkable, add the validator in the same PR (see §8 for the pending
  ones: description coverage, relationship endpoint validity, template
  well-formedness).
- **Unit tests** for every pure part: codecs, flattening, type mapping,
  cursor filter construction, config narrowing. Anything hand-rolled
  (an XML codec, a pagination quirk) is fully unit-tested — nothing
  ships blind.
- **Mocked-transport sync tests** (nock-style) covering: first full
  sync, incremental sync with merge, empty entity, auth failure,
  rate-limit retry, cancellation.
- **Live validation before GA:** run the connector against a real
  sandbox/demo account (EO test division, Odoo trial DB) and eyeball
  the profiled semantic layer end-to-end. Headless tests do not
  reproduce everything (the Vega lesson generalises).

### Phase H — Registration & surfaces

- Register in `packages/connectors/src/index.ts`. The `add-source`
  wizard and `/source-types` are registry-driven — no backend route or
  migration work per connector.
- Frontend: add the tile metadata (`REGISTRY_DESCRIPTIONS`,
  `REGISTRY_COLORS` in `frontend/app/sources/page.tsx`).
- Update CLAUDE.md Current State; add the connector brief README.

---

## 7. Definition of Done (merge gate for a new connector)

- [ ] Connector brief (README) with tier classification, doc links + version, allowlist rationale, intended star schema
- [ ] `configSchema` strict; OAuth spec if applicable; token-rotation hook wired if the provider rotates
- [ ] `egressAllowList` minimal and enforced via shared `HttpClient`
- [ ] Read-only enforced by construction where the API shape allows it
- [ ] Entity catalog: warehouse-safe names, descriptions on every entity, incremental + businessKey wherever supported
- [ ] Explicit `columns` schema on writes (no `auto_detect` for Tier 1/2)
- [ ] Cursor filter `>=` + merge-by-key; type-aware flattening; stable pagination order; streaming + cancellation
- [ ] `getKnownRelationships` with descriptions (Tier 1/2)
- [ ] Every relationship endpoint column EXISTS, and the two ends' declared types could be one key (Phase E1a) — both are conformance errors, not runtime drops
- [ ] Column/table docs harvested (Tier 1) or curated (Tier 2), landing at the trusted rung; AI covers only the remainder
- [ ] Conformance suite green; unit tests for all pure logic; mocked sync tests for the six scenarios in Phase G
- [ ] Live sandbox validation performed and findings noted in the README
- [ ] Registered + frontend tile + CLAUDE.md updated

---

## 8. Platform gaps this contract depends on (build once, benefits every connector)

The playbook above assumes a few extension points. Status:

1. **Trusted-tier descriptions in the profiler.** ✅ SHIPPED 2026-07-14.
   `SourceConnector.describeEntities?(config, selectedEntities, ctx)`
   returns `EntityDocs[]` (table/column docs + role hints + docs-derived
   relationships, with `provenance: 'declared' | 'curated'`). The
   profiler lands documented rows approved (`ai_draft=false`,
   `approval_status='approved'`, `semantic_source` provenance column on
   `source_tables`/`source_columns`, mirrored to Neo4j as
   `semanticSource`/`aiDraft` per the dual-write contract), skips
   documented columns in AI Pass C, and merges docs-derived
   relationships at the `declared` rung. Failure of the docs harvest
   degrades to the AI pipeline (never fatal).
2. **Odoo `fields_get` harvest.** ✅ SHIPPED 2026-07-14. Transports
   request `string`/`help`/`relation`; `describeEntities` maps `help` →
   column description (verbatim), `string` → display label, many2one
   `relation` → declared relationships + synthesised FK descriptions,
   field type → measure/dimension role hints. Covers customer custom
   fields automatically. Curated one-line descriptions added for all
   21 allowlisted entities.
3. **ExactOnline column-docs curation.** ✅ SHIPPED 2026-07-14. All 61
   catalog entities transcribed DETERMINISTICALLY from the EO REST
   reference (an HTML-table parser over the details pages — no model in
   the transcription loop, verbatim by construction): 2,613 documented
   columns in the generated `exactonline/docs.ts`, served statically by
   `ExactOnlineConnector.describeEntities` at `provenance: 'curated'`.
   Role hints derived from Edm types (Double/Decimal → measure;
   Guid/String/Boolean/DateTime → dimension; integers → no hint).
   Relationships intentionally not duplicated (static catalog already
   flows through `getKnownRelationships`). Columns EO adds later fall
   back to the AI pipeline. `exactonline/docs.test.ts` is the
   conformance gate (keys ⊆ catalog, names safe, descriptions
   non-empty, coverage thresholds). One caveat: `TimeCostTransactions`
   has no standalone REST docs page — transcribed from the Sync API
   variant (`SyncProjectTimeCostTransactions`, same data model,
   `Timestamp` bookkeeping field excluded).
4. **Star-schema template contract.** ✅ SHIPPED 2026-07-14 (contract +
   platform integration + Odoo template v1 + ExactOnline template v1).
   `SourceConnector.getStarSchemaTemplate()` returns a versioned
   `StarSchemaTemplate` (conformed dims + facts with per-table
   `sourceEntities`, product groupings, relationships, KPIs — mirrors the
   bus-matrix design shape). `instantiateStarSchemaTemplate` implements
   graceful degradation (drop uncovered tables, repair relationships /
   product groupings / dim ownership / build order, drop KPIs whose
   required tables dropped; null when no fact survives → AI fallback).
   Backend: the "Prepare my data" bus-matrix workflow now tries the
   template FIRST (`services/starSchemaTemplates.ts` maps it onto
   `BusMatrixOutput`; validation, `buildBusMatrix` persistence and the
   transformation phases run unchanged) — the AI designer is officially
   the fallback. `data_products.template_version` records provenance
   (NULL = AI-designed). Escape hatch:
   `STAR_SCHEMA_TEMPLATES_DISABLED=1`. Odoo template v1: 9 conformed
   dims, 6 facts (invoice lines, journal items, sales/purchase order
   lines, payments, stock moves), 5 products, 33 relationships, 5 KPIs —
   validated structurally against the catalog AND executed end-to-end in
   DuckDB against synthetic Odoo tables in the package test suite
   (`odoo/starSchemaTemplate.test.ts`), incl. the credit-note sign
   convention. Template SQL targets modern Odoo (16+); facts never JOIN
   dims (natural FK ids), so a dropped dim can't break a surviving fact.
5. **New conformance checks.** ✅ SHIPPED 2026-07-14. The generic suite
   (`conformance.ts` + `conformance.test.ts`) now enforces, for every
   registered connector: every catalog entity has a non-empty
   `description` (playbook Phase C), `getKnownRelationships` endpoints
   connect catalogued entities with safe column names and valid
   cardinalities (`validateKnownRelationships`), and any shipped
   star-schema template passes `validateStarSchemaTemplate` against its
   own catalog. The EO template test additionally proves every column
   lineage points at a field present in the vendor-docs transcription
   ("no guessed field names", enforced in code).

**ExactOnline template v1 notes** (authored 2026-07-14 from the docs.ts
transcription): 6 conformed dims (account, item, item_group, gl_account,
journal [code-keyed], payment_condition [code-keyed]), 6 facts
(fact_sales_invoice_lines, fact_transaction_lines, fact_sales_order_lines,
fact_purchase_order_lines, fact_receivables, fact_payables), 4 products
(Core dimensions → Finance → Sales → Purchasing), 25 relationships, 4 KPIs.
EO-specific conventions honoured: credit notes are NATIVELY NEGATIVE (no
sign-flip measure, unlike Odoo), `*DC` amounts are division-currency
(cross-currency additive), dates TRY_CAST from the ISO strings the
connector writes, GUIDs stay raw VARCHAR FK columns marked technical.
No dim_gl_classification: the vendor docs show GLAccounts carries no
GLClassification field, so the static known-relationship for it never
matches — dropped from the template rather than shipping a dead dim.

Known limitation of the shipped profiler integration: re-profiling
still rebuilds all rows, so a HUMAN-edited description is overwritten
by the next profile run (pre-existing behaviour, now also true for the
docs rung). The "human edit beats everything" rule from §1 needs
edit-tracking to enforce — tracked as follow-up work.
