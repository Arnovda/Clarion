'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';

interface AuditEntry {
  id: number;
  user_id: string;
  user_name: string;
  action: string;
  entity_type: string;
  entity_id: number | null;
  entity_name: string | null;
  details: Record<string, unknown> | string | null;
  created_at: string;
}

interface Props {
  entityType?: string;
  entityId?: number;
  limit?: number;
}

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-green-100 text-green-700',
  update: 'bg-blue-100 text-blue-700',
  delete: 'bg-red-100 text-red-700',
  approve: 'bg-emerald-100 text-emerald-700',
  reject: 'bg-amber-100 text-amber-700',
  submit_for_review: 'bg-purple-100 text-purple-700',
  import: 'bg-indigo-100 text-indigo-700',
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function parseDetails(d: unknown): Record<string, unknown> {
  if (!d) return {};
  if (typeof d === 'string') try { return JSON.parse(d); } catch { return {}; }
  return d as Record<string, unknown>;
}

export default function AuditPanel({ entityType, entityId, limit = 50 }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(limit) });
    if (entityType) params.set('entityType', entityType);
    if (entityId) params.set('entityId', String(entityId));
    api.get(`/semantic/audit?${params}`)
      .then((res) => setEntries(res.data.data ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [entityType, entityId, limit]);

  if (loading) return <div className="p-4 text-sm text-slate-400">Loading audit trail...</div>;
  if (!entries.length) return <div className="p-4 text-sm text-slate-400">No audit entries yet.</div>;

  return (
    <div className="space-y-1">
      {entries.map((entry) => {
        const details = parseDetails(entry.details);
        const detailKeys = Object.keys(details);

        return (
          <div key={entry.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 rounded-lg transition-colors">
            {/* Timeline dot */}
            <div className="flex-shrink-0 mt-1.5">
              <div className="w-2 h-2 rounded-full bg-slate-300" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ACTION_COLORS[entry.action] ?? 'bg-slate-100 text-slate-600'}`}>
                  {entry.action}
                </span>
                <span className="text-xs text-slate-500">{entry.entity_type}</span>
                {entry.entity_name && (
                  <span className="text-xs font-medium text-slate-700">{entry.entity_name}</span>
                )}
                {entry.entity_id && (
                  <span className="text-xs text-slate-400 font-mono">#{entry.entity_id}</span>
                )}
              </div>
              {detailKeys.length > 0 && (
                <div className="text-xs text-slate-400 mt-0.5">
                  {detailKeys.map((k) => `${k}: ${JSON.stringify(details[k])}`).join(' | ')}
                </div>
              )}
            </div>

            <div className="flex-shrink-0 text-right">
              <div className="text-xs font-medium text-slate-500">{entry.user_name || entry.user_id}</div>
              <div className="text-xs text-slate-400">{formatDate(entry.created_at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
