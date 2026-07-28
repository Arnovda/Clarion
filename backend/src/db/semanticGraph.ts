/**
 * semanticGraph.ts — All Cypher queries for the Neo4j semantic knowledge graph.
 * This is the ONLY file in the codebase that contains Cypher.
 *
 * Node labels:  SourceTable, SourceColumn, KpiDefinition, CrossSourceView, QualityRule,
 *               ProductTable, ProductColumn
 * Edge types:   HAS_COLUMN, RELATES_TO, DEFINES_KPI,
 *               INCLUDES (view→table), CROSS_VIEW_LINK (table→table within a view),
 *               APPLIES_TO (rule→table), CHECKS_FIELD (rule→column),
 *               FK_CANDIDATE (column→column: pre-detected join candidates from profiling)
 *
 * Every node carries a `pgId` property — a stable integer drawn from the
 * `semantic_node_id_seq` Postgres sequence.  Routes that return data to the
 * frontend expose `pgId` as `id` so existing response shapes are unchanged.
 */

import { isInt, Integer as Neo4jInt } from 'neo4j-driver';
import { getSession } from './neo4j';
import { semanticDb } from './knex';
import { cacheThrough, cacheInvalidate, CacheKeys } from '../utils/cache';

// Draw a stable integer ID from the Postgres sequence for new Neo4j nodes.
export async function nextPgId(): Promise<number> {
  const result = await semanticDb.raw(`SELECT nextval('semantic_node_id_seq') AS id`);
  return Number((result.rows as Array<{ id: string | number }>)[0].id);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toNum(v: unknown): number {
  if (isInt(v as Neo4jInt)) return (v as Neo4jInt).toNumber();
  if (typeof v === 'number') return v;
  return Number(v);
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function parseDomains(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') {
    try { return JSON.parse(v) as string[]; } catch { return []; }
  }
  return [];
}

function parseJsonField(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

// Map a Neo4j SourceTable record back to a Postgres-compatible row shape.
function mapTable(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:                   toNum(p.pgId),
    connection_id:        toNum(p.connectionId),
    table_name:           toStr(p.tableName),
    display_name:         toStr(p.displayName),
    description:          toStr(p.description),
    owner_name:           toStr(p.ownerName),
    is_active:            Boolean(p.isActive),
    ai_draft:             Boolean(p.aiDraft),
    domains:              JSON.stringify(parseDomains(p.domains)),
    grain:                toStr(p.grain),
    business_key_column:  toStr(p.businessKeyColumn),
    row_count:            p.rowCount != null ? toNum(p.rowCount) : null,
    last_profiled_at:     toStr(p.lastProfiledAt),
    approval_status:      toStr(p.approvalStatus) || 'draft',
    approved_by:          toStr(p.approvedBy),
    approved_at:          toStr(p.approvedAt),
    rejection_reason:     toStr(p.rejectionReason),
    created_at:           toStr(p.createdAt),
    updated_at:           toStr(p.updatedAt),
  };
}

// Map a Neo4j SourceColumn record back to a Postgres-compatible row shape.
function mapColumn(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:             toNum(p.pgId),
    table_id:       toNum(p.tablePgId),
    table_name:     toStr(p.tableName),     // denormalised — needed by query.ts
    column_name:    toStr(p.columnName),
    data_type:      toStr(p.dataType),
    display_name:   toStr(p.displayName),
    description:    toStr(p.description),
    example_values: parseJsonField(p.exampleValues),
    is_dimension:   Boolean(p.isDimension),
    is_measure:     Boolean(p.isMeasure),
    owner_name:     toStr(p.ownerName),
    ai_draft:       Boolean(p.aiDraft),
    approval_status:  toStr(p.approvalStatus) || 'draft',
    approved_by:      toStr(p.approvedBy),
    approved_at:      toStr(p.approvedAt),
    rejection_reason: toStr(p.rejectionReason),
    // Quality stats (may be null if profiling has not run)
    null_count:     p.nullCount     != null ? toNum(p.nullCount)     : null,
    null_pct:       p.nullPct       != null ? Number(p.nullPct)      : null,
    distinct_count: p.distinctCount != null ? toNum(p.distinctCount) : null,
    distinct_pct:   p.distinctPct   != null ? Number(p.distinctPct)  : null,
    min_value:      toStr(p.minValue),
    max_value:      toStr(p.maxValue),
    mean_value:     p.meanValue     != null ? Number(p.meanValue)    : null,
    median_value:   p.medianValue   != null ? Number(p.medianValue)  : null,
    top_values:     parseJsonField(p.topValues),
    created_at:     toStr(p.createdAt),
    updated_at:     toStr(p.updatedAt),
  };
}

// Map a Neo4j KpiDefinition node back to a Postgres-compatible row shape.
function mapKpi(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:                  toNum(p.pgId),
    connection_id:       toNum(p.connectionId),
    name:                toStr(p.name),
    description:         toStr(p.description),
    formula_plain_text:  toStr(p.formulaPlainText),
    formula_sql:         toStr(p.formulaSql),
    owner_name:          toStr(p.ownerName),
    ai_draft:            Boolean(p.aiDraft),
    approval_status:     toStr(p.approvalStatus) || 'draft',
    approved_by:         toStr(p.approvedBy),
    approved_at:         toStr(p.approvedAt),
    rejection_reason:    toStr(p.rejectionReason),
    created_at:          toStr(p.createdAt),
    updated_at:          toStr(p.updatedAt),
  };
}

// Map a Neo4j QualityRule node back to a Postgres-compatible row shape.
function mapQualityRule(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:             toNum(p.pgId),
    connection_id:  toNum(p.connectionId),
    table_name:     toStr(p.tableName),
    rule_name:      toStr(p.ruleName),
    dimension:      toStr(p.dimension),
    field_names:    JSON.stringify(parseDomains(p.fieldNames)),
    description:    toStr(p.description),
    rule_type:      toStr(p.ruleType),
    rule_config:    JSON.stringify(parseJsonField(p.ruleConfig) ?? {}),
    pass_threshold: p.passThreshold != null ? Number(p.passThreshold) : 0.95,
    owner_name:     toStr(p.ownerName),
    is_active:      Boolean(p.isActive),
    created_at:     toStr(p.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export async function getTablesByConnection(
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid})
       RETURN t ORDER BY t.tableName`,
      { cid: connectionId },
    );
    return result.records.map((r) => mapTable(r.get('t').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function updateTable(
  pgId: number,
  patch: {
    display_name?: unknown; description?: unknown; owner_name?: unknown;
    is_active?: unknown; domains?: unknown; grain?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:SourceTable {pgId: $pgId})
       SET t.displayName    = $displayName,
           t.description    = $description,
           t.ownerName      = $ownerName,
           t.isActive       = $isActive,
           t.domains        = $domains,
           t.grain          = $grain,
           t.aiDraft        = false,
           t.updatedAt      = $now`,
      {
        pgId,
        displayName: patch.display_name ?? null,
        description: patch.description ?? null,
        ownerName:   patch.owner_name  ?? null,
        isActive:    patch.is_active   !== undefined ? Boolean(patch.is_active) : true,
        domains:     Array.isArray(patch.domains) ? patch.domains : parseDomains(patch.domains),
        grain:       typeof patch.grain === 'string' ? patch.grain : null,
        now:         new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

export async function getTableDomains(connectionId: number): Promise<string[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid})
       WHERE t.domains IS NOT NULL
       RETURN t.domains AS domains`,
      { cid: connectionId },
    );
    const all = new Set<string>();
    for (const rec of result.records) {
      for (const d of parseDomains(rec.get('domains'))) {
        if (d) all.add(d);
      }
    }
    return Array.from(all).sort();
  } finally {
    await session.close();
  }
}

export async function getTableByConnectionAndName(
  connectionId: number,
  tableName: string,
): Promise<Record<string, unknown> | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn}) RETURN t`,
      { cid: connectionId, tn: tableName },
    );
    if (!result.records.length) return null;
    return mapTable(result.records[0].get('t').properties as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

export async function updateTableBusinessKey(
  connectionId: number,
  tableName: string,
  businessKeyColumn: string | null,
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn})
       SET t.businessKeyColumn = $bk, t.updatedAt = $now`,
      { cid: connectionId, tn: tableName, bk: businessKeyColumn ?? null, now: new Date().toISOString() },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export async function getColumnsByTablePgId(
  tablePgId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {pgId: $tpid})-[:HAS_COLUMN]->(c:SourceColumn)
       RETURN c, t.tableName AS tableName
       ORDER BY c.columnName`,
      { tpid: tablePgId },
    );
    return result.records.map((r) => {
      const props = r.get('c').properties as Record<string, unknown>;
      props.tableName = r.get('tableName');
      return mapColumn(props);
    });
  } finally {
    await session.close();
  }
}

export async function updateColumn(
  pgId: number,
  patch: {
    display_name?: unknown; description?: unknown; owner_name?: unknown;
    is_dimension?: unknown; is_measure?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (c:SourceColumn {pgId: $pgId})
       SET c.displayName  = $displayName,
           c.description  = $description,
           c.ownerName    = $ownerName,
           c.isDimension  = $isDimension,
           c.isMeasure    = $isMeasure,
           c.aiDraft      = false,
           c.updatedAt    = $now`,
      {
        pgId,
        displayName: patch.display_name ?? null,
        description: patch.description  ?? null,
        ownerName:   patch.owner_name   ?? null,
        isDimension: Boolean(patch.is_dimension),
        isMeasure:   Boolean(patch.is_measure),
        now:         new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * Targeted description-only mirror for the enrichment flow. Unlike
 * `updateColumn` (which SETs every mirrored field and therefore NULLs
 * whatever the caller omits), this touches ONLY description + aiDraft —
 * display name, roles and owner are left untouched.
 */
export async function updateColumnDescriptionOnly(
  pgId: number,
  description: string,
  aiDraft: boolean,
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (c:SourceColumn {pgId: $pgId})
       SET c.description = $description,
           c.aiDraft     = $aiDraft,
           c.updatedAt   = $now`,
      { pgId, description, aiDraft, now: new Date().toISOString() },
    );
  } finally {
    await session.close();
  }
}

// All columns for a connection with their table_name denormalised — used by query/dashboards context.
export async function getColumnsByConnection(
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})-[:HAS_COLUMN]->(c:SourceColumn)
       RETURN c, t.tableName AS tableName, t.pgId AS tablePgId
       ORDER BY t.tableName, c.columnName`,
      { cid: connectionId },
    );
    return result.records.map((r) => {
      const props = r.get('c').properties as Record<string, unknown>;
      props.tableName = r.get('tableName');
      props.tablePgId = r.get('tablePgId');
      return mapColumn(props);
    });
  } finally {
    await session.close();
  }
}

// Dimension columns only — for entity pre-flight check in query.ts
export async function getDimensionColumns(
  connectionId: number,
): Promise<{ column_name: string; table_name: string; data_type: string; example_values: unknown }[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})-[:HAS_COLUMN]->(c:SourceColumn {isDimension: true})
       RETURN c.columnName AS columnName, t.tableName AS tableName,
              c.dataType AS dataType, c.exampleValues AS exampleValues`,
      { cid: connectionId },
    );
    return result.records.map((r) => ({
      column_name:    String(r.get('columnName') ?? ''),
      table_name:     String(r.get('tableName')  ?? ''),
      data_type:      String(r.get('dataType')   ?? ''),
      example_values: parseJsonField(r.get('exampleValues')),
    }));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export async function getRelationshipsForConnection(
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid})-[r:RELATES_TO]->(tt:SourceTable)
       RETURN r, ft.tableName AS fromTableName, tt.tableName AS toTableName,
              ft.pgId AS fromTablePgId, tt.pgId AS toTablePgId`,
      { cid: connectionId },
    );
    return result.records.map((r) => {
      const p = r.get('r').properties as Record<string, unknown>;
      return {
        id:                 toNum(p.pgId),
        from_table_id:      toNum(r.get('fromTablePgId')),
        from_column_id:     p.fromColPgId != null ? toNum(p.fromColPgId) : null,
        to_table_id:        toNum(r.get('toTablePgId')),
        to_column_id:       p.toColPgId   != null ? toNum(p.toColPgId)   : null,
        relationship_type:  toStr(p.relType),
        description:        toStr(p.description),
        ai_draft:           Boolean(p.aiDraft),
        // Names are surfaced for UI use. The frontend filters/renders by
        // `from_table` / `to_table` (and the column variants), so we expose
        // them under both the verbose `_name` keys and the short canonical
        // keys for backward-compat with any consumer of either shape.
        from_table_name:    toStr(r.get('fromTableName')),
        to_table_name:      toStr(r.get('toTableName')),
        from_table:         toStr(r.get('fromTableName')),
        to_table:           toStr(r.get('toTableName')),
        from_column:        p.fromColName != null ? toStr(p.fromColName) : null,
        to_column:          p.toColName   != null ? toStr(p.toColName)   : null,
      };
    });
  } finally {
    await session.close();
  }
}

// Returns relationships as {from_table, from_column, to_table, to_column, relationship_type, description}
// Used by query.ts and dashboards.ts for AI context.
export async function getRelationshipsForContext(
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid, isActive: true})-[r:RELATES_TO]->(tt:SourceTable)
       RETURN r, ft.tableName AS fromTable, tt.tableName AS toTable`,
      { cid: connectionId },
    );
    return result.records.map((rec) => {
      const p = rec.get('r').properties as Record<string, unknown>;
      return {
        from_table:        toStr(rec.get('fromTable')),
        from_column:       toStr(p.fromColName),
        to_table:          toStr(rec.get('toTable')),
        to_column:         toStr(p.toColName),
        relationship_type: toStr(p.relType),
        description:       toStr(p.description),
      };
    });
  } finally {
    await session.close();
  }
}

export async function createRelationship(params: {
  fromTablePgId: number;
  fromColumnPgId: number | null;
  fromColName: string | null;
  toTablePgId: number;
  toColumnPgId: number | null;
  toColName: string | null;
  relationshipType: string;
  description: string | null;
  aiDraft: boolean;
  pgId: number;
}): Promise<number> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (ft:SourceTable {pgId: $fromTPgId}), (tt:SourceTable {pgId: $toTPgId})
       CREATE (ft)-[r:RELATES_TO {
         pgId:        $pgId,
         fromColPgId: $fromColPgId,
         fromColName: $fromColName,
         toColPgId:   $toColPgId,
         toColName:   $toColName,
         relType:     $relType,
         description: $description,
         aiDraft:     $aiDraft
       }]->(tt)`,
      {
        pgId:        params.pgId,
        fromTPgId:   params.fromTablePgId,
        toTPgId:     params.toTablePgId,
        fromColPgId: params.fromColumnPgId ?? null,
        fromColName: params.fromColName    ?? null,
        toColPgId:   params.toColumnPgId   ?? null,
        toColName:   params.toColName      ?? null,
        relType:     params.relationshipType,
        description: params.description    ?? null,
        aiDraft:     params.aiDraft,
      },
    );
    return params.pgId;
  } finally {
    await session.close();
  }
}

export async function updateRelationship(
  pgId: number,
  patch: {
    relationship_type?: unknown;
    description?: unknown;
    fromColumnPgId?: number | null;
    fromColName?: string | null;
    toColumnPgId?: number | null;
    toColName?: string | null;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH ()-[r:RELATES_TO {pgId: $pgId}]->()
       SET r.relType     = COALESCE($relType, r.relType),
           r.description = COALESCE($description, r.description),
           r.fromColPgId = CASE WHEN $hasFromCol THEN $fromColPgId ELSE r.fromColPgId END,
           r.fromColName = CASE WHEN $hasFromCol THEN $fromColName ELSE r.fromColName END,
           r.toColPgId   = CASE WHEN $hasToCol   THEN $toColPgId   ELSE r.toColPgId   END,
           r.toColName   = CASE WHEN $hasToCol   THEN $toColName   ELSE r.toColName   END,
           r.aiDraft     = false`,
      {
        pgId,
        relType:     patch.relationship_type ?? null,
        description: patch.description       ?? null,
        hasFromCol:  patch.fromColumnPgId !== undefined,
        fromColPgId: patch.fromColumnPgId    !== undefined ? patch.fromColumnPgId : null,
        fromColName: patch.fromColName       !== undefined ? patch.fromColName    : null,
        hasToCol:    patch.toColumnPgId   !== undefined,
        toColPgId:   patch.toColumnPgId      !== undefined ? patch.toColumnPgId   : null,
        toColName:   patch.toColName         !== undefined ? patch.toColName      : null,
      },
    );
  } finally {
    await session.close();
  }
}

/**
 * The connectionId that owns a relationship, or null if it doesn't exist.
 *
 * Used by the ownership gate for relationships that exist ONLY in the graph:
 * relationships created before the Postgres dual-write was added have no mirror
 * row, so `owns(db, 'table_relationships', id)` would refuse them and users
 * could no longer reject old AI drafts. Resolving the owning connection lets the
 * caller authorise those against `connections` (which IS tenant-scoped) instead
 * of falling back to trusting the id.
 */
export async function getRelationshipConnectionId(pgId: number): Promise<number | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (ft:SourceTable)-[r:RELATES_TO {pgId: $pgId}]->()
       RETURN ft.connectionId AS cid LIMIT 1`,
      { pgId },
    );
    if (!result.records.length) return null;
    const cid = toNum(result.records[0].get('cid'));
    return Number.isInteger(cid) && cid > 0 ? cid : null;
  } finally {
    await session.close();
  }
}

export async function deleteRelationship(pgId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(`MATCH ()-[r:RELATES_TO {pgId: $pgId}]->() DELETE r`, { pgId });
  } finally {
    await session.close();
  }
}

/**
 * Purge every graph node belonging to a tenant — used by the tenant-deletion
 * flow. Nodes are scoped by `connectionId` (source side: SourceTable,
 * SourceColumn, KpiDefinition, QualityRule, CrossSourceView) or `dataProductId`
 * (product side: ProductTable → ProductColumn). Pass the tenant's connection
 * and product ids (collected from Postgres before the rows are deleted).
 * DETACH DELETE removes each node with all its edges. No-op if both lists are
 * empty.
 */
export async function deleteTenantGraph(
  connectionIds: number[],
  productIds: number[],
): Promise<void> {
  if (connectionIds.length === 0 && productIds.length === 0) return;
  const session = getSession();
  try {
    if (productIds.length > 0) {
      await session.run(
        `MATCH (pt:ProductTable) WHERE pt.dataProductId IN $pids
         OPTIONAL MATCH (pt)-[:HAS_COLUMN]->(pc:ProductColumn)
         DETACH DELETE pt, pc`,
        { pids: productIds },
      );
    }
    if (connectionIds.length > 0) {
      await session.run(
        `MATCH (n) WHERE n.connectionId IN $cids DETACH DELETE n`,
        { cids: connectionIds },
      );
    }
  } finally {
    await session.close();
  }
}

export async function deleteAiDraftRelationships(connectionId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid})-[r:RELATES_TO {aiDraft: true}]->() DELETE r`,
      { cid: connectionId },
    );
  } finally {
    await session.close();
  }
}

// Fetch a single column node by pgId — used when resolving column names for relationship creation.
export async function getColumnByPgId(pgId: number): Promise<{ column_name: string; table_name: string } | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (c:SourceColumn {pgId: $pgId}) RETURN c.columnName AS cn, c.tableName AS tn`,
      { pgId },
    );
    if (!result.records.length) return null;
    return {
      column_name: String(result.records[0].get('cn') ?? ''),
      table_name:  String(result.records[0].get('tn') ?? ''),
    };
  } finally {
    await session.close();
  }
}

// Returns relationships between a given table and any of the supplied table pgIds.
// Used by cross-views when auto-importing existing relationships onto the canvas.
export async function getRelationshipsBetweenTables(
  tablePgId: number,
  otherTablePgIds: number[],
): Promise<{ from_table_id: number; from_column_id: number | null; to_table_id: number; to_column_id: number | null; relationship_type: string }[]> {
  if (!otherTablePgIds.length) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:SourceTable)-[r:RELATES_TO]->(b:SourceTable)
       WHERE (a.pgId = $tpid AND b.pgId IN $others)
          OR (b.pgId = $tpid AND a.pgId IN $others)
       RETURN a.pgId AS fromId, r.fromColPgId AS fromColId,
              b.pgId AS toId,   r.toColPgId   AS toColId,
              r.relType AS relType`,
      { tpid: tablePgId, others: otherTablePgIds },
    );
    return result.records.map((rec) => ({
      from_table_id:     toNum(rec.get('fromId')),
      from_column_id:    rec.get('fromColId') != null ? toNum(rec.get('fromColId')) : null,
      to_table_id:       toNum(rec.get('toId')),
      to_column_id:      rec.get('toColId')   != null ? toNum(rec.get('toColId'))   : null,
      relationship_type: String(rec.get('relType') ?? ''),
    }));
  } finally {
    await session.close();
  }
}

// Returns a source table and its 1-hop RELATES_TO neighbours, plus the edges.
// Used by the relationship viewer to expand a table's neighbourhood on demand.
export async function getRelatedTables(tablePgId: number): Promise<{
  tables: Array<{ id: number; tableName: string; displayName: string; connectionId: number }>;
  relationships: Array<{ id: number; fromTableId: number; fromColumnId: number | null; toTableId: number; toColumnId: number | null; relType: string; description: string | null }>;
}> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (src:SourceTable {pgId: $pgId})-[r:RELATES_TO]-(neighbor:SourceTable)
       RETURN neighbor.pgId         AS nPgId,
              neighbor.tableName    AS nTableName,
              neighbor.displayName  AS nDisplayName,
              neighbor.connectionId AS nConnId,
              r.pgId                AS rPgId,
              startNode(r).pgId     AS fromId,
              r.fromColPgId         AS fromColId,
              endNode(r).pgId       AS toId,
              r.toColPgId           AS toColId,
              r.relType             AS relType,
              r.description         AS description`,
      { pgId: tablePgId },
    );

    const tablesMap = new Map<number, { id: number; tableName: string; displayName: string; connectionId: number }>();
    const relsMap   = new Map<number, { id: number; fromTableId: number; fromColumnId: number | null; toTableId: number; toColumnId: number | null; relType: string; description: string | null }>();

    for (const rec of result.records) {
      const nId = toNum(rec.get('nPgId'));
      if (!tablesMap.has(nId)) {
        tablesMap.set(nId, {
          id:           nId,
          tableName:    String(rec.get('nTableName') ?? ''),
          displayName:  String(rec.get('nDisplayName') ?? ''),
          connectionId: toNum(rec.get('nConnId')),
        });
      }
      const rId = toNum(rec.get('rPgId'));
      if (!relsMap.has(rId)) {
        relsMap.set(rId, {
          id:           rId,
          fromTableId:  toNum(rec.get('fromId')),
          fromColumnId: rec.get('fromColId') != null ? toNum(rec.get('fromColId')) : null,
          toTableId:    toNum(rec.get('toId')),
          toColumnId:   rec.get('toColId') != null ? toNum(rec.get('toColId')) : null,
          relType:      String(rec.get('relType') ?? ''),
          description:  rec.get('description') != null ? String(rec.get('description')) : null,
        });
      }
    }

    return {
      tables:        Array.from(tablesMap.values()),
      relationships: Array.from(relsMap.values()),
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// KPI Definitions
// ---------------------------------------------------------------------------

export async function getKpisByConnection(
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (k:KpiDefinition {connectionId: $cid}) RETURN k ORDER BY k.name`,
      { cid: connectionId },
    );
    return result.records.map((r) => mapKpi(r.get('k').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function getKpisByIds(
  pgIds: number[],
  connectionId: number,
): Promise<Record<string, unknown>[]> {
  if (!pgIds.length) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (k:KpiDefinition)
       WHERE k.pgId IN $ids AND k.connectionId = $cid AND k.aiDraft = false
       RETURN k`,
      { ids: pgIds, cid: connectionId },
    );
    return result.records.map((r) => mapKpi(r.get('k').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function createKpi(params: {
  pgId: number;
  connectionId: number;
  name: string;
  description?: string | null;
  formulaPlainText?: string | null;
  formulaSql?: string | null;
  ownerName?: string | null;
  aiDraft: boolean;
}): Promise<number> {
  const session = getSession();
  const now = new Date().toISOString();
  try {
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid})
       WITH t LIMIT 1
       CREATE (k:KpiDefinition {
         pgId:             $pgId,
         connectionId:     $cid,
         name:             $name,
         description:      $description,
         formulaPlainText: $formulaPlainText,
         formulaSql:       $formulaSql,
         ownerName:        $ownerName,
         aiDraft:          $aiDraft,
         createdAt:        $now,
         updatedAt:        $now
       })
       CREATE (t)-[:DEFINES_KPI]->(k)`,
      {
        pgId:             params.pgId,
        cid:              params.connectionId,
        name:             params.name,
        description:      params.description      ?? null,
        formulaPlainText: params.formulaPlainText  ?? null,
        formulaSql:       params.formulaSql        ?? null,
        ownerName:        params.ownerName         ?? null,
        aiDraft:          params.aiDraft,
        now,
      },
    );
    return params.pgId;
  } finally {
    await session.close();
  }
}

export async function updateKpi(
  pgId: number,
  patch: {
    name?: unknown; description?: unknown;
    formula_plain_text?: unknown; formula_sql?: unknown; owner_name?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (k:KpiDefinition {pgId: $pgId})
       SET k.name             = COALESCE($name, k.name),
           k.description      = $description,
           k.formulaPlainText = $formulaPlainText,
           k.formulaSql       = $formulaSql,
           k.ownerName        = $ownerName,
           k.aiDraft          = false,
           k.updatedAt        = $now`,
      {
        pgId,
        name:             patch.name              ?? null,
        description:      patch.description       ?? null,
        formulaPlainText: patch.formula_plain_text ?? null,
        formulaSql:       patch.formula_sql        ?? null,
        ownerName:        patch.owner_name         ?? null,
        now:              new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Approval workflow — update approval status on Neo4j nodes
// ---------------------------------------------------------------------------

const LABEL_MAP: Record<string, string> = {
  table: 'SourceTable',
  column: 'SourceColumn',
  kpi: 'KpiDefinition',
  product_table: 'ProductTable',
  product_column: 'ProductColumn',
};

export async function updateApprovalStatus(
  entityType: 'table' | 'column' | 'kpi' | 'product_table' | 'product_column',
  pgId: number,
  updates: {
    approval_status: string;
    approved_by?: string | null;
    approved_at?: string | null;
    rejection_reason?: string | null;
  },
): Promise<void> {
  const label = LABEL_MAP[entityType];
  if (!label) throw new Error(`Unknown entityType: ${entityType}`);
  const session = getSession();
  try {
    await session.run(
      `MATCH (n:${label} {pgId: $pgId})
       SET n.approvalStatus   = $approvalStatus,
           n.approvedBy       = $approvedBy,
           n.approvedAt       = $approvedAt,
           n.rejectionReason  = $rejectionReason,
           n.updatedAt        = $now`,
      {
        pgId,
        approvalStatus:  updates.approval_status,
        approvedBy:      updates.approved_by ?? null,
        approvedAt:      updates.approved_at ?? null,
        rejectionReason: updates.rejection_reason ?? null,
        now:             new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Semantic context assembly — single-call replacement for the 4 sequential
// Postgres queries currently in query.ts and dashboards.ts
// ---------------------------------------------------------------------------

export interface SemanticQueryContext {
  tables:        Record<string, unknown>[];
  columns:       Record<string, unknown>[];
  kpis:          Record<string, unknown>[];
  relationships: Record<string, unknown>[];
}

/**
 * Lightweight fetch — returns only table/column NAMES (no full properties).
 * Used for entity extraction without loading full context.
 */
export async function getTableAndColumnNames(
  connectionId: number,
  domains?: string[],
): Promise<{ tableName: string; displayName: string; columnNames: string[] }[]> {
  const session = getSession();
  try {
    const domainFilter = domains && domains.length > 0
      ? 'AND ANY(d IN t.domains WHERE d IN $domains)'
      : '';
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})
       WHERE true ${domainFilter}
       OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:SourceColumn)
       RETURN t.tableName AS tableName, t.displayName AS displayName,
              collect(c.columnName) AS columnNames
       ORDER BY t.tableName`,
      { cid: connectionId, domains: domains ?? [] },
    );
    return result.records.map((r) => ({
      tableName:   toStr(r.get('tableName')),
      displayName: toStr(r.get('displayName')),
      columnNames: (r.get('columnNames') as string[]) ?? [],
    }));
  } finally {
    await session.close();
  }
}

/**
 * 2-hop subgraph — fetches full context for tables in the neighbourhood of
 * the given seed tables. Returns the same shape as buildSemanticContextForQuery.
 */
export async function buildRelevantSubgraph(
  connectionId: number,
  seedTableNames: string[],
  domains?: string[],
): Promise<SemanticQueryContext> {
  const session = getSession();
  try {
    const domainFilter = domains && domains.length > 0
      ? 'AND ANY(d IN n.domains WHERE d IN $domains)'
      : '';
    // Find seed tables + their 2-hop RELATES_TO neighbours
    const neighborResult = await session.run(
      `MATCH (seed:SourceTable {connectionId: $cid, isActive: true})
       WHERE seed.tableName IN $seeds
       MATCH (seed)-[:RELATES_TO*0..2]-(n:SourceTable {connectionId: $cid, isActive: true})
       WHERE true ${domainFilter}
       RETURN DISTINCT n.tableName AS tableName`,
      { cid: connectionId, seeds: seedTableNames, domains: domains ?? [] },
    );
    const neighborNames = neighborResult.records.map((r) => toStr(r.get('tableName')));
    if (!neighborNames.length) return { tables: [], columns: [], kpis: [], relationships: [] };

    // Fetch full context for the neighbourhood only
    const tableResult = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})
       WHERE t.tableName IN $names
       RETURN t ORDER BY t.tableName`,
      { cid: connectionId, names: neighborNames },
    );
    const tables = tableResult.records.map((r) =>
      mapTable(r.get('t').properties as Record<string, unknown>),
    );

    const colResult = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})-[:HAS_COLUMN]->(c:SourceColumn)
       WHERE t.tableName IN $names
       RETURN c, t.tableName AS tableName, t.pgId AS tablePgId
       ORDER BY t.tableName, c.columnName`,
      { cid: connectionId, names: neighborNames },
    );
    const columns = colResult.records.map((r) => {
      const cp = { ...r.get('c').properties as Record<string, unknown> };
      cp.tableName = r.get('tableName');
      cp.tablePgId = r.get('tablePgId');
      return mapColumn(cp);
    });

    const relResult = await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid, isActive: true})-[r:RELATES_TO]->(tt:SourceTable)
       WHERE ft.tableName IN $names AND tt.tableName IN $names
       RETURN r, ft.tableName AS fromTable, tt.tableName AS toTable`,
      { cid: connectionId, names: neighborNames },
    );
    const relationships = relResult.records.map((rec) => {
      const p = rec.get('r').properties as Record<string, unknown>;
      return {
        from_table:        toStr(rec.get('fromTable')),
        from_column:       toStr(p.fromColName),
        to_table:          toStr(rec.get('toTable')),
        to_column:         toStr(p.toColName),
        relationship_type: toStr(p.relType),
        description:       toStr(p.description),
      };
    });

    const kpiResult = await session.run(
      `MATCH (k:KpiDefinition {connectionId: $cid}) RETURN k ORDER BY k.name`,
      { cid: connectionId },
    );
    const kpis = kpiResult.records.map((r) =>
      mapKpi(r.get('k').properties as Record<string, unknown>),
    );

    return { tables, columns, kpis, relationships };
  } finally {
    await session.close();
  }
}

export async function buildSemanticContextForQuery(
  connectionId: number,
  domains?: string[],
): Promise<SemanticQueryContext> {
  const cacheKey = CacheKeys.semanticContext(connectionId, domains);
  return cacheThrough(cacheKey, () => _buildSemanticContextForQuery(connectionId, domains), 5 * 60 * 1000);
}

async function _buildSemanticContextForQuery(
  connectionId: number,
  domains?: string[],
): Promise<SemanticQueryContext> {
  const session = getSession();
  try {
    // --- Tables ---
    const domainFilter = domains && domains.length > 0
      ? 'AND ANY(d IN t.domains WHERE d IN $domains)'
      : '';
    const tableResult = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})
       WHERE true ${domainFilter}
       RETURN t ORDER BY t.tableName`,
      { cid: connectionId, domains: domains ?? [] },
    );
    const tables = tableResult.records.map((r) =>
      mapTable(r.get('t').properties as Record<string, unknown>),
    );

    if (!tables.length) return { tables: [], columns: [], kpis: [], relationships: [] };

    // --- Columns ---
    const colResult = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, isActive: true})-[:HAS_COLUMN]->(c:SourceColumn)
       ${domainFilter ? `WHERE ANY(d IN t.domains WHERE d IN $domains)` : ''}
       RETURN c, t.tableName AS tableName, t.pgId AS tablePgId
       ORDER BY t.tableName, c.columnName`,
      { cid: connectionId, domains: domains ?? [] },
    );
    const columns = colResult.records.map((r) => {
      const cp = { ...r.get('c').properties as Record<string, unknown> };
      cp.tableName = r.get('tableName');
      cp.tablePgId = r.get('tablePgId');
      return mapColumn(cp);
    });

    // --- Relationships ---
    const relResult = await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid, isActive: true})-[r:RELATES_TO]->(tt:SourceTable)
       RETURN r, ft.tableName AS fromTable, tt.tableName AS toTable`,
      { cid: connectionId },
    );
    const relationships = relResult.records.map((rec) => {
      const p = rec.get('r').properties as Record<string, unknown>;
      return {
        from_table:        toStr(rec.get('fromTable')),
        from_column:       toStr(p.fromColName),
        to_table:          toStr(rec.get('toTable')),
        to_column:         toStr(p.toColName),
        relationship_type: toStr(p.relType),
        description:       toStr(p.description),
      };
    });

    // --- KPIs ---
    const kpiResult = await session.run(
      `MATCH (k:KpiDefinition {connectionId: $cid}) RETURN k ORDER BY k.name`,
      { cid: connectionId },
    );
    const kpis = kpiResult.records.map((r) =>
      mapKpi(r.get('k').properties as Record<string, unknown>),
    );

    return { tables, columns, kpis, relationships };
  } finally {
    await session.close();
  }
}

/**
 * Invalidate all cached semantic data for a connection (or all connections).
 * Call this after schema changes, re-profiling, definition updates, etc.
 */
export async function invalidateSemanticCache(connectionId?: number): Promise<void> {
  if (connectionId) {
    await cacheInvalidate(CacheKeys.semanticPattern(connectionId));
  } else {
    await cacheInvalidate('semantic:*');
  }
}

// ---------------------------------------------------------------------------
// Multi-hop JOIN path discovery
// ---------------------------------------------------------------------------

export interface JoinPathStep {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  relationship_type: string;
}

/**
 * For each pair of tables in `tableNames`, find the shortest path through
 * RELATES_TO edges. Returns paths with 2+ hops (direct relationships are
 * already in the standard relationship context).
 */
export async function getJoinPaths(
  connectionId: number,
  tableNames: string[],
): Promise<{ from: string; to: string; steps: JoinPathStep[] }[]> {
  if (tableNames.length < 2) return [];
  const session = getSession();
  const paths: { from: string; to: string; steps: JoinPathStep[] }[] = [];
  try {
    // Check each pair once
    for (let i = 0; i < tableNames.length; i++) {
      for (let j = i + 1; j < tableNames.length; j++) {
        const result = await session.run(
          `MATCH path = shortestPath(
             (a:SourceTable {connectionId: $cid, tableName: $from})
             -[:RELATES_TO*..4]-
             (b:SourceTable {connectionId: $cid, tableName: $to})
           )
           WHERE length(path) >= 2
           RETURN [n IN nodes(path) | n.tableName] AS nodeNames,
                  [r IN relationships(path) | {
                    fromTable: startNode(r).tableName,
                    fromCol:   r.fromColName,
                    toTable:   endNode(r).tableName,
                    toCol:     r.toColName,
                    relType:   r.relType
                  }] AS steps`,
          { cid: connectionId, from: tableNames[i], to: tableNames[j] },
        );
        for (const rec of result.records) {
          const steps = (rec.get('steps') as Record<string, unknown>[]).map((s) => ({
            from_table:        toStr(s.fromTable),
            from_column:       toStr(s.fromCol),
            to_table:          toStr(s.toTable),
            to_column:         toStr(s.toCol),
            relationship_type: toStr(s.relType),
          }));
          paths.push({ from: tableNames[i], to: tableNames[j], steps });
        }
      }
    }
    return paths;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Path finder — all shortest paths between two tables
// ---------------------------------------------------------------------------

export interface PathFinderResult {
  paths: {
    tables: { pgId: number; tableName: string; displayName: string }[];
    relationships: {
      pgId: number;
      fromTablePgId: number;
      fromColPgId: number | null;
      fromColName: string | null;
      toTablePgId: number;
      toColPgId: number | null;
      toColName: string | null;
      relType: string;
    }[];
  }[];
}

export async function findAllShortestPaths(
  connectionId: number,
  fromTablePgId: number,
  toTablePgId: number,
): Promise<PathFinderResult> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:SourceTable {connectionId: $cid, pgId: $from}),
            (b:SourceTable {connectionId: $cid, pgId: $to})
       MATCH path = allShortestPaths((a)-[:RELATES_TO*..8]-(b))
       RETURN [n IN nodes(path) | {
                pgId: n.pgId,
                tableName: n.tableName,
                displayName: n.displayName
              }] AS tables,
              [r IN relationships(path) | {
                pgId: r.pgId,
                fromTablePgId: startNode(r).pgId,
                fromColPgId: r.fromColPgId,
                fromColName: r.fromColName,
                toTablePgId: endNode(r).pgId,
                toColPgId: r.toColPgId,
                toColName: r.toColName,
                relType: r.relType
              }] AS rels
       LIMIT 10`,
      { cid: connectionId, from: fromTablePgId, to: toTablePgId },
    );

    const paths = result.records.map((rec) => {
      const tables = (rec.get('tables') as Record<string, unknown>[]).map((t) => ({
        pgId:        toNum(t.pgId),
        tableName:   toStr(t.tableName),
        displayName: toStr(t.displayName),
      }));
      const relationships = (rec.get('rels') as Record<string, unknown>[]).map((r) => ({
        pgId:          toNum(r.pgId),
        fromTablePgId: toNum(r.fromTablePgId),
        fromColPgId:   r.fromColPgId != null ? toNum(r.fromColPgId) : null,
        fromColName:   r.fromColName != null ? toStr(r.fromColName) : null,
        toTablePgId:   toNum(r.toTablePgId),
        toColPgId:     r.toColPgId != null ? toNum(r.toColPgId) : null,
        toColName:     r.toColName != null ? toStr(r.toColName) : null,
        relType:       toStr(r.relType),
      }));
      return { tables, relationships };
    });

    return { paths };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Cross-source views
// ---------------------------------------------------------------------------

function mapCrossView(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:            toNum(p.pgId),
    name:          toStr(p.name),
    description:   toStr(p.description),
    connection_id: p.connectionId != null ? toNum(p.connectionId) : null,
    user_id:       toStr(p.userId),
    created_at:    toStr(p.createdAt),
    updated_at:    toStr(p.updatedAt),
  };
}

export async function getCrossSourceViews(connectionId?: number): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const cypher = connectionId != null
      ? `MATCH (v:CrossSourceView {connectionId: $cid}) RETURN v ORDER BY v.updatedAt DESC`
      : `MATCH (v:CrossSourceView) RETURN v ORDER BY v.updatedAt DESC`;
    const result = await session.run(cypher, connectionId != null ? { cid: connectionId } : {});
    return result.records.map((r) => mapCrossView(r.get('v').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function createCrossSourceView(params: {
  pgId: number;
  name: string;
  description?: string | null;
  connectionId?: number | null;
  userId: string | number;
}): Promise<number> {
  const session = getSession();
  const now = new Date().toISOString();
  try {
    await session.run(
      `CREATE (v:CrossSourceView {
         pgId:         $pgId,
         name:         $name,
         description:  $description,
         connectionId: $connectionId,
         userId:       $userId,
         createdAt:    $now,
         updatedAt:    $now
       })`,
      { pgId: params.pgId, name: params.name, description: params.description ?? null, connectionId: params.connectionId ?? null, userId: params.userId, now },
    );
    return params.pgId;
  } finally {
    await session.close();
  }
}

export async function updateCrossSourceView(
  pgId: number,
  patch: { name?: string; description?: string },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (v:CrossSourceView {pgId: $pgId})
       SET v.name        = COALESCE($name, v.name),
           v.description = $description,
           v.updatedAt   = $now`,
      { pgId, name: patch.name ?? null, description: patch.description ?? null, now: new Date().toISOString() },
    );
  } finally {
    await session.close();
  }
}

export async function deleteCrossSourceView(pgId: number): Promise<void> {
  const session = getSession();
  try {
    // DETACH DELETE removes the node and all its edges (INCLUDES, CROSS_VIEW_LINK if embedded)
    await session.run(
      `MATCH (v:CrossSourceView {pgId: $pgId})
       OPTIONAL MATCH (v)-[:INCLUDES]->(t:SourceTable)
       // Remove CROSS_VIEW_LINK edges that belong to this view
       WITH v, collect(t) AS ts
       UNWIND ts AS t
       OPTIONAL MATCH (t)-[cvl:CROSS_VIEW_LINK {viewPgId: $pgId}]->()
       DELETE cvl
       WITH v
       DETACH DELETE v`,
      { pgId },
    );
  } finally {
    await session.close();
  }
}

export async function getCrossSourceViewDetail(pgId: number): Promise<{
  view: Record<string, unknown> | null;
  viewTables: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  relationships: Record<string, unknown>[];
} | null> {
  const session = getSession();
  try {
    const viewResult = await session.run(
      `MATCH (v:CrossSourceView {pgId: $pgId}) RETURN v`,
      { pgId },
    );
    if (!viewResult.records.length) return null;
    const view = mapCrossView(viewResult.records[0].get('v').properties as Record<string, unknown>);

    // Tables on canvas with position
    const tablesResult = await session.run(
      `MATCH (v:CrossSourceView {pgId: $pgId})-[inc:INCLUDES]->(t:SourceTable)
       RETURN t, inc.posX AS posX, inc.posY AS posY`,
      { pgId },
    );
    const viewTables = tablesResult.records.map((r) => {
      const tp = r.get('t').properties as Record<string, unknown>;
      return {
        view_table_id: null, // no separate Postgres row
        pos_x:         r.get('posX') != null ? Number(r.get('posX')) : 80,
        pos_y:         r.get('posY') != null ? Number(r.get('posY')) : 80,
        table_id:      toNum(tp.pgId),
        table_name:    toStr(tp.tableName),
        display_name:  toStr(tp.displayName),
        connection_id: toNum(tp.connectionId),
      };
    });

    // Columns for every table on the canvas
    const tableIds = viewTables.map((t) => t.table_id as number);
    const columns: Record<string, unknown>[] = [];
    if (tableIds.length) {
      const colResult = await session.run(
        `MATCH (t:SourceTable)-[:HAS_COLUMN]->(c:SourceColumn)
         WHERE t.pgId IN $tids
         RETURN c, t.tableName AS tableName, t.pgId AS tablePgId
         ORDER BY c.columnName`,
        { tids: tableIds },
      );
      for (const r of colResult.records) {
        const cp = r.get('c').properties as Record<string, unknown>;
        cp.tableName = r.get('tableName');
        cp.tablePgId = r.get('tablePgId');
        columns.push(mapColumn(cp));
      }
    }

    // Cross-view relationships within this view
    const relResult = await session.run(
      `MATCH (a:SourceTable)-[r:CROSS_VIEW_LINK {viewPgId: $pgId}]->(b:SourceTable)
       RETURN r, a.pgId AS fromTableId, b.pgId AS toTableId`,
      { pgId },
    );
    const relationships = relResult.records.map((r) => {
      const rp = r.get('r').properties as Record<string, unknown>;
      return {
        id:                toNum(rp.pgId),
        view_id:           pgId,
        from_table_id:     toNum(r.get('fromTableId')),
        from_column_id:    rp.fromColPgId != null ? toNum(rp.fromColPgId) : null,
        to_table_id:       toNum(r.get('toTableId')),
        to_column_id:      rp.toColPgId   != null ? toNum(rp.toColPgId)   : null,
        relationship_type: toStr(rp.relType),
        label:             toStr(rp.label),
      };
    });

    return { view, viewTables, columns, relationships };
  } finally {
    await session.close();
  }
}

export async function addTableToView(
  viewPgId: number,
  tablePgId: number,
  posX: number,
  posY: number,
): Promise<void> {
  const session = getSession();
  try {
    // MERGE prevents duplicate INCLUDES edges
    await session.run(
      `MATCH (v:CrossSourceView {pgId: $vpid}), (t:SourceTable {pgId: $tpid})
       MERGE (v)-[inc:INCLUDES]->(t)
       ON CREATE SET inc.posX = $posX, inc.posY = $posY`,
      { vpid: viewPgId, tpid: tablePgId, posX, posY },
    );
  } finally {
    await session.close();
  }
}

export async function removeTableFromView(viewPgId: number, tablePgId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (v:CrossSourceView {pgId: $vpid})-[inc:INCLUDES]->(t:SourceTable {pgId: $tpid})
       DELETE inc
       WITH t
       MATCH (t)-[cvl:CROSS_VIEW_LINK {viewPgId: $vpid}]-()
       DELETE cvl`,
      { vpid: viewPgId, tpid: tablePgId },
    );
  } finally {
    await session.close();
  }
}

export async function updateTablePositionInView(
  viewPgId: number,
  tablePgId: number,
  posX: number,
  posY: number,
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (v:CrossSourceView {pgId: $vpid})-[inc:INCLUDES]->(t:SourceTable {pgId: $tpid})
       SET inc.posX = $posX, inc.posY = $posY`,
      { vpid: viewPgId, tpid: tablePgId, posX, posY },
    );
  } finally {
    await session.close();
  }
}

export async function addCrossViewRelationship(params: {
  pgId: number;
  viewPgId: number;
  fromTablePgId: number;
  fromColumnPgId?: number | null;
  fromColName?: string | null;
  toTablePgId: number;
  toColumnPgId?: number | null;
  toColName?: string | null;
  relationshipType: string;
  label?: string | null;
}): Promise<number> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (a:SourceTable {pgId: $fromTPgId}), (b:SourceTable {pgId: $toTPgId})
       CREATE (a)-[:CROSS_VIEW_LINK {
         pgId:        $pgId,
         viewPgId:    $viewPgId,
         relType:     $relType,
         label:       $label,
         fromColPgId: $fromColPgId,
         fromColName: $fromColName,
         toColPgId:   $toColPgId,
         toColName:   $toColName
       }]->(b)`,
      {
        pgId:        params.pgId,
        fromTPgId:   params.fromTablePgId,
        toTPgId:     params.toTablePgId,
        viewPgId:    params.viewPgId,
        relType:     params.relationshipType,
        label:       params.label       ?? null,
        fromColPgId: params.fromColumnPgId ?? null,
        fromColName: params.fromColName   ?? null,
        toColPgId:   params.toColumnPgId  ?? null,
        toColName:   params.toColName     ?? null,
      },
    );
    return params.pgId;
  } finally {
    await session.close();
  }
}

export async function deleteCrossViewRelationship(pgId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(`MATCH ()-[r:CROSS_VIEW_LINK {pgId: $pgId}]->() DELETE r`, { pgId });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Quality rules
// ---------------------------------------------------------------------------

export async function getQualityRules(
  connectionId: number,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (q:QualityRule {connectionId: $cid, tableName: $tn})
       RETURN q ORDER BY q.createdAt`,
      { cid: connectionId, tn: tableName },
    );
    return result.records.map((r) => mapQualityRule(r.get('q').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function getActiveQualityRules(
  connectionId: number,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (q:QualityRule {connectionId: $cid, tableName: $tn, isActive: true})
       RETURN q ORDER BY q.createdAt`,
      { cid: connectionId, tn: tableName },
    );
    return result.records.map((r) => mapQualityRule(r.get('q').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

export async function createQualityRule(params: {
  pgId: number;
  connectionId: number;
  tableName: string;
  ruleName: string;
  dimension?: string | null;
  fieldNames?: string[];
  description?: string | null;
  ruleType: string;
  ruleConfig?: Record<string, unknown>;
  passThreshold?: number;
  ownerName?: string | null;
}): Promise<number> {
  const session = getSession();
  const now = new Date().toISOString();
  try {
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn})
       CREATE (q:QualityRule {
         pgId:          $pgId,
         connectionId:  $cid,
         tableName:     $tn,
         ruleName:      $ruleName,
         dimension:     $dimension,
         fieldNames:    $fieldNames,
         description:   $description,
         ruleType:      $ruleType,
         ruleConfig:    $ruleConfig,
         passThreshold: $passThreshold,
         ownerName:     $ownerName,
         isActive:      true,
         createdAt:     $now
       })
       CREATE (q)-[:APPLIES_TO]->(t)`,
      {
        pgId:          params.pgId,
        cid:           params.connectionId,
        tn:            params.tableName,
        ruleName:      params.ruleName,
        dimension:     params.dimension     ?? null,
        fieldNames:    params.fieldNames    ?? [],
        description:   params.description   ?? null,
        ruleType:      params.ruleType,
        ruleConfig:    JSON.stringify(params.ruleConfig ?? {}),
        passThreshold: params.passThreshold ?? 0.95,
        ownerName:     params.ownerName     ?? null,
        now,
      },
    );
    return params.pgId;
  } finally {
    await session.close();
  }
}

export async function updateQualityRule(
  pgId: number,
  patch: {
    rule_name?: unknown; dimension?: unknown; field_names?: unknown;
    description?: unknown; rule_type?: unknown; rule_config?: unknown;
    pass_threshold?: unknown; owner_name?: unknown; is_active?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { pgId };

    if (patch.rule_name     !== undefined) { setClauses.push('q.ruleName = $ruleName');       params.ruleName       = patch.rule_name; }
    if (patch.dimension     !== undefined) { setClauses.push('q.dimension = $dimension');      params.dimension      = patch.dimension; }
    if (patch.field_names   !== undefined) { setClauses.push('q.fieldNames = $fieldNames');    params.fieldNames     = Array.isArray(patch.field_names) ? patch.field_names : parseDomains(patch.field_names); }
    if (patch.description   !== undefined) { setClauses.push('q.description = $description');  params.description    = patch.description; }
    if (patch.rule_type     !== undefined) { setClauses.push('q.ruleType = $ruleType');        params.ruleType       = patch.rule_type; }
    if (patch.rule_config   !== undefined) { setClauses.push('q.ruleConfig = $ruleConfig');    params.ruleConfig     = JSON.stringify(patch.rule_config); }
    if (patch.pass_threshold!== undefined) { setClauses.push('q.passThreshold = $passThreshold'); params.passThreshold = patch.pass_threshold; }
    if (patch.owner_name    !== undefined) { setClauses.push('q.ownerName = $ownerName');      params.ownerName      = patch.owner_name; }
    if (patch.is_active     !== undefined) { setClauses.push('q.isActive = $isActive');        params.isActive       = Boolean(patch.is_active); }

    if (!setClauses.length) return;
    await session.run(
      `MATCH (q:QualityRule {pgId: $pgId}) SET ${setClauses.join(', ')}`,
      params,
    );
  } finally {
    await session.close();
  }
}

export async function deleteQualityRule(pgId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (q:QualityRule {pgId: $pgId}) DETACH DELETE q`,
      { pgId },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Quality stats sync — called after profiling to update node properties
// ---------------------------------------------------------------------------

export async function updateTableQualityStats(
  connectionId: number,
  tableName: string,
  stats: { rowCount?: number | null; lastProfiledAt?: string | null },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn})
       SET t.rowCount      = $rowCount,
           t.lastProfiledAt = $lastProfiledAt`,
      {
        cid:            connectionId,
        tn:             tableName,
        rowCount:       stats.rowCount        ?? null,
        lastProfiledAt: stats.lastProfiledAt  ?? new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

export async function updateColumnQualityStats(
  connectionId: number,
  tableName: string,
  fieldName: string,
  stats: {
    nullCount?: number | null; nullPct?: number | null;
    distinctCount?: number | null; distinctPct?: number | null;
    minValue?: string | null; maxValue?: string | null;
    meanValue?: number | null; medianValue?: number | null;
    topValues?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn})-[:HAS_COLUMN]->(c:SourceColumn {columnName: $fn})
       SET c.nullCount     = $nullCount,
           c.nullPct       = $nullPct,
           c.distinctCount = $distinctCount,
           c.distinctPct   = $distinctPct,
           c.minValue      = $minValue,
           c.maxValue      = $maxValue,
           c.meanValue     = $meanValue,
           c.medianValue   = $medianValue,
           c.topValues     = $topValues`,
      {
        cid:           connectionId,
        tn:            tableName,
        fn:            fieldName,
        nullCount:     stats.nullCount     ?? null,
        nullPct:       stats.nullPct       ?? null,
        distinctCount: stats.distinctCount ?? null,
        distinctPct:   stats.distinctPct   ?? null,
        minValue:      stats.minValue      ?? null,
        maxValue:      stats.maxValue      ?? null,
        meanValue:     stats.meanValue     ?? null,
        medianValue:   stats.medianValue   ?? null,
        topValues:     stats.topValues     != null ? JSON.stringify(stats.topValues) : null,
      },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// SchemaProfiler — MERGE-based upsert (idempotent, safe for re-profiling)
// ---------------------------------------------------------------------------

export interface UpsertTableInput {
  pgId: number;
  connectionId: number;
  tableName: string;
  displayName: string;
  description: string | null;
  grain?: string | null;
  /** false when the description is connector-documented (trusted). Default true. */
  aiDraft?: boolean;
  /** Provenance rung: 'declared' | 'curated' | 'ai' (docs/SOURCE_ONBOARDING.md §1). */
  semanticSource?: string | null;
}

export interface UpsertColumnInput {
  pgId: number;
  tablePgId: number;
  tableName: string;
  columnName: string;
  dataType: string;
  displayName: string;
  description: string | null;
  exampleValues: unknown;
  isDimension: boolean;
  isMeasure: boolean;
  /** false when the description is connector-documented (trusted). Default true. */
  aiDraft?: boolean;
  /** Provenance rung: 'declared' | 'curated' | 'ai' (docs/SOURCE_ONBOARDING.md §1). */
  semanticSource?: string | null;
}

export interface UpsertRelationshipInput {
  pgId: number;
  fromTablePgId: number;
  fromColPgId: number | null;
  fromColName: string | null;
  toTablePgId: number;
  toColPgId: number | null;
  toColName: string | null;
  relType: string;
  description: string | null;
}

export async function upsertConnectionGraph(
  tables: UpsertTableInput[],
  columns: UpsertColumnInput[],
  relationships: UpsertRelationshipInput[],
): Promise<void> {
  const session = getSession();
  const now = new Date().toISOString();
  try {
    // Upsert tables — MERGE on (connectionId, tableName) so re-profiling preserves nodes
    for (const t of tables) {
      await session.run(
        `MERGE (tbl:SourceTable {connectionId: $cid, tableName: $tn})
         ON CREATE SET
           tbl.pgId           = $pgId,
           tbl.displayName    = $displayName,
           tbl.description    = $description,
           tbl.grain          = $grain,
           tbl.isActive       = true,
           tbl.aiDraft        = $aiDraft,
           tbl.semanticSource = $semanticSource,
           tbl.domains        = [],
           tbl.createdAt      = $now,
           tbl.updatedAt      = $now
         ON MATCH SET
           tbl.pgId           = $pgId,
           tbl.displayName    = $displayName,
           tbl.description    = $description,
           tbl.grain          = $grain,
           tbl.semanticSource = $semanticSource,
           tbl.aiDraft        = CASE WHEN $aiDraft THEN tbl.aiDraft ELSE false END,
           tbl.updatedAt      = $now`,
        { pgId: t.pgId, cid: t.connectionId, tn: t.tableName, displayName: t.displayName, description: t.description, grain: t.grain ?? null, aiDraft: t.aiDraft ?? true, semanticSource: t.semanticSource ?? null, now },
      );
    }

    // Upsert columns — MERGE on (tableName, columnName) so re-profiling reuses existing nodes
    // even when Postgres IDs change (delete + re-insert gives new PKs).
    for (const c of columns) {
      await session.run(
        `MATCH (tbl:SourceTable {pgId: $tpid})
         MERGE (col:SourceColumn {tableName: $tn, columnName: $cn})
         ON CREATE SET
           col.pgId           = $pgId,
           col.tablePgId      = $tpid,
           col.dataType       = $dataType,
           col.displayName    = $displayName,
           col.description    = $description,
           col.exampleValues  = $exampleValues,
           col.isDimension    = $isDimension,
           col.isMeasure      = $isMeasure,
           col.aiDraft        = $aiDraft,
           col.semanticSource = $semanticSource,
           col.createdAt      = $now,
           col.updatedAt      = $now
         ON MATCH SET
           col.pgId           = $pgId,
           col.tablePgId      = $tpid,
           col.dataType       = $dataType,
           col.displayName    = $displayName,
           col.description    = $description,
           col.exampleValues  = $exampleValues,
           col.semanticSource = $semanticSource,
           col.aiDraft        = CASE WHEN $aiDraft THEN col.aiDraft ELSE false END,
           col.updatedAt      = $now
         MERGE (tbl)-[:HAS_COLUMN]->(col)`,
        {
          pgId:           c.pgId,
          tpid:           c.tablePgId,
          tn:             c.tableName,
          cn:             c.columnName,
          dataType:       c.dataType,
          displayName:    c.displayName,
          description:    c.description,
          exampleValues:  JSON.stringify(c.exampleValues),
          isDimension:    c.isDimension,
          isMeasure:      c.isMeasure,
          aiDraft:        c.aiDraft ?? true,
          semanticSource: c.semanticSource ?? null,
          now,
        },
      );
    }

    // Remove old AI-draft RELATES_TO edges and re-create — confirmed edges are preserved
    // because we only delete where aiDraft = true.
    const connectionIds = [...new Set(tables.map((t) => t.connectionId))];
    for (const cid of connectionIds) {
      await session.run(
        `MATCH (ft:SourceTable {connectionId: $cid})-[r:RELATES_TO {aiDraft: true}]->() DELETE r`,
        { cid },
      );
    }
    for (const rel of relationships) {
      await session.run(
        `MATCH (ft:SourceTable {pgId: $fromTPgId}), (tt:SourceTable {pgId: $toTPgId})
         CREATE (ft)-[r:RELATES_TO {
           pgId:        $pgId,
           fromColPgId: $fromColPgId,
           fromColName: $fromColName,
           toColPgId:   $toColPgId,
           toColName:   $toColName,
           relType:     $relType,
           description: $description,
           aiDraft:     true
         }]->(tt)`,
        {
          pgId:        rel.pgId,
          fromTPgId:   rel.fromTablePgId,
          toTPgId:     rel.toTablePgId,
          fromColPgId: rel.fromColPgId ?? null,
          fromColName: rel.fromColName ?? null,
          toColPgId:   rel.toColPgId   ?? null,
          toColName:   rel.toColName   ?? null,
          relType:     rel.relType,
          description: rel.description ?? null,
        },
      );
    }
  } finally {
    await session.close();
  }
}

// Returns { tableName → pgId } map — needed by SchemaProfiler and re-suggest route
export async function getTablePgIdMap(connectionId: number): Promise<Map<string, number>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid}) RETURN t.tableName AS tn, t.pgId AS pgId`,
      { cid: connectionId },
    );
    const map = new Map<string, number>();
    for (const r of result.records) map.set(String(r.get('tn')), toNum(r.get('pgId')));
    return map;
  } finally {
    await session.close();
  }
}

// Returns { "tableName.columnName" → pgId } map — needed by SchemaProfiler and re-suggest route
export async function getColumnPgIdMap(connectionId: number): Promise<Map<string, number>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable {connectionId: $cid})-[:HAS_COLUMN]->(c:SourceColumn)
       RETURN t.tableName AS tn, c.columnName AS cn, c.pgId AS pgId`,
      { cid: connectionId },
    );
    const map = new Map<string, number>();
    for (const r of result.records) {
      map.set(`${r.get('tn')}.${r.get('cn')}`, toNum(r.get('pgId')));
    }
    return map;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// FK Candidate edges — pre-detected join candidates stored during profiling
// ---------------------------------------------------------------------------

export interface FkCandidateEdge {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  source: string;       // 'declared' | 'name_pattern' | 'ai_suggested' | 'value_overlap'
  confidence: number;
  overlapRatio: number | null;
}

/**
 * Persist FK candidates as FK_CANDIDATE edges between SourceColumn nodes.
 * Old candidates for this connection are deleted first.
 */
export async function saveFkCandidates(
  connectionId: number,
  candidates: FkCandidateEdge[],
): Promise<void> {
  if (!candidates.length) return;
  const session = getSession();
  try {
    // Clear old candidates for this connection
    await session.run(
      `MATCH (t:SourceTable {connectionId: $cid})-[:HAS_COLUMN]->(fc:SourceColumn)
       -[r:FK_CANDIDATE]->(:SourceColumn)
       DELETE r`,
      { cid: connectionId },
    );

    // Insert new candidates
    for (const c of candidates) {
      await session.run(
        `MATCH (ft:SourceTable {connectionId: $cid, tableName: $fromTable})-[:HAS_COLUMN]->(fc:SourceColumn {columnName: $fromCol})
         MATCH (tt:SourceTable {connectionId: $cid, tableName: $toTable})-[:HAS_COLUMN]->(tc:SourceColumn {columnName: $toCol})
         CREATE (fc)-[:FK_CANDIDATE {
           source:       $source,
           confidence:   $confidence,
           overlapRatio: $overlapRatio
         }]->(tc)`,
        {
          cid:          connectionId,
          fromTable:    c.fromTable,
          fromCol:      c.fromColumn,
          toTable:      c.toTable,
          toCol:        c.toColumn,
          source:       c.source,
          confidence:   c.confidence,
          overlapRatio: c.overlapRatio,
        },
      );
    }
  } finally {
    await session.close();
  }
}

/**
 * Retrieve all FK_CANDIDATE edges for a connection, including table/column names.
 */
export async function getFkCandidates(
  connectionId: number,
): Promise<FkCandidateEdge[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (ft:SourceTable {connectionId: $cid})-[:HAS_COLUMN]->(fc:SourceColumn)
       -[r:FK_CANDIDATE]->(tc:SourceColumn)<-[:HAS_COLUMN]-(tt:SourceTable)
       RETURN ft.tableName AS fromTable, fc.columnName AS fromCol,
              tt.tableName AS toTable,   tc.columnName AS toCol,
              r.source AS source, r.confidence AS confidence, r.overlapRatio AS overlapRatio`,
      { cid: connectionId },
    );
    return result.records.map((r) => ({
      fromTable:    String(r.get('fromTable')),
      fromColumn:   String(r.get('fromCol')),
      toTable:      String(r.get('toTable')),
      toColumn:     String(r.get('toCol')),
      source:       String(r.get('source')),
      confidence:   Number(r.get('confidence')),
      overlapRatio: r.get('overlapRatio') != null ? Number(r.get('overlapRatio')) : null,
    }));
  } finally {
    await session.close();
  }
}

// Returns tables by their pgIds — used by cross-views for integer FK compat
export async function getTablesByPgIds(pgIds: number[]): Promise<Record<string, unknown>[]> {
  if (!pgIds.length) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:SourceTable) WHERE t.pgId IN $ids RETURN t`,
      { ids: pgIds },
    );
    return result.records.map((r) => mapTable(r.get('t').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Product Tables & Columns — mirror of Postgres product_tables / product_columns
// ---------------------------------------------------------------------------

function mapProductTable(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:                    toNum(p.pgId),
    data_product_id:       toNum(p.dataProductId),
    star_schema_id:        p.starSchemaId != null ? toNum(p.starSchemaId) : null,
    table_name:            toStr(p.tableName),
    display_name:          toStr(p.displayName),
    description:           toStr(p.description),
    table_role:            toStr(p.tableRole),
    dag_order:             p.dagOrder != null ? toNum(p.dagOrder) : 0,
    row_count:             p.rowCount != null ? toNum(p.rowCount) : null,
    transformation_status: toStr(p.transformationStatus),
    owner_name:            toStr(p.ownerName),
    domains:               JSON.stringify(parseDomains(p.domains)),
    ai_draft:              Boolean(p.aiDraft),
    approval_status:       toStr(p.approvalStatus) || 'draft',
    approved_by:           toStr(p.approvedBy),
    approved_at:           toStr(p.approvedAt),
    rejection_reason:      toStr(p.rejectionReason),
    last_run_at:           toStr(p.lastRunAt),
    created_at:            toStr(p.createdAt),
    updated_at:            toStr(p.updatedAt),
  };
}

function mapProductColumn(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id:                        toNum(p.pgId),
    table_id:                  toNum(p.tablePgId),
    table_name:                toStr(p.tableName),
    column_name:               toStr(p.columnName),
    data_type:                 toStr(p.dataType),
    display_name:              toStr(p.displayName),
    description:               toStr(p.description),
    column_role:               toStr(p.columnRole),
    fk_target_table:           toStr(p.fkTargetTable),
    fk_target_column:          toStr(p.fkTargetColumn),
    transformation_expression: toStr(p.transformationExpression),
    additivity:                toStr(p.additivity),
    scd_type:                  p.scdType != null ? toNum(p.scdType) : 1,
    sort_order:                p.sortOrder != null ? toNum(p.sortOrder) : 0,
    owner_name:                toStr(p.ownerName),
    ai_draft:                  Boolean(p.aiDraft),
    approval_status:           toStr(p.approvalStatus) || 'draft',
    approved_by:               toStr(p.approvedBy),
    approved_at:               toStr(p.approvedAt),
    rejection_reason:          toStr(p.rejectionReason),
    created_at:                toStr(p.createdAt),
    updated_at:                toStr(p.updatedAt),
  };
}

// All product tables for a specific data product
export async function getProductTablesByProduct(
  dataProductId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:ProductTable {dataProductId: $dpid})
       RETURN t ORDER BY t.dagOrder, t.tableName`,
      { dpid: dataProductId },
    );
    return result.records.map((r) => mapProductTable(r.get('t').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

// All product tables across all products (for the semantic tree)
export async function getAllProductTables(): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:ProductTable)
       RETURN t ORDER BY t.dataProductId, t.dagOrder, t.tableName`,
    );
    return result.records.map((r) => mapProductTable(r.get('t').properties as Record<string, unknown>));
  } finally {
    await session.close();
  }
}

// Single product table by pgId (for version tracking)
export async function getProductTableByPgId(pgId: number): Promise<Record<string, unknown> | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:ProductTable {pgId: $pgId}) RETURN t`,
      { pgId },
    );
    if (result.records.length === 0) return null;
    return mapProductTable(result.records[0].get('t').properties as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

// Single product column by pgId (for version tracking)
export async function getProductColumnByPgId(pgId: number): Promise<Record<string, unknown> | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (c:ProductColumn {pgId: $pgId}) RETURN c`,
      { pgId },
    );
    if (result.records.length === 0) return null;
    return mapProductColumn(result.records[0].get('c').properties as Record<string, unknown>);
  } finally {
    await session.close();
  }
}

// Columns for a product table
export async function getProductColumnsByTablePgId(
  tablePgId: number,
): Promise<Record<string, unknown>[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:ProductTable {pgId: $tpid})-[:HAS_COLUMN]->(c:ProductColumn)
       RETURN c, t.tableName AS tableName
       ORDER BY c.sortOrder, c.columnName`,
      { tpid: tablePgId },
    );
    return result.records.map((r) => {
      const props = r.get('c').properties as Record<string, unknown>;
      props.tableName = r.get('tableName');
      return mapProductColumn(props);
    });
  } finally {
    await session.close();
  }
}

// Update a product table definition (governance fields)
export async function updateProductTable(
  pgId: number,
  patch: {
    display_name?: unknown; description?: unknown; owner_name?: unknown;
    domains?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:ProductTable {pgId: $pgId})
       SET t.displayName  = $displayName,
           t.description  = $description,
           t.ownerName    = $ownerName,
           t.domains      = $domains,
           t.aiDraft      = false,
           t.updatedAt    = $now`,
      {
        pgId,
        displayName: patch.display_name ?? null,
        description: patch.description  ?? null,
        ownerName:   patch.owner_name   ?? null,
        domains:     Array.isArray(patch.domains) ? patch.domains : parseDomains(patch.domains),
        now:         new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

// Update a product column definition (governance fields)
export async function updateProductColumn(
  pgId: number,
  patch: {
    display_name?: unknown; description?: unknown; owner_name?: unknown;
    column_role?: unknown;
  },
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (c:ProductColumn {pgId: $pgId})
       SET c.displayName = $displayName,
           c.description = $description,
           c.ownerName   = $ownerName,
           c.columnRole  = COALESCE($columnRole, c.columnRole),
           c.aiDraft     = false,
           c.updatedAt   = $now`,
      {
        pgId,
        displayName: patch.display_name ?? null,
        description: patch.description  ?? null,
        ownerName:   patch.owner_name   ?? null,
        columnRole:  patch.column_role   ?? null,
        now:         new Date().toISOString(),
      },
    );
  } finally {
    await session.close();
  }
}

// Upsert product tables + columns to Neo4j (called after design / transformation)
export async function upsertProductGraph(
  dataProductId: number,
  tables: Array<{
    pgId: number;
    starSchemaId: number;
    tableName: string;
    displayName: string | null;
    description: string | null;
    tableRole: string;
    dagOrder: number;
    rowCount: number | null;
    transformationStatus: string | null;
    aiDraft: boolean;
    lastRunAt: string | null;
  }>,
  columns: Array<{
    pgId: number;
    tablePgId: number;
    tableName: string;
    columnName: string;
    dataType: string | null;
    displayName: string | null;
    description: string | null;
    columnRole: string | null;
    fkTargetTable: string | null;
    fkTargetColumn: string | null;
    transformationExpression: string | null;
    additivity: string | null;
    scdType: number;
    sortOrder: number;
    aiDraft: boolean;
  }>,
): Promise<void> {
  const session = getSession();
  const now = new Date().toISOString();
  try {
    // Upsert tables — MERGE on (dataProductId, tableName)
    for (const t of tables) {
      await session.run(
        `MERGE (tbl:ProductTable {dataProductId: $dpid, tableName: $tn})
         ON CREATE SET
           tbl.pgId                  = $pgId,
           tbl.starSchemaId          = $ssid,
           tbl.displayName           = $displayName,
           tbl.description           = $description,
           tbl.tableRole             = $tableRole,
           tbl.dagOrder              = $dagOrder,
           tbl.rowCount              = $rowCount,
           tbl.transformationStatus  = $txStatus,
           tbl.aiDraft               = $aiDraft,
           tbl.lastRunAt             = $lastRunAt,
           tbl.approvalStatus        = 'draft',
           tbl.domains               = [],
           tbl.createdAt             = $now,
           tbl.updatedAt             = $now
         ON MATCH SET
           tbl.pgId                  = $pgId,
           tbl.starSchemaId          = $ssid,
           tbl.displayName           = COALESCE(CASE WHEN tbl.aiDraft = false THEN tbl.displayName ELSE $displayName END, $displayName),
           tbl.description           = COALESCE(CASE WHEN tbl.aiDraft = false THEN tbl.description ELSE $description END, $description),
           tbl.tableRole             = $tableRole,
           tbl.dagOrder              = $dagOrder,
           tbl.rowCount              = $rowCount,
           tbl.transformationStatus  = $txStatus,
           tbl.lastRunAt             = $lastRunAt,
           tbl.updatedAt             = $now`,
        {
          pgId:        t.pgId,
          dpid:        dataProductId,
          ssid:        t.starSchemaId,
          tn:          t.tableName,
          displayName: t.displayName ?? t.tableName,
          description: t.description ?? null,
          tableRole:   t.tableRole,
          dagOrder:    t.dagOrder,
          rowCount:    t.rowCount ?? null,
          txStatus:    t.transformationStatus ?? 'draft',
          aiDraft:     t.aiDraft,
          lastRunAt:   t.lastRunAt ?? null,
          now,
        },
      );
    }

    // Upsert columns — MERGE on parent table + columnName
    for (const c of columns) {
      await session.run(
        `MATCH (tbl:ProductTable {pgId: $tpid})
         MERGE (col:ProductColumn {tablePgId: $tpid, columnName: $cn})
         ON CREATE SET
           col.pgId                      = $pgId,
           col.tableName                 = $tn,
           col.dataType                  = $dataType,
           col.displayName               = $displayName,
           col.description               = $description,
           col.columnRole                = $columnRole,
           col.fkTargetTable             = $fkTargetTable,
           col.fkTargetColumn            = $fkTargetColumn,
           col.transformationExpression  = $txExpr,
           col.additivity                = $additivity,
           col.scdType                   = $scdType,
           col.sortOrder                 = $sortOrder,
           col.aiDraft                   = $aiDraft,
           col.approvalStatus            = 'draft',
           col.createdAt                 = $now,
           col.updatedAt                 = $now
         ON MATCH SET
           col.pgId                      = $pgId,
           col.tableName                 = $tn,
           col.dataType                  = $dataType,
           col.displayName               = COALESCE(CASE WHEN col.aiDraft = false THEN col.displayName ELSE $displayName END, $displayName),
           col.description               = COALESCE(CASE WHEN col.aiDraft = false THEN col.description ELSE $description END, $description),
           col.columnRole                = $columnRole,
           col.fkTargetTable             = $fkTargetTable,
           col.fkTargetColumn            = $fkTargetColumn,
           col.transformationExpression  = $txExpr,
           col.additivity                = $additivity,
           col.scdType                   = $scdType,
           col.sortOrder                 = $sortOrder,
           col.updatedAt                 = $now
         MERGE (tbl)-[:HAS_COLUMN]->(col)`,
        {
          pgId:          c.pgId,
          tpid:          c.tablePgId,
          tn:            c.tableName,
          cn:            c.columnName,
          dataType:      c.dataType ?? null,
          displayName:   c.displayName ?? c.columnName,
          description:   c.description ?? null,
          columnRole:    c.columnRole ?? null,
          fkTargetTable: c.fkTargetTable ?? null,
          fkTargetColumn:c.fkTargetColumn ?? null,
          txExpr:        c.transformationExpression ?? null,
          additivity:    c.additivity ?? null,
          scdType:       c.scdType ?? 1,
          sortOrder:     c.sortOrder ?? 0,
          aiDraft:       c.aiDraft,
          now,
        },
      );
    }

    // Remove orphaned columns (columns that were in Neo4j but not in the current set)
    const tableNames = tables.map((t) => t.tableName);
    const colKeys = columns.map((c) => `${c.tableName}::${c.columnName}`);
    if (tableNames.length) {
      await session.run(
        `MATCH (t:ProductTable {dataProductId: $dpid})-[:HAS_COLUMN]->(c:ProductColumn)
         WHERE t.tableName IN $tableNames
         WITH c, c.tableName + '::' + c.columnName AS key
         WHERE NOT key IN $colKeys
         DETACH DELETE c`,
        { dpid: dataProductId, tableNames, colKeys },
      );
    }

    // Remove orphaned tables
    const currentTableNames = tables.map((t) => t.tableName);
    await session.run(
      `MATCH (t:ProductTable {dataProductId: $dpid})
       WHERE NOT t.tableName IN $names
       OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:ProductColumn)
       DETACH DELETE c, t`,
      { dpid: dataProductId, names: currentTableNames },
    );
  } finally {
    await session.close();
  }
}

// Delete all product graph nodes for a data product
export async function deleteProductGraph(dataProductId: number): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (t:ProductTable {dataProductId: $dpid})
       OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:ProductColumn)
       DETACH DELETE c, t`,
      { dpid: dataProductId },
    );
  } finally {
    await session.close();
  }
}

// Product tree for the semantic page sidebar
export async function getProductTree(): Promise<{
  products: Array<{
    dataProductId: number;
    tables: Array<Record<string, unknown>>;
  }>;
}> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (t:ProductTable)
       OPTIONAL MATCH (t)-[:HAS_COLUMN]->(c:ProductColumn)
       RETURN t, count(c) AS columnCount
       ORDER BY t.dataProductId, t.dagOrder, t.tableName`,
    );

    const productMap = new Map<number, Array<Record<string, unknown>>>();
    for (const rec of result.records) {
      const props = rec.get('t').properties as Record<string, unknown>;
      const mapped = mapProductTable(props);
      mapped.column_count = toNum(rec.get('columnCount'));
      const dpid = toNum(props.dataProductId);
      if (!productMap.has(dpid)) productMap.set(dpid, []);
      productMap.get(dpid)!.push(mapped);
    }

    const products = Array.from(productMap.entries()).map(([dataProductId, tables]) => ({
      dataProductId,
      tables,
    }));

    return { products };
  } finally {
    await session.close();
  }
}
