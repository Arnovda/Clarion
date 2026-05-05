/**
 * Shared types for the /query chat surface.
 * Extracted from page.tsx so leaf components (MessageBubble, ThinkingPanel, …)
 * can import them without pulling the whole page module.
 */

export interface DebugInfo {
  confirmedTables:        number;
  confirmedColumns:       number;
  confirmedRelationships: number;
  confirmedKpis:          number;
  hint:                   string;
  semanticContext:        string;
  relationshipContext:    string;
  kpiFormulas?:           string;
}

export interface EntityMismatch {
  literal:      string;
  alternatives: string[];
}

export interface EntityAmbiguity {
  literal:     string;
  tableName:   string;
  columnName:  string;
  rows:        Record<string, unknown>[];
}

export interface ForecastPoint {
  date:  string;
  value: number;
  lower: number;
  upper: number;
}

export type VisualizationType = 'bar' | 'line' | 'stacked_bar' | 'pie' | 'table';

export interface VisualizationHint {
  type:    VisualizationType;
  xKey?:   string;
  yKey?:   string;
  groupBy?: string;
}

export interface ForecastData {
  historical:  Array<{ date: string; value: number }>;
  predicted:   ForecastPoint[];
  method:      string;
  r2:          number;
  periods:     number;
  periodUnit:  string;
  explanation: string;
}

/** One option offered when intent === 'clarify'. */
export interface ClarifyOption {
  label:          string;
  interpretation: string;
}

export interface Message {
  id:                  number;
  role:                'user' | 'assistant';
  text:                string;
  question?:           string;             // stored on assistant messages for repair
  sql?:                string;
  tablesUsed?:         string[];
  confidence?:         number;
  warning?:            string;
  blocked?:            boolean;
  flagReason?:         string;             // why a query was blocked (sub-confidence breakdown)
  subScores?:          { schema?: number; join?: number; formula?: number };
  uncertaintyNotes?:   string[];
  /**
   * Material assumptions the AI made when generating the SQL. Rendered as
   * a small footnote under the answer — must NOT compete with the main
   * result. Examples: "Revenue excl. VAT", "Active customers only".
   */
  assumptions?:        string[];
  /**
   * Present when intent === 'clarify'. The bubble renders a different
   * shape: ambiguity statement + clickable option chips. No rows/sql.
   */
  intent?:             'data' | 'explain' | 'clarify';
  ambiguity?:          string;
  options?:            ClarifyOption[];
  needsClarification?: boolean;            // entity pre-flight: mismatch or ambiguity
  mismatches?:         EntityMismatch[];   // unrecognised literals + fuzzy alternatives
  ambiguities?:        EntityAmbiguity[];  // literals that matched multiple rows
  error?:              boolean;
  errorDetail?:        string;             // raw error message (admin/analyst only)
  errorStack?:         string;             // stack trace (admin/analyst only)
  debug?:              DebugInfo;
  rows?:               Record<string, unknown>[];
  wasRepaired?:        boolean;            // prevents re-triggering repair on already-fixed answers
  reasoning?:          string;             // Claude's extended thinking, stored for replay
  queryLayer?:         'product' | 'source'; // which data layer was queried
  feedback?:           'up' | 'down' | null;
  feedbackComment?:    string;
  serverId?:           number;             // DB id from conversation_messages table
  forecast?:           ForecastData;       // forecast visualization data
  visualization?:      VisualizationHint;  // LLM-suggested chart type for the result rows
}

export interface Conversation {
  id:        number;           // server-side DB id
  title:     string;
  starred:   boolean;
  createdAt: string;
  updatedAt: string;
  messages:  Message[];
}

// ── Ephemeral repair state — never serialised ────────────────────────────────

export type RepairEventKind =
  | { kind: 'thinking';      text: string }
  | { kind: 'data_query';    sql: string }
  | { kind: 'query_result';  rows: Record<string, unknown>[]; rowCount: number }
  | { kind: 'revised_sql';   sql: string }
  | { kind: 'clarification'; question: string };

export interface RepairState {
  forMessageId:          number;
  events:                RepairEventKind[];
  isActive:              boolean;
  pendingClarification?: string;
  pendingHistory?:       Array<{ role: 'user' | 'assistant'; content: string }>;
}
