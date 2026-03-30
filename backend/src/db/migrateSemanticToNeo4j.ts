/**
 * migrateSemanticToNeo4j.ts — One-shot migration script.
 *
 * Copies all semantic data from PostgreSQL into Neo4j, preserving stable
 * pgIds drawn from the semantic_node_id_seq Postgres sequence so that any
 * Postgres rows that reference semantic-layer integer IDs (e.g. cross_view_tables,
 * cross_view_relationships, rule_executions) remain valid.
 *
 * Run once:  ts-node src/db/migrateSemanticToNeo4j.ts
 *
 * Safe to re-run — uses MERGE on unique keys so it won't create duplicates.
 */

import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

import { semanticDb } from './knex';
import { getSession, ensureNeo4jConstraints, closeDriver } from './neo4j';

// ---------------------------------------------------------------------------
// Helper — draw the next integer from the Postgres sequence
// ---------------------------------------------------------------------------

async function nextPgId(): Promise<number> {
  const result = await semanticDb.raw(`SELECT nextval('semantic_node_id_seq') AS id`);
  return Number(result.rows[0].id);
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

async function mergeSourceTable(params: {
  pgId: number; connectionId: number; tableName: string;
  displayName: string | null; description: string | null;
  ownerName: string | null; isActive: boolean; aiDraft: boolean;
  domains: string[]; businessKeyColumn: string | null;
  createdAt: string; updatedAt: string;
}): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MERGE (t:SourceTable {connectionId: $cid, tableName: $tn})
       ON CREATE SET
         t.pgId              = $pgId,
         t.displayName       = $displayName,
         t.description       = $description,
         t.ownerName         = $ownerName,
         t.isActive          = $isActive,
         t.aiDraft           = $aiDraft,
         t.domains           = $domains,
         t.businessKeyColumn = $businessKeyColumn,
         t.createdAt         = $createdAt,
         t.updatedAt         = $updatedAt
       ON MATCH SET
         t.displayName       = $displayName,
         t.description       = $description,
         t.ownerName         = $ownerName,
         t.isActive          = $isActive,
         t.aiDraft           = $aiDraft,
         t.domains           = $domains,
         t.businessKeyColumn = $businessKeyColumn,
         t.updatedAt         = $updatedAt`,
      {
        pgId:              params.pgId,
        cid:               params.connectionId,
        tn:                params.tableName,
        displayName:       params.displayName       ?? null,
        description:       params.description       ?? null,
        ownerName:         params.ownerName         ?? null,
        isActive:          params.isActive,
        aiDraft:           params.aiDraft,
        domains:           params.domains,
        businessKeyColumn: params.businessKeyColumn ?? null,
        createdAt:         params.createdAt,
        updatedAt:         params.updatedAt,
      },
    );
  } finally {
    await session.close();
  }
}

async function mergeSourceColumn(params: {
  pgId: number; tablePgId: number; tableName: string;
  columnName: string; dataType: string | null;
  displayName: string | null; description: string | null;
  exampleValues: unknown; isDimension: boolean; isMeasure: boolean;
  ownerName: string | null; aiDraft: boolean;
  createdAt: string; updatedAt: string;
}): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (tbl:SourceTable {pgId: $tpid})
       MERGE (col:SourceColumn {tablePgId: $tpid, columnName: $cn})
       ON CREATE SET
         col.pgId          = $pgId,
         col.tableName     = $tn,
         col.dataType      = $dataType,
         col.displayName   = $displayName,
         col.description   = $description,
         col.exampleValues = $exampleValues,
         col.isDimension   = $isDimension,
         col.isMeasure     = $isMeasure,
         col.ownerName     = $ownerName,
         col.aiDraft       = $aiDraft,
         col.createdAt     = $createdAt,
         col.updatedAt     = $updatedAt
       ON MATCH SET
         col.pgId          = $pgId,
         col.tableName     = $tn,
         col.dataType      = $dataType,
         col.displayName   = $displayName,
         col.description   = $description,
         col.exampleValues = $exampleValues,
         col.isDimension   = $isDimension,
         col.isMeasure     = $isMeasure,
         col.ownerName     = $ownerName,
         col.aiDraft       = $aiDraft,
         col.updatedAt     = $updatedAt
       MERGE (tbl)-[:HAS_COLUMN]->(col)`,
      {
        pgId:          params.pgId,
        tpid:          params.tablePgId,
        tn:            params.tableName,
        cn:            params.columnName,
        dataType:      params.dataType      ?? null,
        displayName:   params.displayName   ?? null,
        description:   params.description   ?? null,
        exampleValues: typeof params.exampleValues === 'string'
          ? params.exampleValues
          : JSON.stringify(params.exampleValues ?? []),
        isDimension:   params.isDimension,
        isMeasure:     params.isMeasure,
        ownerName:     params.ownerName     ?? null,
        aiDraft:       params.aiDraft,
        createdAt:     params.createdAt,
        updatedAt:     params.updatedAt,
      },
    );
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function migrate(): Promise<void> {
  console.log('=== Neo4j Semantic Migration ===\n');

  // Wait for Neo4j to be ready and create constraints
  await ensureNeo4jConstraints();

  // pgId maps: Postgres integer id → Neo4j pgId
  // (for existing data they are the same; we use the Postgres IDs directly)
  const tablePgIdMap  = new Map<number, number>(); // pgTableId → pgId
  const columnPgIdMap = new Map<number, number>(); // pgColId → pgId
  const kpiPgIdMap    = new Map<number, number>(); // pgKpiId → pgId
  const viewPgIdMap   = new Map<number, number>(); // pgViewId → pgId
  const rulePgIdMap   = new Map<number, number>(); // pgRuleId → pgId
  const relPgIdMap    = new Map<number, number>(); // pgRelId  → pgId

  // ── 1. Source tables ──────────────────────────────────────────────────────
  console.log('Migrating source_tables…');
  const pgTables = await semanticDb('source_tables').orderBy('id');
  for (const t of pgTables) {
    // Use the existing Postgres ID as pgId (stable, no collision risk since
    // the sequence starts at 1 and we seed it to max(id)+1 afterwards)
    const pgId = t.id as number;
    tablePgIdMap.set(pgId, pgId);
    const domains = t.domains
      ? (typeof t.domains === 'string' ? JSON.parse(t.domains) : t.domains)
      : [];
    await mergeSourceTable({
      pgId,
      connectionId:    t.connection_id as number,
      tableName:       t.table_name as string,
      displayName:     t.display_name as string | null,
      description:     t.description as string | null,
      ownerName:       t.owner_name as string | null,
      isActive:        Boolean(t.is_active),
      aiDraft:         Boolean(t.ai_draft),
      domains:         domains as string[],
      businessKeyColumn: t.business_key_column as string | null,
      createdAt:       t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at ?? new Date().toISOString()),
      updatedAt:       t.updated_at instanceof Date ? t.updated_at.toISOString() : String(t.updated_at ?? new Date().toISOString()),
    });
  }
  console.log(`  ✓ ${pgTables.length} tables`);

  // ── 2. Source columns ─────────────────────────────────────────────────────
  console.log('Migrating source_columns…');
  const pgColumns = await semanticDb('source_columns')
    .join('source_tables', 'source_columns.table_id', 'source_tables.id')
    .select('source_columns.*', 'source_tables.table_name')
    .orderBy('source_columns.id');
  for (const c of pgColumns) {
    const pgId     = c.id as number;
    const tablePgId = tablePgIdMap.get(c.table_id as number) ?? (c.table_id as number);
    columnPgIdMap.set(pgId, pgId);
    await mergeSourceColumn({
      pgId,
      tablePgId,
      tableName:     c.table_name as string,
      columnName:    c.column_name as string,
      dataType:      c.data_type as string | null,
      displayName:   c.display_name as string | null,
      description:   c.description as string | null,
      exampleValues: c.example_values,
      isDimension:   Boolean(c.is_dimension),
      isMeasure:     Boolean(c.is_measure),
      ownerName:     c.owner_name as string | null,
      aiDraft:       Boolean(c.ai_draft),
      createdAt:     c.created_at instanceof Date ? c.created_at.toISOString() : String(c.created_at ?? new Date().toISOString()),
      updatedAt:     c.updated_at instanceof Date ? c.updated_at.toISOString() : String(c.updated_at ?? new Date().toISOString()),
    });
  }
  console.log(`  ✓ ${pgColumns.length} columns`);

  // ── 3. Table relationships ─────────────────────────────────────────────────
  console.log('Migrating table_relationships…');
  const pgRels = await semanticDb('table_relationships')
    .join('source_tables as ft', 'table_relationships.from_table_id', 'ft.id')
    .join('source_tables as tt', 'table_relationships.to_table_id',   'tt.id')
    .leftJoin('source_columns as fc', 'table_relationships.from_column_id', 'fc.id')
    .leftJoin('source_columns as tc', 'table_relationships.to_column_id',   'tc.id')
    .select(
      'table_relationships.*',
      'ft.table_name as from_table_name', 'tt.table_name as to_table_name',
      'fc.column_name as from_col_name',  'tc.column_name as to_col_name',
    )
    .orderBy('table_relationships.id');

  for (const rel of pgRels) {
    const pgId       = rel.id as number;
    const fromTPgId  = tablePgIdMap.get(rel.from_table_id  as number) ?? (rel.from_table_id  as number);
    const toTPgId    = tablePgIdMap.get(rel.to_table_id    as number) ?? (rel.to_table_id    as number);
    const fromColPgId = rel.from_column_id ? (columnPgIdMap.get(rel.from_column_id as number) ?? (rel.from_column_id as number)) : null;
    const toColPgId   = rel.to_column_id   ? (columnPgIdMap.get(rel.to_column_id   as number) ?? (rel.to_column_id   as number)) : null;
    relPgIdMap.set(pgId, pgId);

    const session = getSession();
    try {
      await session.run(
        `MATCH (ft:SourceTable {pgId: $fromTPgId}), (tt:SourceTable {pgId: $toTPgId})
         MERGE (ft)-[r:RELATES_TO {pgId: $pgId}]->(tt)
         ON CREATE SET
           r.fromColPgId = $fromColPgId, r.fromColName = $fromColName,
           r.toColPgId   = $toColPgId,   r.toColName   = $toColName,
           r.relType     = $relType,     r.description = $description,
           r.aiDraft     = $aiDraft
         ON MATCH SET
           r.fromColPgId = $fromColPgId, r.fromColName = $fromColName,
           r.toColPgId   = $toColPgId,   r.toColName   = $toColName,
           r.relType     = $relType,     r.description = $description,
           r.aiDraft     = $aiDraft`,
        {
          pgId,
          fromTPgId,  toTPgId,
          fromColPgId: fromColPgId ?? null,
          fromColName: (rel.from_col_name as string | null) ?? null,
          toColPgId:   toColPgId   ?? null,
          toColName:   (rel.to_col_name   as string | null) ?? null,
          relType:     rel.relationship_type as string,
          description: (rel.description   as string | null) ?? null,
          aiDraft:     Boolean(rel.ai_draft),
        },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgRels.length} relationships`);

  // ── 4. KPI definitions ────────────────────────────────────────────────────
  console.log('Migrating kpi_definitions…');
  const pgKpis = await semanticDb('kpi_definitions').orderBy('id');
  for (const k of pgKpis) {
    const pgId = k.id as number;
    kpiPgIdMap.set(pgId, pgId);

    const session = getSession();
    try {
      await session.run(
        `MATCH (t:SourceTable {connectionId: $cid}) WITH t LIMIT 1
         MERGE (kpi:KpiDefinition {pgId: $pgId})
         ON CREATE SET
           kpi.connectionId     = $cid,
           kpi.name             = $name,
           kpi.description      = $description,
           kpi.formulaPlainText = $formulaPlainText,
           kpi.formulaSql       = $formulaSql,
           kpi.ownerName        = $ownerName,
           kpi.aiDraft          = $aiDraft,
           kpi.createdAt        = $createdAt,
           kpi.updatedAt        = $updatedAt
         ON MATCH SET
           kpi.name             = $name,
           kpi.description      = $description,
           kpi.formulaPlainText = $formulaPlainText,
           kpi.formulaSql       = $formulaSql,
           kpi.ownerName        = $ownerName,
           kpi.aiDraft          = $aiDraft,
           kpi.updatedAt        = $updatedAt
         MERGE (t)-[:DEFINES_KPI]->(kpi)`,
        {
          pgId,
          cid:             k.connection_id as number,
          name:            k.name as string,
          description:     (k.description   as string | null) ?? null,
          formulaPlainText:(k.formula_plain_text as string | null) ?? null,
          formulaSql:      (k.formula_sql    as string | null) ?? null,
          ownerName:       (k.owner_name     as string | null) ?? null,
          aiDraft:         Boolean(k.ai_draft),
          createdAt:       k.created_at instanceof Date ? k.created_at.toISOString() : String(k.created_at ?? new Date().toISOString()),
          updatedAt:       k.updated_at instanceof Date ? k.updated_at.toISOString() : String(k.updated_at ?? new Date().toISOString()),
        },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgKpis.length} KPIs`);

  // ── 5. Cross-source views ─────────────────────────────────────────────────
  console.log('Migrating cross_source_views…');
  const pgViews = await semanticDb('cross_source_views').orderBy('id');
  for (const v of pgViews) {
    const pgId = v.id as number;
    viewPgIdMap.set(pgId, pgId);

    const session = getSession();
    try {
      await session.run(
        `MERGE (cv:CrossSourceView {pgId: $pgId})
         ON CREATE SET
           cv.name        = $name,
           cv.description = $description,
           cv.userId      = $userId,
           cv.createdAt   = $createdAt,
           cv.updatedAt   = $updatedAt
         ON MATCH SET
           cv.name        = $name,
           cv.description = $description,
           cv.userId      = $userId,
           cv.updatedAt   = $updatedAt`,
        {
          pgId,
          name:        v.name as string,
          description: (v.description as string | null) ?? null,
          userId:      (v.user_id     as string | null) ?? null,
          createdAt:   v.created_at instanceof Date ? v.created_at.toISOString() : String(v.created_at ?? new Date().toISOString()),
          updatedAt:   v.updated_at instanceof Date ? v.updated_at.toISOString() : String(v.updated_at ?? new Date().toISOString()),
        },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgViews.length} cross-views`);

  // ── 6. Cross-view table memberships ───────────────────────────────────────
  console.log('Migrating cross_view_tables…');
  const pgViewTables = await semanticDb('cross_view_tables').orderBy('id');
  for (const vt of pgViewTables) {
    const viewPgId  = viewPgIdMap.get(vt.view_id  as number) ?? (vt.view_id  as number);
    const tablePgId = tablePgIdMap.get(vt.table_id as number) ?? (vt.table_id as number);

    const session = getSession();
    try {
      await session.run(
        `MATCH (cv:CrossSourceView {pgId: $vpid}), (t:SourceTable {pgId: $tpid})
         MERGE (cv)-[inc:INCLUDES]->(t)
         ON CREATE SET inc.posX = $posX, inc.posY = $posY
         ON MATCH  SET inc.posX = $posX, inc.posY = $posY`,
        { vpid: viewPgId, tpid: tablePgId, posX: vt.pos_x ?? 80, posY: vt.pos_y ?? 80 },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgViewTables.length} cross-view memberships`);

  // ── 7. Cross-view relationships ────────────────────────────────────────────
  console.log('Migrating cross_view_relationships…');
  const pgCvRels = await semanticDb('cross_view_relationships')
    .leftJoin('source_columns as fc', 'cross_view_relationships.from_column_id', 'fc.id')
    .leftJoin('source_columns as tc', 'cross_view_relationships.to_column_id',   'tc.id')
    .select('cross_view_relationships.*', 'fc.column_name as from_col_name', 'tc.column_name as to_col_name')
    .orderBy('cross_view_relationships.id');

  for (const cvr of pgCvRels) {
    const pgId      = cvr.id as number;
    const viewPgId  = viewPgIdMap.get(cvr.view_id      as number) ?? (cvr.view_id      as number);
    const fromTPgId = tablePgIdMap.get(cvr.from_table_id as number) ?? (cvr.from_table_id as number);
    const toTPgId   = tablePgIdMap.get(cvr.to_table_id   as number) ?? (cvr.to_table_id   as number);
    const fromColPgId = cvr.from_column_id ? (columnPgIdMap.get(cvr.from_column_id as number) ?? (cvr.from_column_id as number)) : null;
    const toColPgId   = cvr.to_column_id   ? (columnPgIdMap.get(cvr.to_column_id   as number) ?? (cvr.to_column_id   as number)) : null;

    const session = getSession();
    try {
      await session.run(
        `MATCH (a:SourceTable {pgId: $fromTPgId}), (b:SourceTable {pgId: $toTPgId})
         MERGE (a)-[r:CROSS_VIEW_LINK {pgId: $pgId}]->(b)
         ON CREATE SET
           r.viewPgId    = $viewPgId,
           r.relType     = $relType,
           r.label       = $label,
           r.fromColPgId = $fromColPgId, r.fromColName = $fromColName,
           r.toColPgId   = $toColPgId,   r.toColName   = $toColName
         ON MATCH SET
           r.viewPgId    = $viewPgId,
           r.relType     = $relType,
           r.label       = $label,
           r.fromColPgId = $fromColPgId, r.fromColName = $fromColName,
           r.toColPgId   = $toColPgId,   r.toColName   = $toColName`,
        {
          pgId, viewPgId, fromTPgId, toTPgId,
          relType:     (cvr.relationship_type as string) ?? 'many_to_one',
          label:       (cvr.label             as string | null) ?? null,
          fromColPgId: fromColPgId ?? null,
          fromColName: (cvr.from_col_name as string | null) ?? null,
          toColPgId:   toColPgId   ?? null,
          toColName:   (cvr.to_col_name   as string | null) ?? null,
        },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgCvRels.length} cross-view relationships`);

  // ── 8. Quality rules ───────────────────────────────────────────────────────
  console.log('Migrating quality_rules…');
  const pgRules = await semanticDb('quality_rules').orderBy('id');
  for (const qr of pgRules) {
    const pgId = qr.id as number;
    rulePgIdMap.set(pgId, pgId);

    const fieldNames = qr.field_names
      ? (typeof qr.field_names === 'string' ? JSON.parse(qr.field_names) : qr.field_names)
      : [];
    const ruleConfig = qr.rule_config
      ? (typeof qr.rule_config === 'string' ? qr.rule_config : JSON.stringify(qr.rule_config))
      : '{}';

    const session = getSession();
    try {
      await session.run(
        `MATCH (t:SourceTable {connectionId: $cid, tableName: $tn})
         MERGE (q:QualityRule {pgId: $pgId})
         ON CREATE SET
           q.connectionId  = $cid,
           q.tableName     = $tn,
           q.ruleName      = $ruleName,
           q.dimension     = $dimension,
           q.fieldNames    = $fieldNames,
           q.description   = $description,
           q.ruleType      = $ruleType,
           q.ruleConfig    = $ruleConfig,
           q.passThreshold = $passThreshold,
           q.ownerName     = $ownerName,
           q.isActive      = $isActive,
           q.createdAt     = $createdAt
         ON MATCH SET
           q.connectionId  = $cid,
           q.tableName     = $tn,
           q.ruleName      = $ruleName,
           q.dimension     = $dimension,
           q.fieldNames    = $fieldNames,
           q.description   = $description,
           q.ruleType      = $ruleType,
           q.ruleConfig    = $ruleConfig,
           q.passThreshold = $passThreshold,
           q.ownerName     = $ownerName,
           q.isActive      = $isActive
         MERGE (q)-[:APPLIES_TO]->(t)`,
        {
          pgId,
          cid:           qr.connection_id as number,
          tn:            qr.table_name    as string,
          ruleName:      qr.rule_name     as string,
          dimension:     (qr.dimension    as string | null) ?? null,
          fieldNames:    fieldNames as string[],
          description:   (qr.description  as string | null) ?? null,
          ruleType:      qr.rule_type     as string,
          ruleConfig,
          passThreshold: qr.pass_threshold != null ? Number(qr.pass_threshold) : 0.95,
          ownerName:     (qr.owner_name   as string | null) ?? null,
          isActive:      Boolean(qr.is_active),
          createdAt:     qr.created_at instanceof Date ? qr.created_at.toISOString() : String(qr.created_at ?? new Date().toISOString()),
        },
      );
    } finally {
      await session.close();
    }
  }
  console.log(`  ✓ ${pgRules.length} quality rules`);

  // ── 9. Advance the Postgres sequence past all IDs we've used ──────────────
  const allIds = [
    ...pgTables.map((r) => r.id as number),
    ...pgColumns.map((r) => r.id as number),
    ...pgRels.map((r) => r.id as number),
    ...pgKpis.map((r) => r.id as number),
    ...pgViews.map((r) => r.id as number),
    ...pgViewTables.map((r) => r.id as number),
    ...pgCvRels.map((r) => r.id as number),
    ...pgRules.map((r) => r.id as number),
  ];
  const maxId = allIds.length ? Math.max(...allIds) : 0;
  if (maxId > 0) {
    await semanticDb.raw(`SELECT setval('semantic_node_id_seq', ?)`, [maxId]);
    console.log(`\nSequence advanced to ${maxId}.  Next pgId = ${maxId + 1}`);
  }

  console.log('\n=== Migration complete ===');
  void (relPgIdMap); // suppress unused-var warnings
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => closeDriver());
