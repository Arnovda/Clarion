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
