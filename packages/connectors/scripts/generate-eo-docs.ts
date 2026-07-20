/**
 * generate-eo-docs — deterministic transcription of ExactOnline's REST API
 * reference into `src/exactonline/docs.ts`.
 *
 * Sources (vendor-published, no model in the loop — verbatim by construction):
 *   • Index:   https://start.exactonline.nl/docs/HlpRestAPIResources.aspx
 *              → maps each entity's apiPath to its docs details page name.
 *   • Details: HlpRestAPIResourcesDetails.aspx?name=<page>
 *              → one table row per property. Each row's checkbox input
 *                carries name / data-type / data-isnavigation / data-key;
 *                the property-name cell hyperlinks to the TARGET entity's
 *                docs page when the property is a foreign key; the last
 *                <td> is the description.
 *
 * Captured per column: description (verbatim), role hint (from the Edm
 * type), the Edm type itself, and — new since 2026-07-20 — the FK target
 * (`references`) resolved from the docs hyperlink to our entity catalog,
 * with `toColumn` taken from the target's key-marked (data-key="True")
 * property. Navigation properties are skipped.
 *
 * Run from packages/connectors:  npx tsx scripts/generate-eo-docs.ts
 * Then: review the diff, run `npm test`, commit docs.ts together with this
 * script. Network access to start.exactonline.nl required (public pages).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { EXACT_ONLINE_ENTITIES } from '../src/exactonline/entities';

const BASE = 'https://start.exactonline.nl/docs';

/** Entities whose docs page differs from the index mapping (or is absent). */
const MANUAL_OVERRIDES: Record<string, { docsName: string; excludeColumns?: string[] }> = {
  // No standalone REST docs page — same model as the Sync variant, which
  // additionally exposes a Timestamp cursor column our entity doesn't have.
  TimeCostTransactions: { docsName: 'SyncProjectTimeCostTransactions', excludeColumns: ['Timestamp'] },
  // The vendor's index lists this endpoint as singular `SupplierItem`;
  // our catalog syncs the plural set name.
  SupplierItems: { docsName: 'LogisticsSupplierItem' },
};

interface ParsedColumn {
  name: string;
  edmType: string;
  isKey: boolean;
  description: string;
  /** Docs page name of the FK target (from the name-cell hyperlink). */
  targetDocsName: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function fetchPage(url: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { headers: { 'User-Agent': 'clarion-docs-transcriber' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err) {
      if (attempt === 2) throw new Error(`fetch failed for ${url}: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error('unreachable');
}

/** Index page → map of apiPath (e.g. '/crm/Accounts') → docs page name. */
function parseIndex(html: string): Map<string, string> {
  const all = new Map<string, string[]>();
  // Anchor text restricted to [^<]* so a function row's anchor (whose next
  // cell holds ANOTHER link, not a path) can never bridge to a later row's
  // path cell.
  const re = /<a[^>]*class="Endpoints"[^>]*href="HlpRestAPIResourcesDetails\.aspx\?name=([A-Za-z0-9]+)"[^>]*>[^<]*<\/a><\/td>\s*<td>\s*\/api\/v1\/\{division\}([^<\s]+)\s*<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const [, docsName, apiPath] = m;
    const list = all.get(apiPath) ?? [];
    list.push(docsName);
    all.set(apiPath, list);
  }
  // A path can be listed several times: the entity-set page plus function
  // endpoints (docs names prefixed `Read…`, e.g. ReadPayrollEmployment
  // ContractFlexPhasesOnFocusDate). Prefer the non-function page.
  const map = new Map<string, string>();
  for (const [apiPath, names] of all) {
    const preferred = names.find((n) => !n.startsWith('Read')) ?? names[0];
    map.set(apiPath, preferred);
  }
  return map;
}

/** Details page → property rows (navigation properties skipped). */
function parseDetails(html: string): ParsedColumn[] {
  const out: ParsedColumn[] = [];
  // Rows are <tr ...> ... </tr>; only property rows contain the showget checkbox.
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(html)) !== null) {
    const row = rm[1];
    const input = /<input[^>]*class="showget"[^>]*>/.exec(row)?.[0]
      ?? /<input[^>]*type="checkbox"[^>]*data-type=[^>]*>/.exec(row)?.[0];
    if (!input) continue;
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(input)?.[1] ?? '';
    const colName = attr('name');
    const edmType = attr('data-type');
    if (!colName || !edmType) continue;
    if (attr('data-isnavigation') === 'True') continue;

    // FK target: an anchor to another details page inside the row (the
    // name cell). The Edm-type cell's anchor points at odata.org, so
    // filtering on the details-page href is unambiguous.
    const target = /<a[^>]*href=['"]HlpRestAPIResourcesDetails\.aspx\?name=([A-Za-z0-9]+)['"]/.exec(row)?.[1] ?? null;

    // Description: the LAST <td> of the row.
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((t) => t[1]);
    const description = tds.length > 0 ? stripTags(tds[tds.length - 1]) : '';

    out.push({
      name: colName,
      edmType,
      isKey: attr('data-key') === 'True',
      description,
      targetDocsName: target,
    });
  }
  return out;
}

/** Same role heuristic as the 2026-07-14 transcription. */
function roleFor(edmType: string): 'measure' | 'dimension' | undefined {
  if (edmType === 'Edm.Double' || edmType === 'Edm.Decimal') return 'measure';
  if (/^Edm\.(Guid|String|Boolean|DateTime|DateTimeOffset|Date)$/.test(edmType)) return 'dimension';
  return undefined; // integers: a line number and a quantity look the same
}

async function main() {
  console.log('fetching index…');
  const indexHtml = await fetchPage(`${BASE}/HlpRestAPIResources.aspx?SourceAction=10`);
  const indexMap = parseIndex(indexHtml);
  console.log(`index: ${indexMap.size} endpoint mappings`);

  // Resolve docs page per catalog entity.
  const docsNameByEntity = new Map<string, { docsName: string; excludeColumns: Set<string> }>();
  const missing: string[] = [];
  for (const e of EXACT_ONLINE_ENTITIES) {
    const override = MANUAL_OVERRIDES[e.name];
    const docsName = override?.docsName ?? indexMap.get(e.apiPath);
    if (!docsName) { missing.push(`${e.name} (${e.apiPath})`); continue; }
    docsNameByEntity.set(e.name, { docsName, excludeColumns: new Set(override?.excludeColumns ?? []) });
  }
  if (missing.length) {
    throw new Error(`no docs page found for: ${missing.join(', ')} — add MANUAL_OVERRIDES entries`);
  }

  // Reverse map: docs page name → OUR entity name (for FK target resolution).
  const entityByDocsName = new Map<string, string>();
  for (const [entity, { docsName }] of docsNameByEntity) entityByDocsName.set(docsName, entity);

  // Fetch + parse every details page (sequential + polite).
  const parsedByEntity = new Map<string, ParsedColumn[]>();
  for (const [entity, { docsName, excludeColumns }] of docsNameByEntity) {
    const html = await fetchPage(`${BASE}/HlpRestAPIResourcesDetails.aspx?name=${docsName}`);
    const cols = parseDetails(html).filter((c) => !excludeColumns.has(c.name));
    if (cols.length < 3) {
      throw new Error(`suspiciously few columns (${cols.length}) parsed for ${entity} (${docsName}) — page layout change?`);
    }
    parsedByEntity.set(entity, cols);
    console.log(`  ${entity} (${docsName}): ${cols.length} columns, ${cols.filter((c) => c.targetDocsName).length} linked`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // Key column per entity (for FK toColumn). Falls back to 'ID'.
  const keyColByEntity = new Map<string, string>();
  for (const [entity, cols] of parsedByEntity) {
    const key = cols.find((c) => c.isKey)?.name ?? (cols.some((c) => c.name === 'ID') ? 'ID' : null);
    if (key) keyColByEntity.set(entity, key);
  }

  // Emit docs.ts.
  let totalCols = 0;
  let totalRefs = 0;
  const entityNames = [...parsedByEntity.keys()].sort();
  const chunks: string[] = [];
  for (const entity of entityNames) {
    const cols = [...parsedByEntity.get(entity)!].sort((a, b) => a.name.localeCompare(b.name));
    const lines: string[] = [];
    for (const c of cols) {
      if (!c.description) continue; // undocumented → AI pipeline handles it
      totalCols++;
      const parts = [`name: ${JSON.stringify(c.name)}`, `description: ${JSON.stringify(c.description)}`];
      const role = roleFor(c.edmType);
      if (role) parts.push(`role: ${JSON.stringify(role)}`);
      parts.push(`dataType: ${JSON.stringify(c.edmType)}`);
      // FK reference — only when the docs hyperlink resolves to an entity
      // in OUR catalog (targets we don't sync can't be relationship ends),
      // and never for the primary key itself (its docs link is self-noise).
      if (c.targetDocsName && !c.isKey) {
        const targetEntity = entityByDocsName.get(c.targetDocsName);
        if (targetEntity) {
          const toColumn = keyColByEntity.get(targetEntity) ?? 'ID';
          parts.push(`references: { table: ${JSON.stringify(targetEntity)}, column: ${JSON.stringify(toColumn)} }`);
          totalRefs++;
        }
      }
      lines.push(`    { ${parts.join(', ')} },`);
    }
    chunks.push(`  ${entity}: [\n${lines.join('\n')}\n  ],`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const header = `/**
 * ExactOnline column documentation — transcribed from the vendor's REST API
 * reference (https://start.exactonline.nl/docs/HlpRestAPIResources.aspx),
 * one details page per entity. GENERATED — do not hand-edit individual
 * descriptions; regenerate with \`npx tsx scripts/generate-eo-docs.ts\`
 * (see docs/SOURCE_ONBOARDING.md Phase E2, Tier 2 curation).
 *
 * Consumed by \`ExactOnlineConnector.describeEntities\` at the \`curated\`
 * provenance rung: the schema profiler stores these approved and skips the
 * AI description pass for covered columns. Columns absent here (or added
 * by EO after transcription) simply fall back to the AI pipeline.
 *
 * Role hints are derived from the OData Edm type at generation time:
 * Double/Decimal → measure; Guid/String/Boolean/DateTime → dimension;
 * integers → no hint (a line number and a quantity look the same).
 *
 * \`dataType\` is the vendor-declared Edm type (informational). \`references\`
 * is the vendor-documented FK target — the docs pages hyperlink every FK
 * property to its target entity's page — resolved to OUR entity names and
 * key columns, and emitted as declared relationships by describeEntities.
 *
 * Transcribed ${today}. Entities: ${entityNames.length}, documented columns: ${totalCols}, FK references: ${totalRefs}.
 */

import type { ColumnDoc } from '../types';

export const EXACT_ONLINE_COLUMN_DOCS: Readonly<Record<string, readonly ColumnDoc[]>> = {
`;
  const out = header + chunks.join('\n') + '\n};\n';
  const outPath = path.resolve(__dirname, '../src/exactonline/docs.ts');
  await fs.writeFile(outPath, out, 'utf8');
  console.log(`\nwrote ${outPath}`);
  console.log(`entities: ${entityNames.length}, documented columns: ${totalCols}, FK references: ${totalRefs}`);
  if (totalCols < 1000) throw new Error('sanity check failed: fewer than 1000 documented columns');
}

main().catch((e) => { console.error(e); process.exit(1); });
