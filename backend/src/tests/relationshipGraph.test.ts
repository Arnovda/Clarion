import { describe, it, expect } from 'vitest';
import {
  buildGraph,
  neighbourhood,
  deriveProvenance,
  isDrawable,
  MAX_TABLES,
  type RelationshipRow,
  type TableRow,
} from '../services/relationshipGraph';

const table = (id: number, connectionId: number, name = `t${id}`): TableRow => ({
  id, connection_id: connectionId, table_name: name, display_name: null, description: null,
});

const rel = (id: number, from: number | null, to: number | null, over: Partial<RelationshipRow> = {}): RelationshipRow => ({
  id,
  kind: 'join',
  from_table_id: from,
  from_column_id: from ? from * 10 : null,
  to_table_id: to,
  to_column_id: to ? to * 10 : null,
  relationship_type: 'many_to_one',
  description: null,
  ai_draft: false,
  confirmed_by_user: false,
  measured: null,
  match_keys: null,
  flagged_at: null,
  flagged_reason: null,
  ...over,
});

describe('deriveProvenance', () => {
  it('treats a confirmed relationship as human even when it began as an AI draft', () => {
    // Confirming is taking ownership. If this returned 'ai', the canvas would
    // keep showing work the user already did.
    expect(deriveProvenance({ ai_draft: true, confirmed_by_user: true })).toBe('human');
  });

  it('separates an unconfirmed AI draft from a vendor-declared relationship', () => {
    expect(deriveProvenance({ ai_draft: true, confirmed_by_user: false })).toBe('ai');
    expect(deriveProvenance({ ai_draft: false, confirmed_by_user: false })).toBe('declared');
  });
});

describe('isDrawable', () => {
  it('rejects a relationship with an unresolved endpoint', () => {
    // The 2026-08-03 audit found eight of these in one tenant, rendering as
    // `Table.? -> Other.ID`. They cannot express a join and cannot be drawn.
    expect(isDrawable(rel(1, null, 2))).toBe(false);
    expect(isDrawable(rel(2, 1, null))).toBe(false);
    expect(isDrawable(rel(3, 1, 2))).toBe(true);
  });
});

describe('neighbourhood', () => {
  const chain = [rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 4)];

  it('follows relationships in both directions', () => {
    // Anchoring on the middle of a chain must reach the parent as well as the
    // child — a foreign key points one way but the canvas reads both.
    expect([...neighbourhood(2, chain, 1)].sort()).toEqual([1, 2, 3]);
  });

  it('expands one hop at a time', () => {
    expect([...neighbourhood(1, chain, 1)].sort()).toEqual([1, 2]);
    expect([...neighbourhood(1, chain, 2)].sort()).toEqual([1, 2, 3]);
    expect([...neighbourhood(1, chain, 3)].sort()).toEqual([1, 2, 3, 4]);
  });

  it('stops early instead of looping on a cycle', () => {
    const cyclic = [rel(1, 1, 2), rel(2, 2, 3), rel(3, 3, 1)];
    expect([...neighbourhood(1, cyclic, 10)].sort()).toEqual([1, 2, 3]);
  });

  it('returns just the anchor when it has no relationships', () => {
    expect([...neighbourhood(9, chain, 2)]).toEqual([9]);
  });

  it('ignores unresolved endpoints when walking', () => {
    expect([...neighbourhood(1, [rel(1, 1, null)], 1)]).toEqual([1]);
  });
});

describe('buildGraph', () => {
  const tables = [table(1, 100), table(2, 100), table(3, 200)];

  it('flags an edge whose endpoints live in different sources', () => {
    // This is the whole reason the canvas is tenant-scoped, and computing it
    // here means the client never has to join tables to find out.
    const g = buildGraph(tables, [rel(1, 1, 2), rel(2, 2, 3)]);
    expect(g.relationships.find((r) => r.id === 1)!.isCrossSource).toBe(false);
    expect(g.relationships.find((r) => r.id === 2)!.isCrossSource).toBe(true);
    expect(g.stats.crossSource).toBe(1);
  });

  it('drops an edge with one leg outside the requested scope', () => {
    // Otherwise the canvas draws a line into nothing.
    const g = buildGraph(tables, [rel(1, 1, 2), rel(2, 2, 3)], {
      visibleTableIds: new Set([1, 2]),
    });
    expect(g.relationships.map((r) => r.id)).toEqual([1]);
    expect(g.tables.map((t) => t.id)).toEqual([1, 2]);
  });

  it('counts unresolved relationships without drawing them', () => {
    // Reported, not hidden: a tenant with eight broken rows should be able to
    // find that out.
    const g = buildGraph(tables, [rel(1, 1, 2), rel(2, null, 2)]);
    expect(g.relationships).toHaveLength(1);
    expect(g.stats.unresolved).toBe(1);
  });

  it('counts pending review as the AI drafts nobody confirmed', () => {
    const g = buildGraph(tables, [
      rel(1, 1, 2, { ai_draft: true }),
      rel(2, 1, 2, { ai_draft: true, confirmed_by_user: true }),
      rel(3, 1, 2, { ai_draft: false }),
    ]);
    expect(g.stats.pendingReview).toBe(1);
  });

  it('reports a relationship count per table, counting both endpoints', () => {
    const g = buildGraph(tables, [rel(1, 1, 2), rel(2, 2, 3)]);
    const byId = Object.fromEntries(g.tables.map((t) => [t.id, t.relationshipCount]));
    expect(byId).toEqual({ 1: 1, 2: 2, 3: 1 });
  });

  it('defaults a pre-migration row with no kind to a join', () => {
    // Everything written before migration 77 was single-source by
    // construction, so 'join' is correct rather than merely convenient.
    const g = buildGraph(tables, [rel(1, 1, 2, { kind: null })]);
    expect(g.relationships[0].kind).toBe('join');
  });

  it('says so when it truncates rather than implying a full graph', () => {
    const many = Array.from({ length: MAX_TABLES + 5 }, (_, i) => table(i + 1, 100));
    const g = buildGraph(many, []);
    expect(g.truncated).toBe(true);
    expect(g.tables).toHaveLength(MAX_TABLES);
    // The stat reports the real total, so the UI can say how much is missing.
    expect(g.stats.tables).toBe(MAX_TABLES + 5);
  });

  it('does not claim truncation at the cap boundary', () => {
    const exact = Array.from({ length: MAX_TABLES }, (_, i) => table(i + 1, 100));
    expect(buildGraph(exact, []).truncated).toBe(false);
  });
});


describe('flagged relationships', () => {
  it('surfaces the flag and its reason on the edge', () => {
    const g = buildGraph(
      [table(1, 'invoices', 7), table(2, 'customers', 7)],
      [rel(1, 1, 2, { flagged_at: '2026-08-13T10:00:00Z', flagged_reason: 'Exact still syncing' })],
    );
    expect(g.relationships[0].flagged).toBe(true);
    expect(g.relationships[0].flaggedReason).toBe('Exact still syncing');
  });

  it('counts flags over every row, including ones that cannot be drawn', () => {
    // A flag raised on a link whose endpoint later stopped resolving is still a
    // flag you are owed an answer on. Counting only the drawable ones would
    // make it disappear from the tally without anyone deciding anything.
    const g = buildGraph(
      [table(1, 'invoices', 7), table(2, 'customers', 7)],
      [
        rel(1, 1, 2, { flagged_at: '2026-08-13T10:00:00Z' }),
        rel(2, 1, null, { flagged_at: '2026-08-13T10:00:00Z' }),
        rel(3, 1, 2),
      ],
    );
    expect(g.relationships).toHaveLength(2);
    expect(g.stats.flagged).toBe(2);
  });
});


describe('counting a table\'s relationships', () => {
  it('counts a self-reference once, not twice', () => {
    // A parent pointer inside one table (GLClassifications.Parent ->
    // GLClassifications.ID) is ONE relationship. Counting both endpoints made
    // the table advertise a number the list underneath it could never reach.
    const g = buildGraph(
      [table(1, 'GLClassifications', 7)],
      [rel(1, 1, 1)],
    );
    expect(g.tables[0].relationshipCount).toBe(1);
  });

  it('still counts a normal relationship on both of its tables', () => {
    const g = buildGraph(
      [table(1, 'invoices', 7), table(2, 'customers', 7)],
      [rel(1, 1, 2)],
    );
    expect(g.tables.map((t) => t.relationshipCount)).toEqual([1, 1]);
  });
});
