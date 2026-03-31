import { TableInfo } from '../../connectors/BaseConnector';

export interface ColumnQualityStat {
  field_name: string;
  null_pct: number;
  distinct_count: number;
  row_count: number;
  top_values: Array<{ value: string; pct: number }>;
  min_value: string | null;
  max_value: string | null;
}

export interface TableQualityStat {
  table_name: string;
  row_count: number;
  columns: ColumnQualityStat[];
}

export const SCHEMA_DRAFT_SYSTEM = `You are a data cataloguing assistant. Given a database schema with table names, column names, data types, sample values, and statistical quality hints, generate plain-language definitions for every table and column.

The statistical hints tell you:
- When distinct_count equals row_count and null_pct is ~0 → that column is almost certainly the PRIMARY KEY
- When a column's distinct_count in one table closely matches the row_count of another table → strong FOREIGN KEY signal; suggest a relationship
- Low-cardinality columns (few distinct values) are dimensions; high-range numeric columns are likely measures

For each table, determine its GRAIN — what does one row represent? Express it as a short phrase starting with "one row per" (e.g. "one row per order", "one row per line item", "one row per customer").

Return JSON only, no preamble, no explanation. You MUST use exactly this structure:

{
  "tables": [
    {
      "table_name": "orders",
      "display_name": "Sales Orders",
      "description": "Records each customer order placed in the system.",
      "grain": "one row per order",
      "suggested_relationships": [
        { "to_table": "customers", "via_column": "customer_id", "to_column": "id", "type": "many_to_one" }
      ]
    }
  ],
  "columns": [
    {
      "table_name": "orders",
      "column_name": "order_date",
      "display_name": "Order Date",
      "description": "The date the customer placed the order.",
      "is_dimension": true,
      "is_measure": false
    }
  ]
}

The "columns" array must be flat — one entry per column across all tables, NOT nested inside each table.`;

export function buildSchemaDraftUser(
  sourceType: string,
  tables: TableInfo[],
  qualityStats?: TableQualityStat[],
): string {
  const schemaSection = `Source type: ${sourceType}
Schema: ${JSON.stringify(
    tables.map((t) => ({
      table_name: t.tableName,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        sample_values: c.sampleValues,
      })),
    })),
    null,
    2,
  )}`;

  if (!qualityStats || qualityStats.length === 0) return schemaSection;

  const statsSection = qualityStats.map((tbl) => {
    const colLines = tbl.columns.map((col) => {
      const nullInfo = col.null_pct > 0.001 ? `${Math.round(col.null_pct * 100)}% null` : '0% null';
      const distinctInfo = `${col.distinct_count} distinct`;
      const pct = tbl.row_count > 0 ? Math.round((col.distinct_count / tbl.row_count) * 100) : 0;

      const hints: string[] = [`${distinctInfo} (${pct}%)`, nullInfo];

      if (col.distinct_count === tbl.row_count && col.null_pct < 0.001) {
        hints.push('→ LIKELY PRIMARY KEY');
      } else if (col.null_pct < 0.05 && pct < 50 && col.distinct_count > 1) {
        hints.push('→ possible FOREIGN KEY');
      }

      if (col.top_values.length > 0 && col.distinct_count <= 20) {
        const vals = col.top_values.slice(0, 6)
          .map((v) => `${v.value}(${Math.round(v.pct * 100)}%)`)
          .join(', ');
        hints.push(`values: ${vals}`);
      } else if (col.min_value !== null && col.max_value !== null) {
        hints.push(`range ${col.min_value}–${col.max_value}`);
      }

      return `    ${col.field_name}: ${hints.join('; ')}`;
    }).join('\n');

    return `${tbl.table_name} (${tbl.row_count} rows):\n${colLines}`;
  }).join('\n\n');

  return `${schemaSection}

Statistical quality hints (use these to identify PKs, FKs, and relationships):
${statsSection}`;
}

export interface SchemaDraftOutput {
  tables: Array<{
    table_name: string;
    display_name: string;
    description: string;
    grain?: string;        // e.g. "one row per order"
    suggested_relationships: Array<{
      to_table: string;
      via_column: string;   // column in the FROM table (the FK side)
      to_column: string;    // column in the TO table (the PK side)
      type: string;
    }>;
  }>;
  columns: Array<{
    table_name: string;
    column_name: string;
    display_name: string;
    description: string;
    is_dimension: boolean;
    is_measure: boolean;
  }>;
}
