'use client';

/**
 * <TableDetailPanel> — a SOURCE table's page in the catalog.
 *
 * The same explorer layout as a product table (breadcrumb › name · actions ·
 * tabs; Overview = description + ONE columns table + the "About" rail),
 * with what a source table is about: the source it came from (its mark),
 * whether it is in the AI's context, which subjects are built from it,
 * what it feeds, and the columns' roles — a dimension you group by, a
 * measure you add up — set in the row. Confirm / Flag on a suggestion
 * stays where it was, at the top. Relations (who laid each link, whether
 * it holds) sits beside Lineage; the canvas stays the place to draw one.
 */
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ArrowRight, Check, ChevronDown, ChevronRight, Flag, MessageSquareText, Sparkles } from 'lucide-react';
import { ClarionMark } from '@/components/brand/ClarionMark';
import api from '@/lib/api';
import { SourceTable, SourceColumn } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';
import HelpTooltip from '@/components/HelpTooltip';
import QualityPanel from '@/components/QualityPanel';
import { parseDomains, parseExamples, PreviewTable } from './shared';
import { useRole, canCurate, isAdminRole } from '@/lib/role';
import { cn } from '@/lib/cn';
import AiPromptDialog from './AiPromptDialog';
import ConnectorMarkIcon from '@/components/ConnectorMarkIcon';
import ExplorerHeader, { HeaderAction, type Crumb } from '@/components/catalog/ExplorerHeader';
import AboutRail, { RailChip, type AboutSection } from '@/components/catalog/AboutRail';
import ColumnsTable, { type ColumnRow } from '@/components/catalog/ColumnsTable';
import LineageSummary from '@/components/catalog/LineageSummary';
import SourceTableRelations from '@/components/catalog/SourceTableRelations';
import type { AssistantOpenMode, CatalogConnection, CatalogNavTarget } from '@/components/catalog/navigation';

const LineageGraph = dynamic(() => import('@/components/catalog/LineageGraph'), { ssr: false });

type ViewTab = 'overview' | 'sample' | 'relations' | 'lineage' | 'quality' | 'history';

interface Props {
  table: SourceTable;
  columns: SourceColumn[];
  focusColumnId: number | null;
  connectionDomains?: string[];
  onSaved: () => void;
  onClose?: () => void;
  onNavigate?: (target: CatalogNavTarget) => void;
  onAskAssistant?: (mode: AssistantOpenMode) => void;
  connections?: CatalogConnection[];
}

interface UsedInProduct { id: number; name: string; status: string }
interface PolicyRow { id: number; name: string; table_name: string; column_name: string | null; policy_type: string }

export default function TableDetailPanel({
  table, columns, focusColumnId, connectionDomains = [], onSaved, onClose, onNavigate, onAskAssistant, connections = [],
}: Props) {
  const role = useRole();
  const curator = canCurate(role);
  const admin = isAdminRole(role);
  const [tbl, setTbl]               = useState<SourceTable>(table);
  const [cols, setCols]             = useState<SourceColumn[]>(columns);
  const [savingTable, setSavingTable] = useState(false);
  const [savedMsg, setSavedMsg]     = useState('');
  const [confirmingAi, setConfirmingAi] = useState(false);
  const [flaggingAi, setFlaggingAi] = useState(false);
  const [aiTarget, setAiTarget]     = useState<{ kind: 'table' } | { kind: 'column'; col: SourceColumn } | null>(null);
  const [moreOpen, setMoreOpen]     = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [showColHistory, setShowColHistory] = useState<number | null>(null);
  const [viewTab, setViewTab]       = useState<ViewTab>('overview');
  const [usedIn, setUsedIn]         = useState<UsedInProduct[]>([]);
  const [policies, setPolicies]     = useState<PolicyRow[]>([]);

  if (table.id !== tbl.id) { setTbl(table); setCols(columns); }

  useEffect(() => {
    let cancelled = false;
    api.get(`/products/by-source-table/${tbl.id}`)
      .then((res) => { if (!cancelled) setUsedIn((res.data.data ?? []) as UsedInProduct[]); })
      .catch(() => { if (!cancelled) setUsedIn([]); });
    return () => { cancelled = true; };
  }, [tbl.id]);
  useEffect(() => {
    let cancelled = false;
    api.get('/policies/mine')
      .then((r) => { if (!cancelled) setPolicies((r.data?.data ?? []) as PolicyRow[]); })
      .catch(() => { if (!cancelled) setPolicies([]); });
    return () => { cancelled = true; };
  }, []);

  const connection = useMemo(() => connections.find((c) => c.id === tbl.connection_id) ?? null, [connections, tbl.connection_id]);

  // ── Writes ───────────────────────────────────────────────────────────────
  async function saveTable() {
    setSavingTable(true);
    try {
      await api.patch(`/semantic/tables/${tbl.id}`, {
        display_name: tbl.display_name,
        description:  tbl.description,
        is_active:    tbl.is_active,
        domains:      parseDomains(tbl.domains),
      });
      setSavedMsg('Saved');
      setTimeout(() => setSavedMsg(''), 2000);
      onSaved();
    } catch {
      setSavedMsg('Could not save');
    }
    setSavingTable(false);
  }

  async function confirmAiTable() {
    setConfirmingAi(true);
    try {
      await api.patch(`/semantic/tables/${tbl.id}`, { ai_draft: false, approval_status: 'approved' });
      setTbl({ ...tbl, ai_draft: false, approval_status: 'approved' });
      onSaved();
    } finally { setConfirmingAi(false); }
  }

  async function flagAiTable() {
    setFlaggingAi(true);
    try {
      await api.patch(`/semantic/tables/${tbl.id}`, { approval_status: 'flagged' });
      setTbl({ ...tbl, approval_status: 'flagged' });
      onSaved();
    } finally { setFlaggingAi(false); }
  }

  function updateCol(id: number, patch: Partial<SourceColumn>) {
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function saveColumn(col: SourceColumn, patch: Partial<SourceColumn> = {}) {
    const next = { ...col, ...patch };
    await api.patch(`/semantic/columns/${col.id}`, {
      display_name: next.display_name,
      description:  next.description,
      is_dimension: next.is_dimension,
      is_measure:   next.is_measure,
    });
    updateCol(col.id, patch);
    onSaved();
  }

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag) return;
    const current = parseDomains(tbl.domains);
    if (!current.includes(tag)) setTbl({ ...tbl, domains: [...current, tag] });
    setDomainInput('');
  }

  const isAiDraft = !!tbl.ai_draft && tbl.approval_status !== 'approved';
  const title = tbl.display_name || tbl.table_name;
  const ownDomains = parseDomains(tbl.domains).filter((tag) => !connectionDomains.includes(tag));
  const tablePolicies = policies.filter((p) => p.table_name === tbl.table_name);

  // ── Header ───────────────────────────────────────────────────────────────
  const crumbs: Crumb[] = [
    { label: 'Catalog', onClick: () => onNavigate?.({ kind: 'catalog' }) },
    { label: connection?.name ?? 'Source', onClick: () => onNavigate?.({ kind: 'source', connectionId: tbl.connection_id }) },
    { label: title },
  ];
  const tabs: Array<{ id: ViewTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'sample', label: 'Sample data' },
    ...(curator ? [{ id: 'relations' as const, label: 'Relations' }] : []),
    ...(curator ? [{ id: 'lineage' as const, label: 'Lineage' }] : []),
    { id: 'quality', label: 'Quality' },
    ...(curator ? [{ id: 'history' as const, label: 'History' }] : []),
  ];

  // ── The rail ─────────────────────────────────────────────────────────────
  const sections: AboutSection[] = [
    {
      title: 'About this table',
      rows: [
        { label: 'Type', value: 'Source table' },
        {
          label: 'Source',
          value: connection ? (
            <button type="button" onClick={() => onNavigate?.({ kind: 'source', connectionId: connection.id })} className="inline-flex items-center gap-1.5 text-ocean hover:text-ocean-hover transition-colors text-left min-w-0">
              <ConnectorMarkIcon connectorType={connection.connector_type ?? connection.type} size="xs" />
              <span className="truncate">{connection.name}</span>
            </button>
          ) : null,
        },
        { label: 'In answers', value: tbl.is_active ? <RailChip tone="ok">Yes</RailChip> : <RailChip tone="warn" title="Excluded from the AI's context">No</RailChip> },
        {
          label: 'Domains',
          value: (connectionDomains.length > 0 || ownDomains.length > 0) ? (
            <span className="flex flex-wrap gap-1">
              {connectionDomains.map((d) => <RailChip key={`c-${d}`} title="From the source">{d}</RailChip>)}
              {ownDomains.map((d) => <RailChip key={`t-${d}`} tone="ocean">{d}</RailChip>)}
            </span>
          ) : null,
        },
      ],
    },
    {
      title: 'Used in',
      body: usedIn.length === 0 ? (
        <span className="text-muted">No subject is built from this table yet.</span>
      ) : (
        <span className="flex flex-wrap gap-1">
          {usedIn.map((p) => (
            <button key={p.id} type="button" onClick={() => onNavigate?.({ kind: 'subject', productId: p.id })} className="inline-flex items-center gap-1 rounded border border-line bg-softer px-1.5 py-0.5 text-[11.5px] text-ink-2 hover:border-ocean hover:text-ocean transition-colors">
              {p.name}
              <ArrowRight className="w-3 h-3 text-muted-2" strokeWidth={2} aria-hidden />
            </button>
          ))}
        </span>
      ),
    },
    ...(curator ? [{
      title: 'What it feeds',
      body: <LineageSummary layer="source" tableId={tbl.id} compact onOpenLineage={() => setViewTab('lineage')} />,
    }] : []),
    ...(tablePolicies.length > 0 || admin ? [{
      title: 'Policies',
      body: tablePolicies.length > 0 ? (
        <ul className="space-y-1">
          {tablePolicies.map((p) => (
            <li key={p.id} className="text-[12.5px] text-ink-2">
              <span className="font-medium">{p.name}</span>
              <span className="text-muted"> · {p.policy_type === 'column_mask' ? `masks ${p.column_name ?? 'a column'}` : 'filters rows'}</span>
            </li>
          ))}
        </ul>
      ) : <span className="text-muted">None apply to you.</span>,
      link: admin ? { label: 'Manage policies', href: '/policies' } : undefined,
    }] : []),
  ];

  // ── The columns ──────────────────────────────────────────────────────────
  const rows: ColumnRow[] = cols.map((col) => ({
    id: col.id,
    name: col.column_name,
    displayName: col.display_name,
    type: col.data_type,
    description: col.description,
    focused: col.id === focusColumnId,
    extra: curator ? (
      <span className="inline-flex items-center gap-3">
        <label className="inline-flex items-center gap-1 text-[11.5px] text-ink-2 cursor-pointer" title="Used to group and filter">
          <input type="checkbox" checked={!!col.is_dimension} onChange={(e) => { void saveColumn(col, { is_dimension: e.target.checked }); }} className="rounded w-3.5 h-3.5 accent-ocean" />
          Dim
        </label>
        <label className="inline-flex items-center gap-1 text-[11.5px] text-ink-2 cursor-pointer" title="A number that adds up">
          <input type="checkbox" checked={!!col.is_measure} onChange={(e) => { void saveColumn(col, { is_measure: e.target.checked }); }} className="rounded w-3.5 h-3.5 accent-ocean" />
          Mea
        </label>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1">
        {col.is_dimension && <RailChip tone="ocean">Dimension</RailChip>}
        {col.is_measure && <RailChip tone="ok">Measure</RailChip>}
      </span>
    ),
    status: curator ? (
      <ApprovalBadge
        entityType="column" entityId={col.id}
        status={col.approval_status} aiDraft={col.ai_draft}
        rejectionReason={col.rejection_reason} onChanged={onSaved}
        compact
      />
    ) : undefined,
    details: curator ? (
      <SourceColumnDetails
        col={col}
        onChange={(patch) => updateCol(col.id, patch)}
        onSave={(patch) => saveColumn(col, patch)}
        onAskAi={() => setAiTarget({ kind: 'column', col })}
        historyOpen={showColHistory === col.id}
        onToggleHistory={() => setShowColHistory(showColHistory === col.id ? null : col.id)}
      />
    ) : undefined,
  }));

  const hasRoleChips = !curator && cols.some((c) => c.is_dimension || c.is_measure);
  const rowsShown = hasRoleChips || curator ? rows : rows.map((r) => ({ ...r, extra: undefined }));

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg panel-enter">
      <ExplorerHeader
        crumbs={crumbs}
        icon={<ConnectorMarkIcon connectorType={connection?.connector_type ?? connection?.type} size="md" />}
        title={title}
        technicalName={curator ? tbl.table_name : undefined}
        badges={(
          <>
            {!tbl.is_active && (
              <span className="text-[10px] font-mono tracking-[0.08em] uppercase px-1.5 py-0.5 rounded border border-line bg-softer text-muted-2">Not in answers</span>
            )}
            {curator && (
              <ApprovalBadge
                entityType="table"
                entityId={tbl.id}
                status={tbl.approval_status}
                aiDraft={tbl.ai_draft}
                rejectionReason={tbl.rejection_reason}
                onChanged={onSaved}
                compact
              />
            )}
          </>
        )}
        actions={curator && onAskAssistant ? (
          <HeaderAction onClick={() => onAskAssistant('ask')} primary icon={<MessageSquareText className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />} title="Ask the assistant about this table">
            Ask about it
          </HeaderAction>
        ) : undefined}
        tabs={tabs}
        activeTab={viewTab}
        onTabChange={setViewTab}
        onClose={onClose}
      />

      {/* ── Overview ──────────────────────────────────────────────────────── */}
      {viewTab === 'overview' && (
        <div className="flex-1 overflow-y-auto px-6 pt-5 pb-24">
          <div className="flex gap-8 items-start">
            <div className="flex-1 min-w-0 space-y-5">
              {curator && isAiDraft && (
                <section className="bg-ocean-softer border border-ocean/30 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <ClarionMark size={16} className="shrink-0 mt-0.5" />
                    <p className="text-[13px] text-ink leading-relaxed">
                      <span className="font-medium">Suggested by Clarion.</span> Confirm the description if it is right, or flag it.
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={confirmAiTable} disabled={confirmingAi || flaggingAi} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-ok-soft text-ok hover:bg-ok hover:text-white transition-colors disabled:opacity-50">
                      <Check className="w-3 h-3" strokeWidth={2.5} aria-hidden />{confirmingAi ? '…' : 'Confirm'}
                    </button>
                    <button onClick={flagAiTable} disabled={confirmingAi || flaggingAi} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-warn-soft text-warn hover:bg-warn hover:text-white transition-colors disabled:opacity-50">
                      <Flag className="w-3 h-3" strokeWidth={2} aria-hidden />{flaggingAi ? '…' : 'Flag'}
                    </button>
                  </div>
                </section>
              )}

              <section className="bg-raised border border-line rounded-lg p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h3 className="text-[13px] font-medium text-ink">Description</h3>
                  {curator && (
                    <button type="button" onClick={() => setAiTarget({ kind: 'table' })} className="inline-flex items-center gap-1 text-[11.5px] text-ocean hover:text-ocean-hover transition-colors" title="Ask AI to write or change this description">
                      <Sparkles className="w-3 h-3" strokeWidth={1.75} aria-hidden />
                      Ask AI
                    </button>
                  )}
                </div>
                {curator ? (
                  <>
                    <textarea
                      value={tbl.description ?? ''}
                      onChange={(e) => setTbl({ ...tbl, description: e.target.value })}
                      rows={3}
                      className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder:text-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors resize-none"
                      placeholder="What does this table contain?"
                    />
                    <button type="button" onClick={() => setMoreOpen((o) => !o)} className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 transition-colors" aria-expanded={moreOpen}>
                      {moreOpen ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
                      Name, answers and domains
                    </button>
                    {moreOpen && (
                      <div className="mt-3 grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-[11px] text-muted mb-1">Display name</label>
                          <input
                            value={tbl.display_name ?? ''}
                            onChange={(e) => setTbl({ ...tbl, display_name: e.target.value })}
                            className="w-full bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                            placeholder="A name people use"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-1 text-[11px] text-muted mb-1">
                            In the AI&apos;s answers
                            <HelpTooltip text="Whether Ask AI may read this table when it answers questions." />
                          </label>
                          <select
                            value={tbl.is_active ? 'yes' : 'no'}
                            onChange={(e) => setTbl({ ...tbl, is_active: e.target.value === 'yes' })}
                            className="w-full bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                          >
                            <option value="yes">Yes — the AI may use it</option>
                            <option value="no">No — keep it out</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="flex items-center gap-1 text-[11px] text-muted mb-1">
                            Data domains
                            <HelpTooltip text="Business areas this table belongs to (sales, hr, finance). Helps scope the AI's reading." />
                          </label>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {connectionDomains.map((tag) => <RailChip key={`c-${tag}`} title="From the source">{tag}</RailChip>)}
                            {ownDomains.map((tag) => (
                              <span key={tag} className="inline-flex items-center gap-1 text-[11px] bg-ai-soft text-ai border border-line rounded px-1.5 py-0.5">
                                {tag}
                                <button type="button" onClick={() => setTbl({ ...tbl, domains: parseDomains(tbl.domains).filter((d) => d !== tag) })} className="hover:text-ai/70 leading-none" aria-label={`Remove ${tag}`}>&times;</button>
                              </span>
                            ))}
                            <input
                              value={domainInput}
                              onChange={(e) => setDomainInput(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addDomain(domainInput); } }}
                              placeholder="Add a domain…"
                              className="bg-raised border border-line rounded-md px-2 py-1 text-[12px] text-ink-2 focus:outline-none focus:border-ocean w-40"
                            />
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-4">
                      <button type="button" onClick={saveTable} disabled={savingTable} className="px-4 py-1.5 bg-ocean text-white text-[12.5px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors">
                        {savingTable ? 'Saving…' : 'Save'}
                      </button>
                      {savedMsg && <span className={cn('text-[12px]', savedMsg === 'Saved' ? 'text-ok' : 'text-err')}>{savedMsg}</span>}
                    </div>
                  </>
                ) : (
                  tbl.description
                    ? <p className="text-[13px] text-ink-2 leading-relaxed">{tbl.description}</p>
                    : <p className="text-[13px] text-muted-2 italic">No description yet.</p>
                )}
              </section>

              <section>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h3 className="text-[13px] font-medium text-ink">
                    Columns <span className="font-mono text-[11px] text-muted-2 tabular-nums ml-1">{cols.length}</span>
                  </h3>
                  {curator && (
                    <span className="text-[11.5px] text-muted">{cols.filter((c) => !c.ai_draft).length} of {cols.length} confirmed</span>
                  )}
                </div>
                <ColumnsTable
                  rows={rowsShown}
                  onSaveDescription={curator ? async (id, text) => {
                    const col = cols.find((c) => c.id === id);
                    if (col) await saveColumn(col, { description: text });
                  } : undefined}
                  extraHeader={(curator || hasRoleChips) ? (
                    <span className="inline-flex items-center gap-1">Role <HelpTooltip text="Dimension: used to group and filter. Measure: a number that adds up." /></span>
                  ) : undefined}
                  statusHeader={curator ? 'Status' : undefined}
                />
              </section>
            </div>

            <AboutRail sections={sections} />
          </div>
        </div>
      )}

      {/* ── Sample data ───────────────────────────────────────────────────── */}
      {viewTab === 'sample' && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <PreviewTable url={`/semantic/preview?connectionId=${tbl.connection_id}&table=${encodeURIComponent(tbl.table_name)}&limit=25`} autoLoad />
        </div>
      )}

      {/* ── Relations — who laid each link, whether it holds ──────────────── */}
      {viewTab === 'relations' && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <SourceTableRelations tableId={tbl.id} onNavigate={onNavigate} />
        </div>
      )}

      {/* ── Lineage ───────────────────────────────────────────────────────── */}
      {viewTab === 'lineage' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="border-b border-line bg-raised px-6 py-2">
            <p className="text-[12px] text-muted">Which subject columns this table feeds, and how.</p>
          </div>
          <LineageGraph layer="source" tableId={tbl.id} />
        </div>
      )}

      {/* ── Quality ───────────────────────────────────────────────────────── */}
      {viewTab === 'quality' && (
        <QualityPanel connId={tbl.connection_id} tableName={tbl.table_name} />
      )}

      {/* ── History ───────────────────────────────────────────────────────── */}
      {viewTab === 'history' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <HistoryPanel entityType="table" entityId={tbl.id} entityName={title} />
        </div>
      )}

      {aiTarget && aiTarget.kind === 'table' && (
        <AiPromptDialog
          entityType="table"
          entityId={tbl.id}
          entityName={title}
          currentDescription={tbl.description ?? ''}
          onAccept={(text) => setTbl({ ...tbl, description: text })}
          onClose={() => setAiTarget(null)}
        />
      )}
      {aiTarget && aiTarget.kind === 'column' && (
        <AiPromptDialog
          entityType="column"
          entityId={aiTarget.col.id}
          entityName={aiTarget.col.display_name || aiTarget.col.column_name}
          currentDescription={aiTarget.col.description ?? ''}
          onAccept={(text) => { void saveColumn(aiTarget.col, { description: text }); }}
          onClose={() => setAiTarget(null)}
        />
      )}
    </div>
  );
}

/** Under a source column row: the display name, example values, history. */
function SourceColumnDetails({
  col, onChange, onSave, onAskAi, historyOpen, onToggleHistory,
}: {
  col: SourceColumn;
  onChange: (patch: Partial<SourceColumn>) => void;
  onSave: (patch: Partial<SourceColumn>) => Promise<void>;
  onAskAi: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const examples = parseExamples(col.example_values);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px]">
          <label className="block text-[11px] text-muted mb-1">Display name</label>
          <div className="flex items-center gap-2">
            <input
              value={col.display_name ?? ''}
              onChange={(e) => onChange({ display_name: e.target.value })}
              className="flex-1 bg-raised border border-line rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
              placeholder="A name people use"
            />
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try { await onSave({ display_name: col.display_name }); setMsg('Saved'); }
                catch { setMsg('Could not save'); }
                finally { setSaving(false); setTimeout(() => setMsg(''), 1500); }
              }}
              className="px-3 py-1.5 bg-ocean text-white text-[12px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50"
            >
              {saving ? '…' : 'Save'}
            </button>
            {msg && <span className={cn('text-[11.5px]', msg === 'Saved' ? 'text-ok' : 'text-err')}>{msg}</span>}
          </div>
        </div>
        <button type="button" onClick={onAskAi} className="inline-flex items-center gap-1 text-[12px] text-ocean hover:text-ocean-hover transition-colors pb-2">
          <Sparkles className="w-3 h-3" strokeWidth={1.75} aria-hidden />
          Ask AI for a description
        </button>
        <button type="button" onClick={onToggleHistory} className="text-[12px] text-muted hover:text-ink-2 transition-colors pb-2">
          {historyOpen ? 'Hide history' : 'History'}
        </button>
      </div>
      {examples.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted mr-1">Examples</span>
          {examples.map((v, i) => (
            <span key={i} className="text-[11px] bg-softer text-ink-3 px-1.5 py-0.5 rounded font-mono border border-line">{v}</span>
          ))}
        </div>
      )}
      {historyOpen && (
        <div className="pt-3 border-t border-line/60">
          <HistoryPanel entityType="column" entityId={col.id} entityName={col.display_name || col.column_name} />
        </div>
      )}
    </div>
  );
}
