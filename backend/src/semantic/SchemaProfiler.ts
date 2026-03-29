import { SqliteConnector } from '../connectors/SqliteConnector';
import { generateSchemaDraft } from '../ai/AIService';
import { semanticDb } from '../db/knex';
import { runQualityProfile } from '../quality/QualityProfiler';

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

  // 2. Generate AI draft definitions
  const draft = await generateSchemaDraft('sqlite', schema.tables);

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
    // Delete existing data for this connection before re-inserting
    const existingTables = await trx('source_tables').where({ connection_id: connectionId }).select('id');
    const existingTableIds = existingTables.map((t: { id: number }) => t.id);
    if (existingTableIds.length) {
      const existingColumnIds = await trx('source_columns')
        .whereIn('table_id', existingTableIds)
        .pluck('id');

      // Remove cross_view_relationships that reference these columns before deleting columns
      if (existingColumnIds.length) {
        await trx('cross_view_relationships')
          .where(function () {
            this.whereIn('from_column_id', existingColumnIds).orWhereIn('to_column_id', existingColumnIds);
          })
          .delete();
      }

      await trx('table_relationships')
        .where(function () {
          this.whereIn('from_table_id', existingTableIds).orWhereIn('to_table_id', existingTableIds);
        })
        .delete();
      await trx('source_columns').whereIn('table_id', existingTableIds).delete();
      await trx('source_tables').whereIn('id', existingTableIds).delete();
    }

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

      // Insert columns for this table
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

    // 5. Insert suggested relationships — now with column IDs resolved
    for (const tableDef of draft.tables) {
      const fromTableId = tableIdMap.get(tableDef.table_name);
      if (!fromTableId) continue;

      for (const rel of tableDef.suggested_relationships ?? []) {
        const toTableId = tableIdMap.get(rel.to_table);
        if (!toTableId) continue;

        // Resolve column IDs from the column map (best-effort — null if not found)
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
  });

  // Auto-run quality profiling for every table — fire and forget, never blocks schema profiling
  for (const table of schema.tables) {
    runQualityProfile(connectionId, table.tableName, filePath)
      .catch((err) => console.error(`[QualityProfiler] auto-profile failed for ${table.tableName}:`, err));
  }

  return { connectionId, tablesInserted, columnsInserted, relationshipsInserted };
}
