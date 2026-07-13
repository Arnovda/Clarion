// ─── types.ts ─────────────────────────────────────────────────────────────────
// Shared TypeScript interfaces for the Clarion dashboard system.
// Import from here instead of defining inline in page.tsx.

import type { WidgetSpec } from '@/lib/contract';

// ─── Filter & Widget Specs (shared API contract) ─────────────────────────────
// FilterSpec / WidgetSpec / DashboardSpec are what the backend AI generates and
// persists — their canonical definitions live in @/lib/contract (mirrored
// byte-identically at backend/src/shared/contract.ts). Re-exported here so all
// existing `from './types'` imports keep working unchanged.

export type { FilterSpec, WidgetSpec, DashboardSpec } from '@/lib/contract';

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
  /** Set on error messages. When present, the chat bubble renders a
   *  "View error" expander showing the technical detail returned by
   *  the backend. The backend only ships real error text to admins
   *  (see errorHandler.ts), so for viewer/analyst roles this will
   *  typically be the same generic "Something went wrong" string. */
  errorDetail?: string;
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
  /** When this widget is the cross-filter source, the clicked value
   *  (used for Power-BI-style visual highlight — non-matching bars dim). */
  crossFilterValue?: string;
  /** Called when the user clicks a KPI card to view the underlying records */
  onDrillDetail?: () => void;
  /** Right-click on a data point — opens the context menu at the click
   *  coordinates with the dimension value the user clicked on. Optional
   *  `series` carries the second axis for stacked / pivot widgets. */
  onContextMenu?: (e: React.MouseEvent, value: string, series?: string) => void;
}
