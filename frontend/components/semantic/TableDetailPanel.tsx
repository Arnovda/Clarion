'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { SourceTable, SourceColumn } from './types';

interface Props {
  table: SourceTable;
  columns: SourceColumn[];
  focusColumnId: number | null;
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDomains(raw: SourceTable['domains']): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try { return JSON.parse(raw as unknown as string) ?? []; } catch { return []; }
}

function parseExamples(raw: SourceColumn['example_values']): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {}
  return [];
}

// ---------------------------------------------------------------------------
// PreviewTable — inline data preview
// ---------------------------------------------------------------------------

function PreviewTable({ connectionId, tableName }: { connectionId: number; tableName: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rows, setRows]   = useState<Record<string, unknown>[]>([]);
  const [cols, setCols]   = useState<string[]>([]);

  async function load() {
    setState('loading');
    try {
      const res = await api.get(`/semantic/preview?connectionId=${connectionId}&table=${encodeURIComponent(tableName)}&limit=10`);
      setRows(res.data.data.rows);
      setCols(res.data.data.columns);
      setState('done');
    } catch {
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={load}
        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
      >
        Preview data →
      </button>
    );
  }

  if (state === 'loading') {
    return <p className="text-xs text-slate-400">Loading preview…</p>;
  }

  if (state === 'error') {
    return <p className="text-xs text-red-500">Could not load preview.</p>;
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-slate-500">First {rows.length} rows</span>
        <button onClick={() => setState('idle')} className="text-xs text-slate-400 hover:text-slate-600">Hide</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="text-xs w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {cols.map((c) => (
                <th key={c} className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}>
                {cols.map((c) => (
                  <td key={c} className="px-3 py-1.5 text-slate-700 whitespace-nowrap max-w-[180px] truncate" title={String(row[c] ?? '')}>
                    {row[c] == null ? <span className="text-slate-300 italic">null</span> : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function TableDetailPanel({ table, columns, focusColumnId, onSaved }: Props) {
  const [tbl, setTbl]               = useState<SourceTable>(table);
  const [cols, setCols]             = useState<SourceColumn[]>(columns);
  const [savingTable, setSavingTable] = useState(false);
  const [savingCol, setSavingCol]   = useState<number | null>(null);
  const [savedMsg, setSavedMsg]     = useState('');

  // Keep local state in sync when parent switches to a different table
  if (table.id !== tbl.id) { setTbl(table); setCols(columns); }

  const [domainInput, setDomainInput] = useState('');

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag) return;
    const current: string[] = parseDomains(tbl.domains);
    if (!current.includes(tag)) setTbl({ ...tbl, domains: [...current, tag] });
    setDomainInput('');
  }

  function removeDomain(tag: string) {
    setTbl({ ...tbl, domains: parseDomains(tbl.domains).filter((d) => d !== tag) });
  }

  async function saveTable() {
    setSavingTable(true);
    await api.patch(`/semantic/tables/${tbl.id}`, {
      display_name: tbl.display_name,
      description:  tbl.description,
      is_active:    tbl.is_active,
      domains:      parseDomains(tbl.domains),
    });
    setSavingTable(false);
    setSavedMsg('Table saved');
    setTimeout(() => setSavedMsg(''), 2000);
    onSaved();
  }

  async function saveColumn(col: SourceColumn) {
    setSavingCol(col.id);
    await api.patch(`/semantic/columns/${col.id}`, {
      display_name: col.display_name,
      description:  col.description,
      is_dimension: col.is_dimension,
      is_measure:   col.is_measure,
    });
    setSavingCol(null);
    onSaved();
  }

  function updateCol(id: number, patch: Partial<SourceColumn>) {
    setCols((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c));
  }

  const badge = (draft: boolean) => (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${draft ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
      {draft ? 'AI draft' : 'Confirmed'}
    </span>
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">

      {/* Table details */}
      <section className="bg-white rounded-xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-semibold text-slate-900">{tbl.display_name || tbl.table_name}</h2>
            <p className="text-xs text-slate-400 font-mono mt-0.5">{tbl.table_name}</p>
          </div>
          {badge(tbl.ai_draft)}
        </div>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Display name</label>
            <input
              value={tbl.display_name ?? ''}
              onChange={(e) => setTbl({ ...tbl, display_name: e.target.value })}
              className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Active</label>
            <select
              value={tbl.is_active ? 'yes' : 'no'}
              onChange={(e) => setTbl({ ...tbl, is_active: e.target.value === 'yes' })}
              className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="yes">Yes — include in AI context</option>
              <option value="no">No — exclude from AI context</option>
            </select>
          </div>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
          <textarea
            value={tbl.description ?? ''}
            onChange={(e) => setTbl({ ...tbl, description: e.target.value })}
            rows={2}
            className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-500 mb-1">Data domains</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {parseDomains(tbl.domains).map((tag) => (
              <span key={tag} className="inline-flex items-center gap-1 text-xs bg-violet-100 text-violet-700 border border-violet-200 rounded-full px-2.5 py-0.5 font-medium">
                {tag}
                <button onClick={() => removeDomain(tag)} className="hover:text-violet-900 leading-none">&times;</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDomain(domainInput); } }}
              placeholder="Add domain tag (e.g. sales, hr) and press Enter"
              className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={() => addDomain(domainInput)}
              className="px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors"
            >Add</button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={saveTable}
            disabled={savingTable}
            className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {savingTable ? 'Saving…' : 'Confirm table'}
          </button>
          {savedMsg && <span className="text-sm text-green-600">{savedMsg}</span>}
        </div>

        {/* Inline data preview */}
        <div className="mt-4 pt-4 border-t border-slate-100">
          <PreviewTable connectionId={tbl.connection_id} tableName={tbl.table_name} />
        </div>
      </section>

      {/* Columns */}
      <section>
        <h3 className="text-sm font-semibold text-slate-700 mb-3">
          Columns <span className="text-slate-400 font-normal">({cols.length})</span>
        </h3>
        <div className="space-y-3">
          {cols.map((col) => {
            const isFocused  = col.id === focusColumnId;
            const examples   = parseExamples(col.example_values);
            return (
              <div
                key={col.id}
                id={`col-${col.id}`}
                className={`bg-white rounded-xl border p-4 transition-all ${isFocused ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200'}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-sm text-slate-700">{col.column_name}</span>
                    <span className="text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{col.data_type}</span>
                    {col.is_dimension && <span className="text-xs text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">dimension</span>}
                    {col.is_measure   && <span className="text-xs text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">measure</span>}
                  </div>
                  {badge(col.ai_draft)}
                </div>

                {/* Example values chips */}
                {examples.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {examples.map((v, i) => (
                      <span key={i} className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full font-mono">
                        {v}
                      </span>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 mb-1">Display name</label>
                    <input
                      value={col.display_name ?? ''}
                      onChange={(e) => updateCol(col.id, { display_name: e.target.value })}
                      className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-end gap-4 pb-1">
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={col.is_dimension}
                        onChange={(e) => updateCol(col.id, { is_dimension: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-slate-600">Dimension</span>
                    </label>
                    <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={col.is_measure}
                        onChange={(e) => updateCol(col.id, { is_measure: e.target.checked })}
                        className="rounded"
                      />
                      <span className="text-slate-600">Measure</span>
                    </label>
                  </div>
                </div>

                <div className="mb-3">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Description</label>
                  <input
                    value={col.description ?? ''}
                    onChange={(e) => updateCol(col.id, { description: e.target.value })}
                    className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <button
                  onClick={() => saveColumn(col)}
                  disabled={savingCol === col.id}
                  className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {savingCol === col.id ? 'Saving…' : 'Confirm column'}
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
