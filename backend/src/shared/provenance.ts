/**
 * Provenance — ONE ladder for where a semantic fact came from (E5 of
 * docs/backlog/ingestion-chain-assessment.md).
 *
 * ══ THIS FILE EXISTS AS TWO BYTE-IDENTICAL COPIES ═══════════════════════════
 *
 *     backend/src/shared/provenance.ts
 *     frontend/lib/provenance.ts
 *
 * Edit them TOGETHER; `backend/scripts/lint-contract-sync.ts` fails the build
 * when they differ. Like legalVersions.ts this file MAY hold runtime code —
 * the derivation below is the point: the backend stamps a rung on rows it
 * writes and the frontend must read a stored rung the same way it would
 * derive one, or a chip says "verified" over a row the API called a draft.
 *
 * WHY A LADDER AND NOT THE STORED FIELDS. Storage records the CHANNEL
 * (`semantic_source`: 'declared' | 'curated' | 'ai' | … on tables and
 * columns; 'vendor_docs' | 'name_pattern' | 'ai_model' | … on relationships)
 * beside three separate booleans (`edited_by_user`, `confirmed_by_user`,
 * `ai_draft`) and an `approval_status`. That is the right thing to STORE —
 * the channel answers "how was this found?", which confirmation must not
 * overwrite. But no reader could answer the simpler question "how far may I
 * trust this?" without re-deriving it, and each did so differently: a
 * column a person rewrote still carried `semantic_source='ai'`, and an AI
 * guess that passed a measurement was stored exactly like one that had not.
 *
 * The rungs, strongest first. `human` outranks everything because a person
 * took ownership; `declared` outranks `curated` because the vendor's own
 * documentation is externally verifiable while a curated entry is Clarion's
 * claim; `derived` is a deterministic computation over the data or the SQL
 * (no model, but nobody vouched); `ai_verified` is a model proposal that
 * SOMETHING checked — a measurement against the data, or an approval;
 * `ai_draft` is a proposal nobody has checked; `unknown` is a row written
 * before provenance was recorded, and must never render as any other rung.
 */

export type ProvenanceRung =
  | 'human'
  | 'declared'
  | 'curated'
  | 'derived'
  | 'ai_verified'
  | 'ai_draft'
  | 'unknown';

/** Strongest first. Sorting by index gives "most trusted at the top". */
export const PROVENANCE_RUNGS: readonly ProvenanceRung[] = [
  'human', 'declared', 'curated', 'derived', 'ai_verified', 'ai_draft', 'unknown',
];

/** What a person reads. Labels name who asserted the fact, not the mechanism. */
export const PROVENANCE_LABEL: Record<ProvenanceRung, { label: string; hint: string }> = {
  human: {
    label: 'Confirmed by your team',
    hint: 'Someone on your team wrote or confirmed this. It outranks everything else.',
  },
  declared: {
    label: 'Documented by the source',
    hint: 'The source system states this in its own documentation or metadata.',
  },
  curated: {
    label: "Built into Clarion's connector",
    hint: "Written by hand into Clarion for this kind of source. Reliable, but Clarion's claim rather than the vendor's.",
  },
  derived: {
    label: 'Worked out by Clarion',
    hint: 'Computed from your data or from the SQL without a model — for example, a join read off a query. Not yet confirmed by a person.',
  },
  ai_verified: {
    label: 'Suggested by Clarion, checked',
    hint: 'A model proposed this and it passed a check — a measurement against your data, or an approval.',
  },
  ai_draft: {
    label: 'Suggested by Clarion',
    hint: 'A model proposed this and nobody has checked it yet. Confirm it or flag it.',
  },
  unknown: {
    label: 'Origin not recorded',
    hint: 'This was written before Clarion recorded where things come from. Re-analysing the source fills it in.',
  },
};

/** Channels that mean the source system itself asserted the fact. */
const DECLARED_CHANNELS: ReadonlySet<string> = new Set(['declared', 'vendor_docs']);
/** Channels that are a deterministic computation, not a model and not a person. */
const DERIVED_CHANNELS: ReadonlySet<string> = new Set(['derived', 'name_pattern', 'value_overlap']);

/**
 * The stored fields a rung is derived from. Every field is optional because
 * the three tables carry different subsets: tables/columns have
 * `edited_by_user` + `approval_status`, relationships have
 * `confirmed_by_user` + `measured`. Pass what the row has.
 */
export interface ProvenanceInputs {
  /** `semantic_source` — the channel. */
  semanticSource?: string | null;
  /** Tables/columns: a person changed a semantic field. */
  editedByUser?: boolean | null;
  /** Relationships: a person confirmed or corrected the link. */
  confirmedByUser?: boolean | null;
  aiDraft?: boolean | null;
  /** Tables/columns: 'draft' | 'pending' | 'approved' | 'flagged'. */
  approvalStatus?: string | null;
  /** Relationships: the cached measurement, if any. */
  measured?: { verdict?: string | null } | null;
}

/**
 * Derive the rung. Pure; the order of the rules IS the ladder.
 *
 * A note on `ai_verified`: an approval counts even when it came from the
 * auto-approve job rather than a person — that is honest, because what the
 * rung says is "a check passed", not "a person looked". A person looking is
 * `human`, and only an EDIT or a CONFIRM records that.
 */
export function provenanceOf(i: ProvenanceInputs): ProvenanceRung {
  if (i.editedByUser === true || i.confirmedByUser === true) return 'human';
  const channel = (i.semanticSource ?? '').trim();
  if (DECLARED_CHANNELS.has(channel)) return 'declared';
  if (channel === 'curated') return 'curated';
  if (DERIVED_CHANNELS.has(channel)) return 'derived';
  if (channel === '') return 'unknown';
  // Everything else is a model's channel: 'ai', 'ai_enriched', 'ai_model',
  // 'ai_suggested'. Draft until something checked it.
  if (i.measured?.verdict === 'strong') return 'ai_verified';
  if (i.aiDraft === false && i.approvalStatus === 'approved') return 'ai_verified';
  if (i.aiDraft === false && i.approvalStatus == null) return 'ai_verified';
  return 'ai_draft';
}

/** Is the rung one Ask AI may lean on without a person having looked? */
export function isTrustedRung(r: ProvenanceRung): boolean {
  return r === 'human' || r === 'declared' || r === 'curated';
}
