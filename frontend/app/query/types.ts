/**
 * Shared types for the /query chat surface.
 * Extracted from page.tsx so leaf components (MessageBubble, ThinkingPanel, …)
 * can import them without pulling the whole page module.
 */

import type { Investigation, InvestigationStep, InvestigationStreamStatus } from '@/lib/investigationTypes';

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

/**
 * One table this answer was computed from, with its own freshness — resolved
 * server-side (routes/query.ts resolveAnswerSources) with zero AI calls.
 * Drives the answer card's "Data as of …" trust line and the "How I got
 * this" source list with catalog deep links.
 */
export interface AnswerSource {
  name:            string;
  kind:            'product' | 'source' | 'unknown';
  lastRefreshedAt: string | null;
  productName?:    string | null;
  sourceName?:     string | null;
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
  wasRepaired?:        boolean;            // the answer was corrected by the repair loop
  /**
   * The repair loop is still running on this answer — it was revealed
   * provisionally after the ~10s hold (owner decision 2026-08-27: hold up to
   * 10s, then show marked-provisional rather than an unmarked answer that
   * silently changes under the reader). Cleared when the loop settles.
   */
  checking?:           boolean;
  /** Plain-language trail of what the repair loop checked — "What I checked"
   *  in the How-I-got-this expander. Persisted in meta. */
  repairSummary?:      string[];
  /** Per-answer source freshness (see AnswerSource). Persisted in meta. */
  sources?:            AnswerSource[];
  /** Wall-clock time to answer, for the "answered in 9s" receipt. */
  answeredInMs?:       number;
  /** Present when data access policies filtered this result. */
  policyNotice?:       string;
  /** Blocked answers: the backend notified the tenant's admins of the gap. */
  adminNotified?:      boolean;
  /**
   * The answer was served from a curator-approved saved question (exact
   * normalized match) — human-attributed trust, the strongest tier. The
   * trust line renders "Verified by your team".
   */
  verified?:           boolean;
  reasoning?:          string;             // Claude's extended thinking, stored for replay
  queryLayer?:         'product' | 'source'; // which data layer was queried
  feedback?:           'up' | 'down' | null;
  feedbackComment?:    string;
  serverId?:           number;             // DB id from conversation_messages table
  forecast?:           ForecastData;       // forecast visualization data
  visualization?:      VisualizationHint;  // LLM-suggested chart type for the result rows
  /**
   * Mode for this assistant message. 'ask' is the standard NL→SQL flow.
   * 'investigate' renders an embedded multi-step investigation trail
   * inside the message bubble (drives the same backend SSE stream as
   * /investigate, just rendered inline).
   */
  mode?:               'ask' | 'investigate';
  /** Live + final state for an in-bubble investigation. */
  investigation?: {
    id?:                   number;
    question:              string;
    focus:                 string | null;
    productId:             number;
    streamStatus:          InvestigationStreamStatus;
    steps:                 InvestigationStep[];
    conclusion:            string | null;
    conclusionConfidence:  'high' | 'medium' | 'low' | null;
    failureReason:         string | null;
    /** Hydrated `Investigation` object once the stream concludes. */
    full?:                 Investigation | null;
  };
}

export interface Conversation {
  id:        number;           // server-side DB id
  title:     string;
  starred:   boolean;
  createdAt: string;
  updatedAt: string;
  messages:  Message[];
}

// ── Ephemeral repair state ───────────────────────────────────────────────────
//
// The live event feed stays ephemeral (the corrected ANSWER is persisted —
// server-side by /query/repair, plus the plain-language repairSummary in
// meta — but the block-by-block feed is progress narration, not the record).
// SQL/rows fields are optional because the backend strips them for viewers.

export type RepairEventKind =
  | { kind: 'thinking';      text: string; detail?: string }
  | { kind: 'data_query';    sql?: string }
  | { kind: 'query_result';  rowCount: number; rows?: Record<string, unknown>[] }
  | { kind: 'revised_sql';   sql?: string }
  | { kind: 'clarification'; question: string };

export interface RepairState {
  forMessageId:          number;
  events:                RepairEventKind[];
  isActive:              boolean;
  /**
   * The answer being double-checked, HELD OUT of the transcript while the
   * repair loop runs (up to ~10s) so a wrong number is never shown, read,
   * and then silently swapped. After the hold expires it is appended with
   * `checking: true`; `revealed` tracks whether that has happened.
   */
  holdMsg?:              Message;
  revealed:              boolean;
  pendingClarification?: string;
  pendingHistory?:       Array<{ role: 'user' | 'assistant'; content: string }>;
}
