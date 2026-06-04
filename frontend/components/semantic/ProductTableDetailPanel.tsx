'use client';

import { useEffect, useState } from 'react';
import { format as formatSql } from 'sql-formatter';
import { ArrowRight, GitBranch, X } from 'lucide-react';
import api from '@/lib/api';
import { ProductColumn, ProductTable, ProductTreeItem } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';
import QualityPanel from '@/components/QualityPanel';
import { parseDomains, classifyType, completenessBucket, PreviewTable } from './shared';
import { useRole, canCurate } from '@/lib/role';

type ViewTab = 'overview' | 'columns' | 'relationships' | 'quality' | 'history';

interface Props {
  tableId: number;
  productTree: ProductTreeItem[];
  columns: ProductColumn[];
  focusColumnId: number | null;
  onSaved: () => void;
  /** Dismiss the panel. Wired from the parent (e.g. /catalog) so cards
   *  views can close the right inset; left unset when the panel is the
   *  whole pane (Structure mode), where there's nothing to close to. */
  onClose?: () => void;
}

const roleColor = (role: string | null): string => {
  switch (role) {
    case 'fact':       return 'bg-ocean-softer text-ocean';
    case 'dimension':  return 'bg-ai-soft text-ai';
    case 'bridge':     return 'bg-warn-soft text-warn';
    case 'junk':       return 'bg-softer text-muted';
    default:           return 'bg-softer text-muted';
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
    case 'natural_key':          return 'bg-warn-soft text-warn';
    case 'foreign_key':          return 'bg-ocean-softer text-ocean';
    case 'measure':              return 'bg-ok-soft text-ok';
    case 'attribute':            return 'bg-ai-soft text-ai';
    case 'degenerate_dimension': return 'bg-err-soft text-err';
    default:                     return 'bg-softer text-muted';
  }
};

const columnCompleteness = (col: ProductColumn) =>
  completenessBucket(
    !!col.description && col.description.trim().length > 0,
    !!col.column_role,
    !col.ai_draft,
  );

interface RelRow {
  direction: 'OUT' | 'IN';
  fromTable: string;
  fromColumn: string | null;
  toTable: string;
  toColumn: string | null;
  relationship: string;
}

// ---------------------------------------------------------------------------
// Main panel — five-tab layout matching TableDetailPanel
// ---------------------------------------------------------------------------

export default function ProductTableDetailPanel({
  tableId, productTree, columns, focusColumnId, onSaved, onClose,
}: Props) {
  const role = useRole();
  const curator = canCurate(role);
  // Find the table in the product tree
  let table: ProductTable | null = null;
  let pgTableId: number | null = null;
  let productConnectionId: number | null = null;
  let parentProductId: number | null = null;
  let parentSchemaId: number | null = null;
  const usedByProducts: string[] = [];
  for (const product of productTree) {
    for (const schema of product.starSchemas) {
      const found = schema.tables.find((t) => t.id === tableId);
      if (found) {
        table = found;
        pgTableId = (found as { pg_table_id?: number }).pg_table_id ?? tableId;
        productConnectionId = product.connectionId;
        parentProductId = product.productId;
        parentSchemaId = schema.schemaId;
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
  const [viewTab, setViewTab]         = useState<ViewTab>('overview');
  const [domainInput, setDomainInput] = useState('');
  const [showColHistory, setShowColHistory] = useState<number | null>(null);
  const [rels, setRels] = useState<RelRow[]>([]);
  const [relsLoading, setRelsLoading] = useState(false);

  // Relationships are stored per star schema in product_relationships and exposed
  // via GET /api/products/:productId. Fetch lazily when the user opens the tab.
  useEffect(() => {
    if (viewTab !== 'relationships') return;
    if (parentProductId == null || !table) return;
    const tableName = table.table_name;
    let cancelled = false;
    setRelsLoading(true);
    api.get(`/products/${parentProductId}`).then((res) => {
      if (cancelled) return;
      const product = res.data.data ?? res.data;
      const schemas: Array<{
        id: number;
        relationships: Array<{
          from_table_name: string;
          from_column_name: string | null;
          to_table_name: string;
          to_column_name: string | null;
          relationship_type: string;
        }>;
      }> = product?.star_schemas ?? [];
      const all = schemas.flatMap((s) => s.relationships ?? []);
      const out: RelRow[] = [];
      for (const r of all) {
        if (r.from_table_name === tableName) {
          out.push({
            direction: 'OUT',
            fromTable: r.from_table_name,
            fromColumn: r.from_column_name,
            toTable: r.to_table_name,
            toColumn: r.to_column_name,
            relationship: r.relationship_type,
          });
        } else if (r.to_table_name === tableName) {
          out.push({
            direction: 'IN',
            fromTable: r.from_table_name,
            fromColumn: r.from_column_name,
            toTable: r.to_table_name,
            toColumn: r.to_column_name,
            relationship: r.relationship_type,
          });
        }
      }
      setRels(out);
    }).catch(() => { if (!cancelled) setRels([]); })
      .finally(() => { if (!cancelled) setRelsLoading(false); });
    return () => { cancelled = true; };
  }, [viewTab, parentProductId, table?.table_name]);

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

  if (!tbl) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-2 text-sm">
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

  const isAiDraft = !!tbl.ai_draft && tbl.approval_status !== 'approved';

  // History is curator-only — viewers don't need the audit log.
  const tabs: { id: ViewTab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'columns', label: 'Columns', count: cols.length },
    { id: 'relationships', label: 'Relationships' },
    { id: 'quality', label: 'Quality' },
    ...(curator ? [{ id: 'history' as const, label: 'History' }] : []),
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg panel-enter">
      {/* Header */}
      <div className="bg-raised border-b border-line px-6 pt-5 pb-0 flex-shrink-0">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="min-w-0">
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1">Product table</p>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] truncate">
                {tbl.display_name || tbl.table_name}
              </h2>
              {/* Dimensional-modeling jargon (fact / dimension / bridge / junk)
                  is curator vocabulary — viewers don't need it on a header. */}
              {curator && (
                <span className={`text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line ${roleColor(tbl.table_role)}`}>
                  {tbl.table_role}
                </span>
              )}
            </div>
            {/* Mono raw name only for curators. */}
            {curator && (
              <p className="text-[12px] font-mono text-muted-2 mt-1 truncate">{tbl.table_name}</p>
            )}

            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted bg-softer border border-line px-2 py-0.5 rounded">
                {cols.length} columns
              </span>
              {tbl.row_count != null && (
                <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted bg-softer border border-line px-2 py-0.5 rounded">
                  {tbl.row_count.toLocaleString()} rows
                </span>
              )}
              {tbl.transformation_status && (
                <span className={`text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line ${
                  tbl.transformation_status === 'success' ? 'text-ok bg-ok-soft'
                  : tbl.transformation_status === 'error' ? 'text-err bg-err-soft'
                  : 'text-muted-2 bg-softer'
                }`}>
                  {tbl.transformation_status}
                </span>
              )}
              {tbl.last_run_at && (
                <span className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2">
                  Last run: {new Date(tbl.last_run_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>

          {/* Approval badge is governance — curator-only. */}
          <div className="flex items-start gap-2 flex-shrink-0">
            {curator && (
              <ApprovalBadge
                entityType="product_table"
                entityId={tbl.id}
                status={tbl.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
                aiDraft={!!tbl.ai_draft}
                onChanged={onSaved}
              />
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4" strokeWidth={1.75} />
              </button>
            )}
          </div>
        </div>

        {/* Tab strip */}
        <div className="flex items-center gap-0 -mb-px">
          {tabs.map((t) => {
            const active = viewTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setViewTab(t.id)}
                className={`px-4 py-2.5 text-[13px] transition-colors whitespace-nowrap relative ${
                  active ? 'text-ink font-medium' : 'text-muted hover:text-ink-2'
                }`}
              >
                {t.label}
                {typeof t.count === 'number' && (
                  <span className="ml-1.5 text-[11px] font-mono text-muted-2 tabular-nums">({t.count})</span>
                )}
                {active && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Overview ──────────────────────────────────────────────────────── */}
      {viewTab === 'overview' && (
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
          {/* AI suggested banner — saving clears ai_draft via the update endpoint.
              Curator-only — viewers don't get the inline edit form. */}
          {curator && isAiDraft && (
            <section className="bg-ocean-softer border border-ocean/30 rounded-lg p-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="min-w-0">
                  <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-ocean mb-1">AI suggested</p>
                  <p className="text-[13px] text-ink leading-relaxed">
                    Review the description below. Saving will mark this table as confirmed.
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Edit form */}
          <section className="bg-raised border border-line rounded-lg p-6 space-y-5">
            <div className="grid grid-cols-2 gap-5">
              <div>
                <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Display name</label>
                <input
                  value={tbl.display_name ?? ''}
                  onChange={(e) => setTbl({ ...tbl, display_name: e.target.value })}
                  className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                  placeholder="Human-readable name"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Owner</label>
                <input
                  value={tbl.owner_name ?? ''}
                  onChange={(e) => setTbl({ ...tbl, owner_name: e.target.value })}
                  className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                  placeholder="Table owner"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Description</label>
              <textarea
                value={tbl.description ?? ''}
                onChange={(e) => setTbl({ ...tbl, description: e.target.value })}
                rows={3}
                className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors resize-none"
                placeholder="What does this table contain?"
              />
            </div>

            {/* Domain tags */}
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Data domains</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {domains.map((tag) => (
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
                onClick={saveTable}
                disabled={savingTable}
                className="px-5 py-2 bg-ocean text-white text-[13px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
              >
                {savingTable ? 'Saving...' : 'Save table'}
              </button>
              {savedMsg && (
                <span className="text-xs text-ok font-semibold flex items-center gap-1">
                  <span className="orb-approved" style={{ width: 6, height: 6 }} /> {savedMsg}
                </span>
              )}
            </div>
          </section>

          {/* Used in: products that share this dim */}
          {usedByProducts.length > 0 && (
            <section className="bg-raised border border-line rounded-lg p-6">
              <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-3">Used in — data products</p>
              <div className="flex flex-wrap gap-2">
                {usedByProducts.map((pName) => (
                  <span key={pName} className="inline-flex items-center gap-1.5 text-[12px] text-ink-2 bg-softer border border-line rounded-md px-3 py-1.5">
                    {pName}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Data preview + SQL view. SqlViewer is curator-only — the
              transformation SQL is engineering content. Viewers see the
              data preview only, which is what's useful for understanding
              what the table actually contains. */}
          <section className="bg-raised border border-line rounded-lg p-6 space-y-3">
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Data preview</p>
            <PreviewTable url={`/semantic/product-preview?productTableId=${pgTableId ?? tableId}&limit=10`} />
            {curator && <SqlViewer pgTableId={pgTableId ?? tableId} />}
          </section>
        </div>
      )}

      {/* ── Columns ───────────────────────────────────────────────────────── */}
      {viewTab === 'columns' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-[12px] text-muted-2">
              {cols.filter((c) => !c.ai_draft).length}/{cols.length} columns confirmed
            </p>
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

          {colView === 'grid' && (
            <div className="bg-raised border border-line rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-softer border-b border-line">
                    <th className="text-left px-4 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Column</th>
                    <th className="text-left px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Type</th>
                    <th className="text-left px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Role</th>
                    <th className="text-left px-3 py-3 font-mono font-medium tracking-[0.1em] uppercase text-muted text-[10px]">Description</th>
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
                            className="w-full bg-transparent text-ink-2 placeholder:text-muted-2 focus:outline-none focus:bg-raised focus:ring-1 focus:ring-ocean/50 rounded-md px-2 py-1 -ml-2 text-xs transition-all"
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

          {colView === 'cards' && (
            <div className="space-y-3">
              {cols.map((col) => {
                const isFocused = col.id === focusColumnId;
                const typeInfo  = classifyType(col.data_type);

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

                    {(col.fk_target_table || col.transformation_expression || col.additivity) && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {col.fk_target_table && (
                          <span className="text-[10px] bg-ocean-softer text-ocean border border-line px-2 py-0.5 rounded font-mono">
                            FK &rarr; {col.fk_target_table}.{col.fk_target_column}
                          </span>
                        )}
                        {col.additivity && (
                          <span className="text-[10px] bg-softer text-muted border border-line px-2 py-0.5 rounded">
                            {col.additivity}
                          </span>
                        )}
                        {col.scd_type > 1 && (
                          <span className="text-[10px] bg-softer text-muted border border-line px-2 py-0.5 rounded">
                            History Type {col.scd_type}
                          </span>
                        )}
                        {col.transformation_expression && (
                          <span className="text-[10px] bg-softer text-muted border border-line px-2 py-0.5 rounded font-mono truncate max-w-[300px]" title={col.transformation_expression}>
                            {col.transformation_expression}
                          </span>
                        )}
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
                      <div className="flex items-end gap-3 pb-1">
                        {col.column_role && (
                          <span className={`text-xs px-3 py-1.5 rounded-lg font-semibold ${colRoleBadge(col.column_role)}`}>
                            {colRoleLabel(col.column_role)}
                          </span>
                        )}
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
                        <HistoryPanel entityType="product_column" entityId={col.id} entityName={col.display_name || col.column_name} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Relationships ─────────────────────────────────────────────────── */}
      {viewTab === 'relationships' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {relsLoading ? (
            <p className="text-[13px] text-muted">Loading relationships...</p>
          ) : rels.length === 0 ? (
            <div className="bg-raised border border-line rounded-lg p-6 text-center">
              <GitBranch className="w-8 h-8 text-muted-2 mx-auto mb-3" strokeWidth={1.5} />
              <p className="font-display text-[16px] text-ink tracking-[-0.01em]">No relationships</p>
              <p className="text-[12px] text-muted mt-1.5 max-w-md mx-auto leading-relaxed">
                No relationships are defined for this product table in the star schema.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {rels.map((r, i) => (
                <div key={i} className="bg-raised border border-line rounded-lg px-4 py-3 flex items-center gap-3">
                  <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 bg-softer border border-line px-1.5 py-0.5 rounded">
                    {r.direction}
                  </span>
                  <div className="flex-1 min-w-0 flex items-center gap-2 text-[13px] font-mono">
                    <span className="text-ink-2 truncate">{r.fromTable}{r.fromColumn ? `.${r.fromColumn}` : ''}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-2 flex-shrink-0" strokeWidth={2} />
                    <span className="text-ink-2 truncate">{r.toTable}{r.toColumn ? `.${r.toColumn}` : ''}</span>
                  </div>
                  <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ocean bg-ocean-softer border border-line px-1.5 py-0.5 rounded">
                    {r.relationship}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Quality ───────────────────────────────────────────────────────── */}
      {viewTab === 'quality' && (
        productConnectionId != null ? (
          <QualityPanel connId={productConnectionId} tableName={tbl.table_name} productTableId={tableId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-2 text-sm p-6 text-center max-w-md mx-auto">
            Quality requires a connection. This product is not yet linked to a source.
          </div>
        )
      )}

      {/* ── History ───────────────────────────────────────────────────────── */}
      {viewTab === 'history' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <HistoryPanel entityType="product_table" entityId={tbl.id} entityName={tbl.display_name || tbl.table_name} />
        </div>
      )}
    </div>
  );
}

// ─── SQL syntax highlighting (lightweight, regex-based) ────────────────────
const SQL_KEYWORDS = new Set([
  'SELECT','FROM','WHERE','GROUP','BY','ORDER','HAVING','LIMIT','OFFSET',
  'JOIN','LEFT','RIGHT','INNER','OUTER','FULL','CROSS','ON','USING',
  'AS','AND','OR','NOT','IN','EXISTS','BETWEEN','LIKE','ILIKE','IS','NULL',
  'CASE','WHEN','THEN','ELSE','END','UNION','ALL','DISTINCT','WITH','RECURSIVE',
  'INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','VIEW','OR','REPLACE',
  'COPY','TO','FORMAT','PARQUET','CAST','TRY_CAST','OVER','PARTITION','ROW_NUMBER',
  'COALESCE','IFNULL','NULLIF','GREATEST','LEAST','ASC','DESC',
]);
const SQL_FUNCS = new Set([
  'COUNT','SUM','AVG','MIN','MAX','ROUND','ABS','CEIL','FLOOR',
  'UPPER','LOWER','TRIM','LENGTH','SUBSTRING','SUBSTR','REPLACE','CONCAT',
  'DATE','DATE_TRUNC','DATE_PART','EXTRACT','NOW','CURRENT_DATE','CURRENT_TIMESTAMP',
  'STRFTIME','STRPTIME','MD5','HASH','LIST','STRUCT','JSON',
]);

function HighlightedSql({ sql }: { sql: string }) {
  const re = /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\b\d+(?:\.\d+)?\b|\b\w+\b)/g;
  const parts = sql.split(re);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith('--') || p.startsWith('/*')) {
          return <span key={i} className="text-white/40 italic">{p}</span>;
        }
        if (p.startsWith("'") || p.startsWith('"')) {
          return <span key={i} className="text-emerald-300">{p}</span>;
        }
        if (/^\d/.test(p)) {
          return <span key={i} className="text-amber-300">{p}</span>;
        }
        const upper = p.toUpperCase();
        if (SQL_KEYWORDS.has(upper)) {
          return <span key={i} className="text-sky-300 font-semibold">{p}</span>;
        }
        if (SQL_FUNCS.has(upper)) {
          return <span key={i} className="text-violet-300">{p}</span>;
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

// ─── SqlViewer — lazy-loaded "Show SQL" toggle ──────────────────────────────
function SqlViewer({ pgTableId }: { pgTableId: number }) {
  const [state, setState] = useState<'idle' | 'loading' | 'open' | 'error'>('idle');
  const [sql, setSql] = useState<string | null>(null);
  const [errMsg, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  async function load() {
    setState('loading');
    try {
      const res = await api.get(`/semantic/product-tables/${pgTableId}/sql`);
      const raw = res.data.data.transformation_sql ?? null;
      let pretty = raw;
      if (raw) {
        try {
          pretty = formatSql(raw, { language: 'duckdb', keywordCase: 'upper', tabWidth: 2 });
        } catch {
          pretty = raw;
        }
      }
      setSql(pretty);
      setState('open');
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load SQL';
      setErr(msg);
      setState('error');
    }
  }

  async function copy() {
    if (!sql) return;
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={load}
        className="inline-flex items-center gap-2 text-[12px] text-ocean hover:text-ocean-hover font-medium group transition-colors"
      >
        <span className="w-5 h-5 rounded-md bg-ocean-softer group-hover:bg-ocean-soft flex items-center justify-center transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
        </span>
        View SQL
      </button>
    );
  }

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-2">
        <span className="w-3 h-3 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
        Loading SQL…
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center gap-2 text-[12px] text-err">
        {errMsg}
        <button onClick={() => setState('idle')} className="text-muted-2 hover:text-ink-2 underline">retry</button>
      </div>
    );
  }

  return (
    <div className="panel-enter">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted">Transformation SQL</span>
        <div className="flex items-center gap-3">
          {sql && (
            <button onClick={copy} className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 hover:text-ink-2 transition-colors">
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          <button onClick={() => setState('idle')} className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 hover:text-ink-2 transition-colors">
            Hide
          </button>
        </div>
      </div>
      {sql ? (
        <pre className="preview-terminal rounded-md overflow-auto max-h-96 px-4 py-3 text-[12px] font-mono leading-[1.55] whitespace-pre text-white/85">
          <HighlightedSql sql={sql} />
        </pre>
      ) : (
        <p className="text-[12px] text-muted-2 italic">No transformation SQL is stored for this table.</p>
      )}
    </div>
  );
}
