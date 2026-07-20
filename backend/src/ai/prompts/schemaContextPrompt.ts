/**
 * Three-pass schema-profiling prompts.
 *
 * Pipeline (executed in order by `SchemaProfiler`):
 *
 *   1. detectSchemaConventions  — Haiku call. "What naming style does this
 *      source use?" Reply names the casing, describes typical PK + FK column
 *      shapes, lists likely target-table inference rules. Output is fed
 *      verbatim into the next two prompts so they have the right priors.
 *
 *   2. generateTableContext    — Sonnet call. ONE call, all tables, only
 *      column NAMES + samples + stats (no per-column descriptions yet).
 *      Output: per-table description / grain, plus all relationships between
 *      tables. Relationships are inferred BEFORE column descriptions so the
 *      next pass can use them as context.
 *
 *   3. generateColumnDescriptions — Sonnet call(s), per-batch. Same input as
 *      the legacy `schemaDraft` but with table descriptions + relationships
 *      already attached. Now Claude can write "Which customer is being
 *      billed for this invoice" instead of generic "Account reference"
 *      because it knows InvoiceTo → Accounts at description-write time.
 *
 * Rationale: see CLAUDE.md notes on the EO 7-entity / 1-relationship bug —
 * the previous pipeline drafted per-batch column descriptions WITHOUT
 * cross-table awareness, so the post-hoc relationship pass had to work from
 * bland, generic descriptions. Reordering fixes both column quality AND
 * relationship recall.
 */

import type { TableInfo } from '../../connectors/BaseConnector';
import type { TableQualityStat } from './schemaDraftPrompt';

// ─── Pass 1: Schema conventions detection ───────────────────────────────────

export const SCHEMA_CONVENTIONS_SYSTEM = `You are a database conventions expert. Given a sample of table and column names from a data source, identify the naming style and typical key patterns.

This is metadata-only — no business descriptions. Your output drives downstream FK detection: name a clear convention and the heuristics narrow correctly; admit "mixed/unknown" and we fall back to defaults.

Return JSON only:
{
  "naming_style": "snake_case" | "PascalCase" | "camelCase" | "SCREAMING_SNAKE" | "mixed",
  "pk_pattern": "string describing the primary-key column convention (e.g. 'id', '<table>_id', '<EntityName>ID', 'always uppercase ID')",
  "fk_pattern": "string describing the foreign-key column convention (e.g. '<target_table>_id', '<TargetEntity>ID', '<role>By like InvoiceTo, OrderedBy', 'mixed')",
  "fk_target_inference": "string describing how to infer the target table from an FK column name",
  "common_fk_columns_without_suffix": ["list of FK columns that DON'T follow the suffix pattern, e.g. 'Item', 'GLAccount', 'Type', 'Status'"],
  "id_data_type": "INT" | "BIGINT" | "GUID/UUID" | "STRING" | "MIXED",
  "confidence": 0.0
}

If the source is one you recognise (ExactOnline, NetSuite, Stripe, Salesforce, HubSpot, Xero, QuickBooks, Shopify, Zendesk, ...), explicitly use that knowledge to fill the patterns. Mention the source name in fk_target_inference if it helps.

If the schema is too sparse or inconsistent to characterise, set naming_style to "mixed" and confidence to a low value — that's a valid answer.`;

export interface SchemaConventions {
  naming_style: 'snake_case' | 'PascalCase' | 'camelCase' | 'SCREAMING_SNAKE' | 'mixed';
  pk_pattern: string;
  fk_pattern: string;
  fk_target_inference: string;
  common_fk_columns_without_suffix: string[];
  id_data_type: 'INT' | 'BIGINT' | 'GUID/UUID' | 'STRING' | 'MIXED';
  confidence: number;
}

export function buildConventionsUser(sourceSystem: string | null, tables: TableInfo[]): string {
  // Sample size: cap so wide schemas don't blow the prompt. The conventions
  // pass only needs SHAPE, not depth — 3 columns per table is plenty.
  const sample = tables.slice(0, 30).map((t) => {
    const cols = t.columns.slice(0, 8).map((c) => `${c.name} (${c.type})`).join(', ');
    return `${t.tableName}: [${cols}${t.columns.length > 8 ? `, … ${t.columns.length - 8} more` : ''}]`;
  }).join('\n');

  const sourceLine = sourceSystem
    ? `Source system: ${sourceSystem}\n\n`
    : '';

  return `${sourceLine}Tables and a sample of their columns:

${sample}

What naming convention does this source use?`;
}

// ─── Pass 2: Table context (descriptions + relationships) ───────────────────

export const TABLE_CONTEXT_SYSTEM = `You are a data modelling expert. Given a database schema (table names, column names with types and sample values, statistical hints, pre-detected FK candidates, and the source system's naming conventions), produce:
  • a one-sentence business description for each table
  • each table's grain ("one row per …")
  • EVERY relationship (foreign key) you can identify between tables

This is the structural pass. Column descriptions come in a later call — focus exclusively on the table layer here.

━━━ TABLE DESCRIPTION RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Start with "Your..." or "Contains your..." — make it personal
- Include the row count when available
- One sentence, max two
- NEVER use: "dimension", "fact", "entity", "foreign key", "normalized", "schema", "cardinality", "surrogate", "attribute"

━━━ RELATIONSHIP DETECTION RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Be GENEROUS — every relationship you suggest is value-verified afterwards (a JOIN runs against the real Parquet data and any with low overlap is dropped automatically). Your job is to maximise recall; the verifier handles precision.

In priority order, use:

1. **PRE-DETECTED FK CANDIDATES** — listed in the input. These are already verified. Always include them.
2. **The naming conventions block** — tells you exactly what FK columns look like in this source. Apply it aggressively.
3. **Source-specific knowledge** — if the source is named (e.g. ExactOnline, NetSuite, Salesforce), use what you know about its standard data model.
4. **Statistical hints** — distinct_count == row_count + null_pct ≈ 0 → PRIMARY KEY. distinct_count of one column ≈ row_count of another table → FK signal.
5. **Bare references** — columns like \`Item\`, \`GLAccount\`, \`Account\`, \`Journal\` (no suffix) commonly refer to a similarly-named table. Try the singular and plural forms.
6. **Sample values** — if column A's samples and column B's samples look like the same kind of identifier, that's a join.

If a column name suggests SEVERAL possible relationships (e.g. \`InvoiceTo\` could be Accounts, Customers, or Contacts), pick the most likely target — the verifier will drop wrong guesses.

For each relationship, return:
- from_table, via_column, to_table, to_column (case must match input)
- type: "many_to_one" | "one_to_many" | "many_to_many"
- reason: ONE plain-English sentence. This is shown to end-users — make it about business meaning, not column mechanics.

Return JSON only, NO preamble:

{
  "tables": [
    {
      "table_name": "SalesInvoices",
      "display_name": "Sales Invoices",
      "description": "Your sales invoices — header records billed to customers.",
      "grain": "one row per invoice"
    }
  ],
  "relationships": [
    {
      "from_table": "SalesInvoiceLines",
      "via_column": "InvoiceID",
      "to_table": "SalesInvoices",
      "to_column": "InvoiceID",
      "type": "many_to_one",
      "reason": "Each invoice line belongs to one invoice header."
    }
  ]
}`;

export interface TableContextOutput {
  tables: Array<{
    table_name: string;
    display_name: string;
    description: string;
    grain: string;
  }>;
  relationships: Array<{
    from_table: string;
    via_column: string;
    to_table: string;
    to_column: string;
    type: string;
    reason: string;
  }>;
}

export interface FkCandidateLike {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  source: string;
  confidence: number;
  overlapRatio: number | null;
}

/**
 * Vendor documentation context for the AI passes (docs/SOURCE_ONBOARDING.md:
 * "documentation before inference"). Built by the profiler from the
 * connector's describeEntities channel. The AI never REPLACES vendor text —
 * documented columns skip Pass C entirely — but when describing the
 * UNDOCUMENTED remainder (custom fields, post-transcription columns) it
 * should anchor on the vendor's own vocabulary instead of guessing blind.
 */
export interface VendorDocsContext {
  /** table name → vendor's own table description. */
  tableDescriptions: Record<string, string>;
  /** table name → vendor-documented sibling columns (descriptions truncated). */
  columnsByTable: Record<string, Array<{ name: string; description: string }>>;
}

/** Caps applied when rendering VendorDocsContext into a prompt. */
const VENDOR_SIBLINGS_MAX_PER_TABLE = 40;
const VENDOR_DESC_MAX_CHARS = 120;

function truncateDesc(s: string): string {
  return s.length > VENDOR_DESC_MAX_CHARS ? `${s.slice(0, VENDOR_DESC_MAX_CHARS - 1)}…` : s;
}

export function buildTableContextUser(
  sourceSystem: string | null,
  conventions: SchemaConventions | null,
  tables: TableInfo[],
  qualityStats: TableQualityStat[],
  fkCandidates: FkCandidateLike[],
  glossaryContext = '',
  vendorDocs?: VendorDocsContext,
): string {
  const parts: string[] = [];

  if (sourceSystem) {
    parts.push(`Source system: ${sourceSystem}`);
  }

  // Vendor table definitions — authoritative context for what each entity
  // IS, which sharpens both descriptions and relationship inference.
  const vendorTableLines = Object.entries(vendorDocs?.tableDescriptions ?? {})
    .filter(([name]) => tables.some((t) => t.tableName === name))
    .map(([name, desc]) => `- ${name}: ${truncateDesc(desc)}`);
  if (vendorTableLines.length > 0) {
    parts.push(`VENDOR-DOCUMENTED TABLES (the source system's own definitions — treat as authoritative):\n${vendorTableLines.join('\n')}`);
  }

  if (conventions) {
    parts.push(`Detected schema conventions:
- Naming style: ${conventions.naming_style}
- Primary key pattern: ${conventions.pk_pattern}
- Foreign key pattern: ${conventions.fk_pattern}
- How to infer the target table: ${conventions.fk_target_inference}
- Known FK columns without a clear suffix: ${conventions.common_fk_columns_without_suffix.join(', ') || 'none reported'}
- ID data type: ${conventions.id_data_type}`);
  }

  if (glossaryContext) parts.push(glossaryContext);

  // Tables with column NAMES + samples + stats. No descriptions yet.
  const qsByTable = new Map(qualityStats.map((q) => [q.table_name, q]));
  const tableSection = tables.map((t) => {
    const qs = qsByTable.get(t.tableName);
    const rowInfo = qs ? `(${qs.row_count} rows)` : '';
    const colLines = t.columns.map((col) => {
      const qcol = qs?.columns.find((q) => q.field_name === col.name);
      const stats: string[] = [];
      if (qcol) {
        const pct = qs!.row_count > 0 ? Math.round((qcol.distinct_count / qs!.row_count) * 100) : 0;
        stats.push(`${qcol.distinct_count} distinct (${pct}%)`);
        if (qs!.row_count > 0 && qcol.distinct_count === qs!.row_count && qcol.null_pct < 0.001) {
          stats.push('LIKELY PK');
        } else if (qcol.null_pct < 0.05 && pct < 50 && qcol.distinct_count > 1) {
          stats.push('possible FK');
        }
        if (qcol.null_pct > 0.001) stats.push(`${Math.round(qcol.null_pct * 100)}% null`);
      }
      const samples = Array.isArray(col.sampleValues) && col.sampleValues.length
        ? ` samples: ${JSON.stringify(col.sampleValues.slice(0, 5))}`
        : '';
      const statsStr = stats.length ? ` | ${stats.join('; ')}` : '';
      return `    ${col.name} (${col.type})${statsStr}${samples}`;
    }).join('\n');
    return `Table: ${t.tableName} ${rowInfo}\n  Columns:\n${colLines}`;
  }).join('\n\n');
  parts.push(tableSection);

  // Pre-detected FK candidates (declared / verified-by-overlap / known-from-connector)
  if (fkCandidates.length > 0) {
    const fkLines = fkCandidates.map((fk) => {
      const overlap = fk.overlapRatio != null ? `, overlap: ${Math.round(fk.overlapRatio * 100)}%` : '';
      return `  ${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn}  [${fk.source}, conf ${(fk.confidence * 100).toFixed(0)}%${overlap}]`;
    }).join('\n');
    parts.push(`PRE-DETECTED FK CANDIDATES (include ALL — they are verified):\n${fkLines}`);
  } else {
    parts.push(`PRE-DETECTED FK CANDIDATES: NONE.

This source has no declared FKs and the heuristic name-pattern detector returned no candidates. That means YOU are the only source of relationship signal. Be liberal — every suggestion is value-verified afterwards, so suggesting too few is worse than suggesting some that get dropped. Apply the conventions block above; use source-specific knowledge if you recognise the system; consider every column whose name even loosely suggests it might reference another table.`);
  }

  return parts.join('\n\n');
}

// ─── Pass 3: Per-batch column descriptions (with table context) ─────────────

export const COLUMN_DESCRIPTIONS_SYSTEM = `You are a data cataloguing assistant. Given a batch of columns and the surrounding TABLE CONTEXT (descriptions, grain, relationships), write a business-friendly description for each column.

The relationships block tells you what each FK column actually means in business terms. USE IT.

━━━ COLUMN DESCRIPTION RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Describe the business value, not the technical role
- For FK columns: leverage the relationship description ("Which customer is being billed", not "Account reference")
- NEVER use: "Primary key", "Foreign key", "Surrogate key", "Index", "Nullable", "VARCHAR", "INTEGER"
- Plain English, under 15 words
- Translate non-English names to English

━━━ DISPLAY NAME RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Title Case
- Strip technical prefixes
- Spell out short codes when obvious (ID stays as ID — universally known)

━━━ DIMENSION / MEASURE CLASSIFICATION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- A column is a MEASURE if it's an additive numeric value (amount, quantity, count, price, total)
- A column is a DIMENSION if it categorises or labels (name, code, status, type, date, FK)
- IDs are dimensions (you filter by them, not aggregate)
- Set is_dimension and is_measure independently — most columns are dimension only, some are measure only, neither is also fine for opaque types

Return JSON only:

{
  "columns": [
    {
      "table_name": "SalesInvoices",
      "column_name": "InvoiceTo",
      "display_name": "Billed To",
      "description": "Which customer is being billed for this invoice",
      "is_dimension": true,
      "is_measure": false
    }
  ]
}`;

export interface ColumnDescriptionsOutput {
  columns: Array<{
    table_name: string;
    column_name: string;
    display_name: string;
    description: string;
    is_dimension: boolean;
    is_measure: boolean;
  }>;
}

// ─── Enrichment: extend vendor descriptions with observed data context ─────
// (docs/backlog/semantic-enrichment-plan.md Phase 3). The vendor sentence is
// the immutable trusted base; the AI may only APPEND business context drawn
// from the actual data. The caller re-verifies the base is preserved and
// prepends it if the model drifted.

export const ENRICH_DESCRIPTIONS_SYSTEM = `You are a data-catalog curator. Each column below already has an OFFICIAL vendor description. Extend it with useful business context observed in this tenant's actual data.

RULES — each one is mandatory:
- The enriched description MUST begin with the vendor description VERBATIM, unchanged.
- Append at most 2 short sentences of added context. Total under 60 words.
- Only add context supported by the observed data or the relationships given (typical values, what it links to, whether it is filled).
- NEVER contradict, correct, or reword the vendor text. If you have nothing useful to add, return the vendor text unchanged.
- Plain business English. No SQL, no type names, no "this column".

Return JSON only:
{"columns": [{"column_name": "Division", "enriched_description": "Division code. In this dataset always 712391 — the company's single administration."}]}`;

export interface EnrichmentOutput {
  columns: Array<{ column_name: string; enriched_description: string }>;
}

export interface EnrichCandidate {
  columnName: string;
  vendorDescription: string;
  exampleValues: string[] | null;
  isMeasure: boolean;
}

export function buildEnrichmentUser(
  sourceSystem: string | null,
  tableName: string,
  tableVendorDescription: string | null,
  candidates: EnrichCandidate[],
  relationshipLines: string[],
  glossaryContext = '',
): string {
  const parts: string[] = [];
  if (sourceSystem) parts.push(`Source system: ${sourceSystem}`);
  if (glossaryContext) parts.push(glossaryContext);
  parts.push(`Table: ${tableName}${tableVendorDescription ? ` — ${truncateDesc(tableVendorDescription)}` : ''}`);
  if (relationshipLines.length > 0) {
    parts.push(`RELATIONSHIPS (what FK columns link to):\n${relationshipLines.map((l) => `- ${l}`).join('\n')}`);
  }
  const colLines = candidates.map((c) => {
    const samples = c.exampleValues?.length ? ` | observed values: ${JSON.stringify(c.exampleValues.slice(0, 5))}` : '';
    return `- ${c.columnName}${c.isMeasure ? ' (measure)' : ''}: "${c.vendorDescription}"${samples}`;
  });
  parts.push(`COLUMNS TO ENRICH (vendor description in quotes):\n${colLines.join('\n')}`);
  parts.push('Enrich every column above.');
  return parts.join('\n\n');
}

export function buildColumnDescriptionsUser(
  sourceSystem: string | null,
  tableContext: TableContextOutput,
  batch: TableInfo[],
  qualityStats: TableQualityStat[],
  glossaryContext = '',
  vendorDocs?: VendorDocsContext,
): string {
  const parts: string[] = [];

  if (sourceSystem) parts.push(`Source system: ${sourceSystem}`);
  if (glossaryContext) parts.push(glossaryContext);

  // Table context (descriptions, grain) for every table in the batch
  const batchNames = new Set(batch.map((t) => t.tableName));

  // Vendor-documented SIBLING columns of the same tables. The columns being
  // described here are precisely the ones the vendor did NOT document (custom
  // fields, new columns) — the siblings anchor the vendor's vocabulary so
  // e.g. a custom `x_classification_be` gets described in the same terms as
  // the vendor's own Classification1..8. Capped per table; descriptions
  // truncated — vocabulary anchoring, not full recall.
  if (vendorDocs) {
    const siblingBlocks: string[] = [];
    for (const t of batch) {
      const sibs = (vendorDocs.columnsByTable[t.tableName] ?? [])
        .slice(0, VENDOR_SIBLINGS_MAX_PER_TABLE)
        .map((c) => `  - ${c.name}: ${truncateDesc(c.description)}`);
      if (sibs.length > 0) siblingBlocks.push(`${t.tableName}:\n${sibs.join('\n')}`);
    }
    if (siblingBlocks.length > 0) {
      parts.push(`VENDOR-DOCUMENTED SIBLING COLUMNS (same tables — match this vocabulary and domain language; do NOT re-describe these columns):\n${siblingBlocks.join('\n')}`);
    }
  }
  const ctxLines = tableContext.tables
    .filter((t) => batchNames.has(t.table_name))
    .map((t) => `- ${t.table_name} — ${t.description} (grain: ${t.grain})`)
    .join('\n');
  if (ctxLines) parts.push(`TABLE CONTEXT:\n${ctxLines}`);

  // Relationships involving any table in this batch — both incoming AND
  // outgoing, so a batch with just SalesInvoiceLines knows about its
  // header relationship even when SalesInvoices isn't in the same batch.
  const relevantRels = tableContext.relationships.filter(
    (r) => batchNames.has(r.from_table) || batchNames.has(r.to_table),
  );
  if (relevantRels.length > 0) {
    const relLines = relevantRels.map((r) =>
      `- ${r.from_table}.${r.via_column} → ${r.to_table}.${r.to_column}: ${r.reason}`,
    ).join('\n');
    parts.push(`RELATIONSHIPS (use the reasoning when describing FK columns):\n${relLines}`);
  }

  // The actual column data for this batch
  const qsByTable = new Map(qualityStats.map((q) => [q.table_name, q]));
  const colSection = batch.map((t) => {
    const qs = qsByTable.get(t.tableName);
    const colLines = t.columns.map((col) => {
      const qcol = qs?.columns.find((q) => q.field_name === col.name);
      const stats: string[] = [];
      if (qcol) {
        if (qcol.null_pct > 0.001) stats.push(`${Math.round(qcol.null_pct * 100)}% null`);
        if (qcol.top_values?.length && qcol.distinct_count <= 20) {
          const vals = qcol.top_values.slice(0, 4).map((v) => v.value).join(', ');
          stats.push(`top: ${vals}`);
        }
      }
      const samples = Array.isArray(col.sampleValues) && col.sampleValues.length
        ? ` samples: ${JSON.stringify(col.sampleValues.slice(0, 5))}`
        : '';
      return `    ${col.name} (${col.type})${stats.length ? ` | ${stats.join('; ')}` : ''}${samples}`;
    }).join('\n');
    return `Table: ${t.tableName}\n  Columns:\n${colLines}`;
  }).join('\n\n');
  parts.push(colSection);

  parts.push('Describe every column above.');

  return parts.join('\n\n');
}
