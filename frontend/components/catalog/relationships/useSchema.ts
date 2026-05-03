'use client';

/**
 * useSchema — single hook that loads and caches the full schema for a
 * connection (tables + their columns + relationships) and exposes mutation
 * callbacks. All three relationship views (Diagram / List / Review queue)
 * share this hook so they reflect the same data and refresh together after
 * any edit.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import type { SourceTable, SourceColumn } from '@/components/semantic/types';

export interface RelationshipRow {
  id: number;
  from_table_id: number;
  from_column_id: number | null;
  to_table_id: number;
  to_column_id: number | null;
  relationship_type: string;
  description: string;
  ai_draft: boolean;
  from_table: string;
  to_table: string;
  from_column: string | null;
  to_column: string | null;
  from_table_name: string;
  to_table_name: string;
}

export interface SchemaState {
  loading: boolean;
  error: string | null;
  tables: SourceTable[];
  columnsByTable: Record<number, SourceColumn[]>;
  relationships: RelationshipRow[];
  /** Re-fetch tables + columns + relationships from the server. */
  reload: () => Promise<void>;
  /** Re-fetch only relationships (cheap; tables/columns rarely change). */
  reloadRelationships: () => Promise<void>;
}

export function useSchema(connectionId: number): SchemaState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [columnsByTable, setColumnsByTable] = useState<Record<number, SourceColumn[]>>({});
  const [relationships, setRelationships] = useState<RelationshipRow[]>([]);

  const reloadRelationships = useCallback(async () => {
    try {
      const r = await api.get(`/semantic/relationships?connectionId=${connectionId}`);
      setRelationships((r.data.data ?? []) as RelationshipRow[]);
    } catch (e) {
      // Don't blow up the whole view on a relationship reload failure.
      console.warn('reloadRelationships failed', e);
    }
  }, [connectionId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tRes, rRes] = await Promise.all([
        api.get(`/semantic/tables?connectionId=${connectionId}`),
        api.get(`/semantic/relationships?connectionId=${connectionId}`),
      ]);
      const tbls: SourceTable[] = tRes.data.data ?? [];
      setTables(tbls);
      setRelationships((rRes.data.data ?? []) as RelationshipRow[]);

      // Fetch all columns in parallel. Failures per-table are non-fatal so
      // one bad table doesn't break the whole view.
      const colsArr = await Promise.all(
        tbls.map((t) =>
          api
            .get(`/semantic/columns?tableId=${t.id}`)
            .then((r) => [t.id, (r.data.data ?? []) as SourceColumn[]] as const)
            .catch(() => [t.id, [] as SourceColumn[]] as const),
        ),
      );
      const map: Record<number, SourceColumn[]> = {};
      for (const [id, cols] of colsArr) map[id] = cols;
      setColumnsByTable(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load schema');
      setTables([]);
      setColumnsByTable({});
      setRelationships([]);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => { reload(); }, [reload]);

  return useMemo(
    () => ({ loading, error, tables, columnsByTable, relationships, reload, reloadRelationships }),
    [loading, error, tables, columnsByTable, relationships, reload, reloadRelationships],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation helpers — kept outside the hook so any view can call them and then
// invoke the hook's reload* methods to refresh.
// ─────────────────────────────────────────────────────────────────────────────

export async function createRelationship(input: {
  from_table_id: number;
  from_column_id: number | null;
  to_table_id: number;
  to_column_id: number | null;
  relationship_type: string;
  description?: string | null;
}): Promise<{ id: number }> {
  const res = await api.post('/semantic/relationships', input);
  return res.data.data;
}

/**
 * PATCH auto-sets ai_draft=false on every call (server-side), so an
 * empty patch counts as a "confirm". Pass concrete fields to also edit.
 */
export async function patchRelationship(id: number, patch: {
  relationship_type?: string;
  description?: string | null;
  from_column_id?: number | null;
  to_column_id?: number | null;
} = {}): Promise<void> {
  await api.patch(`/semantic/relationships/${id}`, patch);
}

export async function deleteRelationship(id: number): Promise<void> {
  await api.delete(`/semantic/relationships/${id}`);
}
