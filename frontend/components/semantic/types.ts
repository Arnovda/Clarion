export interface SourceTable {
  id: number;
  connection_id: number;
  table_name: string;
  display_name: string;
  description: string;
  ai_draft: boolean;
  is_active: boolean;
  domains?: string[];
  grain?: string;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

export interface SourceColumn {
  id: number;
  table_id: number;
  column_name: string;
  display_name: string;
  description: string;
  data_type: string;
  example_values: string | string[] | null;
  is_dimension: boolean;
  is_measure: boolean;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

export interface Relationship {
  id: number;
  from_table_id: number;
  from_column_id: number | null;
  to_table_id: number;
  to_column_id: number | null;
  from_table_name: string;
  to_table_name: string;
  relationship_type: string;
  description: string;
  ai_draft: boolean;
}

export interface CrossSourceView {
  id: number;
  name: string;
  description: string | null;
  connection_id: number | null;
}

export interface ProductTable {
  id: number;
  data_product_id: number;
  star_schema_id: number | null;
  table_name: string;
  display_name: string;
  description: string;
  table_role: 'fact' | 'dimension' | 'bridge' | 'junk';
  dag_order: number;
  row_count: number | null;
  transformation_status: string | null;
  owner_name: string | null;
  domains: string | string[];
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
  column_count?: number;
  last_run_at?: string;
}

export interface ProductColumn {
  id: number;
  table_id: number;
  table_name: string;
  column_name: string;
  data_type: string;
  display_name: string;
  description: string;
  column_role: string | null;
  fk_target_table: string | null;
  fk_target_column: string | null;
  transformation_expression: string | null;
  additivity: string | null;
  scd_type: number;
  sort_order: number;
  owner_name: string | null;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}

export interface ProductTreeItem {
  productId: number;
  productName: string;
  connectionId: number | null;
  status: string;
  starSchemas: {
    schemaId: number;
    schemaName: string;
    tables: ProductTable[];
  }[];
}

export interface KpiDefinition {
  id: number;
  connection_id: number;
  name: string;
  description: string;
  formula_plain_text: string;
  formula_sql: string;
  ai_draft: boolean;
  approval_status?: 'draft' | 'pending_review' | 'approved' | 'rejected';
  approved_by?: string;
  approved_at?: string;
  rejection_reason?: string;
}
