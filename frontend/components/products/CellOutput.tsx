'use client';

import { cn } from '@/lib/cn';
import { AlertCircle, CheckCircle2 } from 'lucide-react';

export interface CellOutputData {
  rows?: Record<string, unknown>[];
  columns?: string[];
  rowCount?: number;
  durationMs?: number;
  error?: string;
}

export default function CellOutput({ data, status }: { data: CellOutputData | null; status?: string | null }) {
  if (!data) return null;

  if (data.error || status === 'error') {
    return (
      <div className="rounded-md border border-err/30 bg-err-soft px-3.5 py-2.5 text-[12.5px] text-err">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" strokeWidth={2} />
          <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed">{data.error}</pre>
        </div>
      </div>
    );
  }

  const rows = data.rows ?? [];
  const columns = data.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
  if (columns.length === 0) return null;

  const shown = rows.slice(0, 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] font-mono text-muted-2 tracking-[0.06em]">
        <CheckCircle2 className="w-3 h-3 text-ok" strokeWidth={2} />
        <span>{(data.rowCount ?? rows.length).toLocaleString('en-GB')} rows</span>
        {data.durationMs !== undefined && <span>· {data.durationMs}ms</span>}
      </div>
      <div className="border border-line rounded-md overflow-hidden text-[11.5px]">
        <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
          <table className="w-full">
            <thead className="bg-softer sticky top-0">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="text-left px-2.5 py-1.5 font-mono text-muted text-[10px] tracking-[0.06em] uppercase font-medium whitespace-nowrap">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className="border-t border-line hover:bg-softer/30">
                  {columns.map((c) => (
                    <td key={c} className="px-2.5 py-1.5 text-ink-2 tabular-nums whitespace-nowrap max-w-[250px] truncate">
                      {fmt(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > shown.length && (
          <div className="px-2.5 py-1 bg-softer text-[10px] font-mono text-muted text-center">
            showing {shown.length} of {rows.length} rows
          </div>
        )}
      </div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}
