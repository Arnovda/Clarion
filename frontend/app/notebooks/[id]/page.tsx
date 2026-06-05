'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import api from '@/lib/api';
import { usePyodide } from '@/components/notebooks/usePyodide';
import SchemaExplorer from '@/components/notebooks/SchemaExplorer';

// Lazy-load CellEditor to avoid SSR issues with CodeMirror
const CellEditor = dynamic(() => import('@/components/notebooks/CellEditor'), { ssr: false });

/* ── Types ────────────────────────────────────────────────────────────── */
interface Cell {
  id: number;
  cell_type: 'sql' | 'python' | 'markdown';
  source: string;
  position: number;
  last_output: unknown;
  last_status: string | null;
  last_run_at: string | null;
}

interface Notebook {
  id: number;
  title: string;
  description: string | null;
  connection_id: number | null;
  starred: boolean;
  cells: Cell[];
}

interface Connection {
  id: number;
  name: string;
}

interface CellOutput {
  rows?: Record<string, unknown>[];
  columns?: string[];
  rowCount?: number;
  durationMs?: number;
  error?: string;
  // Python outputs
  stdout?: string;
  images?: string[];
}

/* ── Notebook Editor Page ─────────────────────────────────────────────── */
export default function NotebookEditorPage() {
  const params = useParams();
  const router = useRouter();
  const notebookId = Number(params.id);

  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [cells, setCells] = useState<Cell[]>([]);
  const [outputs, setOutputs] = useState<Map<number, CellOutput>>(new Map());
  const [running, setRunning] = useState<Set<number>>(new Set());
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningAll, setRunningAll] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeCellId, setActiveCellId] = useState<number | null>(null);
  const [scope, setScope] = useState<'sources' | 'products'>('products');

  const titleInputRef = useRef<HTMLInputElement>(null);
  /** Map of cell ID → insert callback (set by CellEditor via onReady) */
  const insertCallbacks = useRef<Map<number, (text: string) => void>>(new Map());
  const { loading: pyLoading, ready: pyReady, runPython, setSqlResult, setConnectionId } = usePyodide();

  /** Insert text into the active cell's editor */
  const insertIntoActiveCell = useCallback((text: string) => {
    const targetId = activeCellId ?? cells[0]?.id;
    if (!targetId) return;
    const cb = insertCallbacks.current.get(targetId);
    if (cb) {
      cb(text);
    } else {
      // Fallback: append to cell source
      setCells((prev) => prev.map((c) =>
        c.id === targetId ? { ...c, source: c.source ? c.source + text : text } : c
      ));
    }
  }, [activeCellId, cells]);

  // ── Load notebook ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const [nbRes, connRes] = await Promise.all([
        api.get(`/notebooks/${notebookId}`),
        api.get('/connections'),
      ]);
      const nb = nbRes.data.data as Notebook;
      setNotebook(nb);
      setTitle(nb.title);
      setCells(nb.cells.sort((a, b) => a.position - b.position));
      setConnections(connRes.data.data ?? []);

      // Restore cached outputs
      const restoredOutputs = new Map<number, CellOutput>();
      for (const cell of nb.cells) {
        if (cell.last_output) {
          const parsed = typeof cell.last_output === 'string'
            ? JSON.parse(cell.last_output)
            : cell.last_output;
          restoredOutputs.set(cell.id, parsed);
        }
      }
      setOutputs(restoredOutputs);
    } catch {
      router.push('/notebooks');
    } finally {
      setLoading(false);
    }
  }, [notebookId, router]);

  useEffect(() => { load(); }, [load]);

  // Keep Pyodide's connection ID in sync with the notebook's connection
  useEffect(() => {
    if (notebook?.connection_id) setConnectionId(notebook.connection_id);
  }, [notebook?.connection_id, setConnectionId]);

  // ── Title editing ──────────────────────────────────────────────────
  const saveTitle = async () => {
    setEditingTitle(false);
    if (title.trim() && title !== notebook?.title) {
      await api.patch(`/notebooks/${notebookId}`, { title: title.trim() });
      setNotebook((prev) => prev ? { ...prev, title: title.trim() } : prev);
    }
  };

  // ── Connection change ──────────────────────────────────────────────
  const changeConnection = async (connId: number) => {
    await api.patch(`/notebooks/${notebookId}`, { connectionId: connId });
    setNotebook((prev) => prev ? { ...prev, connection_id: connId } : prev);
  };

  // ── Cell CRUD ──────────────────────────────────────────────────────
  const addCell = async (afterPosition: number, type: 'sql' | 'python' | 'markdown' = 'sql') => {
    const res = await api.post(`/notebooks/${notebookId}/cells`, {
      cellType: type,
      position: afterPosition + 1,
    });
    if (res.data.ok) {
      setCells((prev) => {
        const updated = prev.map((c) =>
          c.position > afterPosition ? { ...c, position: c.position + 1 } : c
        );
        return [...updated, res.data.data].sort((a, b) => a.position - b.position);
      });
    }
  };

  const deleteCell = async (cellId: number) => {
    if (cells.length <= 1) return; // keep at least one cell
    await api.delete(`/notebooks/cells/${cellId}`);
    setCells((prev) => prev.filter((c) => c.id !== cellId));
    setOutputs((prev) => {
      const next = new Map(prev);
      next.delete(cellId);
      return next;
    });
  };

  const updateCellSource = (cellId: number, source: string) => {
    setCells((prev) => prev.map((c) => c.id === cellId ? { ...c, source } : c));
  };

  const changeCellType = async (cellId: number, newType: 'sql' | 'python' | 'markdown') => {
    await api.patch(`/notebooks/cells/${cellId}`, { cellType: newType });
    setCells((prev) => prev.map((c) => c.id === cellId ? { ...c, cell_type: newType } : c));
  };

  // Auto-save cell source (debounced)
  const saveTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const debouncedSave = (cellId: number, source: string) => {
    const existing = saveTimers.current.get(cellId);
    if (existing) clearTimeout(existing);
    saveTimers.current.set(cellId, setTimeout(() => {
      api.patch(`/notebooks/cells/${cellId}`, { source }).catch(() => {});
    }, 1000));
  };

  // ── Execute cell ───────────────────────────────────────────────────
  const executeCell = async (cellId: number) => {
    const cell = cells.find((c) => c.id === cellId);
    if (!cell || !cell.source.trim()) return;

    setRunning((prev) => new Set(prev).add(cellId));

    try {
      if (cell.cell_type === 'sql') {
        const res = await api.post(`/notebooks/cells/${cellId}/execute`, { source: cell.source });
        const output: CellOutput = res.data.ok
          ? { rows: res.data.data.rows, columns: res.data.data.columns, rowCount: res.data.data.rowCount, durationMs: res.data.data.durationMs }
          : { error: res.data.error };
        setOutputs((prev) => new Map(prev).set(cellId, output));

        // Register SQL result for Python cells
        if (res.data.ok && res.data.data.rows) {
          setSqlResult(String(cellId), res.data.data.rows);
        }
      } else if (cell.cell_type === 'python') {
        const result = await runPython(cell.source);
        const output: CellOutput = result.error
          ? { error: result.error }
          : { stdout: result.stdout, images: result.images };
        setOutputs((prev) => new Map(prev).set(cellId, output));
      }
    } catch (err) {
      setOutputs((prev) => new Map(prev).set(cellId, {
        error: err instanceof Error ? err.message : 'Execution failed',
      }));
    } finally {
      setRunning((prev) => {
        const next = new Set(prev);
        next.delete(cellId);
        return next;
      });
    }
  };

  // ── Run all cells ──────────────────────────────────────────────────
  const runAll = async () => {
    setRunningAll(true);
    for (const cell of cells) {
      if (cell.source.trim() && (cell.cell_type === 'sql' || cell.cell_type === 'python')) {
        await executeCell(cell.id);
      }
    }
    setRunningAll(false);
  };

  // ── Move cell ──────────────────────────────────────────────────────
  const moveCell = async (cellId: number, direction: 'up' | 'down') => {
    const idx = cells.findIndex((c) => c.id === cellId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= cells.length) return;

    const newCells = [...cells];
    [newCells[idx], newCells[swapIdx]] = [newCells[swapIdx], newCells[idx]];
    const reordered = newCells.map((c, i) => ({ ...c, position: i }));
    setCells(reordered);

    await api.post(`/notebooks/${notebookId}/reorder`, {
      order: reordered.map((c) => ({ cellId: c.id, position: c.position })),
    });
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface">
        <div className="w-8 h-8 border-3 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!notebook) return null;

  const connName = connections.find((c) => c.id === notebook.connection_id)?.name;

  return (
    <div className="flex-1 flex flex-col bg-surface overflow-hidden">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-outline-variant/10 bg-surface-container-lowest flex-shrink-0">
        {/* Back */}
        <button
          onClick={() => router.push('/notebooks')}
          className="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors text-on-surface-variant"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Title */}
        {editingTitle ? (
          <input
            ref={titleInputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
            className="text-title-md font-semibold text-on-surface bg-transparent border-b-2 border-primary outline-none px-1 py-0.5 min-w-[200px]"
            autoFocus
          />
        ) : (
          <button
            onClick={() => { setEditingTitle(true); setTimeout(() => titleInputRef.current?.focus(), 0); }}
            className="text-title-md font-semibold text-on-surface hover:text-primary transition-colors px-1 py-0.5"
          >
            {notebook.title}
          </button>
        )}

        {/* Scope toggle */}
        <div className="flex items-center bg-surface-container-low rounded-lg p-0.5 ml-4">
          <button
            onClick={() => setScope('sources')}
            className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-all ${scope === 'sources' ? 'bg-white text-blue-700 shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            Data Sources
          </button>
          <button
            onClick={() => setScope('products')}
            className={`text-[11px] font-semibold px-3 py-1 rounded-md transition-all ${scope === 'products' ? 'bg-white text-violet-700 shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}`}
          >
            Organized Data
          </button>
        </div>

        <div className="flex-1" />

        {/* Run All */}
        <button
          onClick={runAll}
          disabled={runningAll || !notebook.connection_id}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 text-label-md font-semibold hover:bg-emerald-100 disabled:opacity-50 transition-colors"
        >
          {runningAll ? (
            <div className="w-3.5 h-3.5 border-2 border-emerald-300 border-t-emerald-700 rounded-full animate-spin" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
          Run All
        </button>

        {/* Pyodide status */}
        {pyLoading && (
          <span className="text-label-sm text-amber-600 bg-amber-50 px-2 py-1 rounded-lg flex items-center gap-1.5">
            <div className="w-3 h-3 border-2 border-amber-300 border-t-amber-600 rounded-full animate-spin" />
            Loading Python...
          </span>
        )}
        {pyReady && (
          <span className="text-label-sm text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg">
            Python ready
          </span>
        )}

        {/* Toggle sidebar */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`p-1.5 rounded-lg transition-colors ${sidebarOpen ? 'bg-primary/10 text-primary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
          title={sidebarOpen ? 'Hide schema' : 'Show schema'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" />
          </svg>
        </button>
      </div>

      {/* ── Main area: Schema Sidebar + Cells ────────────────────────── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Schema Sidebar — left */}
        {sidebarOpen && (
          <div className="w-[280px] min-w-[280px] border-r border-outline-variant/10 bg-surface-container-lowest flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-outline-variant/10 flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              <span className="text-[12px] font-semibold text-on-surface">Schema</span>
            </div>
            <SchemaExplorer
              connectionId={notebook.connection_id}
              scope={scope}
              onInsert={insertIntoActiveCell}
            />
          </div>
        )}

        {/* Cells */}
        <div className="flex-1 overflow-auto px-6 py-6">
          <div className="max-w-4xl mx-auto space-y-2">
            {cells.map((cell, idx) => (
              <div key={cell.id}>
                <NotebookCell
                  cell={cell}
                  output={outputs.get(cell.id)}
                  isRunning={running.has(cell.id)}
                  isFirst={idx === 0}
                  isLast={idx === cells.length - 1}
                  canDelete={cells.length > 1}
                  connectionId={notebook.connection_id}
                  scope={scope}
                  onSourceChange={(s) => { updateCellSource(cell.id, s); debouncedSave(cell.id, s); }}
                  onRun={() => executeCell(cell.id)}
                  onDelete={() => deleteCell(cell.id)}
                  onTypeChange={(t) => changeCellType(cell.id, t)}
                  onMoveUp={() => moveCell(cell.id, 'up')}
                  onMoveDown={() => moveCell(cell.id, 'down')}
                  onFocus={() => setActiveCellId(cell.id)}
                  onRegisterInsert={(fn) => insertCallbacks.current.set(cell.id, fn)}
                />
                {/* Add cell button between cells */}
                <AddCellButton onAdd={(type) => addCell(cell.position, type)} />
              </div>
            ))}

            {cells.length === 0 && (
              <AddCellButton onAdd={(type) => addCell(-1, type)} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── NotebookCell ─────────────────────────────────────────────────────── */
function NotebookCell({
  cell,
  output,
  isRunning,
  isFirst,
  isLast,
  canDelete,
  connectionId,
  scope,
  onSourceChange,
  onRun,
  onDelete,
  onTypeChange,
  onMoveUp,
  onMoveDown,
  onFocus,
  onRegisterInsert,
}: {
  cell: Cell;
  output?: CellOutput;
  isRunning: boolean;
  isFirst: boolean;
  isLast: boolean;
  canDelete: boolean;
  connectionId: number | null;
  scope: 'sources' | 'products';
  onSourceChange: (s: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onTypeChange: (t: 'sql' | 'python' | 'markdown') => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onFocus?: () => void;
  onRegisterInsert?: (fn: (text: string) => void) => void;
}) {
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [lastAiPrompt, setLastAiPrompt] = useState<string | null>(null);
  const aiInputRef = useRef<HTMLInputElement>(null);

  const generateCode = async () => {
    if (!aiPrompt.trim() || !connectionId) return;
    setAiLoading(true);
    try {
      const res = await api.post('/notebooks/generate', {
        connectionId,
        prompt: aiPrompt.trim(),
        cellType: cell.cell_type,
        scope,
        existingCode: cell.source || undefined,
      });
      if (res.data.ok) {
        setLastAiPrompt(aiPrompt.trim());
        onSourceChange(res.data.data.code);
        setAiPrompt('');
        setAiOpen(false);
      }
    } catch {
      // ignore
    } finally {
      setAiLoading(false);
    }
  };

  const typeColors = {
    sql: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', ring: 'ring-blue-200' },
    python: { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', ring: 'ring-amber-200' },
    markdown: { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-200', ring: 'ring-gray-200' },
  };
  const colors = typeColors[cell.cell_type];

  return (
    <div className={`group rounded-xl border ${output?.error ? 'border-red-200' : 'border-outline-variant/15'} bg-surface-container-lowest overflow-hidden transition-all hover:border-outline-variant/30`}>
      {/* Cell toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-low/50 border-b border-outline-variant/10">
        {/* Type selector */}
        <select
          value={cell.cell_type}
          onChange={(e) => onTypeChange(e.target.value as 'sql' | 'python' | 'markdown')}
          className={`text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${colors.bg} ${colors.text} border-none outline-none cursor-pointer`}
        >
          <option value="sql">SQL</option>
          <option value="python">Python</option>
          <option value="markdown">Markdown</option>
        </select>

        {/* AI generate button */}
        {cell.cell_type !== 'markdown' && (
          <button
            onClick={() => { setAiOpen(!aiOpen); setTimeout(() => aiInputRef.current?.focus(), 50); }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold transition-colors ${aiOpen ? 'bg-violet-100 text-violet-700' : 'text-violet-500 hover:bg-violet-50'}`}
            title="Ask AI to generate code (Ctrl+I)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
              <path d="M8 6a4 4 0 0 1 8 0" />
              <circle cx="12" cy="6" r="1" fill="currentColor" stroke="none" />
            </svg>
            AI
          </button>
        )}

        <div className="flex-1" />

        {/* Duration badge */}
        {output?.durationMs !== undefined && !output.error && (
          <span className="text-[10px] text-on-surface-variant/50 font-mono">{output.durationMs}ms</span>
        )}

        {/* Row count badge */}
        {output?.rowCount !== undefined && !output.error && (
          <span className="text-[10px] text-on-surface-variant/50">{output.rowCount} rows</span>
        )}

        {/* Move buttons */}
        <div className="flex opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={onMoveUp} disabled={isFirst} className="p-1 rounded hover:bg-surface-container-low disabled:opacity-30 text-on-surface-variant" title="Move up">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 15l-6-6-6 6" /></svg>
          </button>
          <button onClick={onMoveDown} disabled={isLast} className="p-1 rounded hover:bg-surface-container-low disabled:opacity-30 text-on-surface-variant" title="Move down">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>

        {/* Run button */}
        {cell.cell_type !== 'markdown' && (
          <button
            onClick={onRun}
            disabled={isRunning}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 text-[11px] font-semibold hover:bg-emerald-100 disabled:opacity-50 transition-colors"
          >
            {isRunning ? (
              <div className="w-3 h-3 border-2 border-emerald-300 border-t-emerald-700 rounded-full animate-spin" />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
            Run
          </button>
        )}

        {/* Delete button */}
        {canDelete && (
          <button
            onClick={onDelete}
            className="p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-error-container/30 text-on-surface-variant hover:text-error transition-all"
            title="Delete cell"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* AI prompt bar */}
      {aiOpen && cell.cell_type !== 'markdown' && (
        <div className="flex items-center gap-2 px-3 py-2 bg-violet-50/50 border-b border-violet-200/30">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22" />
            <path d="M8 6a4 4 0 0 1 8 0" />
            <circle cx="12" cy="6" r="1" fill="#7c3aed" stroke="none" />
          </svg>
          <input
            ref={aiInputRef}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generateCode(); } if (e.key === 'Escape') setAiOpen(false); }}
            placeholder={cell.cell_type === 'sql'
              ? 'Describe the query you want... e.g. "top 10 customers by revenue"'
              : 'Describe what you want... e.g. "plot monthly revenue trend"'}
            className="flex-1 text-[12px] bg-transparent text-on-surface outline-none placeholder:text-on-surface-variant/40"
            disabled={aiLoading}
          />
          {aiLoading ? (
            <div className="w-4 h-4 border-2 border-violet-300 border-t-violet-600 rounded-full animate-spin flex-shrink-0" />
          ) : (
            <button
              onClick={generateCode}
              disabled={!aiPrompt.trim() || !connectionId}
              className="text-[11px] font-semibold text-violet-700 bg-violet-100 hover:bg-violet-200 disabled:opacity-40 px-2.5 py-1 rounded-md transition-colors flex-shrink-0"
            >
              Generate
            </button>
          )}
          <button
            onClick={() => setAiOpen(false)}
            className="p-0.5 rounded text-on-surface-variant/50 hover:text-on-surface-variant transition-colors flex-shrink-0"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* AI prompt label */}
      {lastAiPrompt && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-violet-50/60 border-b border-violet-100">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <path d="M12 2a4 4 0 014 4c0 1.5-.8 2.8-2 3.5V11h-4V9.5A4 4 0 0112 2z" /><path d="M8 14h8" /><path d="M9 18h6" /><path d="M10 22h4" />
          </svg>
          <span className="text-[11px] text-violet-600 italic truncate flex-1">{lastAiPrompt}</span>
          <button
            onClick={() => setLastAiPrompt(null)}
            className="text-violet-300 hover:text-violet-500 flex-shrink-0"
            title="Dismiss"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>
      )}

      {/* Editor */}
      <div className="min-h-[60px]">
        <CellEditor
          value={cell.source}
          onChange={onSourceChange}
          language={cell.cell_type}
          onRun={onRun}
          onFocus={onFocus}
          onReady={onRegisterInsert}
          placeholder={cell.cell_type === 'sql' ? 'SELECT * FROM ...' : cell.cell_type === 'python' ? '# Python code...' : 'Write markdown...'}
        />
      </div>

      {/* Output */}
      {output && <CellOutput output={output} cellType={cell.cell_type} />}
    </div>
  );
}

/* ── Cell Output ──────────────────────────────────────────────────────── */
function CellOutput({ output, cellType }: { output: CellOutput; cellType: string }) {
  if (output.error) {
    return (
      <div className="px-4 py-3 bg-red-50/50 border-t border-red-200/50">
        <pre className="text-[12px] text-red-700 font-mono whitespace-pre-wrap">{output.error}</pre>
      </div>
    );
  }

  // SQL output — table
  if (cellType === 'sql' && output.rows) {
    // Zero-row results would otherwise render an empty <table> with no
    // headers — visually indistinguishable from "nothing happened". Show
    // an explicit, friendly empty state instead.
    if (output.rows.length === 0) {
      return (
        <div className="border-t border-outline-variant/10 px-4 py-3 flex items-center gap-2 text-[12px] text-on-surface-variant">
          <span className="text-emerald-600">✓</span>
          Query ran successfully — no rows matched
          {output.durationMs !== undefined && (
            <span className="text-on-surface-variant/50 font-mono">· {output.durationMs}ms</span>
          )}
        </div>
      );
    }
    return (
      <div className="border-t border-outline-variant/10 overflow-auto max-h-[400px]">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-surface-container-low">
            <tr>
              {(output.columns ?? []).map((col) => (
                <th key={col} className="px-3 py-2 text-left text-[11px] font-semibold text-on-surface-variant uppercase tracking-wider border-b border-outline-variant/15">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {output.rows.slice(0, 100).map((row, ri) => (
              <tr key={ri} className="hover:bg-surface-container-low/50 transition-colors">
                {(output.columns ?? []).map((col) => (
                  <td key={col} className="px-3 py-1.5 text-on-surface font-mono border-b border-outline-variant/5 truncate max-w-[300px]">
                    {row[col] === null ? <span className="text-on-surface-variant/40 italic">null</span> : String(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {output.rows.length > 100 && (
          <div className="px-3 py-2 text-[11px] text-on-surface-variant bg-surface-container-low">
            Showing 100 of {output.rowCount ?? output.rows.length} rows
          </div>
        )}
      </div>
    );
  }

  // Python output — stdout + images
  if (cellType === 'python') {
    const hasContent = output.stdout || (output.images && output.images.length > 0);
    if (!hasContent) return null;

    return (
      <div className="border-t border-outline-variant/10 px-4 py-3 space-y-3">
        {output.stdout && (
          <pre className="text-[12px] text-on-surface font-mono whitespace-pre-wrap">{output.stdout}</pre>
        )}
        {output.images?.map((img, i) => (
          <img key={i} src={`data:image/png;base64,${img}`} alt={`Plot ${i + 1}`} className="max-w-full rounded-lg border border-outline-variant/10" />
        ))}
      </div>
    );
  }

  return null;
}

/* ── Add Cell Button ──────────────────────────────────────────────────── */
function AddCellButton({ onAdd }: { onAdd: (type: 'sql' | 'python' | 'markdown') => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex justify-center py-1 relative">
      <div className={`flex items-center gap-1 transition-opacity ${open ? 'opacity-100' : 'opacity-0 hover:opacity-100'}`}>
        <button
          onClick={() => onAdd('sql')}
          className="text-[10px] font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-md transition-colors"
        >
          + SQL
        </button>
        <button
          onClick={() => onAdd('python')}
          className="text-[10px] font-semibold text-amber-600 bg-amber-50 hover:bg-amber-100 px-2.5 py-1 rounded-md transition-colors"
        >
          + Python
        </button>
        <button
          onClick={() => onAdd('markdown')}
          className="text-[10px] font-semibold text-gray-600 bg-gray-50 hover:bg-gray-100 px-2.5 py-1 rounded-md transition-colors"
        >
          + Markdown
        </button>
      </div>
    </div>
  );
}
