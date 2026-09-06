/** The one read model behind /home — GET /api/home/summary. */
export interface HomeSummary {
  health: {
    overall: number | null;
    freshness: number | null;
    definitions: number | null;
    quality: number | null;
    pipelines: number | null;
  };
  quality: {
    profiledTables: { passing: number; total: number };
    activeRules:    { passing: number; total: number };
  };
  freshness: {
    sources:  { fresh: number; total: number };
    products: { fresh: number; total: number };
    stale: Array<{ id: number; name: string; lastSyncedAt: string | null }>;
    staleProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
    allSources: Array<{ id: number; name: string; connectorType: string | null; lastSyncedAt: string | null; lastSyncStatus: string | null; isStale: boolean }>;
    allProducts: Array<{ id: number; name: string; status: string; lastRefreshedAt: string | null; isStale: boolean }>;
  };
  definitions: {
    tables:        { defined: number; total: number };
    columns:       { defined: number; total: number };
    relationships: { approved: number; total: number };
    pendingReview: { tables: number; columns: number; relationships: number; total: number };
  };
  pipelines: {
    runsThisWeek: number;
    successCount: number;
    failureCount: number;
    activeNow: number;
    successRate: number | null;
  };
  dashboards: Array<{ id: number; title: string; starred: boolean; updatedAt: string | null }>;
  recentQuestions: Array<{ id: number; title: string | null; lastMessageAt: string | null }>;
  alerts: Array<{ id: number; severity: string; message: string; aiContext: string | null; kind: string; createdAt: string | null }>;
}
