import type { Provenance, SemanticSource } from './types';

/**
 * How a relationship's origin is described to a person.
 *
 * **Two facts, not one.** `Provenance` says whether anyone has vouched for the
 * link — it drives the review queue and the dash pattern on the canvas.
 * `SemanticSource` says which of seven channels actually produced it. They were
 * collapsed into one field until migration 79, with two visible consequences:
 *
 *   • 81 relationships hand-written into Clarion's Exact Online connector
 *     rendered as *"Documented by the source"*, claiming the vendor's authority
 *     for our own work;
 *   • a column-name guess, a value-overlap scan and two different AI passes all
 *     rendered as *"Suggested by Clarion"*, so the channel that actually
 *     produced the bad links — the model reading the schema — was
 *     indistinguishable from the three that did not.
 *
 * The labels below are what a business user reads, so they name the thing that
 * did the asserting rather than the mechanism: "Exact Online documents this",
 * not "vendor_docs".
 */
export interface OriginMeta {
  /** Short label for a chip. Kept under ~28 characters so it never wraps. */
  label: string;
  /** One sentence: what this channel actually did, and how much it is worth. */
  hint: string;
  /**
   * How much to lean on it, independent of whether a person has confirmed it.
   * `documented` is externally verifiable; `written` is a human decision made
   * once for every tenant; `found` is a measurement; `proposed` is a guess that
   * survived a measurement.
   */
  tier: 'documented' | 'written' | 'found' | 'proposed';
}

export const ORIGIN: Record<SemanticSource, OriginMeta> = {
  vendor_docs: {
    label: 'Documented by the source',
    hint: 'The source system declares this relationship in its own data model, so it '
      + 'exists by definition. If the data still does not back it, that is nearly always '
      + 'a sync that has not finished — not a wrong link.',
    tier: 'documented',
  },
  declared: {
    label: 'A key in the database',
    hint: 'The database itself declares this as a foreign key. It is enforced at the '
      + 'source, so it cannot be wrong there.',
    tier: 'documented',
  },
  curated: {
    label: "Built into Clarion's connector",
    hint: 'Written by hand into Clarion for this kind of source, because the vendor does '
      + 'not document it. Reliable, but it is our claim rather than the vendor’s — '
      + 'and it was written without seeing your data.',
    tier: 'written',
  },
  name_pattern: {
    label: 'Matched on column names',
    hint: 'Found because the column names line up — a column ending in ID next to a table '
      + 'of that name — and then checked against your values. Wrong when two systems use '
      + 'the same word for different things.',
    tier: 'found',
  },
  value_overlap: {
    label: 'Found by comparing values',
    hint: 'Found only because the values in the two columns agree. The weakest signal '
      + 'there is: a small set of values can agree entirely by coincidence.',
    tier: 'found',
  },
  ai_suggested: {
    label: 'Clarion matched a loose key',
    hint: 'A key column matched nothing, so Clarion proposed a target and then checked it '
      + 'against your data. Proposals that failed the check were discarded.',
    tier: 'proposed',
  },
  ai_model: {
    label: 'Clarion read the schema',
    hint: 'Clarion proposed this from the shape of your tables, then checked it against '
      + 'your data. This is the broadest of the channels and the one most worth a second '
      + 'look — it is where invented links have come from before.',
    tier: 'proposed',
  },
};

/** Rows written before migration 79 carry no channel, and must not pretend to. */
const UNKNOWN_ORIGIN: Record<Provenance, OriginMeta> = {
  human: {
    label: 'Confirmed by your team',
    hint: 'Someone on your team confirmed this. How Clarion first found it was not '
      + 'recorded — this link predates that being tracked.',
    tier: 'written',
  },
  declared: {
    label: 'Trusted, origin not recorded',
    hint: 'Clarion treated this as reliable from the start, but which channel produced it '
      + 'was not recorded. Re-analysing this source will fill it in.',
    tier: 'written',
  },
  ai: {
    label: 'Suggested by Clarion',
    hint: 'Clarion worked this out from your data. Which channel produced it was not '
      + 'recorded — this link predates that being tracked. Confirm it or remove it.',
    tier: 'proposed',
  },
};

/**
 * What to show for one relationship.
 *
 * Confirmation does NOT overwrite the channel: knowing a colleague ticked a link
 * that Clarion invented from the schema is more useful than knowing only that
 * somebody ticked it. So the channel is the label, and `confirmed` rides
 * alongside it.
 */
export function originOf(
  provenance: Provenance,
  semanticSource: SemanticSource | null,
): OriginMeta & { confirmed: boolean; recorded: boolean } {
  const base = semanticSource ? ORIGIN[semanticSource] : UNKNOWN_ORIGIN[provenance];
  return { ...base, confirmed: provenance === 'human', recorded: semanticSource !== null };
}

/** Chip colours by tier. Documented is the accent; a guess is never green. */
export const TIER_STYLE: Record<OriginMeta['tier'], { fg: string; bg: string }> = {
  documented: { fg: '#164e63', bg: '#dbeaf0' },
  written:    { fg: '#3f7a5c', bg: '#dbe8e0' },
  found:      { fg: '#4a5660', bg: '#e3e6ea' },
  proposed:   { fg: '#a06a1c', bg: '#f1e4c8' },
};

/**
 * The two buckets the whole screen is organised around.
 *
 * **Confirmed = what Ask AI is allowed to use.** A relationship earns that by
 * somebody standing behind it: a person on the team confirmed it, the source
 * system documents it, the database enforces it as a constraint, or Clarion's
 * connector ships it. Everything Clarion *inferred* — from column names, from
 * value overlap, from a model reading the schema — is a suggestion, and a
 * suggestion is inert until a person accepts it.
 *
 * Rows written before migration 79 carry no channel at all. For those,
 * `provenance === 'declared'` is the only signal there is: it means the profiler
 * trusted them from the start, which on the old code path meant they came from
 * the connector's documented or curated catalogue. Treating them as confirmed is
 * the reading that matches what those rows actually were.
 */
export type Bucket = 'confirmed' | 'review';

const CONFIRMED_SOURCES: ReadonlySet<SemanticSource> = new Set<SemanticSource>([
  'vendor_docs', 'declared', 'curated',
]);

export function bucketOf(
  r: { provenance: Provenance; semanticSource: SemanticSource | null },
): Bucket {
  if (r.provenance === 'human') return 'confirmed';
  if (r.semanticSource) return CONFIRMED_SOURCES.has(r.semanticSource) ? 'confirmed' : 'review';
  return r.provenance === 'declared' ? 'confirmed' : 'review';
}

/**
 * WHO LAID THIS LINE. The distinction the whole screen turns on.
 *
 *   • `source` — the source system itself asserts it: its own documentation, or
 *     a foreign key the database enforces. It exists by definition. We do not
 *     review these for correctness, because there is nothing to correct.
 *   • `manual` — a person did: your team, or a Clarion engineer writing the
 *     connector catalogue. Good judgement, but judgement, so it can be wrong.
 *
 * A CLARION SUGGESTION IS NOT A THIRD KIND. It is a proposal, not a
 * relationship — it lives in To review until somebody accepts it, and accepting
 * it makes it manual, because at that point a person laid it.
 *
 * The consequence that matters is not the label, it is what a FAILING CHECK
 * means. The same measurement says two different things depending on this:
 * on a manual link it means whoever laid it may have got it wrong; on a
 * source-laid link the link is right and we simply could not confirm it here.
 */
export type LaidBy = 'source' | 'manual';

export function laidBy(
  r: { provenance: Provenance; semanticSource: SemanticSource | null },
): LaidBy {
  return originOf(r.provenance, r.semanticSource).tier === 'documented' ? 'source' : 'manual';
}

export const LAID_BY: Record<LaidBy, { label: string; hint: string }> = {
  source: {
    label: 'Laid by the source',
    hint: 'The source system defines this relationship itself, so it exists whether or not '
      + 'the data we hold can show it. Nothing here needs deciding.',
  },
  manual: {
    label: 'Laid manually',
    hint: 'A person put this link here — your team, or a Clarion engineer writing the '
      + 'connector. That is a judgement, so it is the kind of link that can be wrong.',
  },
};
