/**
 * Loads the tenant-wide business glossary and formats it for AI prompts.
 *
 * The glossary holds abbreviations and company-specific wordings ("QTD",
 * "Net New ARR", etc.) so the model can resolve these terms when a user
 * mentions them in a natural-language question.
 *
 * Used by NL→SQL prompts (source + DuckDB), dashboard generation, and
 * schema draft prompts. Returns an empty string when the glossary is empty
 * — callers can safely concatenate the result without checking.
 */

import { semanticDb } from '../db/knex';

export interface GlossaryEntry {
  term: string;
  meaning: string;
  examples: string[];
  tags: string[];
}

export async function loadGlossary(tenantId: number): Promise<GlossaryEntry[]> {
  if (!Number.isFinite(tenantId)) return [];
  const rows = await semanticDb('business_glossary')
    .where({ tenant_id: tenantId })
    .orderBy('term', 'asc')
    .select('term', 'meaning', 'examples', 'tags');

  return rows.map((r) => ({
    term: String(r.term),
    meaning: String(r.meaning),
    examples: parseArr(r.examples),
    tags:     parseArr(r.tags),
  }));
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
export function formatGlossaryForPrompt(entries: GlossaryEntry[]): string {
  if (!entries.length) return '';
  const lines = entries.map((e) => {
    const tagSuffix = e.tags.length ? `  [${e.tags.join(', ')}]` : '';
    const examples  = e.examples.length ? `\n  Examples: ${e.examples.join('; ')}` : '';
    return `- **${e.term}** — ${e.meaning}${tagSuffix}${examples}`;
  });
  return [
    '## Business glossary',
    '(User-defined abbreviations and company-specific wordings. When a user references one of these terms, treat them as defined here.)',
    '',
    lines.join('\n'),
    '',
  ].join('\n');
}

/** Convenience: load + format in one call. */
export async function getGlossaryPromptBlock(tenantId: number): Promise<string> {
  const entries = await loadGlossary(tenantId);
  return formatGlossaryForPrompt(entries);
}
