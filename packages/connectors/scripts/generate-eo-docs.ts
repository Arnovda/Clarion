/**
 * generate-eo-docs — deterministic transcription of ExactOnline's REST API
 * reference into the Exact Online SOURCE PACKAGE (`src/exactonline/package/
 * datasets/<Entity>.yaml`, the `fields` list of each dataset).
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
 * type), the Edm type itself (`datatype`), and the FK target
 * (`clarion.references`) resolved from the docs hyperlink to our entity
 * catalog, with the target field taken from the target's key-marked
 * (data-key="True") property. Navigation properties are skipped.
 *
 * Only `fields` is rewritten: a dataset's label, description, source,
 * primary_key and `clarion` block are hand-curated and kept as they are.
 *
 * Run from packages/connectors:  npx --yes tsx@4.22 scripts/generate-eo-docs.ts
 * Then: review the diff, run `npm test`, commit the package together with
 * this script. Network access to start.exactonline.nl required (public pages).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { EXACT_ONLINE_ENTITIES } from '../src/exactonline/catalog';
import { toYaml } from '../src/sourcePackage/write';

/** The header every generated dataset file carries (kept in step with the package). */
const DATASET_HEADER = 'Exact Online entity. Field docs are TRANSCRIBED from the vendor REST reference by scripts/generate-eo-docs.ts — do not hand-edit descriptions; edit label/description/clarion freely.';

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

  // Emit: rewrite each dataset file's `fields` in the source package.
  const pkgDir = path.resolve(__dirname, '../src/exactonline/package');
  let totalCols = 0;
  let totalRefs = 0;
  const entityNames = [...parsedByEntity.keys()].sort();
  for (const entity of entityNames) {
    const file = path.join(pkgDir, 'datasets', `${entity}.yaml`);
    let existing: Record<string, unknown>;
    try {
      existing = parseYaml(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`no dataset file for ${entity} at ${file} — add the entity to the package first (name, label, description, source, primary_key, clarion), then re-run`);
    }
    const cols = [...parsedByEntity.get(entity)!].sort((a, b) => a.name.localeCompare(b.name));
    const fields: Array<Record<string, unknown>> = [];
    for (const c of cols) {
      if (!c.description) continue; // undocumented → AI pipeline handles it
      totalCols++;
      const ext: Record<string, unknown> = {};
      const role = roleFor(c.edmType);
      if (role) ext.role = role;
      // FK reference — only when the docs hyperlink resolves to an entity
      // in OUR catalog (targets we don't sync can't be relationship ends),
      // and never for the primary key itself (its docs link is self-noise).
      if (c.targetDocsName && !c.isKey) {
        const targetEntity = entityByDocsName.get(c.targetDocsName);
        if (targetEntity) {
          ext.references = { dataset: targetEntity, field: keyColByEntity.get(targetEntity) ?? 'ID' };
          totalRefs++;
        }
      }
      const field: Record<string, unknown> = { name: c.name, description: c.description, datatype: c.edmType };
      if (Object.keys(ext).length > 0) field.clarion = ext;
      fields.push(field);
    }
    // Canonical key order; everything but `fields` is kept verbatim.
    const updated: Record<string, unknown> = {};
    for (const k of ['name', 'label', 'description', 'source', 'primary_key']) if (existing[k] !== undefined) updated[k] = existing[k];
    if (fields.length > 0) updated.fields = fields;
    updated.clarion = existing.clarion;
    await fs.writeFile(file, toYaml(updated, DATASET_HEADER), 'utf8');
  }

  // Stamp the transcription date on the manifest.
  const manifestPath = path.join(pkgDir, 'package.yaml');
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  await fs.writeFile(manifestPath, manifestText.replace(/transcribed: \d{4}-\d{2}-\d{2}/, `transcribed: ${today}`), 'utf8');

  console.log(`\nrewrote ${entityNames.length} dataset files under ${pkgDir}`);
  console.log(`entities: ${entityNames.length}, documented columns: ${totalCols}, FK references: ${totalRefs}`);
  if (totalCols < 1000) throw new Error('sanity check failed: fewer than 1000 documented columns');
}

main().catch((e) => { console.error(e); process.exit(1); });
