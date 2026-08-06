# The dimensional model

> One doctrine, obeyed by both paths that build a star schema in Clarion:
> the deterministic connector templates and the AI designer.
>
> Read this before changing a `starSchemaTemplate.ts`, `starSchemaPrompt.ts`,
> `busMatrixPrompt.ts`, or the transformation checks.

## Why this document exists

Clarion had two contradictory doctrines. The connector templates built a
**natural-key star**; the AI prompts instructed the model to generate
`ROW_NUMBER()` **surrogate keys**. Which one a customer got depended on
whether a template happened to match their source. Nobody had written down
which was correct, so neither could be wrong, and both drifted.

The doctrine below is the answer. It is enforced by
`validateStarSchemaTemplate` for templates and stated in the prompts for the
AI path — but the reasoning lives here, because a rule whose reason is
missing gets "simplified" away by the next person.

---

## 1. Keys are durable, never positional

**Every dimension is keyed on the source system's own identifier** — an
ExactOnline GUID, an Odoo integer id, a journal code — aliased `{entity}_id`.
Facts carry that same value. There is no generated surrogate key.

**Never `ROW_NUMBER()`.** Not as a convenience, not "just for this dim". The
reason is specific to how this platform stores product tables:

1. Product tables are **overwritten in full** on every refresh
   (`etl/scd2/commit_table.py` writes `mode="overwrite"`).
2. A positional key is therefore regenerated from scratch each time. Insert
   one row upstream and every key after it shifts.
3. Facts and dimensions can be **refreshed independently** — Manage mode has a
   per-table *Run* button.

Put those together and a dimension rebuilt on its own silently re-points every
fact that references it. No error. No failed check. Just revenue attributed to
the wrong customer. That is the worst failure mode a BI platform has, and a
surrogate key is what buys it.

The classical arguments for surrogate keys mostly do not apply here:

| Argument | Status in Clarion |
|---|---|
| Tracks dimension history (SCD2) | Not applicable — the writer is Type 1 only |
| Narrow integer joins are faster | Not measurable — DuckDB dictionary-encodes strings |
| Insulates against source re-keying | GUIDs and Odoo ids are stable |
| Conforms keys across two source systems | No product spans two sources today |

**When a surrogate key does become necessary — SCD2 — it must be DURABLE**: a
hash of the natural key, or a persisted mapping table that is never
regenerated. A positional key would be wrong then too, only more so.

### The one exception: the calendar

`dim_date.date_key` is an `INTEGER` in `YYYYMMDD` form, derived from the date
itself. It is generated, but it is **not positional** — the same date always
produces the same key, so it is stable across rebuilds by construction. That
is what makes it safe, and it is the only reason it is allowed.

Facts reference it with one key per **date role**:

```sql
COALESCE(TRY_CAST(strftime(TRY_CAST(InvoiceDate AS DATE), '%Y%m%d') AS INTEGER), -1) AS invoice_date_key
```

Use `dateKeyExpr()` from `packages/connectors/src/starSchema.ts` rather than
writing it out. Keep the raw `DATE` column alongside the key — the key is what
the star joins on; the date is what an exact-date filter uses.

---

## 2. Every dimension carries an unknown member

One extra row per dimension, keyed `-1` (or `'-1'` for text keys), labelled
`Unknown`, appended with `UNION ALL`. Every **fact** foreign key is
`COALESCE`'d onto it.

This is not decoration. A `NULL` foreign key **disappears from an inner join**.
The AI will write inner joins. So will a dashboard. The result is a total that
is quietly missing the rows whose reference was empty — no error anywhere, and
the shortfall is invisible unless you already know the right answer.

Both source systems make this common: ExactOnline leaves optional references as
empty GUIDs, Odoo leaves unset many2one fields false/NULL.

Use `withUnknownMember()` rather than hand-writing the `UNION ALL`; it emits
typed literals in declared-column order, which is what keeps the row's types
matching the base query.

**Dimension-to-dimension references are NOT coalesced.** On a dimension a null
reference usually means *genuinely none* — a partner with no parent company —
rather than *unknown*. Collapsing the two would invent a hierarchy edge that
does not exist, and dim-to-dim joins are not where measures go missing.

---

## 3. Facts do not join dimensions at build time

A fact's SQL reads its own source entities and nothing else. It carries the
same durable id the dimension is keyed on, so the join is fully available at
**query** time without one at **build** time.

Two things follow, both valuable:

- A dimension that was never synced cannot break a fact that survives. This is
  what makes `instantiateStarSchemaTemplate`'s graceful degradation possible.
- There is no build-order coupling between a fact and the dimensions it
  references beyond the calendar.

---

## 4. Everything a fact declares, it can reach

`dimensionsUsed` and the relationship rows must agree in both directions:

- every dimension in `dimensionsUsed` has at least one relationship from that
  fact to it, and
- every dimension the fact has a relationship to appears in `dimensionsUsed`.

Enforced by `validateStarSchemaTemplate`, which runs in each connector's test
suite.

This exists because of a real defect: all twelve facts across both templates
declared `dim_date` in `dimensionsUsed`, and **not one of them had a
relationship to it**. The calendar showed up in the product, in the catalog,
and on the topic page's break-down line, while the query layer had no idea how
to reach it. The entire conformance suite passed. A rule that only lives in
review is a rule that ships broken.

---

## 5. The rest of the Kimball rules

Unchanged and uncontroversial, listed so there is one place to look:

- **Grain first.** Every fact declares "One row per …" and every column is true
  to it.
- **Fact types**: transaction, periodic snapshot, accumulating snapshot,
  factless.
- **Measures** are classified additive / semi-additive / non-additive. Ratios
  are stored as numerator + denominator, divided in the BI layer.
- **Degenerate dimensions** — invoice numbers, order numbers — stay on the fact
  as plain columns.
- **No snowflaking.** Fold lookups into their parent dimension; keep one flat
  table per entity.
- **No text attributes on facts.** They belong on a dimension.
- **SCD Type 1** only. Type 2 is a backlog design (`docs/backlog/SCD2.md`), not
  a supported shape.

---

## 6. Where this is enforced

| Rule | Enforced by |
|---|---|
| No generated surrogate keys | `validateStarSchemaTemplate` (templates); prompt text (AI) |
| Unknown member on every dim | `validateStarSchemaTemplate`; prompt text |
| Facts reach every dim they declare | `validateStarSchemaTemplate` |
| Calendar relationships target `date_key` | `validateStarSchemaTemplate` |
| Foreign keys actually resolve | `transformationChecks.checkReferentialIntegrity`, at build time, per table |

The last one is the only check that sees **real customer data**, so it is the
one that catches what static validation cannot. It reports three outcomes, and
the distinction matters: `pass` (every key resolved), `fail` (orphans found,
with samples), and `error` (a target dimension could not be read — *unverified*,
which must never be reported as clean).
