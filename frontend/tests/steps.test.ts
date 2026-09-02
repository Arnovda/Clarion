/**
 * P1-7 first frontend tests — the pure step-tree derivation that used to
 * be verified only by throwaway dry-run scripts deleted after each
 * session (the worksheet work's own notes say so). What is committed can
 * regress visibly; what was dry-run once cannot.
 */

import { describe, it, expect } from 'vitest';
import { deriveSteps, flattenSteps, autoLabel, countBranches } from '../app/query/steps';
import type { Message } from '../app/query/types';

const asst = (id: number, over: Partial<Message> = {}): Message => ({
  id,
  role: 'assistant',
  text: `answer ${id}`,
  question: `question ${id}`,
  ...over,
});

describe('deriveSteps', () => {
  it('legacy parentless messages chain linearly — every pre-worksheet thread opens as a straight spine', () => {
    const roots = deriveSteps([asst(1), asst(2), asst(3)]);
    expect(roots).toHaveLength(1);
    const flat = flattenSteps(roots);
    expect(flat.map((s) => s.id)).toEqual([1, 2, 3]);
    // A linear chain is a thread, not a tree: no fork, no indent.
    expect(flat.map((s) => s.depth)).toEqual([0, 0, 0]);
  });

  it('an explicit branch indents; the first child continues at the same level', () => {
    const roots = deriveSteps([
      asst(1, { serverId: 100 }),
      asst(2, { serverId: 101, parentServerId: 100 }),
      asst(3, { serverId: 102, parentServerId: 100 }), // second child = real branch
    ]);
    const flat = flattenSteps(roots);
    const byId = Object.fromEntries(flat.map((s) => [s.id, s]));
    expect(byId[2].depth).toBe(0);
    expect(byId[3].depth).toBe(1);
    expect(countBranches(roots)).toBe(1);
  });

  it('a pending step resolves its parent by session-local id before any server id exists', () => {
    const roots = deriveSteps([
      asst(7, { serverId: 200 }),
      asst(8, { parentLocalId: 7 }),
    ]);
    const flat = flattenSteps(roots);
    expect(flat.map((s) => s.id)).toEqual([7, 8]);
    expect(flat[1].parentId).toBe(7);
  });

  it('error and blocked steps join the tree with a warn mark instead of vanishing', () => {
    const roots = deriveSteps([asst(1), asst(2, { blocked: true })]);
    const flat = flattenSteps(roots);
    expect(flat[1].warn).toBe(true);
  });
});

describe('autoLabel', () => {
  it('drops leading interrogatives in English and Dutch', () => {
    expect(autoLabel('Who owes me money right now?')).toBe('Owes me money right now');
    expect(autoLabel('Hoeveel klanten hebben we?')).toBe('Klanten hebben we');
  });

  it('caps on a word boundary and never returns empty for a bare interrogative', () => {
    const label = autoLabel('Show me the revenue per customer per month for the whole of last year please');
    expect(label.length).toBeLessThanOrEqual(33); // 32 + possible ellipsis char
    expect(label.endsWith(' ')).toBe(false);
    // "Why?" must not label as the empty string.
    expect(autoLabel('Why?').length).toBeGreaterThan(0);
  });
});
