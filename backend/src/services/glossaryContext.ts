/**
 * Loads the tenant-wide business glossary and formats it for AI prompts.
 *
 * The glossary holds abbreviations and company-specific wordings ("QTD",
 * "Net New ARR", etc.) so the model can resolve these terms when a user
 * mentions them in a natural-language question.
 *
 * Since 2026-09-20 a term can also carry LINKS — its address in the topic
 * layer (`fact_receivables.outstanding_amount`, a table, a KPI; see
 * services/glossaryLinks.ts). With `links: true` the prompt states that
 * address as a fact, so the model no longer has to guess which of four
 * similar amount columns "openstaande vordering" is. Callers pass it only
 * for PRODUCT-layer prompts: the addresses are product-table names, and a
 * source-layer prompt's schema does not contain them.
 *
 * Used by NL→SQL prompts (source + DuckDB), dashboard generation, and
 * schema draft prompts. Returns an empty string when the glossary is empty
 * — callers can safely concatenate the result without checking.
 *
 * Reads go through `tenantQuery`, not the bare pool: under the production
 * RLS role a pooled connection without tenant context returns ZERO rows with
 * no error (the aiBudget shape), which would silently drop the glossary from
 * every prompt while the code looked fine.
 */
import { tenantQuery } from './tenantQuery';
import {
  dedupeLinks,
  formatLinksForPrompt,
  linkKey,
  parseGlossaryLinks,
  resolveGlossaryLinks,
  type ResolvedGlossaryLink,
} from './glossaryLinks';

export interface GlossaryEntry {
  term: string;
  meaning: string;
  examples: string[];
  tags: string[];
  /** Where the term lives in the topic layer, checked against the catalog. */
  links: ResolvedGlossaryLink[];
}

export interface GlossaryPromptOptions {
  /**
   * Render each term's resolved links ("In the data: …"). Only for prompts
   * whose schema is the PRODUCT layer — the addresses are product-table
   * names and would point a source-layer prompt at tables it does not have.
   */
  links?: boolean;
}

export async function loadGlossary(tenantId: number): Promise<GlossaryEntry[]> {
  if (!Number.isFinite(tenantId)) return [];
  return tenantQuery(tenantId, async (db) => {
    const rows = await db('business_glossary')
      .where({ tenant_id: tenantId })
      .orderBy('term', 'asc')
      .select('term', 'meaning', 'examples', 'tags', 'links');
    const parsed = rows.map((r) => ({
      term: String(r.term),
      meaning: String(r.meaning),
      examples: parseArr(r.examples),
      tags: parseArr(r.tags),
      rawLinks: parseGlossaryLinks(r.links),
    }));
    // One resolution pass for every link of every term (three queries total).
    const all = dedupeLinks(parsed.flatMap((p) => p.rawLinks));
    const resolved = await resolveGlossaryLinks(db, tenantId, all);
    const byKey = new Map(resolved.map((r) => [linkKey(r), r]));
    return parsed.map(({ rawLinks, ...entry }) => ({
      ...entry,
      links: rawLinks
        .map((l) => byKey.get(linkKey(l)))
        .filter((l): l is ResolvedGlossaryLink => !!l),
    }));
  });
}

function parseArr(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Format the glossary as a markdown block for inclusion in prompts.
 * Returns "" when empty so callers can blindly concatenate.
 */
export function formatGlossaryForPrompt(entries: GlossaryEntry[], opts: GlossaryPromptOptions = {}): string {
  if (!entries.length) return '';
  let anyLinkRendered = false;
  const lines = entries.map((e) => {
    const tagSuffix = e.tags.length ? `  [${e.tags.join(', ')}]` : '';
    const examples  = e.examples.length ? `\n  Examples: ${e.examples.join('; ')}` : '';
    const linkLine  = opts.links ? formatLinksForPrompt(e.links ?? []) : null;
    if (linkLine) anyLinkRendered = true;
    return `- **${e.term}** — ${e.meaning}${tagSuffix}${examples}${linkLine ? `\n  ${linkLine}` : ''}`;
  });
  const rule = anyLinkRendered
    ? ' Where a term says "In the data: …", use EXACTLY that table, column or KPI for it — never a similarly named one.'
    : '';
  return [
    '## Business glossary',
    `(User-defined abbreviations and company-specific wordings. When a user references one of these terms, treat them as defined here.${rule})`,
    '',
    lines.join('\n'),
    '',
  ].join('\n');
}

/** Convenience: load + format in one call. */
export async function getGlossaryPromptBlock(tenantId: number, opts: GlossaryPromptOptions = {}): Promise<string> {
  const entries = await loadGlossary(tenantId);
  return formatGlossaryForPrompt(entries, opts);
}
