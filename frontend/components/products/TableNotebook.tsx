'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Play, Plus, Trash2, Loader2, GripVertical, Sparkles,
  Code as CodeIcon, FileText, MessageSquareText, Rocket, Network, AlertTriangle,
} from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/Toast';
import { format as formatSql } from 'sql-formatter';
import CellOutput from './CellOutput';
import type { CellOutputData } from './CellOutput';

interface Cell {
  id: number;
  product_table_id: number;
  cell_type: 'sql' | 'markdown' | 'nl';
  source: string;
  generated_sql: string | null;
  position: number;
  last_output: CellOutputData | null;
  last_status: string | null;
  last_run_at: string | null;
  is_deploy_cell: boolean;
}

interface Props {
  productTableId: number;
  tableName: string;
  readOnly?: boolean;
  /**
   * True when this table is a stub for a dimension whose canonical
   * definition lives in another product. The backend transparently
   * redirects cell read/write to the owner — this flag exists only so
   * the UI can gate user-initiated writes with a "this affects N
   * products" consent modal. Conformity is preserved either way.
   */
  isShared?: boolean;
  ownerProductName?: string | null;
  onDeployed?: () => void;
}

/** A pending write the user has staged but not yet confirmed via the
 *  shared-dim consent modal. We carry the same shape as a deferred async
 *  call so the modal's confirm handler doesn't need a switch statement. */
type PendingWrite = { run: () => Promise<void>; label: string } | null;

interface UsedByProduct { productId: number; productName: string; kind?: string }

export default function TableNotebook({
  productTableId, tableName, readOnly = false,
  isShared = false, ownerProductName = null,
  onDeployed,
}: Props) {
  const [cells, setCells] = useState<Cell[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningCellId, setRunningCellId] = useState<number | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [editingCellId, setEditingCellId] = useState<number | null>(null);
  const [editBuffer, setEditBuffer] = useState('');
  // Consent gate — populated when a write is staged on a shared dim;
  // cleared after the user confirms or cancels. usedBy is loaded once
  // (the impact list rarely changes within a session).
  const [pendingWrite, setPendingWrite] = useState<PendingWrite>(null);
  const [usedBy, setUsedBy] = useState<UsedByProduct[] | null>(null);
  const toast = useToast();

  /** Either run the action straight away (non-shared) or stage it for the
   *  consent modal (shared). One choke-point covers add / save / delete /
   *  deploy so we can never accidentally skip the gate. */
  const guard = useCallback((label: string, run: () => Promise<void>) => {
    if (!isShared) { void run(); return; }
    setPendingWrite({ label, run });
  }, [isShared]);

  // Lazy-load the impact list the first time we need it.
  useEffect(() => {
    if (!isShared || usedBy !== null) return;
    api.get(`/products/tables/${productTableId}/used-by`)
      .then((r) => {
        const arr = Array.isArray(r.data?.data) ? r.data.data : [];
        setUsedBy(arr.map((u: { productId: number; productName: string; kind?: string }) => ({
          productId: u.productId, productName: u.productName, kind: u.kind,
        })));
      })
      .catch(() => setUsedBy([]));
  }, [isShared, productTableId, usedBy]);

  const loadCells = useCallback(async () => {
    try {
      const res = await api.get(`/products/tables/${productTableId}/cells`);
      setCells(res.data.data ?? []);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [productTableId]);

  useEffect(() => {
    setLoading(true);
    loadCells();
  }, [loadCells]);

  function addCell(cellType: 'sql' | 'markdown' | 'nl') {
    guard(`Add ${cellType.toUpperCase()} cell`, async () => {
      try {
        const res = await api.post(`/products/tables/${productTableId}/cells`, { cellType });
        setCells((prev) => [...prev, res.data.data]);
        setEditingCellId(res.data.data.id);
        setEditBuffer('');
      } catch {
        toast.error('Failed to add cell');
      }
    });
  }

  function saveCell(cellId: number) {
    const buf = editBuffer;
    guard('Save cell', async () => {
      try {
        await api.patch(`/products/tables/cells/${cellId}`, { source: buf });
        setCells((prev) => prev.map((c) => c.id === cellId ? { ...c, source: buf } : c));
        setEditingCellId(null);
      } catch {
        toast.error('Failed to save cell');
      }
    });
  }

  function deleteCell(cellId: number) {
    guard('Delete cell', async () => {
      try {
        await api.delete(`/products/tables/cells/${cellId}`);
        setCells((prev) => prev.filter((c) => c.id !== cellId));
      } catch {
        toast.error('Failed to delete cell');
      }
    });
  }

  async function executeCell(cellId: number) {
    setRunningCellId(cellId);
    try {
      const res = await api.post(`/products/tables/cells/${cellId}/execute`);
      const data = res.data.data as CellOutputData;
      setCells((prev) => prev.map((c) =>
        c.id === cellId ? { ...c, last_output: data, last_status: 'success', last_run_at: new Date().toISOString() } : c
      ));
    } catch (err) {
      const errData = (err as { response?: { data?: { error?: string; suggestedFix?: string } } })?.response?.data;
      const msg = errData?.error ?? 'Execution failed';
      const suggestedFix = errData?.suggestedFix;
      setCells((prev) => prev.map((c) =>
        c.id === cellId ? { ...c, last_output: { error: msg, suggestedFix }, last_status: 'error', last_run_at: new Date().toISOString() } : c
      ));
    } finally {
      setRunningCellId(null);
    }
  }

  async function generateNl(cellId: number) {
    setRunningCellId(cellId);
    try {
      const res = await api.post(`/products/tables/cells/${cellId}/generate`);
      const sql = res.data.data?.generatedSql ?? '';
      setCells((prev) => prev.map((c) =>
        c.id === cellId ? { ...c, generated_sql: sql } : c
      ));
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Generation failed';
      toast.error(msg);
    } finally {
      setRunningCellId(null);
    }
  }

  function deploy() {
    guard('Deploy table', async () => {
      setDeploying(true);
      try {
        await api.post(`/products/tables/${productTableId}/deploy`);
        toast.success(`${tableName} deployed`);
        onDeployed?.();
        loadCells();
      } catch (err) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Deploy failed';
        toast.error(msg);
      } finally {
        setDeploying(false);
      }
    });
  }

  function startEdit(cell: Cell) {
    setEditingCellId(cell.id);
    setEditBuffer(cell.source);
  }

  function cancelEdit() {
    setEditingCellId(null);
    setEditBuffer('');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
      </div>
    );
  }

  const hasSqlCells = cells.some((c) => c.cell_type === 'sql' || c.cell_type === 'nl');

  return (
    <div className="space-y-3">
      {/* Deploy button + data diff */}
      {!readOnly && hasSqlCells && (
        <div className="flex items-center gap-3">
          <DataDiffStrip productTableId={productTableId} />
          <div className="flex-1" />
          <button
            onClick={deploy}
            disabled={deploying}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
          >
            {deploying ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" strokeWidth={2} />}
            {deploying ? 'Deploying…' : 'Deploy'}
          </button>
        </div>
      )}

      {/* Cells */}
      {cells.length === 0 && (
        <div className="text-center py-8">
          <CodeIcon className="w-6 h-6 mx-auto text-muted-2 mb-2" strokeWidth={1.5} />
          <p className="text-[13px] text-muted">No cells yet. Add a SQL cell to define this table.</p>
        </div>
      )}

      {cells.map((cell) => {
        const isEditing = editingCellId === cell.id;
        const isRunning = runningCellId === cell.id;

        return (
          <div key={cell.id} className="rounded-md border border-line bg-surface overflow-hidden">
            {/* Cell header */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-softer border-b border-line">
              <GripVertical className="w-3 h-3 text-muted-2" strokeWidth={1.5} />
              <CellTypeBadge type={cell.cell_type} />
              {cell.is_deploy_cell && (
                <span className="text-[9px] font-mono tracking-[0.12em] uppercase text-ocean bg-ocean-softer px-1.5 py-0.5 rounded">
                  deploy
                </span>
              )}
              <div className="flex-1" />
              {!readOnly && cell.cell_type !== 'markdown' && (
                <button
                  onClick={() => cell.cell_type === 'nl' && !cell.generated_sql ? generateNl(cell.id) : executeCell(cell.id)}
                  disabled={isRunning}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-ocean hover:bg-ocean-softer/60 rounded transition-colors disabled:opacity-50"
                  title={cell.cell_type === 'nl' && !cell.generated_sql ? 'Generate SQL' : 'Run (preview)'}
                >
                  {isRunning
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : cell.cell_type === 'nl' && !cell.generated_sql
                      ? <Sparkles className="w-3 h-3" strokeWidth={2} />
                      : <Play className="w-3 h-3" strokeWidth={2} />
                  }
                  {isRunning ? 'Running…' : cell.cell_type === 'nl' && !cell.generated_sql ? 'Generate' : 'Run'}
                </button>
              )}
              {!readOnly && !cell.is_deploy_cell && (
                <button
                  onClick={() => deleteCell(cell.id)}
                  className="p-1 text-muted-2 hover:text-err rounded transition-colors"
                  title="Delete cell"
                >
                  <Trash2 className="w-3 h-3" strokeWidth={2} />
                </button>
              )}
            </div>

            {/* Cell body */}
            <div className="px-3 py-2">
              {cell.cell_type === 'markdown' ? (
                isEditing ? (
                  <EditArea
                    value={editBuffer}
                    onChange={setEditBuffer}
                    onSave={() => saveCell(cell.id)}
                    onCancel={cancelEdit}
                    placeholder="Write documentation…"
                  />
                ) : (
                  <div
                    className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap cursor-pointer hover:bg-softer/30 rounded px-1 py-0.5 min-h-[24px]"
                    onClick={() => !readOnly && startEdit(cell)}
                  >
                    {cell.source || <span className="text-muted italic">Click to add documentation…</span>}
                  </div>
                )
              ) : cell.cell_type === 'nl' ? (
                <div className="space-y-2">
                  {isEditing ? (
                    <EditArea
                      value={editBuffer}
                      onChange={setEditBuffer}
                      onSave={() => saveCell(cell.id)}
                      onCancel={cancelEdit}
                      placeholder="Describe what this table should contain…"
                    />
                  ) : (
                    <div
                      className="text-[13px] text-ink leading-relaxed cursor-pointer hover:bg-softer/30 rounded px-1 py-0.5 min-h-[24px]"
                      onClick={() => !readOnly && startEdit(cell)}
                    >
                      {cell.source || <span className="text-muted italic">Click to describe what you want…</span>}
                    </div>
                  )}
                  {cell.generated_sql && (
                    <div className="border-t border-line pt-2">
                      <p className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted mb-1">Generated SQL</p>
                      <pre className="text-[12px] font-mono text-ink-2 bg-softer/40 rounded px-2.5 py-2 overflow-x-auto whitespace-pre-wrap leading-relaxed">
                        {prettySql(cell.generated_sql)}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                /* SQL cell */
                isEditing ? (
                  <EditArea
                    value={editBuffer}
                    onChange={setEditBuffer}
                    onSave={() => saveCell(cell.id)}
                    onCancel={cancelEdit}
                    onRun={() => { saveCell(cell.id); executeCell(cell.id); }}
                    placeholder="SELECT …"
                    mono
                  />
                ) : (
                  <pre
                    className="text-[12px] font-mono text-ink-2 leading-relaxed whitespace-pre-wrap cursor-pointer hover:bg-softer/30 rounded px-1 py-0.5 min-h-[24px]"
                    onClick={() => !readOnly && startEdit(cell)}
                  >
                    {cell.source ? prettySql(cell.source) : <span className="text-muted italic font-sans">Click to write SQL…</span>}
                  </pre>
                )
              )}
            </div>

            {/* Cell output */}
            {cell.last_output && (
              <div className="px-3 pb-3">
                <CellOutput
                  data={cell.last_output}
                  status={cell.last_status}
                  onApplyFix={!readOnly ? (fixSql) => {
                    setCells((prev) => prev.map((c) =>
                      c.id === cell.id ? { ...c, source: fixSql } : c
                    ));
                    api.patch(`/products/tables/cells/${cell.id}`, { source: fixSql })
                      .then(() => executeCell(cell.id))
                      .catch(() => {});
                  } : undefined}
                />
              </div>
            )}
          </div>
        );
      })}

      {/* Add cell buttons */}
      {!readOnly && (
        <div className="flex items-center gap-2 pt-1">
          <button onClick={() => addCell('sql')} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink border border-line hover:border-line-strong rounded-md transition-colors">
            <CodeIcon className="w-3 h-3" strokeWidth={2} />
            + SQL
          </button>
          <button onClick={() => addCell('markdown')} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink border border-line hover:border-line-strong rounded-md transition-colors">
            <FileText className="w-3 h-3" strokeWidth={2} />
            + Markdown
          </button>
          <button onClick={() => addCell('nl')} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-ink border border-line hover:border-line-strong rounded-md transition-colors">
            <MessageSquareText className="w-3 h-3" strokeWidth={2} />
            + Ask AI
          </button>
        </div>
      )}

      {/* Shared-dimension consent gate. Renders only while a write is
          staged (pendingWrite !== null). Lists every product that
          consumes this dim — the user sees exactly what their change
          affects before it lands. Conformity is the point: one
          canonical definition for everyone, and you do it knowingly. */}
      {pendingWrite && (
        <SharedDimConsentModal
          tableName={tableName}
          ownerProductName={ownerProductName}
          actionLabel={pendingWrite.label}
          usedBy={usedBy}
          onCancel={() => setPendingWrite(null)}
          onConfirm={async () => {
            const w = pendingWrite;
            setPendingWrite(null);
            if (w) await w.run();
          }}
        />
      )}
    </div>
  );
}

function SharedDimConsentModal({
  tableName, ownerProductName, actionLabel, usedBy, onCancel, onConfirm,
}: {
  tableName: string;
  ownerProductName: string | null;
  actionLabel: string;
  usedBy: UsedByProduct[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Dedupe by productId; "self" (the owner) shouldn't be in the list.
  const others = (usedBy ?? []).filter(
    (u, i, arr) => arr.findIndex((x) => x.productId === u.productId) === i,
  );
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onCancel} aria-hidden />
      <div className="relative bg-raised border border-line rounded-lg shadow-xl w-full max-w-md p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-amber-50 border border-amber-200 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-4 h-4 text-amber-700" strokeWidth={1.75} />
          </div>
          <div className="min-w-0">
            <h2 className="font-display text-[16px] text-ink">Edit shared dimension?</h2>
            <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
              <strong>{tableName}</strong> is the canonical version of this dimension
              {ownerProductName ? <> (managed by <em>{ownerProductName}</em>)</> : null}.
              {' '}{actionLabel.toLowerCase()} updates the single shared definition every product reads.
            </p>
          </div>
        </div>

        <div className="mt-4 border border-line rounded-md bg-bg">
          <div className="px-3 py-2 border-b border-line text-[10.5px] font-mono uppercase tracking-[0.12em] text-muted-2">
            This change will affect
          </div>
          {usedBy === null ? (
            <div className="px-3 py-3 text-[12px] text-muted flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking which products use this…
            </div>
          ) : others.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-muted-2 italic">
              No other products currently use this dimension. You’re effectively editing in place.
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {others.map((u) => (
                <li key={u.productId} className="px-3 py-2 text-[12.5px] text-ink-2 flex items-center gap-2">
                  <Network className="w-3 h-3 text-ocean shrink-0" strokeWidth={1.75} />
                  <span className="truncate">{u.productName}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-[11px] text-muted mt-3">
          Each affected product needs a refresh to materialise the change. You can run them from the Build page.
        </p>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onCancel}
            className="px-3 py-2 text-[13px] font-medium text-ink-2 border border-line rounded-md hover:bg-soft transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-[13px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover transition-colors"
          >
            {actionLabel} for everyone
          </button>
        </div>
      </div>
    </div>
  );
}

function CellTypeBadge({ type }: { type: string }) {
  const config: Record<string, { icon: typeof CodeIcon; label: string; color: string }> = {
    sql: { icon: CodeIcon, label: 'SQL', color: 'text-ocean bg-ocean-softer' },
    markdown: { icon: FileText, label: 'MD', color: 'text-muted bg-softer' },
    nl: { icon: MessageSquareText, label: 'AI', color: 'text-purple-600 bg-purple-50' },
  };
  const c = config[type] ?? config.sql;
  const Icon = c.icon;
  return (
    <span className={cn('inline-flex items-center gap-1 text-[9px] font-mono tracking-[0.12em] uppercase px-1.5 py-0.5 rounded', c.color)}>
      <Icon className="w-2.5 h-2.5" strokeWidth={2} />
      {c.label}
    </span>
  );
}

function EditArea({
  value, onChange, onSave, onCancel, onRun, placeholder, mono,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  onRun?: () => void;
  placeholder?: string;
  mono?: boolean;
}) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      if (onRun) onRun();
      else onSave();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus
        rows={Math.min(Math.max(value.split('\n').length, 3), 20)}
        className={cn(
          'w-full bg-bg border border-line rounded-md px-2.5 py-2 text-[12.5px] text-ink leading-relaxed focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 resize-y',
          mono && 'font-mono text-[12px]',
        )}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave()}
          className="px-2.5 py-1 text-[11px] font-medium bg-ocean text-white rounded hover:bg-ocean-hover transition-colors"
        >
          Save
        </button>
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[11px] font-medium text-muted hover:text-ink transition-colors"
        >
          Cancel
        </button>
        <span className="text-[10px] text-muted-2 ml-auto">
          {onRun ? 'Shift+Enter to save & run' : 'Shift+Enter to save'} · Esc to cancel
        </span>
      </div>
    </div>
  );
}

function DataDiffStrip({ productTableId }: { productTableId: number }) {
  const [diff, setDiff] = useState<{
    unchanged_count: number; updated_count: number; inserted_count: number; deleted_count: number;
    created_at: string;
  } | null>(null);

  useEffect(() => {
    api.get(`/products/tables/${productTableId}/refresh-history?limit=1`)
      .then((res) => {
        const rows = res.data.data ?? [];
        if (rows.length > 0 && rows[0].status === 'success') setDiff(rows[0]);
      })
      .catch(() => {});
  }, [productTableId]);

  if (!diff) return null;

  const total = diff.unchanged_count + diff.updated_count + diff.inserted_count + diff.deleted_count;
  if (total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-[10px] font-mono text-muted-2">
      <span className="text-muted">Last deploy:</span>
      {diff.unchanged_count > 0 && <span>{diff.unchanged_count.toLocaleString('en-GB')} unchanged</span>}
      {diff.updated_count > 0 && <span className="text-ocean">{diff.updated_count.toLocaleString('en-GB')} updated</span>}
      {diff.inserted_count > 0 && <span className="text-ok">{diff.inserted_count.toLocaleString('en-GB')} new</span>}
      {diff.deleted_count > 0 && <span className="text-err">{diff.deleted_count.toLocaleString('en-GB')} deleted</span>}
    </div>
  );
}

function prettySql(sql: string): string {
  try {
    return formatSql(sql, { language: 'sql', tabWidth: 2, keywordCase: 'upper' });
  } catch {
    return sql;
  }
}
