/**
 * semanticGraph.tenant.test.ts — the tenant predicate reaches the wire.
 *
 * lint-graph-tenant-predicate proves every MATCH in the Cypher TEXT carries a
 * tenantId predicate. This suite proves the other half of the contract at the
 * driver boundary: the tenantId a caller passes is the one bound to
 * `$tenantId` in the parameters of EVERY query the function runs. A predicate
 * bound to the wrong value (a hardcoded id, a swapped argument, a missing
 * param that makes the driver throw) passes the text lint and fails here.
 *
 * Neo4j itself is mocked — the sandbox and CI run without a graph, and what
 * is under test is the parameter binding, not Neo4j's matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Captured { cypher: string; params: Record<string, unknown> }
const captured: Captured[] = [];

vi.mock('./neo4j', () => ({
  getSession: () => ({
    run: async (cypher: string, params?: Record<string, unknown>) => {
      captured.push({ cypher, params: params ?? {} });
      return { records: [] };
    },
    close: async () => {},
  }),
}));

import * as graph from './semanticGraph';

const TENANT = 424242;

/** Every query the call produced must reference $tenantId and bind it to TENANT. */
function expectAllScoped() {
  expect(captured.length).toBeGreaterThan(0);
  for (const { cypher, params } of captured) {
    expect(cypher).toContain('$tenantId');
    expect(params.tenantId).toBe(TENANT);
  }
}

beforeEach(() => {
  captured.length = 0;
});

describe('semanticGraph tenant predicate binding', () => {
  it('getProductTree — the P0-2 headline read — is scoped', async () => {
    await graph.getProductTree(TENANT);
    expectAllScoped();
  });

  it('getAllProductTables is scoped', async () => {
    await graph.getAllProductTables(TENANT);
    expectAllScoped();
  });

  it('connection-scoped reads bind the tenant beside the connection id', async () => {
    await graph.getTablesByConnection(7, TENANT);
    await graph.getColumnsByConnection(7, TENANT);
    await graph.getRelationshipsForConnection(7, TENANT);
    await graph.getRelationshipsForContext(7, TENANT);
    await graph.getKpisByConnection(7, TENANT);
    await graph.getDimensionColumns(7, TENANT);
    await graph.getTablePgIdMap(7, TENANT);
    await graph.getColumnPgIdMap(7, TENANT);
    await graph.getFkCandidates(7, TENANT);
    expect(captured.length).toBe(9);
    expectAllScoped();
  });

  it('id-addressed reads are scoped — a bare pgId is enumerable', async () => {
    await graph.getColumnsByTablePgId(11, TENANT);
    await graph.getColumnByPgId(11, TENANT);
    await graph.getRelatedTables(11, TENANT);
    await graph.getTablesByPgIds([11, 12], TENANT);
    await graph.getProductTableByPgId(11, TENANT);
    await graph.getProductColumnByPgId(11, TENANT);
    await graph.getProductColumnsByTablePgId(11, TENANT);
    await graph.getProductTablesByProduct(9, TENANT);
    expect(captured.length).toBe(8);
    expectAllScoped();
  });

  it('id-addressed writes are scoped — construction-level, not gate-level', async () => {
    await graph.updateTable(5, { display_name: 'x' }, TENANT);
    await graph.updateColumn(5, { display_name: 'x' }, TENANT);
    await graph.updateColumnDescriptionOnly(5, 'd', false, TENANT);
    await graph.updateKpi(5, { name: 'x' }, TENANT);
    await graph.updateProductTable(5, { display_name: 'x' }, TENANT);
    await graph.updateProductColumn(5, { display_name: 'x' }, TENANT);
    await graph.updateQualityRule(5, { rule_name: 'x' }, TENANT);
    await graph.deleteQualityRule(5, TENANT);
    await graph.updateApprovalStatus('product_table', 5, { approval_status: 'approved' }, TENANT);
    expect(captured.length).toBe(9);
    expectAllScoped();
  });

  it('edge-addressed operations are scoped through a stamped endpoint node', async () => {
    await graph.setRelationshipFlagged(5, true, TENANT);
    await graph.updateRelationship(5, { description: 'x' }, TENANT);
    await graph.deleteRelationship(5, TENANT);
    await graph.deleteCrossViewRelationship(5, TENANT);
    expect(captured.length).toBe(4);
    expectAllScoped();
  });

  it('cross-source views: the connection-less listing no longer spans tenants', async () => {
    await graph.getCrossSourceViews(undefined, TENANT);
    expectAllScoped();
    captured.length = 0;
    await graph.getCrossSourceViews(7, TENANT);
    expectAllScoped();
  });

  it('cross-source view mutations are scoped on the view AND the table', async () => {
    await graph.addTableToView(1, 2, 0, 0, TENANT);
    expect(captured[0].cypher).toContain('CrossSourceView {pgId: $vpid, tenantId: $tenantId}');
    expect(captured[0].cypher).toContain('SourceTable {pgId: $tpid, tenantId: $tenantId}');
    await graph.removeTableFromView(1, 2, TENANT);
    await graph.updateTablePositionInView(1, 2, 0, 0, TENANT);
    await graph.updateCrossSourceView(1, {}, TENANT);
    await graph.deleteCrossSourceView(1, TENANT);
    expectAllScoped();
  });

  it('context assembly binds the tenant on every one of its queries', async () => {
    // Unique connection ids so cacheThrough cannot serve another test's entry.
    await graph.buildSemanticContextForQuery(70001, TENANT);
    expectAllScoped();
    captured.length = 0;
    await graph.getTableAndColumnNames(70002, TENANT);
    await graph.buildRelevantSubgraph(70003, ['t1'], TENANT);
    await graph.getJoinPaths(70004, ['a', 'b'], TENANT);
    await graph.findAllShortestPaths(70005, 1, 2, TENANT);
    expectAllScoped();
  });

  it('relationship creation refuses cross-tenant endpoints by construction', async () => {
    await graph.createRelationship({
      fromTablePgId: 1, fromColumnPgId: null, fromColName: null,
      toTablePgId: 2, toColumnPgId: null, toColName: null,
      relationshipType: 'many_to_one', description: null, aiDraft: false,
      pgId: 3, tenantId: TENANT,
    });
    expect(captured[0].cypher).toContain('{pgId: $fromTPgId, tenantId: $tenantId}');
    expect(captured[0].cypher).toContain('{pgId: $toTPgId, tenantId: $tenantId}');
    expectAllScoped();
  });

  it('getRelationshipConnectionId stays deliberately tenant-free (the ownership resolver)', async () => {
    // NEGATIVE control: this function exists to DISCOVER which tenant owns a
    // legacy graph-only relationship so the caller can authorise it against
    // Postgres. Scoping it would break exactly that. If this assertion starts
    // failing because someone added the predicate, read the tenant-exempt
    // comment on the function before "fixing" either side.
    await graph.getRelationshipConnectionId(5);
    expect(captured.length).toBe(1);
    expect(captured[0].cypher).not.toContain('$tenantId');
  });
});

/**
 * Two dual-write leaks that the tenant predicate cannot see, both found by the
 * 2026-09-09 ingestion-chain assessment (§6.3). Same driver mock: what is
 * under test is the Cypher this module emits, not Neo4j's behaviour.
 */
describe('semanticGraph — a patch touches only what the patch carries', () => {
  it('confirming a definition does not blank the fields it never mentions', async () => {
    // THE PRODUCTION SHAPE: /review confirms a column by PATCHing exactly
    // `{ ai_draft: false, approval_status: 'approved' }`. The old Cypho SET
    // every mirrored property, coalescing each missing key to null — so the
    // act of approving a description deleted it from the graph, which is the
    // copy the source-layer AI prompt reads.
    await graph.updateColumn(11, {}, TENANT);
    const { cypher, params } = captured[0];
    expect(cypher).not.toContain('c.description');
    expect(cypher).not.toContain('c.displayName');
    expect(cypher).not.toContain('c.ownerName');
    // Booleans are the subtler half: `Boolean(undefined)` is false, so an
    // untouched dimension flag used to be silently cleared.
    expect(cypher).not.toContain('c.isDimension');
    expect(cypher).not.toContain('c.isMeasure');
    // What a confirm DOES mean is still written.
    expect(cypher).toContain('c.aiDraft      = false');
    expect(params).not.toHaveProperty('description');
  });

  it('a field the patch does carry is still written, including an explicit null', async () => {
    await graph.updateColumn(11, { description: 'What this column means', owner_name: null }, TENANT);
    const { cypher, params } = captured[0];
    expect(cypher).toContain('c.description = $description');
    expect(params.description).toBe('What this column means');
    // An explicit null is an instruction to clear, not an absent key.
    expect(cypher).toContain('c.ownerName = $ownerName');
    expect(params.ownerName).toBeNull();
    // Still untouched.
    expect(cypher).not.toContain('c.displayName');
  });

  it('the same rule holds for tables', async () => {
    await graph.updateTable(9, { display_name: 'Invoices' }, TENANT);
    const { cypher, params } = captured[0];
    expect(cypher).toContain('t.displayName = $displayName');
    expect(params.displayName).toBe('Invoices');
    expect(cypher).not.toContain('t.description');
    expect(cypher).not.toContain('t.domains');
    expect(cypher).not.toContain('t.grain');
    // is_active defaulted to TRUE when absent, so a confirm could silently
    // re-activate a table someone had switched off.
    expect(cypher).not.toContain('t.isActive');
  });
});

describe('semanticGraph — re-profiling merges relationships instead of duplicating them', () => {
  const rel = {
    pgId: 501, fromTablePgId: 1, toTablePgId: 2,
    fromColPgId: 10, fromColName: 'customer_id',
    toColPgId: 20, toColName: 'id',
    relType: 'many_to_one', description: 'Invoice belongs to a customer',
  };

  it('merges on the join it asserts, not on the Postgres id', async () => {
    await graph.upsertConnectionGraph([], [], [rel], TENANT);
    const create = captured.find((c) => c.cypher.includes('RELATES_TO') && /MERGE|CREATE \(ft\)/.test(c.cypher));
    expect(create).toBeDefined();
    expect(create!.cypher).toContain('MERGE (ft)-[r:RELATES_TO {fromColName: $fromColName, toColName: $toColName}]->(tt)');
    // pgId must NOT be part of the merge key: the profiler wipes and
    // re-inserts its Postgres rows every run, so the same real relationship
    // arrives with a new id each time and would never match.
    expect(create!.cypher).not.toContain('MERGE (ft)-[r:RELATES_TO {pgId');
  });

  it('a confirmed edge stays confirmed and keeps its description', async () => {
    await graph.upsertConnectionGraph([], [], [rel], TENANT);
    const merge = captured.find((c) => c.cypher.includes('ON MATCH SET'))!;
    expect(merge.cypher).toContain('r.aiDraft     = CASE WHEN r.aiDraft = false THEN false ELSE true END');
    expect(merge.cypher).toContain('r.description = CASE WHEN r.aiDraft = false THEN r.description ELSE $description END');
    // `flagged` is a statement about the DATA. Re-deriving the relationship
    // does not settle it, so the merge must never clear it.
    expect(merge.cypher).not.toContain('r.flagged');
  });

  it('falls back to CREATE when there is no column pair to identify the edge by', async () => {
    await graph.upsertConnectionGraph([], [], [{ ...rel, fromColName: null, toColName: null }], TENANT);
    const stmt = captured.find((c) => c.cypher.includes('RELATES_TO') && !c.cypher.includes('DELETE r'))!;
    expect(stmt.cypher).toContain('CREATE (ft)-[r:RELATES_TO');
    expect(stmt.cypher).not.toContain('MERGE');
  });
});
