'use client';

import { useState, useEffect, useRef } from 'react';
import api from '@/lib/api';

interface SourceTable {
  table_name: string;
  row_count: number;
  column_count: number;
  ingestion_status: string | null;
  ingested_at: string | null;
}

interface IngestionWizardProps {
  connectionId: number;
  connectionName: string;
  /** Called when ingestion is complete and profiling should start */
  onIngestionDone: () => void;
  /** Called if user skips ingestion (existing connections) */
  onSkip?: () => void;
}

type Step = 'loading' | 'pick' | 'ingesting' | 'done' | 'error';

export default function IngestionWizard({
  connectionId,
  connectionName,
  onIngestionDone,
  onSkip,
}: IngestionWizardProps) {
  const [step, setStep] = useState<Step>('loading');
  const [tables, setTables] = useState<SourceTable[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [currentTable, setCurrentTable] = useState<string>('');
  const [ingestionMessage, setIngestionMessage] = useState('');
  const [tableResults, setTableResults] = useState<Array<{ table: string; status: string; rows?: number }>>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Load available tables on mount
  useEffect(() => {
    loadTables();
    return () => abortRef.current?.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  async function loadTables() {
    setStep('loading');
    setError(null);
    try {
      const res = await api.get(`/ingestion/discover?connectionId=${connectionId}`);
      const data: SourceTable[] = res.data.data ?? [];
      setTables(data);
      // Pre-select all tables by default
      setSelected(new Set(data.map((t) => t.table_name)));
      setStep('pick');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Failed to discover tables. Is the ETL service running?';
      setError(msg);
      setStep('error');
    }
  }

  function toggleTable(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(tables.map((t) => t.table_name)));
  }

  function selectNone() {
    setSelected(new Set());
  }

  async function startIngestion() {
    if (selected.size === 0) return;
    setStep('ingesting');
    setProgress(0);
    setCurrentTable('');
    setIngestionMessage(`Ingesting ${selected.size} table(s)...`);
    setTableResults([]);

    const token = typeof window !== 'undefined' ? localStorage.getItem('databridge_token') : null;
    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api'}/ingestion/ingest`,
        {
          method: 'POST',
          headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            connectionId,
            tables: Array.from(selected),
          }),
          signal: abortCtrl.signal,
        },
      );

      if (!res.ok || !res.body) {
        let detail = `HTTP ${res.status}`;
        try { detail = await res.text(); } catch { /* ignore */ }
        setError(`Ingestion failed: ${detail}`);
        setStep('error');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.phase === 'done') {
              setStep('done');
              setIngestionMessage(evt.message ?? 'Ingestion complete');
            } else if (evt.phase === 'error') {
              setError(evt.message ?? 'Ingestion failed');
              setStep('error');
            } else if (evt.phase === 'ingesting') {
              setIngestionMessage(evt.message);
              if (evt.table) setCurrentTable(evt.table);
              if (evt.progress) setProgress(evt.progress);
              if (evt.table && (evt.message?.includes('done') || evt.message?.includes('error'))) {
                setTableResults((prev) => [
                  ...prev,
                  {
                    table: evt.table,
                    status: evt.message?.includes('error') ? 'error' : 'done',
                    rows: parseInt(evt.message?.match(/\((\d+) rows\)/)?.[1] ?? '0'),
                  },
                ]);
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError('Connection to server lost');
        setStep('error');
      }
    }
  }

  const totalRows = tables.filter((t) => selected.has(t.table_name)).reduce((s, t) => s + t.row_count, 0);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (step === 'loading') {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-slate-600">Discovering tables in source...</p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (step === 'error') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6">
        <div className="flex items-start gap-3">
          <span className="text-xl">!</span>
          <div className="flex-1">
            <p className="font-semibold text-red-800 text-sm">Ingestion Error</p>
            <p className="text-xs text-red-600 mt-1">{error}</p>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <button
            onClick={loadTables}
            className="px-4 py-2 text-sm bg-white border border-red-200 text-red-700 rounded-lg hover:bg-red-50 transition-colors"
          >
            Retry
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Skip ingestion
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Ingestion in progress ──────────────────────────────────────────────────
  if (step === 'ingesting') {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
          <p className="text-sm font-semibold text-slate-800">
            Ingesting data for <span className="text-blue-600">{connectionName}</span>
          </p>
          <span className="ml-auto text-xs text-slate-400">{progress}%</span>
        </div>
        <div className="w-full h-1.5 bg-slate-100 rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-xs text-slate-500 mb-3">{ingestionMessage}</p>
        {tableResults.length > 0 && (
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {tableResults.map((r) => (
              <div key={r.table} className="flex items-center gap-2 text-xs">
                <span className={r.status === 'done' ? 'text-green-600' : 'text-red-500'}>
                  {r.status === 'done' ? 'Done' : 'Error'}
                </span>
                <span className="text-slate-700 font-mono">{r.table}</span>
                {r.rows ? <span className="text-slate-400">{r.rows.toLocaleString()} rows</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  if (step === 'done') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-xl p-6">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-2xl">Done</span>
          <div>
            <p className="font-semibold text-green-800 text-sm">
              Data ingested for <span className="font-bold">{connectionName}</span>
            </p>
            <p className="text-xs text-green-600 mt-0.5">{ingestionMessage}</p>
          </div>
        </div>
        {tableResults.length > 0 && (
          <div className="space-y-1 mb-4 max-h-32 overflow-y-auto">
            {tableResults.map((r) => (
              <div key={r.table} className="flex items-center gap-2 text-xs">
                <span className={r.status === 'done' ? 'text-green-600' : 'text-red-500'}>
                  {r.status === 'done' ? 'Done' : 'Error'}
                </span>
                <span className="text-slate-700 font-mono">{r.table}</span>
                {r.rows ? <span className="text-slate-400">{r.rows.toLocaleString()} rows</span> : null}
              </div>
            ))}
          </div>
        )}
        <button
          onClick={onIngestionDone}
          className="w-full px-4 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
        >
          Continue to profiling
        </button>
      </div>
    );
  }

  // ── Table picker ───────────────────────────────────────────────────────────
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-slate-100">
        <h3 className="font-semibold text-slate-900 text-sm">
          Select tables to ingest
        </h3>
        <p className="text-xs text-slate-500 mt-1">
          Choose which tables to load into the data warehouse. Only ingested tables will be available in the platform.
        </p>
      </div>

      <div className="px-6 py-3 border-b border-slate-100 flex items-center gap-3">
        <button onClick={selectAll} className="text-xs text-blue-600 hover:text-blue-800 transition-colors">
          Select all
        </button>
        <span className="text-slate-300">|</span>
        <button onClick={selectNone} className="text-xs text-blue-600 hover:text-blue-800 transition-colors">
          Deselect all
        </button>
        <span className="ml-auto text-xs text-slate-400">
          {selected.size} of {tables.length} selected
          {totalRows > 0 && <span className="ml-1">({totalRows.toLocaleString()} rows total)</span>}
        </span>
      </div>

      <div className="max-h-72 overflow-y-auto divide-y divide-slate-50">
        {tables.map((t) => (
          <label
            key={t.table_name}
            className="flex items-center gap-3 px-6 py-3 hover:bg-slate-50 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(t.table_name)}
              onChange={() => toggleTable(t.table_name)}
              className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
            />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-mono text-slate-800">{t.table_name}</span>
            </div>
            <span className="text-xs text-slate-400 tabular-nums">
              {t.row_count.toLocaleString()} rows
            </span>
            <span className="text-xs text-slate-400 tabular-nums">
              {t.column_count} cols
            </span>
            {t.ingestion_status === 'done' && (
              <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">
                Ingested
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
        {onSkip && (
          <button
            onClick={onSkip}
            className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          >
            Skip
          </button>
        )}
        <button
          onClick={startIngestion}
          disabled={selected.size === 0}
          className="flex-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors font-medium"
        >
          Ingest {selected.size} table{selected.size !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  );
}
