/**
 * Shared types for /products.
 */

export interface Connection {
  id: number;
  name: string;
}

export interface DataProduct {
  id: number;
  connection_id: number;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  star_schema_count?: number;
  icon_svg?: string | null;
}

export interface StarSchema {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  grain: string | null;
  fact_table_type: string;
}

export interface QualityCheck {
  id: number;
  product_table_id: number;
  check_type: 'bk_uniqueness' | 'fan_out';
  status: 'pass' | 'fail' | 'skip' | 'error';
  bk_columns: string | string[];
  total_rows: number;
  distinct_bk_rows: number;
  duplicate_count: number;
  sample_duplicates: string | Record<string, unknown>[];
  message: string;
  executed_at: string;
}

export interface ProductTable {
  id: number;
  star_schema_id: number;
  table_name: string;
  display_name: string | null;
  description: string | null;
  table_role: string;
  transformation_sql: string | null;
  transformation_status: string;
  dag_order: number;
  row_count: number | null;
  last_run_at: string | null;
  last_run_error: string | null;
  load_mode: string;
  quality_checks?: QualityCheck[];
  source_product_table_id?: number | null;
  is_reference?: boolean;
  owner_product_id?: number | null;
  owner_product_name?: string | null;
}

export interface ProductColumn {
  id: number;
  product_table_id: number;
  column_name: string;
  data_type: string | null;
  display_name: string | null;
  description: string | null;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
  transformation_expression: string | null;
  additivity: string | null;
  scd_type: number;
  lineage?: { source_table_name: string; source_column_name: string; transformation_description: string }[];
}

export interface ProductRelationship {
  id: number;
  from_table_name: string;
  from_column_name: string;
  to_table_name: string;
  to_column_name: string;
  relationship_type: string;
}

export interface FullDataProduct extends DataProduct {
  star_schemas: (StarSchema & {
    tables: (ProductTable & { columns: ProductColumn[] })[];
    relationships: ProductRelationship[];
  })[];
}

export interface ProductKpi {
  id: number;
  data_product_id: number;
  name: string;
  description: string | null;
  formula_plain_text: string | null;
  formula_sql: string | null;
  ai_draft: boolean;
  owner_name: string | null;
}

export type ActiveTab = 'overview' | 'bus-matrix' | 'schema' | 'lineage' | 'kpis' | 'quality';
