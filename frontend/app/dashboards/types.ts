// ─── types.ts ─────────────────────────────────────────────────────────────────
// Shared TypeScript interfaces for the DataBridge dashboard system.
// Import from here instead of defining inline in page.tsx.

// ─── Filter & Widget Specs ────────────────────────────────────────────────────

export interface FilterSpec {
  id: string;
  type: 'date_range' | 'select';
  label: string;
  table: string;
  column: string;
  allLabel?: string;
}

export interface WidgetSpec {
  id: string;
  type:
    | 'kpi_card'
    | 'bar_chart'
    | 'vertical_bar_chart'
    | 'stacked_bar_chart'
    | 'line_chart'
    | 'pie_chart'
    | 'top_list'
    | 'data_table'
    | 'combo_chart'
    | 'radar_chart'
    | 'treemap_chart'
    | 'pivot_table';
  title: string;
  sql: string;
  drillDownSql?: string;
  drillDownLabel?: string;
  format?: 'currency' | 'number' | 'percentage';
  colSpan?: 1 | 2 | 3 | 4;
  featured?: boolean;
  /** SQL column name emitted as {{xf_<key>}} when a bar/segment is clicked */
  crossFilterKey?: string;
}

// ─── Dashboard Specs ──────────────────────────────────────────────────────────

export interface DashboardSpec {
  title: string;
  description: string;
  filters: FilterSpec[];
  widgets: WidgetSpec[];
}

export interface SavedDashboard {
  id: number;
  title: string;
  description: string;
  is_favorite: boolean;
  is_shared: boolean;
  shared_permission: string;
  folder: string | null;
  auto_refresh_seconds: number | null;
  user_id: string;
  is_owner: boolean;
  permission: 'owner' | 'editor' | 'viewer';
  created_at: string;
  updated_at: string;
}

export interface DashboardTemplate {
  id: number;
  name: string;
  description: string;
  category: string;
  created_at: string;
}

// ─── Widget Runtime State ─────────────────────────────────────────────────────

export interface WidgetData {
  rows: Record<string, unknown>[];
  loading: boolean;
  /** true while background revalidation is in flight (data is stale but shown) */
  revalidating?: boolean;
  error?: string;
}

export interface DrillState {
  widgetId: string;
  /** crossFilterKey — passed as xf_<key> to all widget executions */
  key: string;
  value: string;
  label: string;
}

// ─── Refinement & Chat ────────────────────────────────────────────────────────

export interface RefinementQuestion {
  question: string;
  suggestions: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  type: 'query' | 'refine';
}

// ─── Shared Widget Component Props ────────────────────────────────────────────

/**
 * Standard props passed to every individual widget renderer component.
 * Use this interface when extracting widget types to their own components.
 */
export interface WidgetExecutionProps {
  spec: WidgetSpec;
  data: WidgetData;
  /** Called when the user clicks a bar/segment to apply a cross-filter. Pass null to clear. */
  onCrossFilter?: (value: string | null) => void;
  /** True when this widget is the source of the currently active cross-filter */
  isCrossFilterActive?: boolean;
  /** Human-readable label for the active drill-down value (shown in widget header) */
  drillLabel?: string;
  /** Called when the user clicks a KPI card to view the underlying records */
  onDrillDetail?: () => void;
}
