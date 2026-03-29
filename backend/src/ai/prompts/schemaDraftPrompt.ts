import { TableInfo } from '../../connectors/BaseConnector';

export const SCHEMA_DRAFT_SYSTEM = `You are a data cataloguing assistant. Given a database schema with table names, column names, data types, and sample values, generate plain-language definitions for every table and column.

Return JSON only, no preamble, no explanation. You MUST use exactly this structure:

{
  "tables": [
    {
      "table_name": "orders",
      "display_name": "Sales Orders",
      "description": "Records each customer order placed in the system.",
      "suggested_relationships": [
        { "to_table": "customers", "via_column": "customer_id", "to_column": "customer_id", "type": "many_to_one" }
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

export function buildSchemaDraftUser(sourceType: string, tables: TableInfo[]): string {
  return `Source type: ${sourceType}
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
}

export interface SchemaDraftOutput {
  tables: Array<{
    table_name: string;
    display_name: string;
    description: string;
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
