/**
 * Line diff for proposed cell changes — pure, no dependency.
 *
 * The AI never overwrites a cell any more: it PROPOSES, and the user reads
 * what would go and what would come before deciding. That review is only
 * worth anything if the diff is honest about which lines actually changed —
 * a "everything removed, everything added" blob tells the reader nothing and
 * is exactly what a naive implementation produces for a one-line edit.
 *
 * So: a classic LCS (longest common subsequence) over lines, which is what
 * git and every merge view compute. Cells are tens of lines, occasionally
 * hundreds; the O(n·m) table is trivial at that size and predictable, which
 * matters more here than the constant factor of a Myers implementation.
 *
 * Deliberately NOT a dependency: `diff`/`jsdiff` would be a few hundred lines
 * of table for a function this file states in forty, and this repo already
 * hand-rolls its xlsx reader and writer for the same reason.
 */

export type DiffKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the OLD text; null on an added line. */
  oldNumber: number | null;
  /** 1-based line number in the NEW text; null on a removed line. */
  newNumber: number | null;
}

export interface DiffStats {
  added: number;
  removed: number;
  /** True when the two texts are identical — nothing to accept or reject. */
  unchanged: boolean;
}

/**
 * Above this many lines on either side the LCS table stops being free
 * (2000×2000 is four million cells). A cell that big is not something anyone
 * reviews line by line anyway, so we degrade honestly to whole-block
 * replacement rather than freezing the tab.
 */
const LCS_LINE_CAP = 2000;

function splitLines(text: string): string[] {
  // A trailing newline is a property of the file, not a line of its own:
  // without this, adding a final newline reads as "one line added".
  const normalised = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalised === '' ? [] : normalised.split('\n');
}

/** Whole-block replacement — the fallback for inputs too large to align. */
function blockReplace(oldLines: string[], newLines: string[]): DiffLine[] {
  return [
    ...oldLines.map((text, i) => ({ kind: 'removed' as const, text, oldNumber: i + 1, newNumber: null })),
    ...newLines.map((text, i) => ({ kind: 'added' as const, text, oldNumber: null, newNumber: i + 1 })),
  ];
}

/**
 * Line-by-line diff of `oldText` → `newText`, in reading order: a removed
 * line appears before the added line that replaces it, the way every merge
 * view shows it.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (a.length > LCS_LINE_CAP || b.length > LCS_LINE_CAP) return blockReplace(a, b);

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'context', text: a[i], oldNumber: i + 1, newNumber: j + 1 });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'removed', text: a[i], oldNumber: i + 1, newNumber: null });
      i++;
    } else {
      out.push({ kind: 'added', text: b[j], oldNumber: null, newNumber: j + 1 });
      j++;
    }
  }
  while (i < a.length) { out.push({ kind: 'removed', text: a[i], oldNumber: i + 1, newNumber: null }); i++; }
  while (j < b.length) { out.push({ kind: 'added', text: b[j], oldNumber: null, newNumber: j + 1 }); j++; }
  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  return { added, removed, unchanged: added === 0 && removed === 0 };
}

/**
 * Collapse long stretches of untouched lines, keeping `context` lines either
 * side of every change. A 200-line query with a one-line edit should not make
 * the reader scroll past 199 lines to find it.
 *
 * Returns the kept lines with `{ gap: n }` markers where lines were folded.
 */
export type DiffRow = { line: DiffLine } | { gap: number };

export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === 'context') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
  });
  // No changes at all → show everything; there is nothing to fold around.
  if (keep.every((k) => !k)) return lines.map((line) => ({ line }));

  const rows: DiffRow[] = [];
  let run = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    if (keep[idx]) {
      if (run > 0) { rows.push({ gap: run }); run = 0; }
      rows.push({ line: lines[idx] });
    } else {
      run++;
    }
  }
  if (run > 0) rows.push({ gap: run });
  return rows;
}
