'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { WidgetSkeleton } from './WidgetSkeletons';

interface DrillDetailModalProps {
  title: string;
  loading: boolean;
  rows: Record<string, unknown>[];
  onClose: () => void;
}

function isNumeric(v: unknown) {
  return typeof v === 'number' || (typeof v === 'string' && v !== '' && !isNaN(Number(v)));
}

function headerLabel(k: string) {
  return k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' ');
}

export function DrillDetailModal({ title, loading, rows, onClose }: DrillDetailModalProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const keys = rows.length > 0 ? Object.keys(rows[0]) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[80vh] bg-raised border border-line rounded-xl shadow-3 flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-line shrink-0">
          <div>
            <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-0.5">Drill-through</p>
            <h3 className="text-[14px] font-medium text-ink">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-ink-4 hover:text-ink-2 hover:bg-softer transition-colors"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="p-6"><WidgetSkeleton /></div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-[13px] text-muted text-center">No records found.</p>
          ) : (
            <table className="w-full text-[12px] border-collapse">
              <thead>
                <tr className="sticky top-0 bg-softer z-10">
                  {keys.map((k) => (
                    <th
                      key={k}
                      className={`px-4 py-2.5 font-mono font-medium text-muted text-[10px] uppercase tracking-[0.08em] border-b border-line whitespace-nowrap ${
                        isNumeric(rows[0]?.[k]) ? 'text-right' : 'text-left'
                      }`}
                    >
                      {headerLabel(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-line last:border-b-0 hover:bg-softer transition-colors">
                    {keys.map((k) => (
                      <td
                        key={k}
                        className={`px-4 py-2 text-ink-2 whitespace-nowrap ${
                          isNumeric(row[k]) ? 'text-right font-mono tabular-nums' : ''
                        }`}
                      >
                        {String(row[k] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        {!loading && rows.length > 0 && (
          <div className="px-5 py-2.5 border-t border-line shrink-0">
            <p className="text-[11px] text-muted">{rows.length} record{rows.length !== 1 ? 's' : ''}</p>
          </div>
        )}
      </div>
    </div>
  );
}
