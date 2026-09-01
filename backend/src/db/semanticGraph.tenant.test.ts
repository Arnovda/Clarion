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
