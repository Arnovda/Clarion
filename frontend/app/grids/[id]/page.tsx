'use client';

/**
 * /grids/[id] — the grid editor: an always-editable table with typed cells,
 * paste-from-Excel, column management, and a save bar.
 *
 * Editing model: everything is a local draft (rows as strings/booleans,
 * columns, name, description). Save writes metadata + the FULL row set —
 * "the table exactly as you see it" — after which the backend materialises
 * the grid into the warehouse and it is queryable in answers/dashboards.
 * Numbers and dates are parsed server-side the way a spreadsheet writes
 * them (1.234,56 · 21/08/2026), so pasting from Excel just works.
 *
 * Vocabulary rule applies (business words only), with one deliberate
 * exception: the table's name-in-answers (`grid_…`) is shown in the status
 * line, because that is the name the user will see Ask AI use.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Check, ChevronDown, Loader2, Plus, Trash2, TriangleAlert, X,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import RequireRole from '@/components/RequireRole';
import { formatRelative } from '@/lib/dates';
import { useWindowedRows } from '@/app/dashboards/utils/useWindowedRows';
import {
  COLUMN_TYPE_LABEL,
  deriveColumnKey,
  type GridColumn,
  type GridColumnType,
  type GridDetail,
} from '../types';

type CellValue = string | boolean;

interface EditRow {
  localId: number;
  values: Record<string, CellValue>;
}

const ROW_H = 37;

export default function GridEditorPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <GridEditor />
    </RequireRole>
  );
}

function GridEditor() {
  const params = useParams<{ id: string }>();
  const gridId = Number(params.id);
  const router = useRouter();
  const toast = useToast();

  const [grid, setGrid] = useState<GridDetail | null>(null);
  const [loadError, setLoadError] = useState('');

  // ── Draft state ──
  const [name, setName] = useState('');
  const [columns, setColumns] = useState<GridColumn[]>([]);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const nextLocalId = useRef(1);

  // ── UI state ──
  const [editingName, setEditingName] = useState(false);
  const [openColKey, setOpenColKey] = useState<string | null>(null);
  const [confirmDeleteCol, setConfirmDeleteCol] = useState(false);
  const [confirmDeleteTable, setConfirmDeleteTable] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const makeRow = useCallback((values: Record<string, CellValue> = {}): EditRow => {
    return { localId: nextLocalId.current++, values };
  }, []);

  const applyServer = useCallback((detail: GridDetail) => {
    setGrid(detail);
    setName(detail.name);
    setColumns(detail.columns);
    setRows(
      detail.rows.map((r) => {
        const values: Record<string, CellValue> = {};
        for (const col of detail.columns) {
          const v = r.data[col.key];
          if (v === null || v === undefined) continue;
          values[col.key] = col.type === 'boolean' ? v === true : String(v);
        }
        return { localId: nextLocalId.current++, values };
      }),
    );
    setDirty(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get(`/grids/${gridId}`);
        if (!cancelled) applyServer(res.data?.data as GridDetail);
      } catch {
        if (!cancelled) setLoadError('Could not load this table.');
      }
    })();
    return () => { cancelled = true; };
  }, [gridId, applyServer]);

  // Warn before navigating away with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ── Mutations on the draft ──

  function setCell(localId: number, key: string, value: CellValue) {
    setRows((prev) => prev.map((r) => (r.localId === localId ? { ...r, values: { ...r.values, [key]: value } } : r)));
    setDirty(true);
  }

  function addRow() {
    setRows((prev) => [...prev, makeRow()]);
    setDirty(true);
  }

  function deleteRow(localId: number) {
    setRows((prev) => prev.filter((r) => r.localId !== localId));
    setDirty(true);
  }

  function addColumn() {
    setColumns((prev) => {
      const taken = new Set(prev.map((c) => c.key));
      const n = prev.length + 1;
      const col: GridColumn = { key: deriveColumnKey(`Column ${n}`, taken), name: `Column ${n}`, type: 'text' };
      setOpenColKey(col.key);
      return [...prev, col];
    });
    setDirty(true);
  }

  function updateColumn(key: string, patch: Partial<Pick<GridColumn, 'name' | 'type'>>) {
    setColumns((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    setDirty(true);
  }

  function deleteColumn(key: string) {
    setColumns((prev) => prev.filter((c) => c.key !== key));
    setOpenColKey(null);
    setConfirmDeleteCol(false);
    setDirty(true);
  }

  // ── Paste from a spreadsheet ──
  // A clipboard with tabs or newlines is a block of cells: fill right and
  // down from the focused cell, growing rows as needed. A single value falls
  // through to the input's own paste.
  function onPaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text/plain');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return;

    const target = document.activeElement as HTMLElement | null;
    const rowAttr = target?.getAttribute('data-row');
    const colAttr = target?.getAttribute('data-col');
    if (rowAttr === null || rowAttr === undefined || !colAttr) return;
    e.preventDefault();

    const anchorRow = Number(rowAttr);
    const anchorCol = columns.findIndex((c) => c.key === colAttr);
    if (anchorCol < 0) return;

    const lines = text.replace(/\r/g, '').split('\n');
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const block = lines.map((l) => l.split('\t'));

    setRows((prev) => {
      const next = [...prev];
      while (next.length < anchorRow + block.length) next.push(makeRow());
      for (let r = 0; r < block.length; r++) {
        const rowIdx = anchorRow + r;
        const values = { ...next[rowIdx].values };
        for (let c = 0; c < block[r].length; c++) {
          const col = columns[anchorCol + c];
          if (!col) break;
          const raw = block[r][c].trim();
          if (col.type === 'boolean') {
            values[col.key] = ['true', 'yes', 'ja', 'oui', '1', 'x'].includes(raw.toLowerCase());
          } else {
            values[col.key] = raw;
          }
        }
        next[rowIdx] = { ...next[rowIdx], values };
      }
      return next;
    });
    setDirty(true);
    toast.info(`Pasted ${block.length} ${block.length === 1 ? 'row' : 'rows'}`);
  }

  // ── Save / discard ──

  const save = useCallback(async () => {
    if (!grid || saving) return;
    setSaving(true);
    try {
      const metaChanged =
        name.trim() !== grid.name ||
        JSON.stringify(columns) !== JSON.stringify(grid.columns);
      if (metaChanged) {
        await api.put(`/grids/${grid.id}`, { name: name.trim(), columns });
      }
      const payload = rows
        .filter((r) => Object.values(r.values).some((v) => v !== '' && v !== undefined))
        .map((r) => {
          const data: Record<string, unknown> = {};
          for (const col of columns) {
            const v = r.values[col.key];
            data[col.key] = v === undefined || v === '' ? null : v;
          }
          return { data };
        });
      const res = await api.put(`/grids/${grid.id}/rows`, { rows: payload });
      const updated = res.data?.data as GridDetail;
      // Keep the draft (it IS the saved state now); refresh server metadata.
      setGrid((prev) => (prev ? { ...prev, ...updated, rows: prev.rows } : prev));
      setDirty(false);
      if (updated.materializeError) {
        toast.warn('Saved, but not usable in answers yet', { description: updated.materializeError });
      } else {
        toast.success('Saved', { description: `Ready to use in answers and dashboards.` });
      }
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error('Could not save', {
        description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error',
      });
    } finally {
      setSaving(false);
    }
  }, [grid, saving, name, columns, rows, toast]);

  function discard() {
    if (!grid) return;
    nextLocalId.current = 1;
    applyServer(grid);
  }

  // Cmd/Ctrl+S saves.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, save]);

  async function deleteTable() {
    if (!grid || deleting) return;
    setDeleting(true);
    try {
      await api.delete(`/grids/${grid.id}`);
      router.push('/grids');
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error('Could not delete the table', {
        description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error',
      });
      setDeleting(false);
    }
  }

  // ── Windowed rendering for large grids ──
  const windowed = useWindowedRows(rows, ROW_H, 150, 14);

  const status = useMemo(() => {
    if (!grid) return null;
    if (dirty) return { tone: 'draft' as const, text: 'Unsaved changes' };
    if (grid.materializeError) {
      return { tone: 'warn' as const, text: 'Rows saved — not usable in answers yet' };
    }
    return {
      tone: 'ok' as const,
      text: `In answers as ${grid.viewName} · updated ${formatRelative(grid.updatedAt)}`,
    };
  }, [grid, dirty]);

  if (loadError) {
    return (
      <div className="flex-1 overflow-y-auto px-10 pt-10">
        <div className="mx-auto max-w-[880px]">
          <a href="/grids" className="text-[13px] text-ocean hover:underline">← Your tables</a>
          <p className="mt-6 text-[13px] text-err">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!grid) {
    return (
      <div className="flex-1 overflow-y-auto px-10 pt-10">
        <div className="mx-auto max-w-[880px] flex items-center gap-2 text-[13px] text-muted">
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-10 pb-28 pt-8">
        <div className="mx-auto max-w-[1040px]">
          {/* ── Header ── */}
          <a
            href="/grids"
            className="inline-flex items-center gap-1 text-[12px] text-muted-2 hover:text-ink-3"
          >
            <ArrowLeft className="h-3 w-3" strokeWidth={2} aria-hidden /> Your tables
          </a>
          <header className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              {editingName ? (
                <input
                  value={name}
                  autoFocus
                  onChange={(e) => { setName(e.target.value); setDirty(true); }}
                  onBlur={() => setEditingName(false)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingName(false); }}
                  className="w-full max-w-[480px] rounded-[8px] border border-ocean bg-bg px-2 py-1 font-display text-[26px] leading-[1.15] tracking-[-0.02em] text-ink focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingName(true)}
                  title="Rename"
                  className="rounded-[8px] px-2 py-1 -mx-2 text-left font-display text-[26px] leading-[1.15] tracking-[-0.02em] text-ink hover:bg-softer"
                >
                  {name}
                </button>
              )}
              {status && (
                <p className="mt-1 flex items-center gap-1.5 px-0 text-[12px] text-muted-2">
                  <span
                    className={`h-[7px] w-[7px] rounded-full ${
                      status.tone === 'ok' ? 'bg-ok' : status.tone === 'warn' ? 'bg-warn' : 'bg-ocean'
                    }`}
                    aria-hidden
                  />
                  {status.text}
                  {status.tone === 'warn' && grid.materializeError && (
                    <span title={grid.materializeError}>
                      <TriangleAlert className="h-3 w-3 text-warn" strokeWidth={2} aria-hidden />
                    </span>
                  )}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-[12px] text-muted-2">
                {rows.length.toLocaleString('en-GB')} {rows.length === 1 ? 'row' : 'rows'}
              </span>
              {!confirmDeleteTable ? (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteTable(true)}
                  className="text-[12px] text-muted-2 underline-offset-2 hover:text-ink-3 hover:underline"
                >
                  Delete table…
                </button>
              ) : null}
            </div>
          </header>

          {confirmDeleteTable && (
            <div className="mt-3 rounded-[10px] border border-line bg-warn-soft px-4 py-3">
              <p className="text-[13px] leading-[1.55] text-ink-2">
                Delete “{grid.name}”? Answers and dashboards that use it will stop finding this
                data. This cannot be undone.
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void deleteTable()}
                  disabled={deleting}
                  className="flex items-center gap-1.5 rounded-[8px] bg-warn px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {deleting && <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} aria-hidden />}
                  Delete the table
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteTable(false)}
                  className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3"
                >
                  Keep it
                </button>
              </div>
            </div>
          )}

          {/* ── The grid ── */}
          <div className="mt-5 overflow-hidden rounded-[10px] border border-line bg-raised shadow-1">
            <div
              className="max-h-[62vh] overflow-auto"
              onScroll={windowed.onScroll}
              onPaste={onPaste}
            >
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="sticky top-0 z-10 bg-softer">
                    <th className="w-[44px] border-b border-line px-2 py-2" aria-label="Row number" />
                    {columns.map((col) => (
                      <th key={col.key} className="relative border-b border-line px-1 py-0 text-left">
                        <button
                          type="button"
                          onClick={() => { setOpenColKey(openColKey === col.key ? null : col.key); setConfirmDeleteCol(false); }}
                          className="flex w-full items-center gap-1.5 rounded px-2 py-2 text-left hover:bg-soft"
                          title="Column settings"
                        >
                          <span className="truncate font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-muted">
                            {col.name}
                          </span>
                          <span className="shrink-0 rounded-full bg-bg px-1.5 py-px font-mono text-[9px] text-muted-2">
                            {COLUMN_TYPE_LABEL[col.type]}
                          </span>
                          <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />
                        </button>
                        {openColKey === col.key && (
                          <ColumnPopover
                            col={col}
                            canDelete={columns.length > 1}
                            confirmingDelete={confirmDeleteCol}
                            onConfirmDelete={setConfirmDeleteCol}
                            onChange={(patch) => updateColumn(col.key, patch)}
                            onDelete={() => deleteColumn(col.key)}
                            onClose={() => { setOpenColKey(null); setConfirmDeleteCol(false); }}
                          />
                        )}
                      </th>
                    ))}
                    <th className="w-[76px] border-b border-line px-2 py-1.5 text-left">
                      <button
                        type="button"
                        onClick={addColumn}
                        className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted-2 hover:bg-soft hover:text-ink-3"
                        title="Add a column"
                      >
                        <Plus className="h-3 w-3" strokeWidth={2} aria-hidden /> column
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {windowed.padTop > 0 && (
                    <tr aria-hidden style={{ height: windowed.padTop }}>
                      <td colSpan={columns.length + 2} className="p-0" />
                    </tr>
                  )}
                  {windowed.visible.map((row, i) => {
                    const absIdx = windowed.startIndex + i;
                    return (
                      <tr key={row.localId} className="group border-b border-line/60 last:border-b-0" style={{ height: ROW_H }}>
                        <td className="px-2 py-0 text-right font-mono text-[10.5px] tabular-nums text-muted-2">
                          {absIdx + 1}
                        </td>
                        {columns.map((col) => (
                          <td key={col.key} className="border-l border-line/40 px-1 py-0">
                            <Cell
                              col={col}
                              rowIdx={absIdx}
                              value={row.values[col.key]}
                              onChange={(v) => setCell(row.localId, col.key, v)}
                            />
                          </td>
                        ))}
                        <td className="border-l border-line/40 px-2 py-0 text-center">
                          <button
                            type="button"
                            onClick={() => deleteRow(row.localId)}
                            className="rounded p-1 text-transparent transition-colors group-hover:text-muted-2 hover:!text-err"
                            title="Delete row"
                            aria-label={`Delete row ${absIdx + 1}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {windowed.padBottom > 0 && (
                    <tr aria-hidden style={{ height: windowed.padBottom }}>
                      <td colSpan={columns.length + 2} className="p-0" />
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              onClick={addRow}
              className="flex w-full items-center gap-1.5 border-t border-line px-4 py-2.5 text-[12.5px] text-muted-2 hover:bg-softer hover:text-ink-3"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> Add row
            </button>
          </div>

          <p className="mt-3 text-[12px] leading-[1.6] text-muted-2">
            Tip: copy a block of cells in Excel and paste it here — click the cell where the
            top-left value should land first. Numbers like 1.234,56 and dates like 21/08/2026 are
            understood.
          </p>
        </div>
      </div>

      {/* ── Save bar ── */}
      {dirty && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center pb-5">
          <div className="pointer-events-auto flex items-center gap-3 rounded-[10px] border border-line bg-raised px-4 py-2.5 shadow-2">
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <span className="h-[7px] w-[7px] rounded-full bg-ocean" aria-hidden /> Unsaved changes
            </span>
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3 disabled:opacity-40"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-[8px] bg-ocean px-4 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {saving
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
                : <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Cell ────────────────────────────────────────────────────────────────────

function Cell({
  col, rowIdx, value, onChange,
}: {
  col: GridColumn;
  rowIdx: number;
  value: CellValue | undefined;
  onChange: (v: CellValue) => void;
}) {
  if (col.type === 'boolean') {
    return (
      <div className="flex justify-center">
        <input
          type="checkbox"
          data-row={rowIdx}
          data-col={col.key}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-line accent-ocean"
        />
      </div>
    );
  }
  const common =
    'w-full bg-transparent px-2 py-2 text-ink-2 placeholder:text-muted-2 focus:outline-none focus:bg-raised focus:ring-1 focus:ring-ocean/50 rounded transition-all';
  if (col.type === 'date') {
    return (
      <input
        type="date"
        data-row={rowIdx}
        data-col={col.key}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
        className={`${common} text-[12.5px]`}
      />
    );
  }
  return (
    <input
      data-row={rowIdx}
      data-col={col.key}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value)}
      inputMode={col.type === 'number' ? 'decimal' : undefined}
      className={`${common} ${col.type === 'number' ? 'text-right font-mono text-[12.5px] tabular-nums' : 'text-[13px]'}`}
    />
  );
}

// ─── Column settings popover ─────────────────────────────────────────────────

function ColumnPopover({
  col, canDelete, confirmingDelete, onConfirmDelete, onChange, onDelete, onClose,
}: {
  col: GridColumn;
  canDelete: boolean;
  confirmingDelete: boolean;
  onConfirmDelete: (v: boolean) => void;
  onChange: (patch: Partial<Pick<GridColumn, 'name' | 'type'>>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} aria-hidden />
      <div className="absolute left-0 top-full z-30 mt-1 w-[230px] rounded-[10px] border border-line bg-raised p-3 shadow-2 normal-case">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">Column</p>
          <button type="button" onClick={onClose} className="rounded p-0.5 text-muted-2 hover:text-ink-3" aria-label="Close">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        <input
          value={col.name}
          autoFocus
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') onClose(); }}
          className="mt-2 w-full rounded-[8px] border border-line bg-bg px-2.5 py-1.5 text-[13px] font-normal normal-case tracking-normal text-ink focus:border-ocean focus:outline-none"
        />
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {(Object.keys(COLUMN_TYPE_LABEL) as GridColumnType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onChange({ type: t })}
              className={`rounded-[8px] border px-2 py-1.5 text-[11.5px] font-normal normal-case tracking-normal transition-colors ${
                col.type === t
                  ? 'border-ocean bg-ocean-softer text-ocean'
                  : 'border-line text-ink-3 hover:border-ink-3'
              }`}
            >
              {COLUMN_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        {canDelete && (
          !confirmingDelete ? (
            <button
              type="button"
              onClick={() => onConfirmDelete(true)}
              className="mt-2.5 text-[11.5px] font-normal normal-case tracking-normal text-muted-2 underline-offset-2 hover:text-err hover:underline"
            >
              Delete this column…
            </button>
          ) : (
            <div className="mt-2.5 rounded-[8px] bg-warn-soft px-2.5 py-2">
              <p className="text-[11.5px] font-normal normal-case tracking-normal leading-[1.5] text-ink-2">
                The values in this column are removed on your next save.
              </p>
              <button
                type="button"
                onClick={onDelete}
                className="mt-1.5 rounded-[6px] bg-warn px-2.5 py-1 text-[11px] font-medium normal-case tracking-normal text-white hover:opacity-90"
              >
                Delete column
              </button>
            </div>
          )
        )}
      </div>
    </>
  );
}
