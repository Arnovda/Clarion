/**
 * Worksheet steps — pure derivation, no React, no network.
 *
 * A STEP is an assistant message viewed as a frozen snapshot (question,
 * assumptions, result, SQL, data-as-of). Steps form a TREE derived from
 * `parentServerId` (docs/backlog/ask-ai-worksheet.md §3 — deliberately no
 * stored order; siblings order by creation). User messages are persisted
 * for the AI's conversation history but are NOT steps: the question lives
 * on the assistant row.
 *
 * Legacy rule: a step with no parent that is not the FIRST step of its
 * thread is a pre-worksheet row — it chains linearly to the step before it.
 * That one rule makes every old conversation open as a straight spine with
 * no data rewrite, while new threads keep exactly one root.
 */

import type { Message } from './types';

export interface Step {
  /** Client message id — stable within the session. */
  id: number;
  serverId?: number;
  msg: Message;
  parentId: number | null;   // client id of the parent step
  children: Step[];
  /** Indent level; the spine caps the visual indent at MAX_INDENT. */
  depth: number;
  label: string;
  /** Error / blocked marker for the spine's warning dot. */
  warn: boolean;
}

/** Spec §4.2: nesting caps at 3 levels of visual indent. */
export const MAX_INDENT = 3;

// ─── Auto-labels (spec §4.5) ─────────────────────────────────────────────────
//
// Drop leading interrogatives (English + Dutch — the user base is Belgian),
// cap at 32 characters on a word boundary, no trailing punctuation.

const LEADING_RE = new RegExp(
  '^\\s*(?:' +
  [
    // English
    'who(?:\\s+(?:are|is|was|were))?', 'what(?:\'s|\\s+(?:is|are|was|were))?',
    'which', 'how\\s+(?:many|much|do(?:es)?|did|is|are)?', 'why', 'when', 'where',
    'show\\s+me', 'show', 'give\\s+me', 'list', 'can\\s+you', 'could\\s+you',
    'do\\s+we', 'does', 'did', 'is', 'are', 'was', 'were',
    // Dutch
    'wie(?:\\s+(?:zijn|is|was|waren))?', 'wat(?:\\s+(?:is|zijn|was|waren))?',
    'welke', 'hoeveel', 'hoe(?:\\s+(?:veel|vaak|komt\\s+het))?', 'waarom',
    'wanneer', 'waar', 'toon(?:\\s+mij)?', 'geef(?:\\s+mij)?', 'kan\\s+je',
    'kun\\s+je', 'zijn', 'is\\s+er', 'zijn\\s+er',
  ].join('|') +
  ')\\b[\\s,:]*',
  'i',
);

export function autoLabel(question: string | undefined): string {
  const q = (question ?? '').trim();
  if (!q) return 'Untitled step';
  let s = q.replace(LEADING_RE, '').trim();
  if (!s) s = q; // the whole question was interrogatives — keep it
  s = s.replace(/[?!.…\s]+$/g, '');
  if (!s) s = q.replace(/[?!.…\s]+$/g, '').trim() || q; // "Why?" must not label as ""
  if (s.length > 32) {
    const cut = s.slice(0, 32);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > 16 ? cut.slice(0, lastSpace) : cut).replace(/[,;:\s]+$/g, '') + '…';
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Tree derivation ─────────────────────────────────────────────────────────

/**
 * Derive the step tree from a conversation's messages (creation order).
 * Returns the roots; use `flattenSteps` for the spine's display order.
 */
export function deriveSteps(messages: Message[]): Step[] {
  const assistant = messages.filter((m) => m.role === 'assistant');
  const byServerId = new Map<number, Step>();
  const byLocalId = new Map<number, Step>();
  const roots: Step[] = [];
  let previous: Step | null = null;

  for (const msg of assistant) {
    const step: Step = {
      id: msg.id,
      serverId: msg.serverId,
      msg,
      parentId: null,
      children: [],
      depth: 0,
      label: (msg.label && msg.label.trim()) || autoLabel(msg.question ?? msg.text),
      warn: !!(msg.error || msg.blocked),
    };

    // Resolve the parent: stored server id → session-local id → legacy chain.
    let parent: Step | null = null;
    if (msg.parentServerId != null) parent = byServerId.get(msg.parentServerId) ?? null;
    if (!parent && msg.parentLocalId != null) parent = byLocalId.get(msg.parentLocalId) ?? null;
    if (!parent && msg.parentServerId == null && msg.parentLocalId == null && previous) {
      // Legacy linear chaining — see the module header.
      parent = previous;
    }

    if (parent) {
      step.parentId = parent.id;
      step.depth = parent.depth + 1;
      parent.children.push(step);
    } else {
      roots.push(step);
    }

    if (msg.serverId != null) byServerId.set(msg.serverId, step);
    byLocalId.set(msg.id, step);
    previous = step;
  }

  return roots;
}

/** Depth-first flatten — the spine's display order (siblings stay in
 *  creation order, a branch's subtree renders under its parent). */
export function flattenSteps(roots: Step[]): Step[] {
  const out: Step[] = [];
  const walk = (s: Step) => {
    out.push(s);
    for (const c of s.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

export function findStep(roots: Step[], id: number): Step | null {
  for (const s of flattenSteps(roots)) if (s.id === id) return s;
  return null;
}

/** Number of steps that started a branch (a non-first child). */
export function countBranches(roots: Step[]): number {
  let n = 0;
  const walk = (s: Step) => {
    s.children.forEach((c, i) => { if (i > 0) n += 1; walk(c); });
  };
  for (const r of roots) walk(r);
  return n;
}

// ─── Spine collapsing (spec §4.6) ────────────────────────────────────────────
//
// Above COLLAPSE_THRESHOLD steps, collapse everything except: the FIRST
// step, the SELECTED step and its ancestors, the LAST THREE steps, any
// STARRED step, and the pending step. Consecutive hidden steps fold into
// one "N earlier steps" row that expands in place. Built now, per the
// brief — retrofitting after people have 40-step threads is much harder.

export const COLLAPSE_THRESHOLD = 12;

export type SpineRow =
  | { kind: 'step'; step: Step }
  | { kind: 'collapsed'; key: number; steps: Step[] };

export function collapseSpine(
  flat: Step[],
  selectedId: number | null,
  expandedKeys: ReadonlySet<number>,
  threshold = COLLAPSE_THRESHOLD,
): SpineRow[] {
  if (flat.length <= threshold) return flat.map((step) => ({ kind: 'step', step }));

  const keep = new Set<number>();
  if (flat.length > 0) keep.add(flat[0].id);                      // first
  for (const s of flat.slice(-3)) keep.add(s.id);                 // last three
  for (const s of flat) {
    if (s.msg.starred) keep.add(s.id);                            // starred
    if (s.id < 0) keep.add(s.id);                                 // pending
  }
  // Selected + its NEAREST ancestors. Deliberate deviation from the brief's
  // letter ("the selected step and its ancestors"): in a linear thread every
  // earlier step IS an ancestor of the leaf, so keeping them all would mean
  // collapsing never fires for the most common thread shape — contradicting
  // the brief's own "5 earlier steps" example. Two hops give the immediate
  // context; the root survives via the keep-first rule.
  const byId = new Map(flat.map((s) => [s.id, s]));
  let cur = selectedId != null ? byId.get(selectedId) ?? null : null;
  let hops = 0;
  while (cur && hops <= 2) {
    keep.add(cur.id);
    cur = cur.parentId != null ? byId.get(cur.parentId) ?? null : null;
    hops += 1;
  }

  const rows: SpineRow[] = [];
  let run: Step[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const key = run[0].id;
    if (expandedKeys.has(key)) {
      for (const s of run) rows.push({ kind: 'step', step: s });
    } else {
      rows.push({ kind: 'collapsed', key, steps: run });
    }
    run = [];
  };
  for (const s of flat) {
    if (keep.has(s.id)) { flush(); rows.push({ kind: 'step', step: s }); }
    else run.push(s);
  }
  flush();
  return rows;
}

/** Oldest source date — the honest "data as of" for a snapshot. */
export function oldestSourceDate(sources?: Array<{ lastRefreshedAt: string | null }>): string | null {
  const dates = (sources ?? []).map((s) => s.lastRefreshedAt).filter(Boolean) as string[];
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b));
}
