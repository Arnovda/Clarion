/**
 * The tenant-wide relationship graph — what the canvas draws.
 *
 * WHY THIS READS POSTGRES AND NOT NEO4J.
 *
 * Neo4j is the semantic source of truth for single-entity reads, and the rest
 * of the catalog goes through `db/semanticGraph.ts`. This does not, on purpose.
 *
 * `semanticGraph` matches nodes by a globally-unique `pgId` with **no tenant
 * predicate anywhere** (see the dual-write contract in CLAUDE.md). Every route
 * that hands it a request-supplied id therefore has to gate that id first. That
 * pattern works when the caller names one entity. It inverts badly here: this
 * endpoint's whole job is "give me everything this tenant has", so gating would
 * mean fetching an unscoped graph and then filtering it against an ownership
 * query — reading other tenants' rows in order to discard them.
 *
 * Postgres carries `tenant_id` on all three tables, with RLS on top. A
 * tenant-wide read is exactly the case it is right for, and the dual-write
 * contract already lists whole-tenant aggregate reads (`routes/home.ts`,
 * `routes/quality.ts`) as legitimately Postgres-side for the same reason.
 *
 * Every query below filters `tenant_id` EXPLICITLY rather than relying on RLS
 * alone, because `reqDb` can fall back to the global pool whose session-level
 * `SET app.current_tenant` has a documented race. An isolation boundary must
 * not depend on which side of that race it lands.
 */

import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'relationshipGraph' });

/**
 * Cap on tables returned in one response. A tenant with two ERPs sits around
 * 80; this exists so a pathological catalog cannot turn one request into a
 * multi-megabyte payload. When it bites, `truncated` says so — a silent cap
 * reads to the user as "this is your whole graph" when it is not.
 */
export const MAX_TABLES = 500;

/** Where a relationship came from. Drives the line style on the canvas. */
export type Provenance = 'human' | 'ai' | 'declared';

export interface RelationshipRow {
  id: number;
  kind: string | null;
  from_table_id: number | null;
  from_column_id: number | null;
  to_table_id: number | null;
  to_column_id: number | null;
  relationship_type: string | null;
  description: string | null;
  ai_draft: boolean | null;
  confirmed_by_user: boolean | null;
  measured: unknown;
  match_keys: unknown;
  flagged_at: Date | string | null;
  flagged_reason: string | null;
}

export interface TableRow {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
}

export interface GraphRelationship {
  id: number;
  kind: 'join' | 'match';
  fromTableId: number;
  fromColumnId: number | null;
  toTableId: number;
  toColumnId: number | null;
  relationshipType: string | null;
  description: string | null;
  provenance: Provenance;
  /** Computed here so the canvas never has to join tables to find out. */
  isCrossSource: boolean;
  measured: unknown;
  matchKeys: unknown;
  /** Someone looked at this and said the data does not back it (migration 78). */
  flagged: boolean;
  flaggedReason: string | null;
}

/**
 * Human beats AI beats vendor docs — the same precedence the profiler uses when
 * deciding what survives a re-profile.
 *
 * A confirmed relationship is human even if it started as an AI draft: the
 * point of confirming is to take ownership of it. `ai_draft = false` without a
 * confirmation means it came from the connector's declared/curated catalogue,
 * which the profiler writes as trusted from the start.
 */
export function deriveProvenance(rel: Pick<RelationshipRow, 'ai_draft' | 'confirmed_by_user'>): Provenance {
  if (rel.confirmed_by_user) return 'human';
  if (rel.ai_draft) return 'ai';
  return 'declared';
}

/**
 * Relationships whose endpoints did not resolve cannot be drawn, and cannot
 * express a join either. The 2026-08-03 audit found eight of them in one
 * production tenant, rendering in the catalog as `Table.? → Other.ID`. Dropping
 * them here keeps the canvas honest; the persist loops are where they should
 * never have been written in the first place.
 */
export function isDrawable(rel: RelationshipRow): boolean {
  return rel.from_table_id != null && rel.to_table_id != null;
}

/**
 * Table ids within `depth` hops of an anchor, following relationships in either
 * direction.
 *
 * Breadth-first over an in-memory adjacency list rather than a recursive CTE:
 * the whole tenant's relationship set is a few hundred rows at SMB scale, so it
 * is one query and no database recursion, and the traversal stays testable
 * without a database.
 */
export function neighbourhood(
  anchorTableId: number,
  rels: readonly RelationshipRow[],
  depth: number,
): Set<number> {
  const adjacency = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  for (const r of rels) {
    if (!isDrawable(r)) continue;
    link(r.from_table_id!, r.to_table_id!);
    link(r.to_table_id!, r.from_table_id!);
  }

  const seen = new Set<number>([anchorTableId]);
  let frontier = [anchorTableId];
  for (let hop = 0; hop < depth; hop += 1) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const neighbour of adjacency.get(id) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return seen;
}

export interface BuiltGraph {
  tables: Array<{
    id: number;
    connectionId: number;
    tableName: string;
    displayName: string | null;
    description: string | null;
    relationshipCount: number;
  }>;
  relationships: GraphRelationship[];
  stats: {
    tables: number;
    relationships: number;
    pendingReview: number;
    flagged: number;
    crossSource: number;
    unresolved: number;
  };
  truncated: boolean;
}

/**
 * Assemble the response from raw rows.
 *
 * Pure so the shaping rules — which relationships are drawable, what counts as
 * pending review, which edges cross a source boundary — can be tested without a
 * database.
 */
export function buildGraph(
  tableRows: readonly TableRow[],
  relRows: readonly RelationshipRow[],
  opts: { visibleTableIds?: Set<number> } = {},
): BuiltGraph {
  const connectionByTable = new Map<number, number>();
  for (const t of tableRows) connectionByTable.set(t.id, t.connection_id);

  const visible = opts.visibleTableIds;
  const inScope = (id: number | null) =>
    id != null && connectionByTable.has(id) && (!visible || visible.has(id));

  const unresolved = relRows.filter((r) => !isDrawable(r)).length;

  const relationships: GraphRelationship[] = [];
  const relCount = new Map<number, number>();

  for (const r of relRows) {
    if (!isDrawable(r)) continue;
    // Both endpoints must be tables this request can see. An edge with one leg
    // outside the requested scope would render as a line into nothing.
    if (!inScope(r.from_table_id) || !inScope(r.to_table_id)) continue;

    const fromConn = connectionByTable.get(r.from_table_id!)!;
    const toConn = connectionByTable.get(r.to_table_id!)!;

    relationships.push({
      id: r.id,
      // Rows written before migration 77 have no `kind`; they are all
      // single-source by construction, which is what the default encodes.
      kind: r.kind === 'match' ? 'match' : 'join',
      fromTableId: r.from_table_id!,
      fromColumnId: r.from_column_id,
      toTableId: r.to_table_id!,
      toColumnId: r.to_column_id,
      relationshipType: r.relationship_type,
      description: r.description,
      provenance: deriveProvenance(r),
      isCrossSource: fromConn !== toConn,
      measured: r.measured ?? null,
      flagged: r.flagged_at != null,
      flaggedReason: r.flagged_reason ?? null,
      matchKeys: r.match_keys ?? null,
    });

    relCount.set(r.from_table_id!, (relCount.get(r.from_table_id!) ?? 0) + 1);
    relCount.set(r.to_table_id!, (relCount.get(r.to_table_id!) ?? 0) + 1);
  }

  const scoped = tableRows.filter((t) => !visible || visible.has(t.id));
  const truncated = scoped.length > MAX_TABLES;
  if (truncated) {
    log.warn({ total: scoped.length, cap: MAX_TABLES }, 'graph response truncated');
  }

  const tables = scoped.slice(0, MAX_TABLES).map((t) => ({
    id: t.id,
    connectionId: t.connection_id,
    tableName: t.table_name,
    displayName: t.display_name,
    description: t.description,
    relationshipCount: relCount.get(t.id) ?? 0,
  }));

  return {
    tables,
    relationships,
    stats: {
      tables: scoped.length,
      relationships: relationships.length,
      // The review queue, which is the canvas's default view: anything AI
      // proposed that nobody has confirmed yet.
      pendingReview: relationships.filter((r) => r.provenance === 'ai').length,
      // Counted over EVERY row, not just the drawable ones: a flag you raised
      // on a link that later became undrawable is still a flag you are owed
      // an answer on.
      flagged: relRows.filter((r) => r.flagged_at != null).length,
      crossSource: relationships.filter((r) => r.isCrossSource).length,
      unresolved,
    },
    truncated,
  };
}
