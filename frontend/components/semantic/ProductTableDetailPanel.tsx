'use client';

/**
 * <ProductTableDetailPanel> — a product table's page in the catalog.
 *
 * Laid out the way the Databricks Catalog Explorer lays a table out (the
 * owner's ask, 2026-09-23): breadcrumb › name · the actions on the right ·
 * a tab strip; the Overview is the description, then ONE columns table
 * (filter, type, description edited in the cell, the team's term), with an
 * "About this table" rail beside it — owner, type, source, built when, its
 * state, quality, where it comes from, terms, the policies that apply.
 *
 * What stays Clarion's: the SQL tab is the DECLARATION (edited in place,
 * one verb, Save; the assistant's proposals land there as a diff), the
 * lineage line is the easy answer on the Overview, vocabulary is business
 * words for viewers (Measures / Lookup, never fact / dimension), and SQL,
 * the technical name and the audit trail are curator surfaces.
 *
 * The Columns tab of the previous layout is gone: two lists of the same
 * columns on two tabs is the busyness the owner asked to end.
 */
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { BookOpen, ChevronDown, ChevronRight, Gauge, MessageSquareText, Sparkles, Table2, WandSparkles, Wrench } from 'lucide-react';
import api from '@/lib/api';
import AiPromptDialog from './AiPromptDialog';
import { ProductColumn, ProductTable, ProductTreeItem, type ResolvedGlossaryLink } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';
import QualityPanel from '@/components/QualityPanel';
import { parseDomains, PreviewTable } from './shared';
import { useRole, canCurate, isAdminRole } from '@/lib/role';
import { formatRelative } from '@/lib/dates';
import { askAboutSubject } from '@/lib/askLink';
import { cn } from '@/lib/cn';
import ConnectorMarkIcon from '@/components/ConnectorMarkIcon';
import ExplorerHeader, { HeaderAction, MoreMenu, type Crumb } from '@/components/catalog/ExplorerHeader';
import AboutRail, { RailChip, type AboutSection } from '@/components/catalog/AboutRail';
import ColumnsTable, { type ColumnRow } from '@/components/catalog/ColumnsTable';
import LineageSummary from '@/components/catalog/LineageSummary';
import { iconForReference } from '@/components/catalog/entityIcons';
import { useSqlProposal } from '@/components/catalog/catalogAssistantContext';
import type { AssistantOpenMode, CatalogConnection, CatalogNavTarget } from '@/components/catalog/navigation';

const LineageGraph = dynamic(() => import('@/components/catalog/LineageGraph'), { ssr: false });
// The SQL editor pulls in CodeMirror — loaded only when the tab opens.
const SqlDeclaration = dynamic(() => import('@/components/catalog/SqlDeclaration'), { ssr: false });

type ViewTab = 'overview' | 'sample' | 'sql' | 'lineage' | 'quality' | 'history';

interface Props {
  /** Graph id OR Postgres product_tables id — the panel resolves both. */
  tableId: number;
  productTree: ProductTreeItem[];
  columns: ProductColumn[];
  focusColumnId: number | null;
  onSaved: () => void;
  onClose?: () => void;
  /** Land on a specific tab — the assistant opens the SQL tab it proposed on. */
  initialTab?: 'sql';
  /** Breadcrumb and "used in" clicks: the page owns the selection. */
  onNavigate?: (target: CatalogNavTarget) => void;
  /** "Change with AI" opens the floating assistant in that mode. */
  onAskAssistant?: (mode: AssistantOpenMode) => void;
  /** GET /connections, for the source's name and mark. */
  connections?: CatalogConnection[];
}

interface Declaration {
  transformation_status: string | null;
  last_run_at: string | null;
  last_run_error: string | null;
  row_count: number | null;
  degraded_reason: string | null;
  declared_by: string | null;
  declared_at: string | null;
  pending_rebuild: boolean;
  shared_from: { tableId: number; productId: number; productName: string } | null;
}

interface QualityRow { product_table_id: number | null; overall_score: number | null; profiled_at: string | null }
interface PolicyRow { id: number; name: string; table_name: string; column_name: string | null; policy_type: string }

/** Business words for the table's shape — viewers never read "fact". */
const TYPE_LABEL: Record<string, string> = {
  fact: 'Measures table',
  dimension: 'Lookup table',
  bridge: 'Bridge table',
  junk: 'Flags table',
};

const colRoleChip = (role: string | null): { label: string; tone: ColumnRow['roleTone'] } | null => {
  switch (role) {
    case 'measure':              return { label: 'Measure', tone: 'ok' };
    case 'degenerate_dimension': return { label: 'Reference', tone: 'neutral' };
    default:                     return null;
  }
};

export default function ProductTableDetailPanel({
  tableId, productTree, columns, focusColumnId, onSaved, onClose, initialTab, onNavigate, onAskAssistant, connections = [],
}: Props) {
  const role = useRole();
  const curator = canCurate(role);
  const admin = isAdminRole(role);

  // ── Resolve the table in the tree (either id space) ────────────────────
  let table: ProductTable | null = null;
  let pgTableId: number | null = null;
  let productConnectionId: number | null = null;
  let parentProductId: number | null = null;
  let parentProductName: string | null = null;
  const usedByProducts: string[] = [];
  for (const product of productTree) {
    for (const schema of product.starSchemas) {
      const found = schema.tables.find(
        (t) => t.id === tableId || (t as { pg_table_id?: number | null }).pg_table_id === tableId,
      );
      if (found) {
        table = found;
        pgTableId = (found as { pg_table_id?: number }).pg_table_id ?? tableId;
        productConnectionId = product.connectionId;
        parentProductId = product.productId;
        parentProductName = product.productName;
        break;
      }
    }
    if (table) break;
  }
  if (table) {
    for (const product of productTree) {
      if (product.productName === parentProductName) continue;
      for (const schema of product.starSchemas) {
        if (schema.tables.some((t) => t.table_name === table!.table_name) && !usedByProducts.includes(product.productName)) {
          usedByProducts.push(product.productName);
        }
      }
    }
    usedByProducts.sort();
  }
  const productIdByName = useMemo(() => new Map(productTree.map((p) => [p.productName, p.productId])), [productTree]);
  const connection = connections.find((c) => c.id === productConnectionId) ?? null;

  // ── State ────────────────────────────────────────────────────────────────
  const [tbl, setTbl]               = useState(table);
  const [cols, setCols]             = useState<ProductColumn[]>(columns);
  const [prevTableId, setPrevTableId] = useState(tableId);
  const [prevColLen, setPrevColLen] = useState(columns.length);
  const [savingTable, setSavingTable] = useState(false);
  const [savedMsg, setSavedMsg]     = useState('');
  const [moreOpen, setMoreOpen]     = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [viewTab, setViewTab]       = useState<ViewTab>(initialTab ?? 'overview');
  const [aiTarget, setAiTarget]     = useState<{ kind: 'table' } | { kind: 'column'; col: ProductColumn } | null>(null);
  const [showColHistory, setShowColHistory] = useState<number | null>(null);
  const [decl, setDecl]             = useState<Declaration | null>(null);
  const [quality, setQuality]       = useState<QualityRow | null>(null);
  const [policies, setPolicies]     = useState<PolicyRow[]>([]);
  const [glossaryTerms, setGlossaryTerms] = useState<Array<{ id: number; term: string; links: ResolvedGlossaryLink[] }>>([]);

  if (tableId !== prevTableId) {
    setPrevTableId(tableId);
    setPrevColLen(columns.length);
    setTbl(table);
    setCols(columns);
  } else if (columns.length !== prevColLen) {
    setPrevColLen(columns.length);
    setCols(columns);
  }

  // A proposal from the floating assistant lands ON the declaration.
  const { proposal } = useSqlProposal(pgTableId);
  const proposalId = proposal?.id ?? null;
  useEffect(() => { if (proposalId) setViewTab('sql'); }, [proposalId]);

  // The rail's facts — one small read each; a failure leaves the row out.
  const tableName = tbl?.table_name ?? null;
  useEffect(() => {
    let cancelled = false;
    api.get('/semantic/glossary')
      .then((r) => {
        if (cancelled) return;
        const rows = (r.data?.data ?? []) as Array<{ id: number; term: string; links?: ResolvedGlossaryLink[] }>;
        setGlossaryTerms(rows.map((row) => ({ id: Number(row.id), term: String(row.term ?? ''), links: Array.isArray(row.links) ? row.links : [] })));
      })
      .catch(() => { if (!cancelled) setGlossaryTerms([]); });
    api.get('/policies/mine')
      .then((r) => { if (!cancelled) setPolicies((r.data?.data ?? []) as PolicyRow[]); })
      .catch(() => { if (!cancelled) setPolicies([]); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (pgTableId == null) return;
    let cancelled = false;
    if (curator) {
      api.get(`/products/tables/${pgTableId}/declaration`)
        .then((r) => { if (!cancelled) setDecl((r.data?.data ?? null) as Declaration | null); })
        .catch(() => { if (!cancelled) setDecl(null); });
    }
    const q = productConnectionId != null ? `?connectionId=${productConnectionId}` : '';
    api.get(`/quality/tables${q}`)
      .then((r) => {
        if (cancelled) return;
        const rows = (r.data?.data ?? []) as QualityRow[];
        setQuality(rows.find((row) => row.product_table_id === pgTableId) ?? null);
      })
      .catch(() => { if (!cancelled) setQuality(null); });
    return () => { cancelled = true; };
  }, [pgTableId, productConnectionId, curator]);

  const termsForColumn = (columnName: string): string[] =>
    glossaryTerms.filter((g) => g.links.some((l) => l.kind === 'column' && l.table === tableName && l.column === columnName)).map((g) => g.term);
  const termsForTable = (): string[] =>
    glossaryTerms.filter((g) => g.links.some((l) => l.kind === 'table' && l.table === tableName)).map((g) => g.term);

  if (!tbl) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-2 text-sm">Table not found</div>
    );
  }

  const domains = parseDomains(tbl.domains);
  const isAiDraft = !!tbl.ai_draft && tbl.approval_status !== 'approved';
  const title = tbl.display_name || tbl.table_name;
  const tablePolicies = policies.filter((p) => p.table_name === tbl.table_name);
  const tableTerms = termsForTable();

  // ── Writes ───────────────────────────────────────────────────────────────
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
      setSavedMsg('Saved');
      setTimeout(() => setSavedMsg(''), 2000);
      onSaved();
    } catch {
      setSavedMsg('Could not save');
    }
    setSavingTable(false);
  }

  function updateCol(id: number, patch: Partial<ProductColumn>) {
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  async function saveColumn(col: ProductColumn, patch: Partial<ProductColumn> = {}) {
    const next = { ...col, ...patch };
    await api.patch(`/semantic/product-columns/${col.id}`, {
      display_name: next.display_name,
      description:  next.description,
    });
    updateCol(col.id, patch);
    onSaved();
  }

  function addDomain(value: string) {
    const tag = value.trim().toLowerCase();
    if (!tag || !tbl) return;
    if (!domains.includes(tag)) setTbl({ ...tbl, domains: [...domains, tag] });
    setDomainInput('');
  }

  // ── Header ───────────────────────────────────────────────────────────────
  const crumbs: Crumb[] = [
    { label: 'Catalog', onClick: () => onNavigate?.({ kind: 'catalog' }) },
    ...(parentProductName && parentProductId != null
      ? [{ label: parentProductName, onClick: () => onNavigate?.({ kind: 'subject', productId: parentProductId! }) }]
      : []),
    { label: title },
  ];
  const RefIcon = iconForReference(title);
  const icon = tbl.table_role === 'dimension'
    ? <span className="w-8 h-8 rounded-lg bg-ai-soft border border-ai/20 flex items-center justify-center text-ai"><RefIcon className="w-4 h-4" strokeWidth={1.75} aria-hidden /></span>
    : <span className="w-8 h-8 rounded-lg bg-ocean-softer border border-ocean/20 flex items-center justify-center text-ocean"><Table2 className="w-4 h-4" strokeWidth={1.75} aria-hidden /></span>;

  const tabs: Array<{ id: ViewTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'sample', label: 'Sample data' },
    ...(curator ? [{ id: 'sql' as const, label: 'SQL' }] : []),
    ...(curator ? [{ id: 'lineage' as const, label: 'Lineage' }] : []),
    { id: 'quality', label: 'Quality' },
    ...(curator ? [{ id: 'history' as const, label: 'History' }] : []),
  ];

  const askHref = parentProductId != null && parentProductName
    ? askAboutSubject({ productId: parentProductId, productName: parentProductName, connectionId: productConnectionId })
    : null;

  // ── The rail ─────────────────────────────────────────────────────────────
  const status = decl?.transformation_status ?? tbl.transformation_status;
  const lastRunAt = decl?.last_run_at ?? tbl.last_run_at ?? null;
  const rowCount = decl?.row_count ?? tbl.row_count ?? null;
  let stateChip: React.ReactNode = null;
  if (decl?.pending_rebuild) {
    stateChip = (
      <span className="space-y-1">
        <RailChip tone="warn">Changed since the last build</RailChip>
        <span className="block text-[11.5px] text-muted">
          {decl.declared_by ? `by ${decl.declared_by}` : 'saved'}{decl.declared_at ? ` · ${formatRelative(decl.declared_at)}` : ''}
        </span>
      </span>
    );
  } else if (decl?.degraded_reason) {
    stateChip = <RailChip tone="warn" title={decl.degraded_reason}>Missing a source column</RailChip>;
  } else if (status === 'success') {
    stateChip = <RailChip tone="ok">Built</RailChip>;
  } else if (status === 'error' || status === 'failed') {
    stateChip = <RailChip tone="err" title={decl?.last_run_error ?? undefined}>Last build failed</RailChip>;
  } else if (status === 'running') {
    stateChip = <RailChip tone="ocean">Building</RailChip>;
  } else if (status) {
    stateChip = <RailChip>Not built yet</RailChip>;
  }

  const sections: AboutSection[] = [
    {
      title: 'About this table',
      rows: [
        { label: 'Type', value: TYPE_LABEL[tbl.table_role] ?? tbl.table_role },
        {
          label: 'Subject',
          value: parentProductName && parentProductId != null ? (
            <button type="button" onClick={() => onNavigate?.({ kind: 'subject', productId: parentProductId! })} className="text-ocean hover:text-ocean-hover transition-colors text-left">
              {parentProductName}
            </button>
          ) : null,
        },
        {
          label: 'Source',
          value: connection ? (
            <button type="button" onClick={() => onNavigate?.({ kind: 'source', connectionId: connection.id })} className="inline-flex items-center gap-1.5 text-ocean hover:text-ocean-hover transition-colors text-left min-w-0">
              <ConnectorMarkIcon connectorType={connection.connector_type ?? connection.type} size="xs" />
              <span className="truncate">{connection.name}</span>
            </button>
          ) : null,
        },
        {
          label: 'Shared from',
          value: decl?.shared_from ? (
            <button type="button" onClick={() => onNavigate?.({ kind: 'subject', productId: decl.shared_from!.productId })} className="text-ocean hover:text-ocean-hover transition-colors text-left">
              {decl.shared_from.productName}
            </button>
          ) : null,
        },
        { label: 'Owner', value: tbl.owner_name || null },
        {
          label: 'Built',
          value: lastRunAt
            ? <span>{formatRelative(lastRunAt)}{rowCount != null ? <span className="text-muted"> · {rowCount.toLocaleString('en-GB')} rows</span> : null}</span>
            : (rowCount != null ? `${rowCount.toLocaleString('en-GB')} rows` : null),
        },
        { label: 'State', value: stateChip },
      ],
    },
    {
      title: 'Quality',
      body: quality?.overall_score != null ? (
        <span className="inline-flex items-center gap-2">
          <RailChip tone={quality.overall_score >= 0.9 ? 'ok' : quality.overall_score >= 0.7 ? 'warn' : 'err'}>
            {Math.round(quality.overall_score * 100)}%
          </RailChip>
          {quality.profiled_at && <span className="text-[11.5px] text-muted">checked {formatRelative(quality.profiled_at)}</span>}
        </span>
      ) : <span className="text-muted">Not checked yet.</span>,
      link: undefined,
    },
    ...(curator && pgTableId != null ? [{
      title: 'Where it comes from',
      body: <LineageSummary layer="product" tableId={pgTableId} compact onOpenLineage={() => setViewTab('lineage')} />,
    }] : []),
    {
      title: 'Your team calls this',
      body: tableTerms.length > 0 ? (
        <span className="flex flex-wrap gap-1">
          {tableTerms.map((t) => (
            <RailChip key={t} tone="ocean"><BookOpen className="w-3 h-3" strokeWidth={2} aria-hidden /><span className="italic">{t}</span></RailChip>
          ))}
        </span>
      ) : <span className="text-muted">No term linked yet.</span>,
      link: curator ? { label: 'Definitions', href: '/definitions' } : undefined,
    },
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
    ...(usedByProducts.length > 0 ? [{
      title: 'Also used in',
      body: (
        <span className="flex flex-wrap gap-1">
          {usedByProducts.map((name) => {
            const pid = productIdByName.get(name);
            return pid != null ? (
              <button key={name} type="button" onClick={() => onNavigate?.({ kind: 'subject', productId: pid })} className="inline-flex rounded border border-line bg-softer px-1.5 py-0.5 text-[11.5px] text-ink-2 hover:border-ocean hover:text-ocean transition-colors">
                {name}
              </button>
            ) : <RailChip key={name}>{name}</RailChip>;
          })}
        </span>
      ),
    }] : []),
  ];

  // ── The columns ──────────────────────────────────────────────────────────
  const rows: ColumnRow[] = cols.map((col) => {
    const chip = colRoleChip(col.column_role);
    const isKey = col.column_role === 'surrogate_key' || col.column_role === 'natural_key';
    const isFk = col.column_role === 'foreign_key';
    return {
      id: col.id,
      name: col.column_name,
      displayName: col.display_name,
      type: col.data_type,
      description: col.description,
      keyKind: isKey ? 'key' : isFk ? 'fk' : null,
      keyTitle: isKey
        ? (col.column_role === 'surrogate_key' ? 'Identifies a row' : 'The natural key')
        : isFk && col.fk_target_table ? `Points at ${col.fk_target_table}${col.fk_target_column ? `.${col.fk_target_column}` : ''}` : undefined,
      roleLabel: chip?.label ?? null,
      roleTone: chip?.tone,
      terms: termsForColumn(col.column_name),
      focused: col.id === focusColumnId,
      status: curator ? (
        <ApprovalBadge
          entityType="product_column" entityId={col.id}
          status={col.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
          aiDraft={!!col.ai_draft}
          onChanged={onSaved}
          compact
        />
      ) : undefined,
      details: curator ? (
        <ColumnDetails
          col={col}
          onChange={(patch) => updateCol(col.id, patch)}
          onSave={(patch) => saveColumn(col, patch)}
          onAskAi={() => setAiTarget({ kind: 'column', col })}
          historyOpen={showColHistory === col.id}
          onToggleHistory={() => setShowColHistory(showColHistory === col.id ? null : col.id)}
        />
      ) : undefined,
    };
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg panel-enter">
      <ExplorerHeader
        crumbs={crumbs}
        icon={icon}
        title={title}
        technicalName={curator ? tbl.table_name : undefined}
        badges={curator ? (
          <>
            <span className="text-[10px] font-mono tracking-[0.08em] uppercase px-1.5 py-0.5 rounded border border-line bg-softer text-muted">
              {tbl.table_role}
            </span>
            <ApprovalBadge
              entityType="product_table"
              entityId={tbl.id}
              status={tbl.approval_status as 'draft' | 'pending_review' | 'approved' | 'rejected' | undefined}
              aiDraft={!!tbl.ai_draft}
              onChanged={onSaved}
              compact
            />
          </>
        ) : undefined}
        actions={(
          <>
            {curator && onAskAssistant && (
              <HeaderAction onClick={() => onAskAssistant('change')} icon={<WandSparkles className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />} title="Ask the assistant to change this table's SQL — it proposes a diff you keep or discard">
                Change with AI
              </HeaderAction>
            )}
            {askHref && (
              <HeaderAction href={askHref} primary icon={<MessageSquareText className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />} title="Ask a question about this subject in Ask AI">
                Ask AI
              </HeaderAction>
            )}
            {curator && parentProductId != null && (
              <MoreMenu items={[
                { label: 'Manage this topic', href: `/topics/${parentProductId}?manage=1`, icon: <Gauge className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> },
                { label: 'Open in the workshop', href: `/products/${parentProductId}`, icon: <Wrench className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> },
              ]} />
            )}
          </>
        )}
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
                <section className="bg-ocean-softer border border-ocean/30 rounded-lg px-4 py-3 flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-ocean shrink-0 mt-0.5" strokeWidth={2} aria-hidden />
                  <p className="text-[13px] text-ink leading-relaxed">
                    <span className="font-medium">Suggested by Clarion.</span> Read the description below; saving it confirms this table.
                  </p>
                </section>
              )}

              {/* Description — a sentence about the table, edited in place. */}
              <section className="bg-raised border border-line rounded-lg p-5">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h3 className="text-[13px] font-medium text-ink">Description</h3>
                  {curator && (
                    <button
                      type="button"
                      onClick={() => setAiTarget({ kind: 'table' })}
                      className="inline-flex items-center gap-1 text-[11.5px] text-ocean hover:text-ocean-hover transition-colors"
                      title="Ask AI to write or change this description"
                    >
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
                      className="w-full bg-raised border border-line rounded-md px-3 py-2 text-[13px] text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors resize-none"
                      placeholder="What is one row of this table?"
                    />
                    <button
                      type="button"
                      onClick={() => setMoreOpen((o) => !o)}
                      className="mt-3 inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink-2 transition-colors"
                      aria-expanded={moreOpen}
                    >
                      {moreOpen ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} aria-hidden />}
                      Name, owner and domains
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
                          <label className="block text-[11px] text-muted mb-1">Owner</label>
                          <input
                            value={tbl.owner_name ?? ''}
                            onChange={(e) => setTbl({ ...tbl, owner_name: e.target.value })}
                            className="w-full bg-raised border border-line rounded-md px-3 py-1.5 text-[13px] text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                            placeholder="Who answers for it"
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[11px] text-muted mb-1">Data domains</label>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {domains.map((tag) => (
                              <span key={tag} className="inline-flex items-center gap-1 text-[11px] bg-ai-soft text-ai border border-line rounded px-1.5 py-0.5">
                                {tag}
                                <button type="button" onClick={() => setTbl({ ...tbl, domains: domains.filter((d) => d !== tag) })} className="hover:text-ai/70 leading-none" aria-label={`Remove ${tag}`}>&times;</button>
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
                      <button
                        type="button"
                        onClick={saveTable}
                        disabled={savingTable}
                        className="px-4 py-1.5 bg-ocean text-white text-[12.5px] font-medium rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
                      >
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

              {/* THE columns — one list, filterable, edited in the cell. */}
              <section>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h3 className="text-[13px] font-medium text-ink">
                    Columns <span className="font-mono text-[11px] text-muted-2 tabular-nums ml-1">{cols.length}</span>
                  </h3>
                  {curator && (
                    <span className="text-[11.5px] text-muted">
                      {cols.filter((c) => !c.ai_draft).length} of {cols.length} confirmed
                    </span>
                  )}
                </div>
                <ColumnsTable
                  rows={rows}
                  onSaveDescription={curator ? async (id, text) => {
                    const col = cols.find((c) => c.id === id);
                    if (col) await saveColumn(col, { description: text });
                  } : undefined}
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
          <PreviewTable url={`/semantic/product-preview?productTableId=${pgTableId ?? tableId}&limit=25`} autoLoad />
        </div>
      )}

      {/* ── SQL — the declaration ─────────────────────────────────────────── */}
      {viewTab === 'sql' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {pgTableId != null ? (
            <SqlDeclaration tableId={pgTableId} canRebuild={curator} />
          ) : (
            <p className="px-6 py-6 text-[13px] text-muted">This table has no stored declaration to edit.</p>
          )}
        </div>
      )}

      {/* ── Lineage ───────────────────────────────────────────────────────── */}
      {viewTab === 'lineage' && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-raised px-6 py-2">
            <p className="text-[12px] text-muted">Which source columns feed this table, and how.</p>
            {parentProductId != null && (
              <a
                href={`/topics/${parentProductId}?manage=1`}
                className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors"
              >
                <Gauge className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                Manage this topic ↗
              </a>
            )}
          </div>
          <LineageGraph layer="product" tableId={pgTableId ?? tableId} />
        </div>
      )}

      {/* ── Quality ───────────────────────────────────────────────────────── */}
      {viewTab === 'quality' && (
        productConnectionId != null ? (
          <QualityPanel connId={productConnectionId} tableName={tbl.table_name} productTableId={tableId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-2 text-sm p-6 text-center max-w-md mx-auto">
            Quality needs a source. This subject is not linked to one yet.
          </div>
        )
      )}

      {/* ── History ───────────────────────────────────────────────────────── */}
      {viewTab === 'history' && (
        <div className="flex-1 overflow-y-auto px-6 py-6">
          <HistoryPanel entityType="product_table" entityId={tbl.id} entityName={title} />
        </div>
      )}

      {/* Ask AI to change a description — fills the field; the person saves. */}
      {aiTarget && aiTarget.kind === 'table' && (
        <AiPromptDialog
          entityType="table"
          entityId={tbl.id}
          entityName={title}
          currentDescription={tbl.description ?? ''}
          endpoint={`/semantic/product-tables/${tbl.id}/improve-description`}
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
          endpoint={`/semantic/product-columns/${aiTarget.col.id}/improve-description`}
          onAccept={(text) => { void saveColumn(aiTarget.col, { description: text }); }}
          onClose={() => setAiTarget(null)}
        />
      )}
    </div>
  );
}

/** Under a column row: what a description cell cannot hold. Curators only. */
function ColumnDetails({
  col, onChange, onSave, onAskAi, historyOpen, onToggleHistory,
}: {
  col: ProductColumn;
  onChange: (patch: Partial<ProductColumn>) => void;
  onSave: (patch: Partial<ProductColumn>) => Promise<void>;
  onAskAi: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const facts: Array<{ label: string; value: string }> = [];
  if (col.fk_target_table) facts.push({ label: 'Points at', value: `${col.fk_target_table}${col.fk_target_column ? `.${col.fk_target_column}` : ''}` });
  if (col.additivity) facts.push({ label: 'Adds up', value: col.additivity });
  if (col.scd_type > 1) facts.push({ label: 'History', value: `Type ${col.scd_type}` });
  if (col.transformation_expression) facts.push({ label: 'Computed as', value: col.transformation_expression });

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
      {facts.length > 0 && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1">
          {facts.map((f) => (
            <div key={f.label} className="flex items-baseline gap-2 text-[12px] min-w-0">
              <dt className="text-muted shrink-0">{f.label}</dt>
              <dd className="font-mono text-ink-2 truncate max-w-[420px]" title={f.value}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {historyOpen && (
        <div className="pt-3 border-t border-line/60">
          <HistoryPanel entityType="product_column" entityId={col.id} entityName={col.display_name || col.column_name} />
        </div>
      )}
    </div>
  );
}
