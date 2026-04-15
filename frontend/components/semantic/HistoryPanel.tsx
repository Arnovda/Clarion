'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';

interface VersionEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  version: number;
  snapshot: Record<string, unknown> | string;
  changes: Record<string, { from: unknown; to: unknown }> | string | null;
  changed_by: string;
  change_reason: string | null;
  created_at: string;
}

interface DiffResult {
  v1: VersionEntry;
  v2: VersionEntry;
  diff: Record<string, { from: unknown; to: unknown }>;
}

interface Props {
  entityType: 'table' | 'column' | 'kpi' | 'product_table' | 'product_column';
  entityId: number;
  entityName: string;
}

function parseJson(v: unknown): Record<string, unknown> {
  if (!v) return {};
  if (typeof v === 'string') try { return JSON.parse(v); } catch { return {}; }
  return v as Record<string, unknown>;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function HistoryPanel({ entityType, entityId, entityName }: Props) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selectedV1, setSelectedV1] = useState<number | null>(null);
  const [selectedV2, setSelectedV2] = useState<number | null>(null);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    setDiffResult(null);
    setSelectedV1(null);
    setSelectedV2(null);
    api.get(`/semantic/history?entityType=${entityType}&entityId=${entityId}`)
      .then((res) => setVersions(res.data.data ?? []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [entityType, entityId]);

  async function loadDiff() {
    if (selectedV1 == null || selectedV2 == null) return;
    setDiffLoading(true);
    try {
      const res = await api.get(`/semantic/diff?entityType=${entityType}&entityId=${entityId}&v1=${selectedV1}&v2=${selectedV2}`);
      setDiffResult(res.data.data);
    } catch { setDiffResult(null); }
    setDiffLoading(false);
  }

  if (loading) {
    return <div className="p-4 text-sm text-slate-400">Loading history...</div>;
  }

  if (!versions.length) {
    return (
      <div className="p-4 text-sm text-slate-400">
        No version history yet for this {entityType}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">
          Version History: {entityName}
        </h3>
        <span className="text-xs text-slate-400">{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Version list */}
      <div className="space-y-2">
        {versions.map((v) => {
          const changes = parseJson(v.changes);
          const changedKeys = Object.keys(changes);
          const isExpanded = expandedVersion === v.version;

          return (
            <div key={v.id} className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50"
                onClick={() => setExpandedVersion(isExpanded ? null : v.version)}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedV1 === v.version || selectedV2 === v.version}
                    onChange={(e) => {
                      e.stopPropagation();
                      if (e.target.checked) {
                        if (selectedV1 == null) setSelectedV1(v.version);
                        else if (selectedV2 == null) setSelectedV2(v.version);
                      } else {
                        if (selectedV1 === v.version) setSelectedV1(null);
                        else if (selectedV2 === v.version) setSelectedV2(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded"
                    title="Select for comparison"
                  />
                  <span className="text-xs font-mono font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                    v{v.version}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-slate-700">
                    {changedKeys.length > 0
                      ? `Changed: ${changedKeys.join(', ')}`
                      : v.change_reason || 'Initial version'}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs text-slate-400">{v.changed_by}</span>
                  <span className="text-xs text-slate-400">{formatDate(v.created_at)}</span>
                  <svg className={`w-4 h-4 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                  {v.change_reason && (
                    <p className="text-xs text-slate-500 mb-2 italic">{v.change_reason}</p>
                  )}
                  {changedKeys.length > 0 ? (
                    <div className="space-y-1.5">
                      {changedKeys.map((key) => (
                        <div key={key} className="text-xs">
                          <span className="font-medium text-slate-600">{key}:</span>{' '}
                          <span className="text-red-500 line-through">{formatValue(changes[key]?.from)}</span>
                          {' → '}
                          <span className="text-green-600">{formatValue(changes[key]?.to)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-400">
                      Full snapshot recorded (no field-level diff available).
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Diff comparison */}
      {(selectedV1 != null || selectedV2 != null) && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-sm font-medium text-slate-700">Compare versions</h4>
            <span className="text-xs text-slate-400">
              {selectedV1 != null ? `v${selectedV1}` : '?'} vs {selectedV2 != null ? `v${selectedV2}` : '?'}
            </span>
            <button
              onClick={loadDiff}
              disabled={selectedV1 == null || selectedV2 == null || diffLoading}
              className="ml-auto px-3 py-1 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {diffLoading ? 'Loading...' : 'Compare'}
            </button>
            <button
              onClick={() => { setSelectedV1(null); setSelectedV2(null); setDiffResult(null); }}
              className="px-3 py-1 text-xs text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          </div>

          {diffResult && (
            <div className="space-y-2">
              {Object.keys(diffResult.diff).length === 0 ? (
                <p className="text-xs text-slate-400">No differences between these versions.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b border-slate-200">
                        <th className="text-left px-3 py-2 font-medium text-slate-500">Field</th>
                        <th className="text-left px-3 py-2 font-medium text-red-500">v{selectedV1}</th>
                        <th className="text-left px-3 py-2 font-medium text-green-600">v{selectedV2}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(diffResult.diff).map(([key, val]) => (
                        <tr key={key} className="border-b border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-600">{key}</td>
                          <td className="px-3 py-2 text-red-500 bg-red-50/50">{formatValue(val.from)}</td>
                          <td className="px-3 py-2 text-green-600 bg-green-50/50">{formatValue(val.to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
