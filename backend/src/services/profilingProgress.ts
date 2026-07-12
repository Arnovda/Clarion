/**
 * Maps a schema-profiling phase (+ optional per-table progress) onto a 0–100
 * progress percentage for the connections UI.
 *
 * Lives in services/ because it is consumed from two directions: the
 * connections route (manual profiling) and the SyncOrchestrator (post-sync
 * auto-profiling). It previously lived inside routes/connections.ts, which
 * forced the orchestrator to reach back into a route module via a dynamic
 * `await import()` — the one confirmed route↔service circular dependency in
 * the codebase. Both sides now import it statically from here.
 */
export function profilingProgressPct(phase: string, tableIndex?: number, tableCount?: number): number {
  // Each phase gets a weight — quality + ai_draft are heaviest
  const weights: Record<string, [number, number]> = {
    schema:   [0,  10],
    quality:  [10, 45],
    ai_draft: [45, 80],
    storing:  [80, 90],
    neo4j:    [90, 98],
    done:     [100, 100],
    error:    [0, 0],
  };
  const [start, end] = weights[phase] ?? [0, 0];
  if (phase === 'error') return 0;
  if (tableIndex != null && tableCount && tableCount > 0) {
    return Math.round(start + (end - start) * (tableIndex + 1) / tableCount);
  }
  return end;
}
