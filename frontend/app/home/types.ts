/** The read models behind /home. */

// ─── GET /api/home/summary ──────────────────────────────────────────────────

export interface HomeAlert {
  id: number;
  severity: string;
  message: string;
  /** Claude's plain-English explanation of the alert. The differentiator. */
  aiContext: string | null;
  kind: string;
  createdAt: string | null;
}

export interface HomeSummary {
  freshness: {
    sources:  { fresh: number; total: number };
    products: { fresh: number; total: number };
    stale: Array<{ id: number; name: string; lastSyncedAt: string | null }>;
    staleProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
    allSources: Array<{ id: number; name: string; connectorType: string | null; lastSyncedAt: string | null; lastSyncStatus: string | null; isStale: boolean }>;
    allProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
  };
  dashboards: Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }>;
  recentQuestions: Array<{ id: number; title: string | null; lastMessageAt: string | null }>;
  alerts: HomeAlert[];
}

// ─── GET /api/briefs/today ──────────────────────────────────────────────────

export interface BriefBullet {
  kind: 'movement' | 'steady' | 'warn';
  label: string;
  delta: string;
  detail: string;
}

export interface BriefContent {
  summary: string;
  bullets: BriefBullet[];
  suggested_focus: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * `investigation` is the R2 half: the overnight run that
 * `morningBriefService` kicks off for the top mover, already concluded
 * by the time anyone opens the page. Absent on a quiet night, on a
 * tenant with no product to investigate, and on every brief written
 * before R2 shipped — so every consumer treats it as optional.
 */
export interface BriefInvestigation {
  id: number;
  question: string;
  /** Which bullet this explains — matched on the pulse entry behind it. */
  pulseEntryId: number | null;
  status: 'running' | 'concluded' | 'failed' | 'cancelled';
  conclusion: string | null;
  conclusionConfidence: 'high' | 'medium' | 'low' | null;
  stepCount: number;
}

export interface Brief {
  id: number;
  brief_date: string;
  content: BriefContent;
  opened_at: string | null;
  emailed_at: string | null;
  created_at: string;
  investigation?: BriefInvestigation | null;
}

// ─── GET /api/pulse/state ───────────────────────────────────────────────────

export interface PulseDelta {
  value: number;
  label: string;
  period: string;
  deltaAbs: number | null;
  deltaPct: number | null;
  direction: 'up' | 'down' | 'flat';
}

export interface PulseTile {
  id: number;
  label: string;
  productName: string | null;
  kind: 'metric' | 'slice' | 'theme';
  sensitivity: 'low' | 'medium' | 'high';
  frequency: 'daily' | 'weekly';
  currentValue: number | null;
  currentValueLabel: string | null;
  asOf: string | null;
  prior: PulseDelta | null;
  priorWeek: PulseDelta | null;
  sparkline: Array<{ date: string; value: number | null }>;
  latestBriefBullet: { briefDate: string; headline: string; context: string; tone: 'warn' | 'positive' | 'neutral' } | null;
  status: 'ok' | 'no_observations_yet' | 'snapshot_failed';
  errorMessage: string | null;
  consecutiveFailures: number;
  lastErrorAt: string | null;
  links: { productId: number | null; kpiId: number | null };
}

// ─── GET /api/query/starters ────────────────────────────────────────────────

export interface QueryStarter {
  question: string;
  kind: 'trend' | 'compare' | 'rank' | 'why' | 'state';
}
