import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateSchemaDraft } from '../ai/AIService';
import { semanticDb } from '../db/knex';
import { runQualityProfile } from '../quality/QualityProfiler';
import { TableQualityStat } from '../ai/prompts/schemaDraftPrompt';

export interface ProfilerResult {
  connectionId: number;
  tablesInserted: number;
  columnsInserted: number;
  relationshipsInserted: number;
}

/**
 * Reads the source schema, calls Claude for draft definitions, and stores
 * everything in the semantic layer (PostgreSQL) with ai_draft = true.
 * Nothing is visible to end-users until an admin confirms each definition.
 */
export async function runSchemaProfiler(
  connectionId: number,
  filePath: string,
): Promise<ProfilerResult> {
  // 1. Introspect source schema
  const connector = new SqliteConnector(filePath);
  await connector.connect();
  const schema = await connector.introspectSchema();
  connector.disconnect();

  // 2. Run quality profiling for all tables first — results feed into the AI draft
  //    so Claude has statistical signals (PK/FK detection, cardinality) for better relationships.
  //    Failures are swallowed per-table so a bad table never blocks the rest.
  const qualityStats: TableQualityStat[] = [];
  for (const table of schema.tables) {
    try {
      const result = await runQualityProfile(connectionId, table.tableName, filePath);
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
  const draft = await generateSchemaDraft('sqlite', schema.tables, qualityStats);

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

    // 5. Insert suggested relationships
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
  });

  return { connectionId, tablesInserted, columnsInserted, relationshipsInserted };
}
