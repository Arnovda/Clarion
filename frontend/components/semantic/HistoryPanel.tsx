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
  onRevert?: () => void;
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

export default function HistoryPanel({ entityType, entityId, entityName, onRevert }: Props) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selectedV1, setSelectedV1] = useState<number | null>(null);
  const [selectedV2, setSelectedV2] = useState<number | null>(null);
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  const [revertingVersion, setRevertingVersion] = useState<number | null>(null);
  const [confirmRevert, setConfirmRevert] = useState<number | null>(null);

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

  async function handleRevert(version: number) {
    // Only allow revert for table, column, kpi (not product_table/product_column)
    if (!['table', 'column', 'kpi'].includes(entityType)) return;
    setRevertingVersion(version);
    try {
      await api.post('/semantic/revert', { entityType, entityId, version });
      // Refresh version history
      const res = await api.get(`/semantic/history?entityType=${entityType}&entityId=${entityId}`);
      setVersions(res.data.data ?? []);
      setConfirmRevert(null);
      onRevert?.();
    } catch {
      // silently fail — user sees the button reset
    }
    setRevertingVersion(null);
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
        <h3 className="text-sm font-semibold text-slate-300">
          Version History: {entityName}
        </h3>
        <span className="text-xs text-slate-500">{versions.length} version{versions.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Version list */}
      <div className="space-y-2">
        {versions.map((v, idx) => {
          const changes = parseJson(v.changes) as Record<string, { from?: unknown; to?: unknown }>;
          const changedKeys = Object.keys(changes);
          const isExpanded = expandedVersion === v.version;
          const isLatest = idx === 0;
          const canRevert = !isLatest && ['table', 'column', 'kpi'].includes(entityType);

          return (
            <div key={v.id} className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-white/5"
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
                  <span className="text-xs font-mono font-bold text-cyan-400 bg-cyan-400/10 px-2 py-0.5 rounded">
                    v{v.version}
                  </span>
                  {isLatest && (
                    <span className="text-[10px] text-purple-300 bg-purple-400/10 px-1.5 py-0.5 rounded">current</span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-slate-300">
                    {changedKeys.length > 0
                      ? `Changed: ${changedKeys.join(', ')}`
                      : v.change_reason || 'Initial version'}
                  </span>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs text-slate-500">{v.changed_by}</span>
                  <span className="text-xs text-slate-500">{formatDate(v.created_at)}</span>
                  <svg className={`w-4 h-4 text-slate-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </div>

              {isExpanded && (
                <div className="px-4 py-3 border-t border-white/5 bg-white/[0.02]">
                  {v.change_reason && (
                    <p className="text-xs text-slate-500 mb-2 italic">{v.change_reason}</p>
                  )}
                  {changedKeys.length > 0 ? (
                    <div className="space-y-1.5">
                      {changedKeys.map((key) => (
                        <div key={key} className="text-xs">
                          <span className="font-medium text-slate-400">{key}:</span>{' '}
                          <span className="text-red-400 line-through">{formatValue(changes[key]?.from)}</span>
                          {' → '}
                          <span className="text-green-400">{formatValue(changes[key]?.to)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">
                      Full snapshot recorded (no field-level diff available).
                    </div>
                  )}

                  {/* Revert button — only for non-latest versions of table/column/kpi */}
                  {canRevert && (
                    <div className="mt-3 pt-2 border-t border-white/5">
                      {confirmRevert === v.version ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-amber-400">Revert to v{v.version}?</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRevert(v.version); }}
                            disabled={revertingVersion === v.version}
                            className="px-2 py-0.5 text-xs text-white bg-amber-600 hover:bg-amber-500 rounded transition-colors disabled:opacity-50"
                          >
                            {revertingVersion === v.version ? 'Reverting...' : 'Confirm'}
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmRevert(null); }}
                            className="px-2 py-0.5 text-xs text-slate-400 hover:text-slate-300 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmRevert(v.version); }}
                          className="text-xs text-cyan-400/70 hover:text-cyan-300 transition-colors"
                        >
                          Revert to this version
                        </button>
                      )}
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
        <div className="bg-white/5 border border-white/10 rounded-lg p-4">
          <div className="flex items-center gap-3 mb-3">
            <h4 className="text-sm font-medium text-slate-300">Compare versions</h4>
            <span className="text-xs text-slate-500">
              {selectedV1 != null ? `v${selectedV1}` : '?'} vs {selectedV2 != null ? `v${selectedV2}` : '?'}
            </span>
            <button
              onClick={loadDiff}
              disabled={selectedV1 == null || selectedV2 == null || diffLoading}
              className="ml-auto px-3 py-1 text-xs bg-cyan-600 text-white rounded-lg hover:bg-cyan-500 disabled:opacity-50"
            >
              {diffLoading ? 'Loading...' : 'Compare'}
            </button>
            <button
              onClick={() => { setSelectedV1(null); setSelectedV2(null); setDiffResult(null); }}
              className="px-3 py-1 text-xs text-slate-500 hover:text-slate-300"
            >
              Clear
            </button>
          </div>

          {diffResult && (
            <div className="space-y-2">
              {Object.keys(diffResult.diff).length === 0 ? (
                <p className="text-xs text-slate-500">No differences between these versions.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="border-b border-white/10">
                        <th className="text-left px-3 py-2 font-medium text-slate-400">Field</th>
                        <th className="text-left px-3 py-2 font-medium text-red-400">v{selectedV1}</th>
                        <th className="text-left px-3 py-2 font-medium text-green-400">v{selectedV2}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(diffResult.diff).map(([key, val]) => (
                        <tr key={key} className="border-b border-white/5">
                          <td className="px-3 py-2 font-medium text-slate-400">{key}</td>
                          <td className="px-3 py-2 text-red-400 bg-red-500/5">{formatValue(val.from)}</td>
                          <td className="px-3 py-2 text-green-400 bg-green-500/5">{formatValue(val.to)}</td>
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
