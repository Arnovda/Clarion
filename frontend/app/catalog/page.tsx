'use client';

/**
 * /catalog — the workspace.
 *
 * ONE tree on the left (subjects with their tables, sources under their own
 * mark, your tables) and ONE view on the right. Nothing selected = what needs
 * you (the landing: suggestions waiting, sources not yet analysed, the health
 * overview). A subject = its page. A product table = its DECLARATION: what it
 * holds, where it comes from, the SQL that builds it — editable in place, one
 * verb (Save). A source or a source table = the review surfaces they had.
 *
 * The assistant floats bottom-right, aimed at whatever is selected. A change
 * it proposes never lands here: it appears ON the declaration as a diff with
 * Keep / Discard (catalogAssistantContext), and Keep is the editor's own Save.
 *
 * Retired 2026-09-22 (owner: "Catalog should be THE place where we work …
 * simple and effective, clear responsibilities"): the All / Sources / Products
 * chips, the Grid / List / Structure control, the card grid and its hero, the
 * preview inset, and the Trust and Glossary facets — health lives on the
 * landing, the glossary is the Definitions pane. The URL stayed the same, so
 * every existing deep link still lands; lib/catalogUrl.ts reads them.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import RequireRole from '@/components/RequireRole';
import CatalogBrowser, {
  type CatalogSchemaSelection,
  type CatalogSelection,
} from '@/components/catalog/CatalogBrowser';
import EntityDetailPanel, { type EntitySelection } from '@/components/catalog/EntityDetailPanel';
import CatalogLanding from '@/components/catalog/CatalogLanding';
import CatalogAssistant, {
  type AssistantScope,
  type CatalogChatMessage,
} from '@/components/catalog/CatalogAssistant';
import {
  CatalogAssistantProvider,
  type ProposalDecision,
  type SqlProposal,
} from '@/components/catalog/catalogAssistantContext';
import { catalogHref, parseCatalogUrl, type CatalogIntent } from '@/lib/catalogUrl';
import { catalogApi, parseIdFromSlug, type CatalogId, type SchemaEntry } from '@/lib/catalog';
import { askSubjectAssistant, type AssistantTurn } from '@/lib/subjectAssistant';
import { canCurate, useRole } from '@/lib/role';
import api from '@/lib/api';
import { getItem, setItem, storageKeys } from '@/lib/storage';
import type { ProductTreeItem } from '@/components/semantic/types';
import type { CatalogConnection, CatalogNavTarget } from '@/components/catalog/navigation';
import {
  useCoworker, useCoworkerChanged, useCoworkerFocusHandler, useCoworkerPageContext,
} from '@/lib/coworker/CoworkerProvider';
import type { CoworkerFocus, CoworkerPageContext } from '@/lib/contract';

type Connection = CatalogConnection;

/** A product table resolved against the product tree: both id spaces, and
 *  the names the assistant's scope chip shows. */
interface ResolvedTable {
  graphId: number;
  pgId: number;
  productId: number;
  productName: string;
  label: string;
  /** Set when this is a COPY of a shared lookup: the original's graph id. */
  ownerGraphId: number | null;
  /** A copy whether or not its original could be found. */
  isCopy: boolean;
}

const MAX_MESSAGES = 40;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error ?? e.message ?? fallback;
}

function isAbort(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === 'CanceledError' || e?.name === 'AbortError' || e?.code === 'ERR_CANCELED';
}

/**
 * The table a selection should OPEN: a copy of a shared lookup (Purchasing's
 * Journal) is not a table in its own right — it has no SQL and no data of its
 * own — so every door that lands on one (an old link, the Relations diagram,
 * lineage, "Also used in") opens its original instead. A copy whose original
 * cannot be found stays itself; its panel says it is shared data.
 */
function canonicalTreeTable(tree: ProductTreeItem[], tableId: number): ResolvedTable | null {
  const found = findTreeTable(tree, tableId);
  if (!found?.isCopy || found.ownerGraphId == null) return found;
  return findTreeTable(tree, found.ownerGraphId) ?? found;
}

function findTreeTable(tree: ProductTreeItem[], tableId: number): ResolvedTable | null {
  for (const p of tree) {
    for (const s of p.starSchemas ?? []) {
      for (const t of s.tables ?? []) {
        const pgId = t.pg_table_id ?? null;
        if (t.id === tableId || pgId === tableId) {
          return {
            graphId: t.id,
            pgId: pgId ?? tableId,
            productId: p.productId,
            productName: p.productName,
            label: t.display_name || t.table_name,
            ownerGraphId: t.owner_graph_id ?? t.owner_pg_table_id ?? null,
            isCopy: t.is_copy === true,
          };
        }
      }
    }
  }
  return null;
}

function CatalogInner() {
  const router = useRouter();
  const params = useSearchParams();
  const role = useRole();
  const curator = canCurate(role);

  // ── Selection ─────────────────────────────────────────────────────────────
  // The tree highlights by (catalog, schema slug, table id); the view opens by
  // ids. Both are kept, and every way of selecting sets both — the tree, a
  // pasted link, the assistant.
  const [tableSel, setTableSel]                 = useState<CatalogSelection | null>(null);
  const [schemaSel, setSchemaSel]               = useState<{ catalog: CatalogId; schemaSlug: string; schemaLabel?: string } | null>(null);
  const [productRootId, setProductRootId]       = useState<number | null>(null);
  const [sourceRootConnId, setSourceRootConnId] = useState<number | null>(null);
  const [initialTab, setInitialTab]             = useState<'sql' | undefined>(undefined);
  const [treeSearch, setTreeSearch]             = useState('');

  const clearSelection = useCallback((writeUrl = true) => {
    setTableSel(null);
    setSchemaSel(null);
    setProductRootId(null);
    setSourceRootConnId(null);
    setInitialTab(undefined);
    if (writeUrl) router.replace('/catalog');
  }, [router]);

  const handleSelectTable = useCallback((sel: CatalogSelection) => {
    setTreeSearch('');
    setTableSel(sel);
    setSchemaSel({ catalog: sel.catalog, schemaSlug: sel.schemaSlug, schemaLabel: sel.schemaLabel });
    setProductRootId(null);
    setSourceRootConnId(null);
    setInitialTab(undefined);
    const id = Number(sel.tableId);
    if (sel.catalog === 'products') {
      router.replace(catalogHref({ kind: 'table', tableId: id }));
    } else {
      const connectionId = parseIdFromSlug(sel.schemaSlug);
      router.replace(connectionId
        ? catalogHref({ kind: 'source-table', tableId: id, connectionId })
        : '/catalog');
    }
  }, [router]);

  const handleSelectSchema = useCallback((sel: CatalogSchemaSelection) => {
    setTableSel(null);
    setInitialTab(undefined);
    setSchemaSel({ catalog: sel.catalog, schemaSlug: sel.schemaSlug, schemaLabel: sel.schemaLabel });
    if (sel.catalog === 'products') {
      const productId = sel.schemaMeta?.dataProductId ?? parseIdFromSlug(sel.schemaSlug);
      if (!productId) return;
      setProductRootId(productId);
      setSourceRootConnId(null);
      router.replace(catalogHref({ kind: 'subject', productId }));
    } else {
      const connectionId = sel.schemaMeta?.connectionId ?? parseIdFromSlug(sel.schemaSlug);
      if (!connectionId) return;
      setSourceRootConnId(connectionId);
      setProductRootId(null);
      router.replace(catalogHref({ kind: 'source', connectionId }));
    }
  }, [router]);

  // ── The product tree, read once and shared ────────────────────────────────
  // The tree's table ids are graph ids; the declaration (and the assistant's
  // proposals) address the Postgres row. The product tree carries both.
  const treeRef = useRef<Promise<ProductTreeItem[]> | null>(null);
  const getProductTree = useCallback((fresh = false): Promise<ProductTreeItem[]> => {
    if (fresh || !treeRef.current) {
      treeRef.current = api.get('/semantic/product-tree')
        .then((r) => (r.data?.data ?? []) as ProductTreeItem[])
        .catch(() => { treeRef.current = null; return [] as ProductTreeItem[]; });
    }
    return treeRef.current;
  }, []);

  // `schemaFor` is declared below; the copy → original redirect needs it.
  const schemaForRef = useRef<((catalog: CatalogId, id: number) => Promise<SchemaEntry | null>) | null>(null);
  const [resolvedTable, setResolvedTable] = useState<ResolvedTable | null>(null);
  useEffect(() => {
    if (!tableSel || tableSel.catalog !== 'products') { setResolvedTable(null); return; }
    const wanted = Number(tableSel.tableId);
    let cancelled = false;
    getProductTree().then((tree) => {
      if (cancelled) return;
      const found = findTreeTable(tree, wanted);
      const canonical = canonicalTreeTable(tree, wanted);
      if (found && canonical && canonical.graphId !== found.graphId) {
        // Landed on a copy — open the original (see canonicalTreeTable).
        void schemaForRef.current?.('products', canonical.productId).then((schema) => {
          if (cancelled) return;
          handleSelectTable({
            catalog: 'products', schemaSlug: schema?.id ?? '', schemaLabel: schema?.label ?? canonical.productName,
            tableId: String(canonical.graphId), tableLabel: canonical.label, tableName: null,
          });
        });
        return;
      }
      setResolvedTable(found);
    });
    return () => { cancelled = true; };
  }, [tableSel, getProductTree, handleSelectTable]);

  // The tree highlights by schema SLUG; a panel or a link knows an id. This
  // finds the slug the way the tree does, so both agree on what is selected.
  const schemaFor = useCallback(async (catalog: CatalogId, id: number): Promise<SchemaEntry | null> => {
    try {
      const schemas = await catalogApi.schemas(catalog);
      return schemas.find((s) => (catalog === 'products'
        ? (s.meta?.dataProductId ?? parseIdFromSlug(s.id)) === id
        : (s.meta?.connectionId ?? parseIdFromSlug(s.id)) === id)) ?? null;
    } catch { return null; }
  }, []);
  schemaForRef.current = schemaFor;

  // ── Deep links, read once on mount ────────────────────────────────────────
  // A pasted link must land on the thing it names AND light it in the tree,
  // so the slug the tree uses is looked up the way the tree itself does.
  const deepLinkDoneRef = useRef(false);
  useEffect(() => {
    if (deepLinkDoneRef.current) return;
    deepLinkDoneRef.current = true;
    const intent: CatalogIntent = parseCatalogUrl(new URLSearchParams(params.toString()));
    if (intent.kind === 'none') return;
    if (intent.kind === 'definitions') { router.replace('/definitions'); return; }

    (async () => {
      if (intent.kind === 'subject') {
        setProductRootId(intent.productId);
        const schema = await schemaFor('products', intent.productId);
        if (schema) setSchemaSel({ catalog: 'products', schemaSlug: schema.id, schemaLabel: schema.label });
        return;
      }
      if (intent.kind === 'source') {
        setSourceRootConnId(intent.connectionId);
        const schema = await schemaFor('sources', intent.connectionId);
        if (schema) setSchemaSel({ catalog: 'sources', schemaSlug: schema.id, schemaLabel: schema.label });
        return;
      }
      if (intent.kind === 'source-table') {
        const schema = await schemaFor('sources', intent.connectionId);
        if (!schema) { setSourceRootConnId(intent.connectionId); return; }
        let label = `Table ${intent.tableId}`;
        try {
          const tables = await catalogApi.tables('sources', schema.id);
          const hit = tables.find((t) => Number(t.id) === intent.tableId);
          if (hit) label = hit.label;
        } catch { /* the label is cosmetic */ }
        setSchemaSel({ catalog: 'sources', schemaSlug: schema.id, schemaLabel: schema.label });
        setTableSel({ catalog: 'sources', schemaSlug: schema.id, schemaLabel: schema.label, tableId: String(intent.tableId), tableLabel: label, tableName: null });
        return;
      }
      if (intent.kind === 'table') {
        const found = canonicalTreeTable(await getProductTree(), intent.tableId);
        if (!found) { setTreeSearch(String(intent.tableId)); return; }
        // A link to a COPY opened its original: the address bar says so too,
        // so a link copied from here points at where the table lives.
        if (found.graphId !== intent.tableId && found.pgId !== intent.tableId) {
          router.replace(catalogHref({ kind: 'table', tableId: found.graphId }));
        }
        const schema = await schemaFor('products', found.productId);
        const slug = schema?.id ?? '';
        setSchemaSel({ catalog: 'products', schemaSlug: slug, schemaLabel: schema?.label ?? found.productName });
        setTableSel({ catalog: 'products', schemaSlug: slug, schemaLabel: schema?.label ?? found.productName, tableId: String(found.graphId), tableLabel: found.label, tableName: null });
        return;
      }
      if (intent.kind === 'table-by-name') {
        // Links that only know a NAME (the dashboard filter popover's
        // `dim_item`): an exact hit opens it; anything else lands in the
        // tree's search instead of a dead end.
        const nameLc = intent.name.toLowerCase();
        try {
          const hits = await catalogApi.search(intent.name);
          const exact = hits.find((h) => h.kind === 'table' && h.catalog === 'products'
            && (h.tableName?.toLowerCase() === nameLc || h.tableLabel.toLowerCase() === nameLc))
            ?? hits.find((h) => h.kind === 'table' && h.tableName?.toLowerCase() === nameLc);
          if (exact) {
            setSchemaSel({ catalog: exact.catalog, schemaSlug: exact.schemaSlug, schemaLabel: exact.schemaLabel });
            setTableSel({ catalog: exact.catalog, schemaSlug: exact.schemaSlug, schemaLabel: exact.schemaLabel, tableId: exact.tableId, tableLabel: exact.tableLabel, tableName: exact.tableName, role: exact.role });
            return;
          }
        } catch { /* fall through to search */ }
        setTreeSearch(intent.name.replace(/^(dim|fact|rollup_monthly)_/, '').replace(/_/g, ' '));
      }
    })();
  // Mount-time only: the URL afterwards is written by the selections above,
  // and the user's navigation must not be fought by it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Navigation asked for by a panel (a breadcrumb, a "used in" chip) ──────
  // Does what the matching tree click does, so the tree, the URL and the view
  // move together — the page owns the selection, a panel never writes it.
  const navigateTo = useCallback(async (target: CatalogNavTarget) => {
    if (target.kind === 'catalog') { clearSelection(); return; }
    if (target.kind === 'subject') {
      const schema = await schemaFor('products', target.productId);
      handleSelectSchema({ catalog: 'products', schemaSlug: schema?.id ?? `subject_${target.productId}`, schemaLabel: schema?.label ?? 'Subject', schemaMeta: schema?.meta ?? { dataProductId: target.productId } });
      return;
    }
    if (target.kind === 'source') {
      const schema = await schemaFor('sources', target.connectionId);
      handleSelectSchema({ catalog: 'sources', schemaSlug: schema?.id ?? `source_${target.connectionId}`, schemaLabel: schema?.label ?? 'Source', schemaMeta: schema?.meta ?? { connectionId: target.connectionId } });
      return;
    }
    if (target.kind === 'source-table') {
      const schema = await schemaFor('sources', target.connectionId);
      const slug = schema?.id ?? `source_${target.connectionId}`;
      handleSelectTable({ catalog: 'sources', schemaSlug: slug, schemaLabel: schema?.label ?? 'Source', tableId: String(target.tableId), tableLabel: `Table ${target.tableId}`, tableName: null });
      return;
    }
    if (target.kind === 'table') {
      const found = canonicalTreeTable(await getProductTree(), target.tableId);
      if (!found) return;
      const schema = await schemaFor('products', found.productId);
      handleSelectTable({ catalog: 'products', schemaSlug: schema?.id ?? '', schemaLabel: schema?.label ?? found.productName, tableId: String(found.graphId), tableLabel: found.label, tableName: null });
      // After the select, which resets the tab: a table just added lands on
      // its SQL so the next act is to declare it.
      if (target.tab) setInitialTab(target.tab);
    }
  }, [clearSelection, schemaFor, handleSelectSchema, handleSelectTable, getProductTree]);

  // ── Connections (names, marks and domains for the panels) ─────────────────
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    api.get('/connections').then((res) => setConnections(res.data.data ?? [])).catch(() => {});
  }, []);

  // ── What the view shows ───────────────────────────────────────────────────
  const selection = useMemo<EntitySelection>(() => {
    if (tableSel) {
      const id = Number(tableSel.tableId);
      if (!Number.isFinite(id)) return { scope: 'empty' };
      if (tableSel.catalog === 'sources') {
        const connectionId = parseIdFromSlug(tableSel.schemaSlug);
        if (!connectionId) return { scope: 'empty' };
        return { scope: 'source-table', tableId: id, connectionId };
      }
      return { scope: 'product-table', tableId: id, initialTab };
    }
    if (productRootId) return { scope: 'product-root', productId: productRootId };
    if (sourceRootConnId) return { scope: 'source-root', connectionId: sourceRootConnId };
    return { scope: 'empty' };
  }, [tableSel, productRootId, sourceRootConnId, initialTab]);

  // A save inside any panel remounts the tree so labels and counts follow.
  const [refreshKey, setRefreshKey] = useState(0);
  const handleSaved = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void getProductTree(true);
  }, [getProductTree]);

  // ── The assistant ─────────────────────────────────────────────────────────
  const [assistantOpen, setAssistantOpen] = useState(false);
  useEffect(() => { setAssistantOpen(getItem(storageKeys.catalogAssistantOpen) === '1'); }, []);
  const updateAssistantOpen = useCallback((open: boolean) => {
    setAssistantOpen(open);
    setItem(storageKeys.catalogAssistantOpen, open ? '1' : '0');
  }, []);

  const [messages, setMessages] = useState<CatalogChatMessage[]>([]);
  const [input, setInput]       = useState('');
  const [mode, setMode]         = useState<'ask' | 'change'>('ask');
  const [loading, setLoading]   = useState(false);
  const [proposal, setProposal] = useState<SqlProposal | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<{ tableId: number; sql: string } | null>(null);

  const scope = useMemo<AssistantScope>(() => {
    if (selection.scope === 'product-table') {
      const label = resolvedTable
        ? `${resolvedTable.productName} › ${resolvedTable.label}`
        : (tableSel?.tableLabel ?? 'this table');
      return {
        kind: 'table',
        label,
        tableId: resolvedTable?.pgId ?? null,
        productId: resolvedTable?.productId ?? null,
        canChange: curator && resolvedTable != null,
      };
    }
    if (selection.scope === 'product-root') {
      return { kind: 'subject', label: schemaSel?.schemaLabel ?? 'this subject', productId: selection.productId, canChange: false };
    }
    if (selection.scope === 'source-root') {
      return { kind: 'source', label: schemaSel?.schemaLabel ?? 'this source', canChange: false };
    }
    if (selection.scope === 'source-table') {
      return { kind: 'source-table', label: tableSel?.tableLabel ?? 'this table', canChange: false };
    }
    return { kind: 'none', label: 'the catalog', canChange: false };
  }, [selection, resolvedTable, tableSel, schemaSel, curator]);

  // A change needs a product table under a curator; anywhere else the box asks.
  useEffect(() => { if (!scope.canChange && mode === 'change') setMode('ask'); }, [scope.canChange, mode]);

  const pushMessage = useCallback((msg: CatalogChatMessage) => {
    setMessages((prev) => [...prev, msg].slice(-MAX_MESSAGES));
  }, []);
  const patchMessage = useCallback((id: string, patch: Partial<CatalogChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    const changing = mode === 'change' && scope.canChange && scope.tableId != null;
    const userMsg: CatalogChatMessage = { id: newId(), role: 'user', text, scopeLabel: scope.label, mode: changing ? 'change' : 'ask' };
    const workingId = newId();
    const controller = new AbortController();
    abortRef.current = controller;
    setInput('');
    setLoading(true);
    pushMessage(userMsg);
    pushMessage({ id: workingId, role: 'assistant', text: '', working: true, startedAt: Date.now(), mode: changing ? 'change' : 'ask', scopeLabel: scope.label });

    try {
      if (changing) {
        const held = draftRef.current;
        const draft = held && held.tableId === scope.tableId ? held.sql : undefined;
        const res = await api.post(`/products/tables/${scope.tableId}/sql/propose`, { instruction: text, ...(draft ? { sql: draft } : {}) }, { signal: controller.signal });
        const data = res.data?.data ?? {};
        if (!data.proposed) {
          patchMessage(workingId, { text: String(data.summary || 'No change was needed.'), working: false, decision: 'none' });
        } else {
          const id = newId();
          setProposal({
            id,
            tableId: scope.tableId!,
            sql: String(data.sql ?? ''),
            summary: String(data.summary ?? ''),
            compiled: Boolean(data.compiled),
            error: data.error ?? null,
            columns: data.columns ?? undefined,
          });
          setInitialTab('sql');
          const note = data.compiled
            ? 'The change is on the table as a diff — Keep saves it, Discard keeps your SQL.'
            : 'The change did not compile; the diff shows where. Keep is disabled until it does.';
          patchMessage(workingId, { id, text: `${data.summary ? `${data.summary}\n\n` : ''}${note}`, working: false, decision: 'pending' });
        }
      } else {
        const history: AssistantTurn[] = [...messages, userMsg]
          .filter((m) => !m.working && m.text)
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.text }));
        const reply = await askSubjectAssistant(history, scope.productId ?? null, scope.tableId ?? null, { signal: controller.signal });
        const extra = reply.proposal
          ? `\n\nThis would be a new subject (${reply.proposal.name}). The Build page can add it alongside what you have.`
          : '';
        patchMessage(workingId, { text: (reply.reply || 'I could not find anything to say about that.') + extra, working: false, decision: 'none' });
      }
    } catch (err) {
      if (isAbort(err)) {
        // Stopped: nothing was written; the words go back into the box.
        setMessages((prev) => prev.filter((m) => m.id !== workingId && m.id !== userMsg.id));
        setInput(text);
      } else {
        patchMessage(workingId, { text: 'Could not do that.', working: false, errorDetail: errorText(err, 'The assistant did not answer.') });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
    }
  }, [input, loading, mode, scope, messages, pushMessage, patchMessage]);

  // The editor reports back: the draft it holds, and what became of a proposal.
  const reportDraft = useCallback((tableId: number, sql: string) => { draftRef.current = { tableId, sql }; }, []);
  const decide = useCallback((proposalId: string, decision: ProposalDecision) => {
    setProposal((p) => (p && p.id === proposalId ? null : p));
    patchMessage(proposalId, { decision });
    if (decision === 'kept') handleSaved();
  }, [patchMessage, handleSaved]);
  const assistantContext = useMemo(() => ({ proposal, reportDraft, decide }), [proposal, reportDraft, decide]);

  // ── The Studio coworker (flag `ai_coworker`) ──────────────────────────────
  // When it is on for this tenant it REPLACES the floating assistant above:
  // the page tells it what is selected, lets it move the selection (Follow
  // along), shows its SQL proposals as the same diff on the declaration, and
  // refreshes when something it proposed was kept. When the flag is off,
  // everything below is inert and the page is exactly what it was.
  const cw = useCoworker();
  const coworkerOn = cw?.enabled === true;
  const coworkerContext = useMemo<CoworkerPageContext | null>(() => {
    if (!coworkerOn) return null;
    const base: CoworkerPageContext = { path: '/catalog', label: scope.kind === 'none' ? null : scope.label };
    if (selection.scope === 'product-table') return { ...base, tableId: resolvedTable?.pgId ?? null, productId: resolvedTable?.productId ?? null };
    if (selection.scope === 'product-root') return { ...base, productId: selection.productId };
    if (selection.scope === 'source-root') return { ...base, connectionId: selection.connectionId };
    if (selection.scope === 'source-table') return { ...base, sourceTableId: selection.tableId, connectionId: selection.connectionId };
    return base;
  }, [coworkerOn, scope, selection, resolvedTable]);
  useCoworkerPageContext(coworkerContext);
  // The canvas, "Your tables" and Definitions are not the catalog's to show:
  // returning false hands them back to the provider, which opens their page.
  const followCoworker = useCallback((f: CoworkerFocus) => {
    if (f.kind === 'relations' || f.kind === 'grid' || f.kind === 'definitions') return false;
    void navigateTo(f);
    return true;
  }, [navigateTo]);
  useCoworkerFocusHandler(coworkerOn ? followCoworker : null);
  // A kept change remounts the view so the declaration shows what is stored.
  const [detailKey, setDetailKey] = useState(0);
  const onCoworkerChanged = useCallback(() => { handleSaved(); setDetailKey((k) => k + 1); }, [handleSaved]);
  useCoworkerChanged(onCoworkerChanged);
  const coworkerSqlProposal = useMemo<SqlProposal | null>(() => {
    if (!coworkerOn || !cw || resolvedTable == null) return null;
    const pending = Object.values(cw.proposals)
      .filter((st) => st.status === 'pending' && st.proposal.kind === 'sql' && st.proposal.tableId === resolvedTable.pgId);
    const last = pending[pending.length - 1];
    if (!last || last.proposal.kind !== 'sql') return null;
    const p = last.proposal;
    return { id: p.id, tableId: p.tableId, sql: p.after, summary: p.summary, compiled: p.compiled, error: p.error ?? null };
  }, [coworkerOn, cw, resolvedTable]);
  const coworkerAssistantContext = useMemo(() => ({
    proposal: coworkerSqlProposal,
    reportDraft,
    decide: (id: string, decision: ProposalDecision) => {
      cw?.markDecided(id, decision);
      if (decision === 'kept') handleSaved();
    },
  }), [coworkerSqlProposal, reportDraft, cw, handleSaved]);

  // Leaving the table drops its unanswered proposal — a diff nobody can see
  // must not be kept waiting.
  useEffect(() => {
    if (proposal && proposal.tableId !== (resolvedTable?.pgId ?? -1)) {
      setProposal(null);
      patchMessage(proposal.id, { decision: 'discarded' });
    }
  }, [proposal, resolvedTable, patchMessage]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <CatalogAssistantProvider value={coworkerOn ? coworkerAssistantContext : assistantContext}>
      <div className="flex flex-1 min-h-0">
        <aside className="flex-shrink-0 border-r border-line flex flex-col" style={{ width: 280 }}>
          <div className="px-3 pt-2.5 pb-2 border-b border-line bg-soft space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-ink">Catalog</span>
              <button
                type="button"
                onClick={handleSaved}
                className="p-1 rounded text-muted-2 hover:text-ink hover:bg-softer transition-colors"
                title="Reload the tree"
                aria-label="Reload the tree"
              >
                <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </div>
            <TreeSearchInput value={treeSearch} onChange={setTreeSearch} onClear={() => setTreeSearch('')} />
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <CatalogBrowser
              key={`browser-${refreshKey}`}
              selected={tableSel}
              selectedSchema={schemaSel}
              onSelectTable={handleSelectTable}
              onSelectSchema={handleSelectSchema}
              searchValue={treeSearch}
            />
          </div>
        </aside>

        {/* `relative`: the assistant is positioned against this column, so it
            floats over the view and never over the tree. */}
        <section className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
          <EntityDetailPanel
            key={`detail-${detailKey}`}
            selection={selection}
            connections={connections}
            onSaved={handleSaved}
            onClose={() => clearSelection()}
            onNavigate={(target) => { void navigateTo(target); }}
            empty={<CatalogLanding curator={curator} />}
          />
          {curator && !coworkerOn && (
            <CatalogAssistant
              open={assistantOpen}
              onOpenChange={updateAssistantOpen}
              scope={scope}
              messages={messages}
              loading={loading}
              mode={mode}
              onModeChange={setMode}
              input={input}
              onInputChange={setInput}
              onSubmit={() => { void handleSubmit(); }}
              onStop={handleStop}
            />
          )}
        </section>
      </div>
    </CatalogAssistantProvider>
  );
}

/**
 * Compact search above the tree. Thin border, clears on Esc so the user
 * never has to grab the mouse to bail.
 */
function TreeSearchInput({
  value, onChange, onClear,
}: { value: string; onChange: (s: string) => void; onClear: () => void }) {
  return (
    <div className="relative">
      <Search
        className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-2 pointer-events-none"
        strokeWidth={1.75}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onClear(); }}
        placeholder="Search tables or columns…"
        className="w-full pl-8 pr-7 py-1.5 text-[12px] bg-raised border border-line rounded text-ink-2 placeholder:text-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
      />
      {value && (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-soft text-muted-2 hover:text-ink"
          aria-label="Clear search"
        >
          <X className="w-3 h-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export default function CatalogPage() {
  return (
    <RequireRole roles={['admin', 'analyst', 'viewer']}>
      <Suspense fallback={
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      }>
        <CatalogInner />
      </Suspense>
    </RequireRole>
  );
}
