import { SqliteConnector } from '../connectors/SqliteConnector';
import { BaseConnector, FkCandidate } from '../connectors/BaseConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import { generateSchemaDraft, suggestFkMatches } from '../ai/AIService';
import { semanticDb } from '../db/knex';
import { runQualityProfile, runQualityProfileWithConnector } from '../quality/QualityProfiler';
import { TableQualityStat } from '../ai/prompts/schemaDraftPrompt';
import * as graph from '../db/semanticGraph';

export interface ProfilerResult {
  connectionId: number;
  tablesInserted: number;
  columnsInserted: number;
  relationshipsInserted: number;
}

export interface ProfilerProgress {
  phase: 'schema' | 'quality' | 'ai_draft' | 'storing' | 'neo4j' | 'done' | 'error';
  message: string;
  table?: string;
  tableIndex?: number;
  tableCount?: number;
  batchIndex?: number;
  batchCount?: number;
}

/**
 * Reads the source schema, calls Claude for draft definitions, and stores
 * everything in the semantic layer (PostgreSQL) with ai_draft = true.
 * Nothing is visible to end-users until an admin confirms each definition.
 *
 * @param connectorOverride — if provided, use this connector instead of creating one from config.
 *        Used when profiling runs on DuckDB after ingestion.
 */
export async function runSchemaProfiler(
  connectionId: number,
  filePath: string | null,
  onProgress?: (p: ProfilerProgress) => void,
  connectorOverride?: BaseConnector,
): Promise<ProfilerResult> {
  const emit = onProgress ?? (() => {});

  // 1. Introspect source schema
  emit({ phase: 'schema', message: 'Reading database schema…' });
  let connector: BaseConnector;
  let shouldDisconnect = true;

  if (connectorOverride) {
    connector = connectorOverride;
    shouldDisconnect = false; // caller manages lifecycle
  } else {
    // Use the factory to create the right connector from the connection record
    const conn = await semanticDb('connections').where({ id: connectionId }).first();
    if (conn) {
      connector = await createConnector(conn);
    } else if (filePath) {
      // Legacy fallback for SQLite filepath
      connector = new SqliteConnector(filePath);
    } else {
      throw new Error(`Connection ${connectionId} not found and no file path provided`);
    }
  }

  await connector.connect();
  const schema = await connector.introspectSchema();
  const heuristicFks: FkCandidate[] = schema.fkCandidates ?? [];
  const classifications = schema.tableClassifications ?? [];

  const declaredCount = heuristicFks.filter((fk) => fk.source === 'declared').length;
  const patternCount = heuristicFks.filter((fk) => fk.source === 'name_pattern').length;
  const overlapCount = heuristicFks.filter((fk) => fk.source === 'value_overlap').length;
  const fkParts: string[] = [];
  if (declaredCount) fkParts.push(`${declaredCount} declared`);
  if (patternCount) fkParts.push(`${patternCount} by name`);
  if (overlapCount) fkParts.push(`${overlapCount} by data`);
  const fkSummary = fkParts.length ? ` — ${fkParts.join(', ')}` : '';
  emit({ phase: 'schema', message: `Found ${schema.tables.length} tables${fkSummary}` });

  // 1b. AI-assisted FK matching — send unmatched key columns to Claude
  const unmatched = connector.getUnmatchedKeyColumns(schema.tables, classifications, heuristicFks);
  const allFkCandidates = [...heuristicFks];
  if (unmatched.length > 0) {
    emit({ phase: 'schema', message: `Asking Claude to match ${unmatched.length} unmatched key column(s)…` });
    const dimTables = classifications
      .filter((c) => c.role === 'dimension' || c.role === 'unknown')
      .map((c) => {
        const t = schema.tables.find((t2) => t2.tableName === c.tableName)!;
        return {
          tableName: c.tableName,
          columns: t.columns.map((col) => ({ name: col.name, sampleValues: col.sampleValues })),
          role: c.role,
        };
      });
    try {
      const aiSuggestions = await suggestFkMatches(unmatched, dimTables);
      // Verify AI suggestions with value overlap
      for (const s of aiSuggestions) {
        const key = `${s.from_table}.${s.from_column}→${s.to_table}.${s.to_column}`;
        if (allFkCandidates.some((c) => `${c.fromTable}.${c.fromColumn}→${c.toTable}.${c.toColumn}` === key)) continue;
        try {
          const result = await connector.executeQuery(
            `SELECT COUNT(DISTINCT f.v) as matched,
                    (SELECT COUNT(DISTINCT "${s.from_column}") FROM "${s.from_table}" WHERE "${s.from_column}" IS NOT NULL) as total
             FROM (SELECT DISTINCT "${s.from_column}" as v FROM "${s.from_table}" WHERE "${s.from_column}" IS NOT NULL ORDER BY "${s.from_column}" LIMIT 500) f
             INNER JOIN "${s.to_table}" t ON CAST(f.v AS TEXT) = CAST(t."${s.to_column}" AS TEXT)`,
          );
          const row = result.rows[0] as { matched: number; total: number } | undefined;
          const ratio = row && row.total > 0 ? row.matched / row.total : 0;
          if (ratio >= 0.5) {
            console.log(`[FK AI] verified: ${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column}: overlap ${Math.round(ratio * 100)}%`);
            allFkCandidates.push({
              fromTable: s.from_table, fromColumn: s.from_column,
              toTable: s.to_table, toColumn: s.to_column,
              source: 'ai_suggested', confidence: ratio >= 0.9 ? 0.9 : 0.75,
              overlapRatio: ratio,
            });
          } else {
            console.log(`[FK AI] rejected: ${s.from_table}.${s.from_column} → ${s.to_table}.${s.to_column}: overlap ${Math.round(ratio * 100)}%`);
          }
        } catch { /* verification query failed — skip */ }
      }
      const aiAdded = allFkCandidates.length - heuristicFks.length;
      if (aiAdded > 0) emit({ phase: 'schema', message: `Claude found ${aiAdded} additional relationship(s)` });
    } catch (err) {
      // AI FK matching is non-fatal — heuristic results are still used
      console.warn('[SchemaProfiler] AI FK matching failed (non-fatal):', err);
    }
  }
  if (shouldDisconnect) connector.disconnect();

  // 2. Run quality profiling for all tables first — results feed into the AI draft
  //    so Claude has statistical signals (PK/FK detection, cardinality) for better relationships.
  //    Failures are swallowed per-table so a bad table never blocks the rest.
  const qualityStats: TableQualityStat[] = [];
  for (let ti = 0; ti < schema.tables.length; ti++) {
    const table = schema.tables[ti];
    emit({ phase: 'quality', message: `Profiling ${table.tableName}…`, table: table.tableName, tableIndex: ti, tableCount: schema.tables.length });
    try {
      // Use connector-based profiler for DuckDB; file-based for SQLite
      const useDuckDb = connectorOverride || (await semanticDb('connections').where({ id: connectionId }).first())?.query_engine === 'duckdb';
      let result: Awaited<ReturnType<typeof runQualityProfile>>;
      if (useDuckDb && connectorOverride) {
        result = await runQualityProfileWithConnector(connectionId, table.tableName, connectorOverride, table.columns.map(c => ({ name: c.name, type: c.type })));
      } else {
        result = await runQualityProfile(connectionId, table.tableName, filePath ?? '');
      }
      qualityStats.push({
        table_name: table.tableName,
        row_count:  result.rowCount,
        columns: result.fields.map((f) => ({
          field_name:     f.field_name,
          null_pct:       f.null_pct,
          distinct_count: f.distinct_count,
          row_count:      result.rowCount,
          top_values:     (f.top_values ?? []).map((v) => ({ value: String(v.value), pct: v.pct })),
          min_value:      f.min_value,
          max_value:      f.max_value,
        })),
      });
    } catch (err) {
      console.warn(`[SchemaProfiler] quality pre-profile skipped for ${table.tableName}:`, err);
    }
  }

  // 3. Generate AI draft definitions — now enriched with quality stats
  emit({ phase: 'ai_draft', message: 'Claude is generating definitions…' });
  const draft = await generateSchemaDraft('sqlite', schema.tables, qualityStats, allFkCandidates, (tableNames, batchIndex, totalBatches) => {
    emit({ phase: 'ai_draft', message: `Generating definitions for ${tableNames.join(', ')}…`, batchIndex, batchCount: totalBatches });
  });

  // 3. Build lookup maps from the draft
  const tableDefMap = new Map(draft.tables.map((t) => [t.table_name, t]));
  const columnDefs = draft.columns;

  // 4. Insert source_tables and source_columns in a transaction
  //    First wipe any existing rows so re-profiling never creates duplicates.
  let tablesInserted = 0;
  let columnsInserted = 0;
  let relationshipsInserted = 0;

  // Map from table_name → inserted id, and "table_name.column_name" → column id
  const tableIdMap  = new Map<string, number>();
  const columnIdMap = new Map<string, number>(); // key: "tableName.columnName"
  let pgRelsForNeo4j: Array<Record<string, unknown>> = []; // populated inside trx for Neo4j sync

  emit({ phase: 'storing', message: 'Saving definitions to database…' });
  await semanticDb.transaction(async (trx) => {
    // Fetch existing tables/columns for this connection
    const existingTables = await trx('source_tables')
      .where({ connection_id: connectionId })
      .select('id', 'table_name');
    const existingTableIds = existingTables.map((t: { id: number }) => t.id);

    // Snapshot cross-view references by name so we can restore them after re-insert
    type CvRelSnapshot = {
      id: number; view_id: number; relationship_type: string; label: string | null;
      from_table: string; from_col: string | null;
      to_table:   string; to_col:   string | null;
    };
    type CvTableSnapshot = { view_id: number; table_name: string; pos_x: number; pos_y: number };

    let cvRelSnapshots:   CvRelSnapshot[]   = [];
    let cvTableSnapshots: CvTableSnapshot[] = [];

    if (existingTableIds.length) {
      const existingColumns = await trx('source_columns')
        .whereIn('table_id', existingTableIds)
        .select('id', 'column_name', 'table_id');

      const colIdToName = new Map(
        existingColumns.map((c: { id: number; column_name: string; table_id: number }) => {
          const tbl = existingTables.find((t: { id: number }) => t.id === c.table_id);
          return [c.id, { table: tbl?.table_name ?? '', col: c.column_name }];
        }),
      );
      const tableIdToName = new Map(existingTables.map((t: { id: number; table_name: string }) => [t.id, t.table_name]));

      // Snapshot cross_view_relationships that touch these tables/columns
      const existingColumnIds = existingColumns.map((c: { id: number }) => c.id);
      if (existingColumnIds.length || existingTableIds.length) {
        const cvRels = await trx('cross_view_relationships')
          .where(function () {
            this
              .whereIn('from_table_id', existingTableIds)
              .orWhereIn('to_table_id',   existingTableIds)
              .orWhereIn('from_column_id', existingColumnIds)
              .orWhereIn('to_column_id',   existingColumnIds);
          })
          .select('id', 'view_id', 'from_table_id', 'from_column_id',
                  'to_table_id', 'to_column_id', 'relationship_type', 'label');

        cvRelSnapshots = cvRels.map((r: {
          id: number; view_id: number;
          from_table_id: number; from_column_id: number | null;
          to_table_id:   number; to_column_id:   number | null;
          relationship_type: string; label: string | null;
        }) => ({
          id:                r.id,
          view_id:           r.view_id,
          relationship_type: r.relationship_type,
          label:             r.label,
          from_table: tableIdToName.get(r.from_table_id) ?? '',
          from_col:   r.from_column_id ? (colIdToName.get(r.from_column_id)?.col ?? null) : null,
          to_table:   tableIdToName.get(r.to_table_id) ?? '',
          to_col:     r.to_column_id   ? (colIdToName.get(r.to_column_id)?.col   ?? null) : null,
        }));

        // Delete snapshotted rows to unblock the FK
        if (cvRelSnapshots.length) {
          await trx('cross_view_relationships')
            .whereIn('id', cvRelSnapshots.map((r) => r.id))
            .delete();
        }
      }

      // Snapshot cross_view_tables that touch these tables
      const cvTables = await trx('cross_view_tables')
        .whereIn('table_id', existingTableIds)
        .select('view_id', 'table_id', 'pos_x', 'pos_y');

      cvTableSnapshots = cvTables.map((r: { view_id: number; table_id: number; pos_x: number; pos_y: number }) => ({
        view_id:    r.view_id,
        table_name: tableIdToName.get(r.table_id) ?? '',
        pos_x:      r.pos_x,
        pos_y:      r.pos_y,
      }));

      // cross_view_tables has onDelete CASCADE so it will auto-delete when source_tables is deleted
      // But we need the snapshot above to re-insert after — no explicit delete needed here.

      await trx('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', existingTableIds).orWhereIn('to_table_id', existingTableIds);
        })
        .delete();
      await trx('source_columns').whereIn('table_id', existingTableIds).delete();
      await trx('source_tables').whereIn('id', existingTableIds).delete();
      // cross_view_tables rows cascade-deleted automatically here
    }

    // Re-insert tables and columns (new IDs)
    for (const table of schema.tables) {
      const def = tableDefMap.get(table.tableName);

      const [row] = await trx('source_tables')
        .insert({
          connection_id: connectionId,
          table_name:    table.tableName,
          display_name:  def?.display_name ?? table.tableName,
          description:   def?.description  ?? null,
          is_active:     true,
          ai_draft:      true,
        })
        .returning('id');

      const tableId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
      tableIdMap.set(table.tableName, tableId);
      tablesInserted++;

      const colsForTable = columnDefs.filter((c) => c.table_name === table.tableName);

      for (const srcCol of table.columns) {
        const colDef = colsForTable.find((c) => c.column_name === srcCol.name);

        const [colRow] = await trx('source_columns')
          .insert({
            table_id:       tableId,
            column_name:    srcCol.name,
            data_type:      srcCol.type,
            display_name:   colDef?.display_name ?? srcCol.name,
            description:    colDef?.description  ?? null,
            example_values: JSON.stringify(srcCol.sampleValues),
            is_dimension:   colDef?.is_dimension  ?? false,
            is_measure:     colDef?.is_measure    ?? false,
            ai_draft:       true,
          })
          .returning('id');

        const colId: number = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);
        columnIdMap.set(`${table.tableName}.${srcCol.name}`, colId);
        columnsInserted++;
      }
    }

    // 5. Insert suggested relationships (AI-generated + programmatic FK merge)
    //    Track which column pairs have been inserted to avoid duplicates.
    const insertedRelKeys = new Set<string>();

    for (const tableDef of draft.tables) {
      const fromTableId = tableIdMap.get(tableDef.table_name);
      if (!fromTableId) continue;

      for (const rel of tableDef.suggested_relationships ?? []) {
        const toTableId = tableIdMap.get(rel.to_table);
        if (!toTableId) continue;

        const fromColId = rel.via_column
          ? (columnIdMap.get(`${tableDef.table_name}.${rel.via_column}`) ?? null)
          : null;
        const toColId = rel.to_column
          ? (columnIdMap.get(`${rel.to_table}.${rel.to_column}`) ?? null)
          : null;

        const relKey = `${tableDef.table_name}.${rel.via_column ?? ''}→${rel.to_table}.${rel.to_column ?? ''}`;
        if (insertedRelKeys.has(relKey)) continue;
        insertedRelKeys.add(relKey);

        await trx('table_relationships').insert({
          from_table_id:     fromTableId,
          from_column_id:    fromColId,
          to_table_id:       toTableId,
          to_column_id:      toColId,
          relationship_type: rel.type,
          description:       `${tableDef.table_name}.${rel.via_column ?? '?'} → ${rel.to_table}.${rel.to_column ?? '?'}`,
          ai_draft:          true,
        });
        relationshipsInserted++;
      }
    }

    // 5b. Insert any high-confidence programmatic FK candidates that Claude missed
    for (const fk of allFkCandidates) {
      if (fk.confidence < 0.7) continue; // skip low-confidence guesses
      const relKey = `${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`;
      if (insertedRelKeys.has(relKey)) continue; // already inserted by AI

      const fromTableId = tableIdMap.get(fk.fromTable);
      const toTableId   = tableIdMap.get(fk.toTable);
      if (!fromTableId || !toTableId) continue;

      const fromColId = columnIdMap.get(`${fk.fromTable}.${fk.fromColumn}`) ?? null;
      const toColId   = columnIdMap.get(`${fk.toTable}.${fk.toColumn}`) ?? null;

      insertedRelKeys.add(relKey);
      await trx('table_relationships').insert({
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: 'many_to_one', // safe default for FK relationships
        description:       `${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn} [${fk.source}]`,
        ai_draft:          true,
      });
      relationshipsInserted++;
    }

    // 6. Restore cross_view_tables — only for tables that still exist
    for (const snap of cvTableSnapshots) {
      const newTableId = tableIdMap.get(snap.table_name);
      if (!newTableId) continue; // table was removed from source — drop the canvas node
      await trx('cross_view_tables')
        .insert({ view_id: snap.view_id, table_id: newTableId, pos_x: snap.pos_x, pos_y: snap.pos_y })
        .onConflict()
        .ignore();
    }

    // 7. Restore cross_view_relationships — only where both tables AND columns still exist
    for (const snap of cvRelSnapshots) {
      const fromTableId = tableIdMap.get(snap.from_table);
      const toTableId   = tableIdMap.get(snap.to_table);
      if (!fromTableId || !toTableId) continue; // a referenced table was removed

      const fromColId = snap.from_col
        ? (columnIdMap.get(`${snap.from_table}.${snap.from_col}`) ?? null)
        : null;
      const toColId = snap.to_col
        ? (columnIdMap.get(`${snap.to_table}.${snap.to_col}`) ?? null)
        : null;

      // If a specific column was referenced but no longer exists, drop this relationship
      if (snap.from_col && !fromColId) continue;
      if (snap.to_col   && !toColId)   continue;

      await trx('cross_view_relationships').insert({
        view_id:           snap.view_id,
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: snap.relationship_type,
        label:             snap.label,
      });
    }

    // Pre-fetch relationships inside the transaction (while RLS context is active)
    // so Neo4j sync has the data after the transaction closes.
    const _insertedTableIds = Array.from(tableIdMap.values());
    pgRelsForNeo4j = _insertedTableIds.length
      ? await trx('table_relationships')
          .leftJoin('source_columns as fc', 'table_relationships.from_column_id', 'fc.id')
          .leftJoin('source_columns as tc', 'table_relationships.to_column_id',   'tc.id')
          .whereIn('table_relationships.from_table_id', _insertedTableIds)
          .select(
            'table_relationships.id',
            'table_relationships.from_table_id', 'table_relationships.to_table_id',
            'table_relationships.from_column_id', 'table_relationships.to_column_id',
            'table_relationships.relationship_type',
            'table_relationships.description',
            'fc.column_name as from_col_name',
            'tc.column_name as to_col_name',
          )
      : [];
  });

  // ── Sync to Neo4j ──────────────────────────────────────────────────────────
  // After all Postgres inserts complete, mirror the semantic layer to Neo4j.
  // Uses MERGE so re-profiling is safe and confirmed definitions are preserved.
  emit({ phase: 'neo4j', message: 'Syncing to knowledge graph…' });
  try {
    // Build UpsertTableInput / UpsertColumnInput arrays from the maps we just built.
    const graphTables: graph.UpsertTableInput[] = schema.tables.map((t) => {
      const def = tableDefMap.get(t.tableName);
      return {
        pgId:         tableIdMap.get(t.tableName) ?? 0,
        connectionId,
        tableName:    t.tableName,
        displayName:  def?.display_name ?? t.tableName,
        description:  def?.description  ?? null,
        grain:        def?.grain        ?? null,
      };
    }).filter((t) => t.pgId > 0);

    const graphColumns: graph.UpsertColumnInput[] = [];
    for (const t of schema.tables) {
      const tablePgId = tableIdMap.get(t.tableName);
      if (!tablePgId) continue;
      const colDefs = columnDefs.filter((c) => c.table_name === t.tableName);
      for (const srcCol of t.columns) {
        const colDef   = colDefs.find((c) => c.column_name === srcCol.name);
        const colPgId  = columnIdMap.get(`${t.tableName}.${srcCol.name}`);
        if (!colPgId) continue;
        graphColumns.push({
          pgId:          colPgId,
          tablePgId,
          tableName:     t.tableName,
          columnName:    srcCol.name,
          dataType:      srcCol.type,
          displayName:   colDef?.display_name ?? srcCol.name,
          description:   colDef?.description  ?? null,
          exampleValues: srcCol.sampleValues,
          isDimension:   colDef?.is_dimension  ?? false,
          isMeasure:     colDef?.is_measure    ?? false,
        });
      }
    }

    // Use relationships pre-fetched inside the transaction (RLS context was active there)
    console.log(`[SchemaProfiler] Neo4j sync: ${graphTables.length} tables, ${graphColumns.length} columns, ${pgRelsForNeo4j.length} relationships pre-fetched from Postgres`);
    const graphRels: graph.UpsertRelationshipInput[] = (pgRelsForNeo4j as {
      id: number; from_table_id: number; to_table_id: number;
      from_column_id: number | null; to_column_id: number | null;
      relationship_type: string; description: string | null;
      from_col_name: string | null; to_col_name: string | null;
    }[]).map((r) => ({
      pgId:          r.id,
      fromTablePgId: r.from_table_id,
      fromColPgId:   r.from_column_id ?? null,
      fromColName:   r.from_col_name  ?? null,
      toTablePgId:   r.to_table_id,
      toColPgId:     r.to_column_id   ?? null,
      toColName:     r.to_col_name    ?? null,
      relType:       r.relationship_type,
      description:   r.description ?? null,
    }));

    await graph.upsertConnectionGraph(graphTables, graphColumns, graphRels);

    // Persist FK candidates so re-suggest can use them later
    if (allFkCandidates.length > 0) {
      await graph.saveFkCandidates(
        connectionId,
        allFkCandidates.map((fk) => ({
          fromTable:    fk.fromTable,
          fromColumn:   fk.fromColumn,
          toTable:      fk.toTable,
          toColumn:     fk.toColumn,
          source:       fk.source,
          confidence:   fk.confidence,
          overlapRatio: fk.overlapRatio ?? null,
        })),
      );
    }
  } catch (neo4jErr) {
    // Non-fatal — Postgres is the source of truth until Phase 7.
    // Log but don't throw; the profiler should still return success.
    console.warn('[SchemaProfiler] Neo4j sync failed (non-fatal):', neo4jErr);
  }

  return { connectionId, tablesInserted, columnsInserted, relationshipsInserted };
}
