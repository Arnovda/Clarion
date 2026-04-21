'use client';

import { useEffect, useRef, useState } from 'react';
import { X, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { getToken } from '../../../lib/auth';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

interface QueryResult {
  label: string;
  rows: Record<string, unknown>[];
  error?: string;
}

interface InvestigationPanelProps {
  widgetTitle: string;
  widgetSql: string;
  widgetRows: Record<string, unknown>[];
  connectionId: number;
  filterValues: Record<string, string>;
  onClose: () => void;
}

type Event =
  | { type: 'status'; text: string }
  | { type: 'hypothesis'; text: string }
  | { type: 'querying'; label: string }
  | { type: 'result'; label: string; rows: Record<string, unknown>[]; error?: string }
  | { type: 'conclusion'; text: string }
  | { type: 'error'; text: string }
  | { type: 'done' };

export function InvestigationPanel({
  widgetTitle,
  widgetSql,
  widgetRows,
  connectionId,
  filterValues,
  onClose,
}: InvestigationPanelProps) {
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [hypothesis, setHypothesis] = useState<string | null>(null);
  const [queryResults, setQueryResults] = useState<QueryResult[]>([]);
  const [runningLabels, setRunningLabels] = useState<Set<string>>(new Set());
  const [conclusion, setConclusion] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [expandedQuery, setExpandedQuery] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  function reset() {
    setHypothesis(null);
    setQueryResults([]);
    setRunningLabels(new Set());
    setConclusion(null);
    setStatusText(null);
    setFatalError(null);
    setExpandedQuery(null);
  }

  async function investigate() {
    if (!question.trim() || running) return;
    reset();
    setRunning(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/dashboards/investigate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId,
          widgetTitle,
          widgetSql,
          widgetRows: widgetRows.slice(0, 20),
          question: question.trim(),
          filterValues,
        }),
        signal: abortRef.current.signal,
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as Event;
            if (event.type === 'status') setStatusText(event.text);
            if (event.type === 'hypothesis') setHypothesis(event.text);
            if (event.type === 'querying') {
              setRunningLabels((prev) => new Set([...prev, event.label]));
            }
            if (event.type === 'result') {
              setRunningLabels((prev) => { const s = new Set(prev); s.delete(event.label); return s; });
              setQueryResults((prev) => [...prev, { label: event.label, rows: event.rows, error: event.error }]);
            }
            if (event.type === 'conclusion') setConclusion(event.text);
            if (event.type === 'error') setFatalError(event.text);
            if (event.type === 'done') setRunning(false);
          } catch { /* ignore malformed event */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setFatalError('Investigation failed. Please try again.');
      setRunning(false);
    }
  }

  const hasResults = hypothesis || queryResults.length > 0 || conclusion;

  return (
    <div className="flex flex-col h-full border-l border-line bg-surface">
      {/* Header */}
      <div className="px-5 py-4 border-b border-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Search className="w-3.5 h-3.5 text-ocean" strokeWidth={2} />
          <span className="text-[11px] font-mono tracking-[0.1em] uppercase text-ink">
            Investigate
          </span>
        </div>
        <button onClick={onClose} className="p-1 rounded text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Widget context */}
      <div className="px-5 py-3 border-b border-line shrink-0">
        <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1">Investigating</p>
        <p className="text-[13px] font-medium text-ink">{widgetTitle}</p>
      </div>

      {/* Question input */}
      <div className="px-5 py-4 border-b border-line shrink-0">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) investigate(); }}
          placeholder={`Why did ${widgetTitle.toLowerCase()} change?`}
          rows={2}
          className="w-full text-[13px] text-ink bg-bg border border-line rounded-md px-3 py-2 resize-none focus:outline-none focus:border-ocean/50 placeholder:text-muted-2"
        />
        <button
          onClick={investigate}
          disabled={running || !question.trim()}
          className="mt-2 w-full py-1.5 rounded-md bg-ocean text-white text-[12px] font-mono tracking-[0.06em] uppercase hover:bg-ocean-hover transition-colors disabled:opacity-40"
        >
          {running ? 'Investigating…' : 'Investigate'}
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        {fatalError && (
          <p className="text-[12px] text-err">{fatalError}</p>
        )}

        {statusText && !hasResults && (
          <p className="text-[12px] text-muted-2 animate-pulse">{statusText}</p>
        )}

        {hypothesis && (
          <div>
            <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1.5">Hypothesis</p>
            <p className="text-[13px] text-ink-2 leading-relaxed italic">{hypothesis}</p>
          </div>
        )}

        {(queryResults.length > 0 || runningLabels.size > 0) && (
          <div>
            <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-2">Diagnostic queries</p>
            <div className="flex flex-col gap-2">
              {/* In-flight labels */}
              {[...runningLabels].map((label) => (
                <div key={label} className="rounded-md border border-line px-3 py-2">
                  <p className="text-[11px] font-mono text-muted-2 animate-pulse">{label}…</p>
                </div>
              ))}
              {/* Completed */}
              {queryResults.map((r) => (
                <div key={r.label} className="rounded-md border border-line overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-softer transition-colors"
                    onClick={() => setExpandedQuery(expandedQuery === r.label ? null : r.label)}
                  >
                    <span className="text-[11px] font-mono text-ink-2">{r.label}</span>
                    {r.error ? (
                      <span className="text-[10px] text-err font-mono">error</span>
                    ) : (
                      <>
                        <span className="text-[10px] text-muted font-mono mr-1">{r.rows.length} rows</span>
                        {expandedQuery === r.label ? (
                          <ChevronUp className="w-3 h-3 text-muted-2" />
                        ) : (
                          <ChevronDown className="w-3 h-3 text-muted-2" />
                        )}
                      </>
                    )}
                  </button>
                  {expandedQuery === r.label && !r.error && r.rows.length > 0 && (
                    <div className="border-t border-line overflow-x-auto">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="bg-softer">
                            {Object.keys(r.rows[0]).map((col) => (
                              <th key={col} className="px-3 py-1.5 text-left font-mono text-muted whitespace-nowrap">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {r.rows.slice(0, 10).map((row, i) => (
                            <tr key={i} className="border-t border-line">
                              {Object.values(row).map((val, j) => (
                                <td key={j} className="px-3 py-1.5 text-ink-2 whitespace-nowrap font-mono">
                                  {val === null || val === undefined ? '—' : String(val)}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {statusText && queryResults.length > 0 && !conclusion && (
          <p className="text-[12px] text-muted-2 animate-pulse">{statusText}</p>
        )}

        {conclusion && (
          <div className="rounded-lg border border-line bg-ocean-softer px-4 py-3">
            <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-ocean mb-2">Finding</p>
            <p className="text-[13px] text-ink leading-relaxed">{conclusion}</p>
          </div>
        )}
      </div>
    </div>
  );
}
