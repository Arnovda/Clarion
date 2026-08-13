/**
 * Wire types for the relationship canvas.
 *
 * Mirrors what `GET /api/relationships/graph` and `POST /api/relationships/measure`
 * return (backend: services/relationshipGraph.ts, services/relationshipMeasure.ts).
 */

export type Provenance = 'human' | 'ai' | 'declared';
export type EdgeKind = 'join' | 'match';

export interface GraphSource {
  id: number;
  name: string;
  connectorType: string;
}

export interface GraphTable {
  id: number;
  connectionId: number;
  tableName: string;
  displayName: string | null;
  description: string | null;
  relationshipCount: number;
}

export interface GraphColumn {
  id: number;
  table_id: number;
  column_name: string;
  data_type: string | null;
  display_name: string | null;
  is_dimension: boolean;
  is_measure: boolean;
}

export interface GraphRelationship {
  id: number;
  kind: EdgeKind;
  fromTableId: number;
  fromColumnId: number | null;
  toTableId: number;
  toColumnId: number | null;
  relationshipType: string | null;
  description: string | null;
  provenance: Provenance;
  /** Computed server-side — the one thing the canvas exists to show. */
  isCrossSource: boolean;
  measured: Measurement | null;
  matchKeys: unknown;
  /** Someone looked at this and said the data does not back it. */
  flagged: boolean;
  flaggedReason: string | null;
}

export interface GraphResponse {
  sources: GraphSource[];
  tables: GraphTable[];
  columns?: GraphColumn[];
  relationships: GraphRelationship[];
  stats: {
    tables: number;
    relationships: number;
    pendingReview: number;
    flagged: number;
    crossSource: number;
    unresolved: number;
  };
  truncated: boolean;
}

export type MeasureVerdict = 'strong' | 'weak' | 'broken' | 'unmeasurable';

export type MeasureReason =
  | 'ok'
  | 'too-few-distinct'
  | 'target-not-key'
  | 'low-containment'
  | 'no-values'
  | 'timeout'
  | 'query-failed';

export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

export interface Measurement {
  verdict: MeasureVerdict;
  reason: MeasureReason;
  containment: {
    matchedDistinct: number;
    sampledDistinct: number;
    ratio: number;
    sampleSize: number;
  } | null;
  target: { rows: number; distinct: number; isKey: boolean } | null;
  cardinality: {
    type: Cardinality;
    avgChildren: number;
    maxChildren: number;
    basis: 'full';
  } | null;
  orphans: { rows: number; basis: 'full' } | null;
  /** Real values from both columns, so a percentage can be understood. */
  examples: { matched: string[]; unmatched: string[]; target: string[] } | null;
  thresholds: {
    sampleSize: number;
    minDistinct: number;
    targetUniqueness: number;
    minContainment: number;
  };
  elapsedMs: number;
}

/** A relationship the user has drawn but not yet confirmed. */
export interface PendingDraw {
  fromTableId: number;
  fromColumnId: number;
  toTableId: number;
  toColumnId: number;
  fromLabel: string;
  toLabel: string;
  /** null while the measurement is still running. */
  measurement: Measurement | null;
  error: string | null;
}

export type Normalisation = 'exact' | 'loose';

export interface MatchMeasurement {
  ok: boolean;
  reason: 'ok' | 'table-not-found' | 'timeout' | 'query-failed';
  normalisation: Normalisation;
  left: { total: number; matched: number; unmatchedSample: string[] } | null;
  right: { total: number; matched: number; unmatchedSample: string[] } | null;
  matchRate: number | null;
  elapsedMs: number;
}

/**
 * A cross-source link the user has drawn but not yet kept. Separate from
 * PendingDraw because a match is a different object from a join — it has a rate
 * and unmatched examples rather than a cardinality.
 */
export interface PendingMatch {
  fromTableId: number;
  fromColumnId: number;
  toTableId: number;
  toColumnId: number;
  fromLabel: string;
  toLabel: string;
  normalisation: Normalisation;
  measurement: MatchMeasurement | null;
  error: string | null;
}
