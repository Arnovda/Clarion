'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { SourceTable, SourceColumn } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';
import HelpTooltip from '@/components/HelpTooltip';
import { parseDomains, parseExamples, classifyType, completenessBucket, PreviewTable } from './shared';

interface Props {
  table: SourceTable;
  columns: SourceColumn[];
  focusColumnId: number | null;
  connectionDomains?: string[];
  onSaved: () => void;
}

const columnCompleteness = (col: SourceColumn) =>
  completenessBucket(
    !!col.description && col.description.trim().length > 0,
    !!(col.is_dimension || col.is_measure),
    !col.ai_draft,
  );

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export default function TableDetailPanel({ table, columns, focusColumnId, connectionDomains = [], onSaved }: Props) {
  const [tbl, setTbl]               = useState<SourceTable>(table);
  const [cols, setCols]             = useState<SourceColumn[]>(columns);
  const [savingTable, setSavingTable] = useState(false);
  const [savingCol, setSavingCol]   = useState<number | null>(null);
  const [savedMsg, setSavedMsg]     = useState('');

  if (table.id !== tbl.id) { setTbl(table); setCols(columns); }

  const [domainInput, setDomainInput] = useState('');
  const [showTableHistory, setShowTableHistory] = useState(false);
  const [showColHistory, setShowColHistory] = useState<number | null>(null);
  const [colView, setColView] = useState<'cards' | 'grid'>('grid');

  // Track unsaved changes for floating bar
  const [hasChanges, setHasChanges] = useState(false);

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag) return;
    const current: string[] = parseDomains(tbl.domains);
    if (!current.includes(tag)) { setTbl({ ...tbl, domains: [...current, tag] }); setHasChanges(true); }
    setDomainInput('');
  }

  function removeDomain(tag: string) {
    setTbl({ ...tbl, domains: parseDomains(tbl.domains).filter((d) => d !== tag) });
    setHasChanges(true);
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
    setHasChanges(false);
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

  function updateTbl(patch: Partial<SourceTable>) {
    setTbl((prev) => ({ ...prev, ...patch }));
    setHasChanges(true);
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg panel-enter">
      <div className="px-6 py-6 space-y-6 pb-24">

        {/* ── Table header ────────────────────────────────────────────────── */}
        <section className="bg-raised border border-line rounded-lg px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Table</p>
              <h2 className="font-display text-[24px] text-ink leading-tight tracking-[-0.02em] truncate">
                {tbl.display_name || tbl.table_name}
              </h2>
              <p className="text-[12px] font-mono text-muted-2 mt-1 truncate">{tbl.table_name}</p>
              <div className="flex items-center gap-2 mt-3">
                <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted bg-softer border border-line px-2 py-0.5 rounded">
                  {cols.length} columns
                </span>
                {tbl.is_active ? (
                  <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ok bg-ok-soft border border-line px-2 py-0.5 rounded">Active</span>
                ) : (
                  <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2 bg-softer border border-line px-2 py-0.5 rounded">Inactive</span>
                )}
              </div>
            </div>
            <ApprovalBadge
              entityType="table"
              entityId={tbl.id}
              status={tbl.approval_status}
              aiDraft={tbl.ai_draft}
              rejectionReason={tbl.rejection_reason}
              onChanged={onSaved}
            />
          </div>
        </section>

        {/* ── Table details — glass card ──────────────────────────────────── */}
        <section className="bg-raised border border-line rounded-lg p-6 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Display name</label>
              <input
                value={tbl.display_name ?? ''}
                onChange={(e) => updateTbl({ display_name: e.target.value })}
                className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                placeholder="Human-readable name"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Active in AI context</label>
              <select
                value={tbl.is_active ? 'yes' : 'no'}
                onChange={(e) => updateTbl({ is_active: e.target.value === 'yes' })}
                className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
              >
                <option value="yes">Yes — include in AI context</option>
                <option value="no">No — exclude from AI context</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Description</label>
            <textarea
              value={tbl.description ?? ''}
              onChange={(e) => updateTbl({ description: e.target.value })}
              rows={2}
              className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors resize-none placeholder:text-muted-2"
              placeholder="What does this table contain?"
            />
          </div>

          <div>
            <label className="flex items-center gap-1.5 text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">
              Data domains
              <HelpTooltip text="Tags that categorize this table by business area (e.g. sales, hr, finance). Helps scope AI queries to relevant tables." />
            </label>
            {/* Inherited from source */}
            {connectionDomains.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {connectionDomains.map((tag) => (
                  <span key={tag} title="Inherited from source" className="inline-flex items-center gap-1 text-[10px] bg-softer text-muted border border-line rounded-md px-2 py-0.5">
                    {tag}
                    <span className="text-[9px] text-muted-2 italic">source</span>
                  </span>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {parseDomains(tbl.domains)
                .filter((tag) => !connectionDomains.includes(tag))
                .map((tag) => (
                  <span key={tag} className="inline-flex items-center gap-1.5 text-[10px] bg-ai-soft text-ai border border-line rounded-md px-2 py-0.5">
                    {tag}
                    <button onClick={() => removeDomain(tag)} className="hover:text-ai/80 leading-none">&times;</button>
                  </span>
                ))}
            </div>
            <div className="flex gap-2">
              <input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDomain(domainInput); } }}
                placeholder="Add domain tag..."
                className="flex-1 bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
              />
              <button
                onClick={() => addDomain(domainInput)}
                className="px-4 py-2 text-sm bg-softer hover:bg-bg text-ink-2 border border-line rounded-md transition-colors"
              >Add</button>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => setShowTableHistory(!showTableHistory)}
              className="px-4 py-2 text-xs text-muted bg-raised border border-line rounded-md hover:bg-softer hover:border-line-strong transition-colors font-medium"
            >
              {showTableHistory ? 'Hide History' : 'History'}
            </button>
            {savedMsg && (
              <span className="text-xs text-ok font-semibold flex items-center gap-1">
                <span className="orb-approved" style={{ width: 6, height: 6 }} /> {savedMsg}
              </span>
            )}
          </div>

          {showTableHistory && (
            <div className="mt-4 pt-4 border-t border-slate-200/30">
              <HistoryPanel entityType="table" entityId={tbl.id} entityName={tbl.display_name || tbl.table_name} />
            </div>
          )}

          {/* Data preview */}
          <div className="pt-4 border-t border-line">
            <PreviewTable url={`/semantic/preview?connectionId=${tbl.connection_id}&table=${encodeURIComponent(tbl.table_name)}&limit=10`} />
          </div>
        </section>

        {/* ── Columns ────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-display font-bold text-ink-2 flex items-center gap-2">
              Columns
              <span className="text-xs font-normal text-muted-2 bg-softer border border-line px-2 py-0.5 rounded-lg">{cols.length}</span>
            </h3>
            <div className="flex items-center bg-raised border border-line rounded-md overflow-hidden">
              <button
                onClick={() => setColView('grid')}
                className={`px-3 py-1.5 text-xs transition-all ${colView === 'grid' ? 'bg-ocean text-white' : 'text-muted-2 hover:text-ink-2'}`}
                title="Compact grid"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M3 6h18M3 18h18" />
                </svg>
              </button>
              <button
                onClick={() => setColView('cards')}
                className={`px-3 py-1.5 text-xs transition-all border-l border-line ${colView === 'cards' ? 'bg-ocean text-white' : 'text-muted-2 hover:text-ink-2'}`}
                title="Expanded cards"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </button>
            </div>
          </div>

          {/* ── Compact grid view with heatmap ────────────────────────────── */}
          {colView === 'grid' && (
            <div className="bg-raised border border-line rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-softer border-b border-line">
                    <th className="text-left px-4 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Column</th>
                    <th className="text-left px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Type</th>
                    <th className="text-left px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Description</th>
                    <th className="text-center px-2 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">
                      <span className="inline-flex items-center gap-0.5">Dim <HelpTooltip text="Dimension columns are used for grouping and filtering (e.g. country, category, date)." /></span>
                    </th>
                    <th className="text-center px-2 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">
                      <span className="inline-flex items-center gap-0.5">Mea <HelpTooltip text="Measure columns contain numeric values that can be aggregated (e.g. revenue, quantity, cost)." /></span>
                    </th>
                    <th className="text-center px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Status</th>
                    <th className="text-right px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {cols.map((col) => {
                    const isFocused = col.id === focusColumnId;
                    const completeness = columnCompleteness(col);
                    const heatClass = completeness === 'complete' ? 'heatmap-complete'
                      : completeness === 'partial' ? 'heatmap-partial' : 'heatmap-incomplete';
                    const typeInfo = classifyType(col.data_type);

                    return (
                      <tr
                        key={col.id}
                        id={`col-${col.id}`}
                        className={`border-b border-slate-100/50 last:border-0 transition-all ${heatClass} ${
                          isFocused ? 'ring-1 ring-inset ring-ocean/30' : 'hover:bg-softer'
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-ink-2 text-[12px]">{col.column_name}</span>
                          {col.display_name && col.display_name !== col.column_name && (
                            <span className="block text-[10px] text-muted-2 truncate max-w-[140px]">{col.display_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-semibold ${typeInfo.cls}`}>
                            <span dangerouslySetInnerHTML={{ __html: typeInfo.icon }} />
                            {col.data_type}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <input
                            value={col.description ?? ''}
                            onChange={(e) => updateCol(col.id, { description: e.target.value })}
                            placeholder="Add description..."
                            className="w-full bg-transparent text-ink-2 placeholder:text-muted-2 focus:outline-none focus:bg-raised focus:ring-1 focus:ring-ocean/50 rounded-md px-2 py-1 -ml-2 text-xs transition-all"
                          />
                        </td>
                        <td className="text-center px-2 py-2.5">
                          <input type="checkbox" checked={col.is_dimension}
                            onChange={(e) => updateCol(col.id, { is_dimension: e.target.checked })}
                            className="rounded w-3.5 h-3.5 accent-ocean border-line" />
                        </td>
                        <td className="text-center px-2 py-2.5">
                          <input type="checkbox" checked={col.is_measure}
                            onChange={(e) => updateCol(col.id, { is_measure: e.target.checked })}
                            className="rounded w-3.5 h-3.5 accent-ocean border-line" />
                        </td>
                        <td className="text-center px-3 py-2.5">
                          <ApprovalBadge
                            entityType="column" entityId={col.id}
                            status={col.approval_status} aiDraft={col.ai_draft}
                            rejectionReason={col.rejection_reason} onChanged={onSaved}
                            compact
                          />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => saveColumn(col)} disabled={savingCol === col.id}
                            className="px-2.5 py-1 bg-ocean text-white text-[10px] rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors font-medium">
                            {savingCol === col.id ? '...' : 'Save'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Expanded card view ────────────────────────────────────────── */}
          {colView === 'cards' && (
            <div className="space-y-3">
              {cols.map((col) => {
                const isFocused  = col.id === focusColumnId;
                const examples   = parseExamples(col.example_values);
                const typeInfo   = classifyType(col.data_type);

                return (
                  <div
                    key={col.id}
                    id={`col-${col.id}`}
                    className={`bg-raised border border-line rounded-lg p-5 transition-all panel-enter ${
                      isFocused ? 'ring-1 ring-ocean/40 border-ocean/40' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="font-mono text-sm text-ink-2 font-semibold">{col.column_name}</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-semibold ${typeInfo.cls}`}>
                          <span dangerouslySetInnerHTML={{ __html: typeInfo.icon }} />
                          {col.data_type}
                        </span>
                        {col.is_dimension && <span className="text-[10px] font-mono tracking-[0.06em] uppercase text-ocean bg-ocean-softer border border-line px-2 py-0.5 rounded">dimension</span>}
                        {col.is_measure   && <span className="text-[10px] font-mono tracking-[0.06em] uppercase text-ok bg-ok-soft border border-line px-2 py-0.5 rounded">measure</span>}
                      </div>
                      <ApprovalBadge
                        entityType="column" entityId={col.id}
                        status={col.approval_status} aiDraft={col.ai_draft}
                        rejectionReason={col.rejection_reason} onChanged={onSaved}
                      />
                    </div>

                    {examples.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {examples.map((v, i) => (
                          <span key={i} className="text-[10px] bg-softer text-muted px-2 py-0.5 rounded font-mono border border-line">
                            {v}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Display name</label>
                        <input
                          value={col.display_name ?? ''}
                          onChange={(e) => updateCol(col.id, { display_name: e.target.value })}
                          className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                        />
                      </div>
                      <div className="flex items-end gap-4 pb-1">
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input type="checkbox" checked={col.is_dimension}
                            onChange={(e) => updateCol(col.id, { is_dimension: e.target.checked })}
                            className="rounded accent-ocean" />
                          <span className="text-ink-2 text-xs">Dimension</span>
                        </label>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input type="checkbox" checked={col.is_measure}
                            onChange={(e) => updateCol(col.id, { is_measure: e.target.checked })}
                            className="rounded accent-ocean" />
                          <span className="text-ink-2 text-xs">Measure</span>
                        </label>
                      </div>
                    </div>

                    <div className="mb-4">
                      <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Description</label>
                      <input
                        value={col.description ?? ''}
                        onChange={(e) => updateCol(col.id, { description: e.target.value })}
                        className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button onClick={() => saveColumn(col)} disabled={savingCol === col.id}
                        className="px-4 py-1.5 bg-ocean text-white text-[12px] rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors font-medium">
                        {savingCol === col.id ? 'Saving...' : 'Confirm column'}
                      </button>
                      <button onClick={() => setShowColHistory(showColHistory === col.id ? null : col.id)}
                        className="px-3 py-1.5 text-xs text-muted-2 bg-raised border border-line rounded-md hover:bg-softer hover:border-line-strong transition-colors">
                        {showColHistory === col.id ? 'Hide' : 'History'}
                      </button>
                    </div>
                    {showColHistory === col.id && (
                      <div className="mt-4 pt-4 border-t border-slate-200/30">
                        <HistoryPanel entityType="column" entityId={col.id} entityName={col.display_name || col.column_name} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* ── Floating action bar ────────────────────────────────────────── */}
      <div className="fixed bottom-0 left-[460px] right-0 z-20 floating-bar px-6 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-2">
              {cols.filter((c) => !c.ai_draft).length}/{cols.length} columns confirmed
            </span>
            {savedMsg && (
              <span className="text-xs text-ok font-semibold flex items-center gap-1.5 animate-fadeIn">
                <span className="orb-approved" style={{ width: 6, height: 6 }} /> {savedMsg}
              </span>
            )}
          </div>
          <button
            onClick={saveTable}
            disabled={savingTable}
            className="px-6 py-2.5 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
          >
            {savingTable ? (
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving...
              </span>
            ) : (
              'Save table'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
