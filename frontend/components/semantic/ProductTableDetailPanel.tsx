'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { ProductColumn, ProductTable, ProductTreeItem } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';

interface Props {
  tableId: number;
  productTree: ProductTreeItem[];
  columns: ProductColumn[];
  focusColumnId: number | null;
  onSaved: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDomains(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try { return JSON.parse(raw) ?? []; } catch { return []; }
}

const roleColor = (role: string | null): string => {
  switch (role) {
    case 'fact':       return 'bg-cyan-500/15 text-cyan-300';
    case 'dimension':  return 'bg-purple-500/15 text-purple-300';
    case 'bridge':     return 'bg-amber-500/15 text-amber-300';
    case 'junk':       return 'bg-white/10 text-white/40';
    default:           return 'bg-white/10 text-white/40';
  }
};

const colRoleLabel = (role: string | null): string => {
  switch (role) {
    case 'surrogate_key':        return 'Surrogate Key';
    case 'natural_key':          return 'Natural Key';
    case 'foreign_key':          return 'Foreign Key';
    case 'measure':              return 'Measure';
    case 'attribute':            return 'Attribute';
    case 'degenerate_dimension': return 'Degenerate Dim';
    default:                     return role ?? '';
  }
};

const colRoleBadge = (role: string | null): string => {
  switch (role) {
    case 'surrogate_key':
    case 'natural_key':          return 'bg-amber-100 text-amber-700';
    case 'foreign_key':          return 'bg-blue-100 text-blue-700';
    case 'measure':              return 'bg-green-100 text-green-700';
    case 'attribute':            return 'bg-purple-100 text-purple-700';
    case 'degenerate_dimension': return 'bg-pink-100 text-pink-700';
    default:                     return 'bg-slate-100 text-slate-500';
  }
};

/** Classify a SQL data type into a visual category */
function classifyType(dt: string): { cls: string; icon: string } {
  const t = (dt ?? '').toLowerCase();
  if (/^(varchar|char|text|string|nvarchar|nchar|clob)/.test(t))  return { cls: 'dtype-text',    icon: 'Aa' };
  if (/^(int|big|small|tiny|float|double|decimal|numeric|real|money|serial)/.test(t)) return { cls: 'dtype-numeric', icon: '#' };
  if (/^(date|time|timestamp|datetime|interval)/.test(t))         return { cls: 'dtype-date',    icon: '&#128197;' };
  if (/^(bool|boolean|bit)/.test(t))                               return { cls: 'dtype-bool',    icon: '&#10003;' };
  if (/^(json|jsonb|xml|array)/.test(t))                           return { cls: 'dtype-json',    icon: '{ }' };
  return { cls: 'dtype-other', icon: '?' };
}

/** Column completeness score (0-3) */
function columnCompleteness(col: ProductColumn): 'complete' | 'partial' | 'incomplete' {
  let score = 0;
  if (col.description && col.description.trim().length > 0) score++;
  if (col.column_role) score++;
  if (!col.ai_draft) score++;
  return score >= 3 ? 'complete' : score >= 1 ? 'partial' : 'incomplete';
}

// ---------------------------------------------------------------------------
// PreviewTable — dark terminal-style data preview
// ---------------------------------------------------------------------------

function PreviewTable({ productTableId }: { productTableId: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [rows, setRows]   = useState<Record<string, unknown>[]>([]);
  const [cols, setCols]   = useState<string[]>([]);
  const [errMsg, setErrMsg] = useState('');

  async function load() {
    setState('loading');
    try {
      const res = await api.get(`/semantic/product-preview?productTableId=${productTableId}&limit=10`);
      setRows(res.data.data.rows);
      setCols(res.data.data.columns);
      setState('done');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load preview';
      setErrMsg(msg);
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={load}
        className="inline-flex items-center gap-2 text-xs text-cyan-600 hover:text-cyan-500 font-semibold group transition-colors"
      >
        <span className="w-5 h-5 rounded-md bg-cyan-500/10 group-hover:bg-cyan-500/20 flex items-center justify-center transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        </span>
        Preview data
      </button>
    );
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        Loading preview...
      </div>
    );
  }

  if (state === 'error') {
    return <p className="text-xs text-red-400">{errMsg}</p>;
  }

  return (
    <div className="mt-3 panel-enter">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">First {rows.length} rows</span>
        <button onClick={() => setState('idle')} className="text-[10px] text-slate-400 hover:text-slate-600 transition-colors">Hide</button>
      </div>
      <div className="preview-terminal rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} className="px-3 py-2.5 text-left font-semibold whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-white/[0.04]">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-2 whitespace-nowrap max-w-[200px] truncate" title={String(row[c] ?? '')}>
                      {row[c] == null ? <span className="text-white/20 italic">null</span> : String(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel — matches TableDetailPanel visual design
// ---------------------------------------------------------------------------

export default function ProductTableDetailPanel({
  tableId, productTree, columns, focusColumnId, onSaved,
}: Props) {
  // Find the table in the product tree
  let table: ProductTable | null = null;
  let productName = '';
  let schemaName = '';
  let pgTableId: number | null = null;
  const usedByProducts: string[] = [];
  for (const product of productTree) {
    for (const schema of product.starSchemas) {
      const found = schema.tables.find((t) => t.id === tableId);
      if (found) {
        table = found;
        productName = product.productName;
        schemaName = schema.schemaName;
        pgTableId = found.pg_table_id ?? tableId;
        break;
      }
    }
    if (table) break;
  }
  if (table) {
    for (const product of productTree) {
      for (const schema of product.starSchemas) {
        if (schema.tables.some((t) => t.table_name === table!.table_name)) {
          if (!usedByProducts.includes(product.productName)) {
            usedByProducts.push(product.productName);
          }
        }
      }
    }
    usedByProducts.sort();
  }

  // Table state
  const [tbl, setTbl]                 = useState(table);
  const [cols, setCols]               = useState<ProductColumn[]>(columns);
  const [prevTableId, setPrevTableId] = useState(tableId);
  const [prevColLen, setPrevColLen]    = useState(columns.length);
  const [savingTable, setSavingTable] = useState(false);
  const [savingCol, setSavingCol]     = useState<number | null>(null);
  const [savedMsg, setSavedMsg]       = useState('');
  const [colView, setColView]         = useState<'cards' | 'grid'>('grid');

  // Keep local state in sync when parent switches table or columns arrive
  if (tableId !== prevTableId) {
    setPrevTableId(tableId);
    setPrevColLen(columns.length);
    setTbl(table);
    setCols(columns);
  } else if (columns.length !== prevColLen) {
    setPrevColLen(columns.length);
    setCols(columns);
  }

  // Domain management
  const [domainInput, setDomainInput] = useState('');
  const [showTableHistory, setShowTableHistory] = useState(false);
  const [showColHistory, setShowColHistory] = useState<number | null>(null);

  if (!tbl) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
        Table not found
      </div>
    );
  }

  const domains = parseDomains(tbl.domains);

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag || !tbl) return;
    if (!domains.includes(tag)) setTbl({ ...tbl, domains: [...domains, tag] });
    setDomainInput('');
  }

  function removeDomain(tag: string) {
    if (!tbl) return;
    setTbl({ ...tbl, domains: domains.filter((d) => d !== tag) });
  }

  async function saveTable() {
    if (!tbl) return;
    setSavingTable(true);
    try {
      await api.patch(`/semantic/product-tables/${tbl.id}`, {
        display_name: tbl.display_name,
        description:  tbl.description,
        owner_name:   tbl.owner_name,
        domains:      parseDomains(tbl.domains),
      });
      setSavedMsg('Table saved');
      setTimeout(() => setSavedMsg(''), 2000);
      onSaved();
    } catch {
      setSavedMsg('Failed to save');
    }
    setSavingTable(false);
  }

  async function saveColumn(col: ProductColumn) {
    setSavingCol(col.id);
    try {
      await api.patch(`/semantic/product-columns/${col.id}`, {
        display_name: col.display_name,
        description:  col.description,
      });
      onSaved();
    } catch {
      alert('Failed to save column');
    }
    setSavingCol(null);
  }

  function updateCol(id: number, patch: Partial<ProductColumn>) {
    setCols((prev) => prev.map((c) => c.id === id ? { ...c, ...patch } : c));
  }

  return (
    <div className="flex-1 overflow-y-auto bg-gradient-to-br from-surface via-surface to-surface-container-low/30 panel-enter">
      <div className="px-6 py-6 space-y-6 pb-24">

        {/* ── Gradient mesh header ────────────────────────────────────────── */}
        <section className="gradient-mesh rounded-2xl p-6 relative overflow-hidden">
          {/* Decorative circles */}
          <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full bg-white/[0.04]" />
          <div className="absolute -bottom-4 -left-4 w-20 h-20 rounded-full bg-white/[0.03]" />

          <div className="relative flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-headline font-bold text-white tracking-tight">
                  {tbl.display_name || tbl.table_name}
                </h2>
                <span className={`text-[10px] px-2.5 py-1 rounded-lg font-semibold ${roleColor(tbl.table_role)}`}>
                  {tbl.table_role}
                </span>
              </div>
              <p className="text-sm font-mono text-white/40 mt-1">{tbl.table_name}</p>

              <div className="flex items-center gap-3 mt-3 flex-wrap">
                <span className="text-[10px] font-semibold text-white/50 bg-white/10 px-2.5 py-1 rounded-lg">
                  {cols.length} columns
                </span>
                {tbl.row_count != null && (
                  <span className="text-[10px] font-semibold text-white/50 bg-white/10 px-2.5 py-1 rounded-lg">
                    {tbl.row_count.toLocaleString()} rows
                  </span>
                )}
                {tbl.transformation_status && (
                  <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-lg ${
                    tbl.transformation_status === 'success' ? 'text-emerald-300 bg-emerald-500/15'
                    : tbl.transformation_status === 'error' ? 'text-red-300 bg-red-500/15'
                    : 'text-white/30 bg-white/5'
                  }`}>
                    {tbl.transformation_status}
                  </span>
                )}
                {tbl.last_run_at && (
                  <span className="text-[10px] text-white/30">
                    Last run: {new Date(tbl.last_run_at).toLocaleDateString()}
                  </span>
                )}
              </div>

              {/* Used-by badges for shared dimensions */}
              {usedByProducts.length > 0 && (
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  <span className="text-[10px] text-white/30">Used in:</span>
                  {usedByProducts.map((pName) => (
                    <span key={pName} className="text-[10px] bg-white/10 text-white/60 border border-white/10 px-2.5 py-0.5 rounded-lg font-medium">
                      {pName}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <ApprovalBadge
              entityType="product_table"
              entityId={tbl.id}
              status={tbl.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
              aiDraft={!!tbl.ai_draft}
              onChanged={onSaved}
            />
          </div>
        </section>

        {/* ── Table details — glass card ──────────────────────────────────── */}
        <section className="glass-card rounded-2xl p-6 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Display name</label>
              <input
                value={tbl.display_name ?? ''}
                onChange={(e) => setTbl({ ...tbl, display_name: e.target.value })}
                className="w-full bg-white/60 border border-white/80 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 focus:border-cyan-300 transition-all placeholder:text-slate-300"
                placeholder="Human-readable name"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Owner</label>
              <input
                value={tbl.owner_name ?? ''}
                onChange={(e) => setTbl({ ...tbl, owner_name: e.target.value })}
                className="w-full bg-white/60 border border-white/80 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 focus:border-cyan-300 transition-all placeholder:text-slate-300"
                placeholder="Table owner"
              />
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Description</label>
            <textarea
              value={tbl.description ?? ''}
              onChange={(e) => setTbl({ ...tbl, description: e.target.value })}
              rows={2}
              className="w-full bg-white/60 border border-white/80 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 transition-all resize-none placeholder:text-slate-300"
              placeholder="What does this table contain?"
            />
          </div>

          {/* Domain tags */}
          <div>
            <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Data domains</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {domains.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1.5 text-[10px] bg-gradient-to-r from-violet-100 to-purple-50 text-violet-700 border border-violet-200/50 rounded-lg px-2.5 py-1 font-semibold shadow-sm">
                  {tag}
                  <button onClick={() => removeDomain(tag)} className="hover:text-violet-900 leading-none text-violet-400">&times;</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDomain(domainInput); } }}
                placeholder="Add domain tag..."
                className="flex-1 bg-white/60 border border-white/80 rounded-xl px-4 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-400/30 transition-all placeholder:text-slate-300"
              />
              <button
                onClick={() => addDomain(domainInput)}
                className="px-4 py-2 text-sm bg-slate-100/80 hover:bg-slate-200/80 text-slate-600 rounded-xl transition-colors font-medium"
              >Add</button>
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => setShowTableHistory(!showTableHistory)}
              className="px-4 py-2 text-xs text-slate-500 bg-white/60 border border-white/60 rounded-xl hover:bg-white/80 transition-all font-medium"
            >
              {showTableHistory ? 'Hide History' : 'History'}
            </button>
            {savedMsg && (
              <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
                <span className="orb-approved" style={{ width: 6, height: 6 }} /> {savedMsg}
              </span>
            )}
          </div>

          {showTableHistory && (
            <div className="mt-4 pt-4 border-t border-slate-200/30">
              <HistoryPanel entityType="product_table" entityId={tbl.id} entityName={tbl.display_name || tbl.table_name} />
            </div>
          )}

          {/* Data preview */}
          <div className="pt-4 border-t border-slate-200/30">
            <PreviewTable productTableId={pgTableId ?? tableId} />
          </div>
        </section>

        {/* ── Columns ────────────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-headline font-bold text-slate-800 flex items-center gap-2">
              Columns
              <span className="text-xs font-normal text-slate-400 bg-slate-100/80 px-2 py-0.5 rounded-lg">{cols.length}</span>
            </h3>
            <div className="flex items-center bg-white/60 border border-white/80 rounded-xl overflow-hidden shadow-sm">
              <button
                onClick={() => setColView('grid')}
                className={`px-3 py-1.5 text-xs transition-all ${colView === 'grid' ? 'bg-primary text-white shadow-glow-primary' : 'text-slate-400 hover:text-slate-600'}`}
                title="Compact grid"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 14h18M3 6h18M3 18h18" />
                </svg>
              </button>
              <button
                onClick={() => setColView('cards')}
                className={`px-3 py-1.5 text-xs transition-all border-l border-white/60 ${colView === 'cards' ? 'bg-primary text-white shadow-glow-primary' : 'text-slate-400 hover:text-slate-600'}`}
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
            <div className="glass-card rounded-2xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50/80 border-b border-slate-200/40">
                    <th className="text-left px-4 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Column</th>
                    <th className="text-left px-3 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Type</th>
                    <th className="text-left px-3 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Role</th>
                    <th className="text-left px-3 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Description</th>
                    <th className="text-center px-3 py-3 font-semibold text-slate-500 uppercase tracking-wider text-[10px]">Status</th>
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
                          isFocused ? 'ring-2 ring-inset ring-cyan-400/30' : 'hover:bg-white/40'
                        }`}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-mono text-slate-700 text-[12px]">{col.column_name}</span>
                          {col.display_name && col.display_name !== col.column_name && (
                            <span className="block text-[10px] text-slate-400 truncate max-w-[140px]">{col.display_name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-semibold ${typeInfo.cls}`}>
                            <span dangerouslySetInnerHTML={{ __html: typeInfo.icon }} />
                            {col.data_type}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          {col.column_role && (
                            <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${colRoleBadge(col.column_role)}`}>
                              {colRoleLabel(col.column_role)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <input
                            value={col.description ?? ''}
                            onChange={(e) => updateCol(col.id, { description: e.target.value })}
                            placeholder="Add description..."
                            className="w-full bg-transparent text-slate-600 placeholder:text-slate-300 focus:outline-none focus:bg-white focus:ring-1 focus:ring-cyan-400/50 rounded-md px-2 py-1 -ml-2 text-xs transition-all"
                          />
                        </td>
                        <td className="text-center px-3 py-2.5">
                          <ApprovalBadge
                            entityType="product_column" entityId={col.id}
                            status={col.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
                            aiDraft={!!col.ai_draft}
                            onChanged={onSaved}
                            compact
                          />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button onClick={() => saveColumn(col)} disabled={savingCol === col.id}
                            className="px-2.5 py-1 bg-primary/90 text-white text-[10px] rounded-lg hover:bg-primary disabled:opacity-50 transition-all font-semibold shadow-sm hover:shadow-glow-primary">
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
                const isFocused = col.id === focusColumnId;
                const typeInfo  = classifyType(col.data_type);

                return (
                  <div
                    key={col.id}
                    id={`col-${col.id}`}
                    className={`glass-card rounded-2xl p-5 transition-all panel-enter ${
                      isFocused ? 'ring-2 ring-cyan-400/40 shadow-glow-teal' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="font-mono text-sm text-slate-800 font-semibold">{col.column_name}</span>
                        <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-md font-semibold ${typeInfo.cls}`}>
                          <span dangerouslySetInnerHTML={{ __html: typeInfo.icon }} />
                          {col.data_type}
                        </span>
                        {col.column_role && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-md font-semibold ${colRoleBadge(col.column_role)}`}>
                            {colRoleLabel(col.column_role)}
                          </span>
                        )}
                      </div>
                      <ApprovalBadge
                        entityType="product_column" entityId={col.id}
                        status={col.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
                        aiDraft={!!col.ai_draft}
                        onChanged={onSaved}
                      />
                    </div>

                    {/* FK / transformation metadata */}
                    {(col.fk_target_table || col.transformation_expression || col.additivity) && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {col.fk_target_table && (
                          <span className="text-[10px] bg-blue-50/80 text-blue-600 px-2.5 py-0.5 rounded-md font-mono border border-blue-200/40">
                            FK &rarr; {col.fk_target_table}.{col.fk_target_column}
                          </span>
                        )}
                        {col.additivity && (
                          <span className="text-[10px] bg-slate-100/60 text-slate-500 px-2.5 py-0.5 rounded-md border border-slate-200/40">
                            {col.additivity}
                          </span>
                        )}
                        {col.scd_type > 1 && (
                          <span className="text-[10px] bg-slate-100/60 text-slate-500 px-2.5 py-0.5 rounded-md border border-slate-200/40">
                            SCD Type {col.scd_type}
                          </span>
                        )}
                        {col.transformation_expression && (
                          <span className="text-[10px] bg-slate-100/60 text-slate-500 px-2.5 py-0.5 rounded-md font-mono truncate max-w-[300px] border border-slate-200/40" title={col.transformation_expression}>
                            {col.transformation_expression}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Display name</label>
                        <input
                          value={col.display_name ?? ''}
                          onChange={(e) => updateCol(col.id, { display_name: e.target.value })}
                          className="w-full bg-white/60 border border-white/80 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/30 transition-all"
                        />
                      </div>
                      <div className="flex items-end gap-3 pb-1">
                        {col.column_role && (
                          <span className={`text-xs px-3 py-1.5 rounded-lg font-semibold ${colRoleBadge(col.column_role)}`}>
                            {colRoleLabel(col.column_role)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mb-4">
                      <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Description</label>
                      <input
                        value={col.description ?? ''}
                        onChange={(e) => updateCol(col.id, { description: e.target.value })}
                        className="w-full bg-white/60 border border-white/80 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/30 transition-all"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <button onClick={() => saveColumn(col)} disabled={savingCol === col.id}
                        className="px-4 py-1.5 bg-primary text-white text-xs rounded-xl hover:bg-primary-container disabled:opacity-50 transition-all font-semibold shadow-sm hover:shadow-glow-primary">
                        {savingCol === col.id ? 'Saving...' : 'Confirm column'}
                      </button>
                      <button onClick={() => setShowColHistory(showColHistory === col.id ? null : col.id)}
                        className="px-3 py-1.5 text-xs text-slate-400 bg-white/60 border border-white/60 rounded-xl hover:bg-white/80 transition-all">
                        {showColHistory === col.id ? 'Hide' : 'History'}
                      </button>
                    </div>

                    {showColHistory === col.id && (
                      <div className="mt-4 pt-4 border-t border-slate-200/30">
                        <HistoryPanel entityType="product_column" entityId={col.id} entityName={col.display_name || col.column_name} />
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
            <span className="text-xs text-slate-400">
              {cols.filter((c) => !c.ai_draft).length}/{cols.length} columns confirmed
            </span>
            {savedMsg && (
              <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1.5 animate-fadeIn">
                <span className="orb-approved" style={{ width: 6, height: 6 }} /> {savedMsg}
              </span>
            )}
          </div>
          <button
            onClick={saveTable}
            disabled={savingTable}
            className="px-6 py-2.5 gradient-primary text-white text-sm font-semibold rounded-xl hover:opacity-90 disabled:opacity-50 transition-all shadow-glow-primary hover:shadow-glow-teal-md"
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
