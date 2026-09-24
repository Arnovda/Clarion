# Source packages

A **source package** is one declarative description of a source system, as data:
what the vendor exposes (datasets and their fields), what we know about how it
joins (relationships), what Clarion builds from it (the star-schema template)
and what it means (descriptions and notes). Since 2026-09-20 it is the only
place the platform's knowledge of Exact Online and Odoo lives; the connector
code is transport plus a thin loader (`src/<connector>/catalog.ts`).

Why: the same knowledge used to be ~5,800 lines of TypeScript across two
connectors. Facts belong in a file a reviewer can diff and a generator can
write. Source #50 then has the same shape as source #1
(`docs/backlog/ingestion-chain-assessment.md` §7 phase 5, E1).

## Layout

```
src/<connector>/package/
├── package.yaml          manifest: version, name, vendor, provenance,
│                         fieldCoverage, categories, curated relationships,
│                         metrics, template products
├── datasets/<Entity>.yaml   one SOURCE dataset each (kind: source)
└── model/<table>.yaml       one MODELLED dataset each (kind: dimension | fact)
```

`loadSourcePackage(dir)` merges the files into one document, validates it
(`schema.json` for shape, `validate.ts` for every cross-reference) and orders
datasets canonically: source datasets by `clarion.categories` then name, then
dimensions, then facts. A package that does not validate throws at import —
CI's conformance suite first, the backend's boot second, never a sync.

The build copies the YAML into `dist/` (`scripts/copy-package-data.mjs`), so
`path.join(__dirname, 'package')` resolves from compiled code as from `src`.

## Vocabulary: Apache Ossie for the shared part, `clarion` for ours

The shared keys are Apache Ossie's, verbatim (checked against
`core-spec/ossie-schema.json`, 2026-09-20):

| Ossie object | keys used here |
|---|---|
| model | `version` · `name` · `description` · `datasets` · `relationships` · `metrics` |
| dataset | `name` · `description` · `source` · `primary_key` · `fields` |
| field | `name` · `label` · `description` · `datatype` · `expression` |
| relationship | `name` · `from` · `from_columns` · `to` · `to_columns` |
| metric | `name` · `description` · `expression` · `datatype` |

Everything Clarion-specific sits under a `clarion` key on the object it
describes. Three **superset** keys sit at object level because they are what a
human reads first and Ossie has no word for them: `label` on a dataset,
`description` and `cardinality` on a relationship. `expression` on a source
field is optional (it equals `name`).

Nobody authors *in* Ossie; every tool keeps its own model and exports. The
export adapter is deliberately not built (no customer has Ossie semantics to
import yet). When one asks, it is a formatting step:

1. fold each `clarion` map into `custom_extensions: [{ vendor_name: clarion, data: JSON.stringify(clarion) }]`;
2. move the superset keys into that extension (or `label` → a field-level equivalent);
3. fill `expression: <name>` on source fields; derive `name` on relationships;
4. drop `fieldCoverage` / `categories` (loader concerns).

## What is derived, so it is written once

| written once | derived |
|---|---|
| `clarion.sync.cursor` on a source dataset | `supportsIncremental` |
| `primary_key: [X]` | `businessKey` |
| a fact's foreign-key field with `clarion.references` | every template relationship (`fact_to_dim` off a fact, `dim_to_dim` off a dimension) and the fact's `dimensionsUsed` (unless listed — `dim_date` can never be derived) |
| `clarion.product` on a modelled dataset | each product's `factTables` / `ownedDimensions` |
| `clarion.categories` on the manifest | the wizard's category order |

## Hard and soft

Descriptions, types, keys and joins are the HARD part: the profiler persists
them at the trusted rung (`declared` / `curated`). `clarion.notes` (Markdown,
on the package, a dataset, a field or a metric) is the SOFT part: caveats,
"why", how to tell two similar things apart. A dataset's notes reach the schema
profiler's prompts through `EntityDocs.notes` (Pass B table context, Pass C
column descriptions) and are never written as a description.

## Two switches every package must set

- `clarion.fieldCoverage: complete | partial` — are the field lists the whole
  column set (Exact Online: a full transcription, so a lineage or relationship
  naming an unlisted field is an error) or a documented subset (Odoo: the
  curated fallback beneath the live `fields_get` harvest, so a missing name
  proves nothing)? Decides which cross-checks run.
- `clarion.provenance: curated | declared` — the rung the documented fields
  land on.

## Working with a package

- **Exact Online field docs** are generated: `npx --yes tsx@4.22
  scripts/generate-eo-docs.ts` rewrites each dataset's `fields` from the
  vendor's REST reference and leaves label/description/clarion alone.
- **Adding an entity**: one file under `datasets/` with name, label,
  description, `source` (API path / model), `primary_key`, `clarion.kind:
  source`, category and cursor. The conformance suite holds it to the format.
- **Changing the template**: edit the table's file under `model/`. A join is
  written once, on the fact's FK field. Keys follow the key rule
  (`../keys.ts`): a dim's `<x>_key` is `clarion_key('<Entity>', <id>)`, a
  fact's FK is the same call on its own column — both `BIGINT`. Bump `clarion.template.version` on a
  shape change — customers stay on the version they materialised.
- **Format changes**: `types.ts` + `schema.json` + `validate.ts` together, and
  `sourcePackage.test.ts` pins both directions.
