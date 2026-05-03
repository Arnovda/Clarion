import { SqliteConnector } from '../connectors/SqliteConnector';
import { BaseConnector, FkCandidate } from '../connectors/BaseConnector';
import { createConnector } from '../connectors/ConnectorFactory';
import {
  detectSchemaConventions,
  generateTableContext,
  generateColumnDescriptions,
  suggestFkMatches,
} from '../ai/AIService';
import type { TableContextOutput, FkCandidateLike } from '../ai/prompts/schemaContextPrompt';
import { semanticDb } from '../db/knex';
import { runQualityProfile, runQualityProfileWithConnector } from '../quality/QualityProfiler';
import { TableQualityStat } from '../ai/prompts/schemaDraftPrompt';
import * as graph from '../db/semanticGraph';
import { getConnector as getSourceConnector } from '@databridge/connectors';

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
 * Three-pass schema profiler.
 *
 *   1. Heuristic FK detection (declared / known-from-connector / name-pattern
 *      / value-overlap) — runs first so subsequent AI calls have anchor points.
 *   2. Quality profiling — null %, distinct counts, top values per column.
 *   3. AI Pass A: detect schema conventions (Haiku, cheap).
 *   4. AI Pass B: generate table descriptions + relationships (one call,
 *      all tables, no per-column descriptions yet).
 *   5. Verify AI-suggested relationships via value-overlap JOINs against
 *      the live data — keep only those with ≥50% overlap.
 *   6. AI Pass C: per-batch column descriptions, with the table context +
 *      verified relationships injected. This is where "InvoiceTo" turns
 *      into "Which customer is being billed for this invoice" instead of
 *      a generic "Account reference".
 *   7. Persist to Postgres + Neo4j.
 *
 * Falls back gracefully on every AI step — a failed conventions/context/column
 * pass logs a warning, the next stage still runs with what it has, and the
 * profiler always returns success unless the introspection itself blows up.
 */
export async function runSchemaProfiler(
  connectionId: number,
  filePath: string | null,
  onProgress?: (p: ProfilerProgress) => void,
  connectorOverride?: BaseConnector,
): Promise<ProfilerResult> {
  const emit = onProgress ?? (() => {});

  // ── 1. Introspect source schema ────────────────────────────────────────
  emit({ phase: 'schema', message: 'Reading database schema…' });
  let connector: BaseConnector;
  let shouldDisconnect = true;
  let connectorType: string | null = null;
  let selectedEntities: readonly string[] | null = null;

  if (connectorOverride) {
    connector = connectorOverride;
    shouldDisconnect = false;
    // We may still want connector_type / selected_entities for AI priming.
    const conn = await semanticDb('connections').where({ id: connectionId }).first();
    connectorType = conn?.connector_type ?? null;
    selectedEntities = (conn?.selected_entities as string[] | null) ?? null;
  } else {
    const conn = await semanticDb('connections').where({ id: connectionId }).first();
    if (conn) {
      connector = await createConnector(conn);
      connectorType = conn.connector_type ?? null;
      selectedEntities = (conn.selected_entities as string[] | null) ?? null;
    } else if (filePath) {
      connector = new SqliteConnector(filePath);
    } else {
      throw new Error(`Connection ${connectionId} not found and no file path provided`);
    }
  }

  await connector.connect();
  const schema = await connector.introspectSchema();
  const heuristicFks: FkCandidate[] = schema.fkCandidates ?? [];
  const classifications = schema.tableClassifications ?? [];

  // ── 1a. Known-from-connector FKs (free signal, no AI tokens) ───────────
  // API-style sources (ExactOnline, NetSuite, …) ship a documented data
  // model — far more reliable than heuristic name-pattern matching on
  // PascalCase columns.
  const knownFks: FkCandidate[] = [];
  if (connectorType && selectedEntities) {
    try {
      const sourceConnector = getSourceConnector(connectorType);
      if (sourceConnector.getKnownRelationships) {
        const known = sourceConnector.getKnownRelationships(selectedEntities);
        for (const rel of known) {
          knownFks.push({
            fromTable: rel.fromTable,
            fromColumn: rel.fromColumn,
            toTable: rel.toTable,
            toColumn: rel.toColumn,
            source: 'declared',
            confidence: 1.0,
          });
        }
        console.log(`[SchemaProfiler] Loaded ${knownFks.length} known relationship(s) from ${connectorType}`);
      }
    } catch (err) {
      console.warn(`[SchemaProfiler] getKnownRelationships(${connectorType}) failed:`, err);
    }
  }

  // De-duplicate: heuristic FKs that match a known one are dropped.
  const knownKeys = new Set(knownFks.map((k) => `${k.fromTable}.${k.fromColumn}→${k.toTable}.${k.toColumn}`));
  const heuristicMinusKnown = heuristicFks.filter(
    (fk) => !knownKeys.has(`${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`),
  );

  const declaredCount = heuristicFks.filter((fk) => fk.source === 'declared').length;
  const patternCount = heuristicFks.filter((fk) => fk.source === 'name_pattern').length;
  const overlapCount = heuristicFks.filter((fk) => fk.source === 'value_overlap').length;
  const fkParts: string[] = [];
  if (knownFks.length) fkParts.push(`${knownFks.length} known`);
  if (declaredCount) fkParts.push(`${declaredCount} declared`);
  if (patternCount) fkParts.push(`${patternCount} by name`);
  if (overlapCount) fkParts.push(`${overlapCount} by data`);
  const fkSummary = fkParts.length ? ` — ${fkParts.join(', ')}` : '';
  emit({ phase: 'schema', message: `Found ${schema.tables.length} tables${fkSummary}` });

  // ── 1b. AI-assisted FK matching (legacy assist) ────────────────────────
  const unmatched = connector.getUnmatchedKeyColumns(schema.tables, classifications, [...knownFks, ...heuristicMinusKnown]);
  const allFkCandidates = [...knownFks, ...heuristicMinusKnown];
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
      const aiAdded = allFkCandidates.length - knownFks.length - heuristicMinusKnown.length;
      if (aiAdded > 0) emit({ phase: 'schema', message: `Claude found ${aiAdded} additional relationship(s)` });
    } catch (err) {
      console.warn('[SchemaProfiler] AI FK matching failed (non-fatal):', err);
    }
  }

  // ── 2. Quality profiling ───────────────────────────────────────────────
  const qualityStats: TableQualityStat[] = [];
  for (let ti = 0; ti < schema.tables.length; ti++) {
    const table = schema.tables[ti];
    emit({ phase: 'quality', message: `Profiling ${table.tableName}…`, table: table.tableName, tableIndex: ti, tableCount: schema.tables.length });
    try {
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

  // ── 3. AI Pass A — detect schema conventions ───────────────────────────
  emit({ phase: 'ai_draft', message: 'Detecting source naming conventions…' });
  const conventions = await detectSchemaConventions(connectorType, schema.tables);
  if (conventions) {
    console.log(`[SchemaProfiler] Conventions: ${conventions.naming_style} (confidence ${conventions.confidence})`);
  }

  // ── 4. AI Pass B — table descriptions + relationships ──────────────────
  emit({ phase: 'ai_draft', message: 'Inferring relationships across the schema…' });
  const fkLikes: FkCandidateLike[] = allFkCandidates.map((fk) => ({
    fromTable: fk.fromTable,
    fromColumn: fk.fromColumn,
    toTable: fk.toTable,
    toColumn: fk.toColumn,
    source: fk.source,
    confidence: fk.confidence,
    overlapRatio: fk.overlapRatio ?? null,
  }));

  let tableContext: TableContextOutput;
  try {
    tableContext = await generateTableContext(
      connectorType, conventions, schema.tables, qualityStats, fkLikes,
    );
    console.log(`[SchemaProfiler] Pass B: ${tableContext.tables.length} tables, ${tableContext.relationships.length} relationships`);
  } catch (err) {
    console.warn('[SchemaProfiler] generateTableContext failed (non-fatal):', err);
    tableContext = {
      tables: schema.tables.map((t) => ({
        table_name: t.tableName, display_name: t.tableName, description: '', grain: '',
      })),
      relationships: [],
    };
  }

  // ── 4a. Build a case-insensitive lookup for the AI's `from_table` /
  //        `to_table` strings. Without this, EO `salesinvoicelines` would
  //        silently fail to match `SalesInvoiceLines` in the schema and the
  //        relationship would be dropped on insert.
  const tableNameByLower = new Map<string, string>();
  for (const t of schema.tables) tableNameByLower.set(t.tableName.toLowerCase(), t.tableName);

  // Normalise relationship table names back to the canonical (Parquet-header)
  // casing so column / table lookups downstream succeed.
  const droppedAiRels: string[] = [];
  for (const rel of tableContext.relationships) {
    const fromCanon = tableNameByLower.get(rel.from_table.toLowerCase());
    const toCanon = tableNameByLower.get(rel.to_table.toLowerCase());
    if (!fromCanon) { droppedAiRels.push(`${rel.from_table}.${rel.via_column}→${rel.to_table}`); continue; }
    if (!toCanon)   { droppedAiRels.push(`${rel.from_table}.${rel.via_column}→${rel.to_table}`); continue; }
    rel.from_table = fromCanon;
    rel.to_table = toCanon;
  }
  if (droppedAiRels.length > 0) {
    console.warn(`[SchemaProfiler] Dropped ${droppedAiRels.length} AI relationship(s) — table not in schema: ${droppedAiRels.slice(0, 5).join(', ')}${droppedAiRels.length > 5 ? '…' : ''}`);
  }
  // Drop the canonicalised-out rels (those whose endpoint tables don't exist).
  tableContext.relationships = tableContext.relationships.filter(
    (r) => tableNameByLower.has(r.from_table.toLowerCase()) && tableNameByLower.has(r.to_table.toLowerCase()),
  );

  // ── 5. Verify AI-suggested relationships via value-overlap ─────────────
  // Drops anything where the data doesn't actually back the suggestion.
  // Skips relationships that came from a known/declared/value-overlap source
  // (those are already trusted). Only verifies the AI's net-new suggestions.
  emit({ phase: 'ai_draft', message: 'Verifying AI-suggested relationships against the data…' });
  const trustedKeys = new Set(allFkCandidates.map((fk) => `${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`));
  const verifiedAiRels: typeof tableContext.relationships = [];
  let aiVerified = 0, aiDropped = 0;
  const VERIFY_TIMEOUT = 8_000;
  const VERIFY_BUDGET  = 60_000;
  const verifyStart = Date.now();
  for (const rel of tableContext.relationships) {
    const key = `${rel.from_table}.${rel.via_column}→${rel.to_table}.${rel.to_column}`;
    if (trustedKeys.has(key)) {
      verifiedAiRels.push(rel);
      continue;
    }
    if (Date.now() - verifyStart > VERIFY_BUDGET) {
      // Budget exhausted — keep remaining AI rels as-is (ai_draft = true,
      // user can confirm/flag in the review queue).
      verifiedAiRels.push(rel);
      continue;
    }
    try {
      const verifyResult = await Promise.race([
        connector.executeQuery(
          `SELECT COUNT(DISTINCT f.v) as matched,
                  (SELECT COUNT(DISTINCT "${rel.via_column}") FROM "${rel.from_table}" WHERE "${rel.via_column}" IS NOT NULL) as total
           FROM (SELECT DISTINCT "${rel.via_column}" as v FROM "${rel.from_table}" WHERE "${rel.via_column}" IS NOT NULL ORDER BY "${rel.via_column}" LIMIT 500) f
           INNER JOIN "${rel.to_table}" t ON CAST(f.v AS TEXT) = CAST(t."${rel.to_column}" AS TEXT)`,
        ),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('verify timeout')), VERIFY_TIMEOUT)),
      ]);
      const row = verifyResult.rows[0] as { matched: number; total: number } | undefined;
      const ratio = row && row.total > 0 ? row.matched / row.total : 0;
      if (ratio >= 0.5) {
        verifiedAiRels.push(rel);
        // Also add to allFkCandidates so it's persisted with overlap info.
        allFkCandidates.push({
          fromTable: rel.from_table, fromColumn: rel.via_column,
          toTable: rel.to_table, toColumn: rel.to_column,
          source: 'ai_suggested',
          confidence: ratio >= 0.9 ? 0.9 : 0.75,
          overlapRatio: ratio,
        });
        aiVerified++;
        console.log(`[SchemaProfiler] AI rel verified: ${key} (overlap ${Math.round(ratio * 100)}%)`);
      } else {
        aiDropped++;
        console.log(`[SchemaProfiler] AI rel rejected: ${key} (overlap ${Math.round(ratio * 100)}%)`);
      }
    } catch {
      // Verification failed (timeout / type mismatch) — keep the rel
      // anyway as ai_draft so the user can review. Better than silently
      // dropping a potentially-good relationship.
      verifiedAiRels.push(rel);
    }
  }
  tableContext.relationships = verifiedAiRels;
  if (aiVerified > 0 || aiDropped > 0) {
    emit({ phase: 'ai_draft', message: `Verified ${aiVerified} AI-suggested relationship(s)${aiDropped ? `, dropped ${aiDropped}` : ''}` });
  }

  // ── 6. AI Pass C — column descriptions with table+rel context ──────────
  emit({ phase: 'ai_draft', message: 'Claude is describing columns…' });
  let columnDescriptions;
  try {
    columnDescriptions = await generateColumnDescriptions(
      connectorType, tableContext, schema.tables, qualityStats,
      (tableNames, batchIndex, totalBatches) => {
        emit({ phase: 'ai_draft', message: `Describing ${tableNames.join(', ')}…`, batchIndex, batchCount: totalBatches });
      },
    );
  } catch (err) {
    console.warn('[SchemaProfiler] generateColumnDescriptions failed (non-fatal):', err);
    columnDescriptions = { columns: [] };
  }

  if (shouldDisconnect) connector.disconnect();

  // Lookup maps
  const tableContextByName = new Map(tableContext.tables.map((t) => [t.table_name, t]));
  const columnDefByKey = new Map(
    columnDescriptions.columns.map((c) => [`${c.table_name}.${c.column_name}`, c]),
  );

  // ── 7. Persist to Postgres + Neo4j ─────────────────────────────────────
  let tablesInserted = 0;
  let columnsInserted = 0;
  let relationshipsInserted = 0;

  const tableIdMap  = new Map<string, number>();
  const columnIdMap = new Map<string, number>();
  let pgRelsForNeo4j: Array<Record<string, unknown>> = [];

  emit({ phase: 'storing', message: 'Saving definitions to database…' });
  await semanticDb.transaction(async (trx) => {
    const existingTables = await trx('source_tables')
      .where({ connection_id: connectionId })
      .select('id', 'table_name');
    const existingTableIds = existingTables.map((t: { id: number }) => t.id);

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

        if (cvRelSnapshots.length) {
          await trx('cross_view_relationships')
            .whereIn('id', cvRelSnapshots.map((r) => r.id))
            .delete();
        }
      }

      const cvTables = await trx('cross_view_tables')
        .whereIn('table_id', existingTableIds)
        .select('view_id', 'table_id', 'pos_x', 'pos_y');

      cvTableSnapshots = cvTables.map((r: { view_id: number; table_id: number; pos_x: number; pos_y: number }) => ({
        view_id:    r.view_id,
        table_name: tableIdToName.get(r.table_id) ?? '',
        pos_x:      r.pos_x,
        pos_y:      r.pos_y,
      }));

      await trx('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', existingTableIds).orWhereIn('to_table_id', existingTableIds);
        })
        .delete();
      await trx('source_columns').whereIn('table_id', existingTableIds).delete();
      await trx('source_tables').whereIn('id', existingTableIds).delete();
    }

    // Re-insert tables and columns
    for (const table of schema.tables) {
      const ctx = tableContextByName.get(table.tableName);

      const [row] = await trx('source_tables')
        .insert({
          connection_id: connectionId,
          table_name:    table.tableName,
          display_name:  ctx?.display_name ?? table.tableName,
          description:   ctx?.description  ?? null,
          is_active:     true,
          ai_draft:      true,
        })
        .returning('id');

      const tableId: number = typeof row === 'object' ? (row as { id: number }).id : (row as number);
      tableIdMap.set(table.tableName, tableId);
      tablesInserted++;

      for (const srcCol of table.columns) {
        const colDef = columnDefByKey.get(`${table.tableName}.${srcCol.name}`);

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

    // Insert relationships from the AI table-context pass.
    const insertedRelKeys = new Set<string>();
    for (const rel of tableContext.relationships) {
      const fromTableId = tableIdMap.get(rel.from_table);
      const toTableId = tableIdMap.get(rel.to_table);
      if (!fromTableId || !toTableId) continue;

      const fromColId = columnIdMap.get(`${rel.from_table}.${rel.via_column}`) ?? null;
      const toColId = columnIdMap.get(`${rel.to_table}.${rel.to_column}`) ?? null;

      const relKey = `${rel.from_table}.${rel.via_column}→${rel.to_table}.${rel.to_column}`;
      if (insertedRelKeys.has(relKey)) continue;
      insertedRelKeys.add(relKey);

      // Known/declared relationships go in NOT-draft so they show up
      // immediately as confirmed; AI-only suggestions go in as drafts for
      // user review.
      const isKnown = knownKeys.has(relKey);
      await trx('table_relationships').insert({
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: rel.type,
        description:       rel.reason ?? `${rel.from_table}.${rel.via_column} → ${rel.to_table}.${rel.to_column}`,
        ai_draft:          !isKnown,
      });
      relationshipsInserted++;
    }

    // 5b. Insert any high-confidence programmatic FK candidates not already covered.
    for (const fk of allFkCandidates) {
      if (fk.confidence < 0.7) continue;
      const relKey = `${fk.fromTable}.${fk.fromColumn}→${fk.toTable}.${fk.toColumn}`;
      if (insertedRelKeys.has(relKey)) continue;

      const fromTableId = tableIdMap.get(fk.fromTable);
      const toTableId   = tableIdMap.get(fk.toTable);
      if (!fromTableId || !toTableId) continue;

      const fromColId = columnIdMap.get(`${fk.fromTable}.${fk.fromColumn}`) ?? null;
      const toColId   = columnIdMap.get(`${fk.toTable}.${fk.toColumn}`) ?? null;

      insertedRelKeys.add(relKey);
      const isKnown = knownKeys.has(relKey);
      await trx('table_relationships').insert({
        from_table_id:     fromTableId,
        from_column_id:    fromColId,
        to_table_id:       toTableId,
        to_column_id:      toColId,
        relationship_type: 'many_to_one',
        description:       `${fk.fromTable}.${fk.fromColumn} → ${fk.toTable}.${fk.toColumn} [${fk.source}]`,
        ai_draft:          !isKnown,
      });
      relationshipsInserted++;
    }

    // Restore cross_view_tables / cross_view_relationships
    for (const snap of cvTableSnapshots) {
      const newTableId = tableIdMap.get(snap.table_name);
      if (!newTableId) continue;
      await trx('cross_view_tables')
        .insert({ view_id: snap.view_id, table_id: newTableId, pos_x: snap.pos_x, pos_y: snap.pos_y })
        .onConflict()
        .ignore();
    }

    for (const snap of cvRelSnapshots) {
      const fromTableId = tableIdMap.get(snap.from_table);
      const toTableId   = tableIdMap.get(snap.to_table);
      if (!fromTableId || !toTableId) continue;

      const fromColId = snap.from_col
        ? (columnIdMap.get(`${snap.from_table}.${snap.from_col}`) ?? null)
        : null;
      const toColId = snap.to_col
        ? (columnIdMap.get(`${snap.to_table}.${snap.to_col}`) ?? null)
        : null;

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

  // ── Sync to Neo4j ──────────────────────────────────────────────────────
  emit({ phase: 'neo4j', message: 'Syncing to knowledge graph…' });
  try {
    const graphTables: graph.UpsertTableInput[] = schema.tables.map((t) => {
      const ctx = tableContextByName.get(t.tableName);
      return {
        pgId:         tableIdMap.get(t.tableName) ?? 0,
        connectionId,
        tableName:    t.tableName,
        displayName:  ctx?.display_name ?? t.tableName,
        description:  ctx?.description  ?? null,
        grain:        ctx?.grain        ?? null,
      };
    }).filter((t) => t.pgId > 0);

    const graphColumns: graph.UpsertColumnInput[] = [];
    for (const t of schema.tables) {
      const tablePgId = tableIdMap.get(t.tableName);
      if (!tablePgId) continue;
      for (const srcCol of t.columns) {
        const colDef = columnDefByKey.get(`${t.tableName}.${srcCol.name}`);
        const colPgId = columnIdMap.get(`${t.tableName}.${srcCol.name}`);
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

    console.log(`[SchemaProfiler] Neo4j sync: ${graphTables.length} tables, ${graphColumns.length} columns, ${pgRelsForNeo4j.length} relationships`);
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
    console.warn('[SchemaProfiler] Neo4j sync failed (non-fatal):', neo4jErr);
  }

  return { connectionId, tablesInserted, columnsInserted, relationshipsInserted };
}
