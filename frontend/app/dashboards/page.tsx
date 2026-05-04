'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Copy, Star, X, Lightbulb, Zap, FileText, Settings } from 'lucide-react';
// We import only the helpers — the picker buttons need to recolor based on
// selection state, so they can't use <SourceBadge> directly. Keeping the
// grouping rule shared via the helpers preserves cross-page consistency.
import { productSourceGroupKey, productSourceGroupLabel } from '@/components/SourceBadge';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import { useToast } from '@/components/ui/Toast';

// ─── Extracted types ─────────────────────────────────────────────────────────
import type {
  FilterSpec,
  WidgetSpec,
  DashboardSpec,
  SavedDashboard,
  DashboardTemplate,
  WidgetData,
  DrillState,
  RefinementQuestion,
  ChatMessage,
} from './types';

// ─── Extracted utilities ─────────────────────────────────────────────────────
import { buildDefaultFilters, relTime } from './utils/format';
import { containerVariants, slideUp, shimmerClass } from './utils/motion';

// ─── Extracted components ────────────────────────────────────────────────────
import { WidgetCard } from './components/WidgetCard';
import { KpiCard } from './components/KpiCard';
import {
  BarChartWidget,
  VerticalBarChartWidget,
  LineChartWidget,
  StackedBarChartWidget,
  PieChartWidget,
  TopListWidget,
  DataTableWidget,
  ComboChartWidget,
  RadarChartWidget,
  TreemapWidget,
  PivotTableWidget,
} from './components/ChartWidgets';
import { FilterBar } from './components/FilterBar';
import { MarkdownAnswer } from './components/MarkdownAnswer';
import { CreateInput } from './components/CreateInput';
import { EmptyDashboardHero } from './components/EmptyDashboardHero';
import { EmailSchedulePanel } from './components/EmailSchedulePanel';
import { DrillDetailModal } from './components/DrillDetailModal';
import { InsightsStrip, InsightsStripSkeleton } from './components/InsightsStrip';
import { InvestigationPanel } from './components/InvestigationPanel';
import { StoryModal } from './components/StoryModal';
import { downloadFile } from './utils/download';

// ─── Constants ───────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ─── Main page ───────────────────────────────────────────────────────────────

export default function DashboardsPage() {
  const toast = useToast();
  const [dashboards, setDashboards] = useState<SavedDashboard[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [currentSpec, setCurrentSpec] = useState<DashboardSpec | null>(null);
  const [isUnsaved, setIsUnsaved] = useState(false);
  const [mode, setMode] = useState<'empty' | 'choosing' | 'refining' | 'creating' | 'viewing'>('empty');
  const [createInput, setCreateInput] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [refinementQuestions, setRefinementQuestions] = useState<RefinementQuestion[]>([]);
  const [refinementAnswers, setRefinementAnswers] = useState<Record<number, string>>({});
  const [refinementLoading, setRefinementLoading] = useState(false);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [filterOptions, setFilterOptions] = useState<Record<string, string[]>>({});
  const [widgetData, setWidgetData] = useState<Record<string, WidgetData>>({});
  const [crossFilter, setCrossFilter] = useState<DrillState | null>(null);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [refineInput, setRefineInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [availableDomains,  setAvailableDomains]  = useState<string[]>([]);
  const [selectedDomains,   setSelectedDomains]   = useState<string[]>([]);
  const [connectionId,      setConnectionId]      = useState<number>(1);
  const [connections,       setConnections]       = useState<{ id: number; name: string; domains: string[] }[]>([]);
  const [products, setProducts] = useState<{
    id: number;
    name: string;
    description: string;
    status: string;
    /** Server-derived primary source. See `frontend/components/SourceBadge.tsx`. */
    source?: {
      id: number | null;
      name: string | null;
      connectorType: string | null;
      multiSource: boolean;
      sourceDeleted?: boolean;
      otherSources?: Array<{ id: number; name: string; connectorType: string | null }>;
    };
  }[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  // Default = product layer. Toggle visible to admins for opt-in source-layer dashboards.
  const [useSourceLayer, setUseSourceLayer] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showShared, setShowShared] = useState(false);
  const [templates, setTemplates] = useState<DashboardTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [autoRefreshActive, setAutoRefreshActive] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drillModal, setDrillModal] = useState<{ title: string; loading: boolean; rows: Record<string, unknown>[] } | null>(null);
  const [insights, setInsights] = useState<string[] | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsDismissed, setInsightsDismissed] = useState(false);
  const [investigationTarget, setInvestigationTarget] = useState<{ spec: WidgetSpec; data: WidgetData } | null>(null);
  const [storyOpen, setStoryOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dashboardGridRef = useRef<HTMLDivElement>(null);
  const widgetCacheRef = useRef<Record<string, WidgetData>>({});

  // ── Load saved dashboards ──────────────────────────────────────────────────

  const loadDashboards = useCallback(async () => {
    try {
      const res = await api.get('/dashboards');
      const sorted = (res.data.data as SavedDashboard[]).sort((a, b) => {
        if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });
      setDashboards(sorted);
    } catch {
      // ignore -- may not be connected yet
    }
  }, []);

  // ── Execute all widgets in a single batch request ─────────────────────────

  const executeAllWidgets = useCallback(
    async (
      spec: DashboardSpec,
      filters: Record<string, string>,
      xFilter: DrillState | null,
      connId: number,
    ) => {
      const hasCachedData = Object.keys(widgetCacheRef.current).length > 0;

      // First load: show skeletons. Subsequent calls (filter changes): keep showing
      // cached data while the background request is in flight (stale-while-revalidate).
      if (!hasCachedData) {
        setWidgetData((prev) => {
          const next = { ...prev };
          for (const w of spec.widgets) next[w.id] = { rows: [], loading: true };
          return next;
        });
      } else {
        // Mark cached entries as revalidating so widgets can show a subtle indicator
        setWidgetData((prev) => {
          const next = { ...prev };
          for (const w of spec.widgets) {
            const cached = next[w.id];
            if (cached && !cached.loading) next[w.id] = { ...cached, revalidating: true };
          }
          return next;
        });
      }

      const widgetsPayload = spec.widgets.map((widget) => {
        const isDrilled = xFilter?.widgetId === widget.id && widget.drillDownSql;
        const sql = isDrilled ? widget.drillDownSql! : widget.sql;
        return {
          id: widget.id,
          sql,
          filterValues: {
            ...filters,
            ...(isDrilled ? { drill_value: xFilter!.value } : {}),
            ...(xFilter ? { [`xf_${xFilter.key}`]: xFilter.value } : {}),
          },
        };
      });

      try {
        const res = await api.post('/dashboards/batch-execute', {
          connectionId: connId,
          widgets: widgetsPayload,
          ...(spec.dataLayer === 'source' ? { dataLayer: 'source' as const } : {}),
        });

        if (res.data.ok) {
          const results = res.data.data.results as Record<string, { rows?: Record<string, unknown>[]; error?: string }>;
          const newEntries: Record<string, WidgetData> = {};
          for (const [id, r] of Object.entries(results)) {
            newEntries[id] = r.error
              ? { rows: [], loading: false, error: r.error }
              : { rows: r.rows ?? [], loading: false };
          }
          // Update the client-side cache with fresh data
          widgetCacheRef.current = { ...widgetCacheRef.current, ...newEntries };
          setWidgetData((prev) => ({ ...prev, ...newEntries }));

          // Fire insights once on first load (not on filter/drill changes)
          if (!hasCachedData) {
            const summaries = spec.widgets.map((w) => ({
              title: w.title,
              type: w.type,
              rows: (results[w.id]?.rows ?? []).slice(0, 5),
            }));
            setInsights(null);
            setInsightsDismissed(false);
            setInsightsLoading(true);
            api.post('/dashboards/insights', { dashboardTitle: spec.title, widgets: summaries })
              .then((r) => { if (r.data.ok) setInsights(r.data.data.insights ?? []); })
              .catch(() => {})
              .finally(() => setInsightsLoading(false));
          }
        } else {
          setWidgetData((prev) => {
            const next = { ...prev };
            for (const w of spec.widgets) next[w.id] = { rows: [], loading: false, error: res.data.error ?? 'Query failed' };
            return next;
          });
        }
      } catch (err: unknown) {
        const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Query failed';
        // On error, clear the revalidating flag but keep showing cached data
        setWidgetData((prev) => {
          const next = { ...prev };
          for (const w of spec.widgets) {
            const cached = widgetCacheRef.current[w.id];
            next[w.id] = cached ? { ...cached, revalidating: false } : { rows: [], loading: false, error: msg };
          }
          return next;
        });
      }
    },
    [],
  );

  // ── Load filter options ───────────────────────────────────────────────────

  async function loadFilterOptions(filters: FilterSpec[], connId: number, dataLayer?: 'product' | 'source') {
    for (const f of filters) {
      if (f.type === 'select' && f.table && f.column) {
        try {
          const res = await api.post('/dashboards/filter-options', {
            connectionId: connId,
            table: f.table,
            column: f.column,
            ...(dataLayer === 'source' ? { dataLayer: 'source' as const } : {}),
          });
          setFilterOptions((prev) => ({ ...prev, [f.id]: res.data.data.options }));
        } catch {
          // ignore
        }
      }
    }
  }

  // ── Step 1: show choose dialog ────────────────────────────────────────────

  function initiateCreate() {
    if (!createInput.trim() || createLoading) return;
    setCreateError('');
    setMode('choosing');
  }

  // ── Step 2a: ask AI for clarifying questions ──────────────────────────────

  async function askForRefinement() {
    setRefinementLoading(true);
    setRefinementQuestions([]);
    setRefinementAnswers({});
    setMode('refining');
    try {
      const res = await api.post('/dashboards/refine', {
        connectionId: connectionId,
        request: createInput.trim(),
        ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
        ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}),
        ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
      });
      setRefinementQuestions(res.data.data.questions ?? []);
    } catch {
      setCreateError('Could not load questions. You can generate directly instead.');
      setMode('choosing');
    } finally {
      setRefinementLoading(false);
    }
  }

  // ── Step 2b / 3: generate the dashboard (optionally with answers) ─────────

  async function createDashboard(answers?: string[]) {
    if (!createInput.trim() || createLoading) return;
    setCreateLoading(true);
    setCreateError('');
    setMode('creating');
    try {
      const res = await api.post('/dashboards/generate', {
        connectionId: connectionId,
        request: createInput.trim(),
        answers: answers?.filter((a) => a.trim()),
        ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
        ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}),
        ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
      });
      const spec: DashboardSpec = res.data.data.spec;
      // Stamp the layer onto the spec so saves + re-executions stay consistent
      spec.dataLayer = useSourceLayer ? 'source' : 'product';
      const defaults = buildDefaultFilters(spec.filters);
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setCrossFilter(null);
      setChatMessages([]);
      setIsUnsaved(true);
      setMode('viewing');
      loadFilterOptions(spec.filters, connectionId, spec.dataLayer);
      executeAllWidgets(spec, defaults, null, connectionId);
      setCreateInput('');
    } catch {
      setCreateError('Failed to generate dashboard. Please try again.');
      setMode('empty');
    } finally {
      setCreateLoading(false);
    }
  }

  // ── Save dashboard ────────────────────────────────────────────────────────

  async function saveDashboard() {
    if (!currentSpec) return;
    setSaving(true);
    try {
      const res = await api.post('/dashboards', {
        connectionId: connectionId,
        title: currentSpec.title,
        description: currentSpec.description,
        spec: currentSpec,
      });
      const savedId = res.data?.data?.id ?? res.data?.id;
      setIsUnsaved(false);
      if (savedId) setActiveId(savedId);
      await loadDashboards();
      toast.success('Dashboard saved');
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string; message?: string } } })?.response?.data?.error
        ?? (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? (err as { message?: string })?.message
        ?? 'Please try again.';
      console.error('[saveDashboard]', err);
      toast.error('Could not save dashboard', { description: msg });
    } finally {
      setSaving(false);
    }
  }

  // ── Open a saved dashboard ────────────────────────────────────────────────

  async function openDashboard(id: number) {
    try {
      const res = await api.get(`/dashboards/${id}`);
      const row = res.data.data;
      const spec: DashboardSpec =
        typeof row.spec === 'string' ? JSON.parse(row.spec) : row.spec;
      const defaults = buildDefaultFilters(spec.filters);
      // Clear client-side cache so new dashboard shows skeletons, not stale data
      widgetCacheRef.current = {};
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setCrossFilter(null);
      setIsUnsaved(false);
      setActiveId(id);
      setMode('viewing');
      setChatMessages([]);
      setSettingsOpen(false);
      const saved = dashboards.find((d) => d.id === id);
      setAutoRefreshActive(!!(saved?.auto_refresh_seconds && saved.auto_refresh_seconds > 0));
      loadFilterOptions(spec.filters, connectionId, spec.dataLayer);
      executeAllWidgets(spec, defaults, null, connectionId);
    } catch {
      // ignore
    }
  }

  // ── Toggle favorite ───────────────────────────────────────────────────────

  async function toggleFavorite(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.patch(`/dashboards/${id}/favorite`);
      await loadDashboards();
    } catch {
      // ignore
    }
  }

  // ── Delete dashboard ──────────────────────────────────────────────────────

  async function deleteDashboard(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete this dashboard?')) return;
    try {
      await api.delete(`/dashboards/${id}`);
      if (activeId === id) {
        setActiveId(null);
        setCurrentSpec(null);
        setMode('empty');
      }
      await loadDashboards();
    } catch {
      // ignore
    }
  }

  // ── Drill-to-detail (KPI cards) ──────────────────────────────────────────

  async function openDrillDetail(widget: { id: string; title: string; drillDownSql?: string; drillDownLabel?: string }) {
    if (!widget.drillDownSql || !connectionId) return;
    const title = widget.drillDownLabel ?? `${widget.title} — detail`;
    setDrillModal({ title, loading: true, rows: [] });
    try {
      const res = await api.post('/dashboards/batch-execute', {
        connectionId,
        widgets: [{ id: widget.id, sql: widget.drillDownSql, filterValues }],
        ...(currentSpec?.dataLayer === 'source' ? { dataLayer: 'source' as const } : {}),
      });
      const rows = res.data.data?.results?.[widget.id]?.rows ?? [];
      setDrillModal({ title, loading: false, rows });
    } catch {
      setDrillModal({ title, loading: false, rows: [] });
    }
  }

  // ── Handle cross-filter / drill-down ─────────────────────────────────────

  function handleCrossFilter(widgetId: string, xfKey: string, value: string | null) {
    if (!value || (crossFilter?.widgetId === widgetId && crossFilter?.value === value)) {
      setCrossFilter(null);
      // Instantly restore cached data while server revalidates
      const cache = widgetCacheRef.current;
      if (Object.keys(cache).length > 0 && currentSpec) {
        setWidgetData((prev) => {
          const next = { ...prev };
          for (const w of currentSpec.widgets) {
            const cached = cache[w.id];
            if (cached) next[w.id] = { ...cached, revalidating: true };
          }
          return next;
        });
      }
      if (currentSpec) executeAllWidgets(currentSpec, filterValues, null, connectionId);
      return;
    }
    const widget = currentSpec?.widgets.find((w) => w.id === widgetId);
    const label = widget?.drillDownLabel?.replace('{{drill_value}}', value) ?? value;
    const newXF: DrillState = { widgetId, key: xfKey, value, label };
    setCrossFilter(newXF);
    if (currentSpec) executeAllWidgets(currentSpec, filterValues, newXF, connectionId);
  }

  // ── Handle filter change ──────────────────────────────────────────────────

  function handleFilterChange(key: string, value: string) {
    const newFilters = { ...filterValues, [key]: value };
    setFilterValues(newFilters);

    if (!currentSpec) return;

    const cache = widgetCacheRef.current;
    const hasCache = Object.keys(cache).length > 0;

    if (hasCache) {
      // Find if this is a select filter whose column matches a widget's crossFilterKey.
      // If so, apply the filter to cached rows instantly — zero server round-trip.
      const filterSpec = currentSpec.filters.find((f) => f.id === key && f.type === 'select');

      setWidgetData((prev) => {
        const next = { ...prev };
        for (const widget of currentSpec.widgets) {
          const cached = cache[widget.id];
          if (!cached || cached.error) continue;

          if (filterSpec && widget.crossFilterKey === filterSpec.column && value !== 'all') {
            // Exact label-match filter — zero latency, no server needed for this widget
            next[widget.id] = {
              rows: cached.rows.filter((r) => String(r.label) === value),
              loading: false,
            };
          } else {
            // Show stale data while revalidating (will be updated by executeAllWidgets)
            next[widget.id] = { ...cached, revalidating: true };
          }
        }
        return next;
      });
    }

    executeAllWidgets(currentSpec, newFilters, crossFilter, connectionId);
  }

  // ── Intent detection -- routes to query or refine ─────────────────────────

  function detectIntent(input: string): 'query' | 'refine' {
    const lower = input.toLowerCase().trim();
    const queryPattern = /^(what|why|how|who|when|which|where|is |are |was |were |can |could |would |should |do |did |show me|tell me|give me|list |find |how many|how much|which |compare)/;
    return queryPattern.test(lower) ? 'query' : 'refine';
  }

  // ── Smart chat submit -- asks data questions OR refines the dashboard ─────

  async function handleChatSubmit() {
    if (!refineInput.trim() || chatLoading || !currentSpec) return;
    const input = refineInput.trim();
    setRefineInput('');

    const intent = detectIntent(input);
    const userMsg: ChatMessage = { id: Date.now().toString(), role: 'user', text: input, type: intent };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatLoading(true);

    try {
      if (intent === 'query') {
        const prevMessages = chatMessages.filter(m => m.type === 'query');
        const isFollowUp = /^(can you|could you|give me|show me|list|what about|and |also |them|they|those|it |that |these)/i.test(input);
        let fullQuestion = input;
        if (isFollowUp && prevMessages.length >= 2) {
          const lastQ = prevMessages[prevMessages.length - 2];
          const lastA = prevMessages[prevMessages.length - 1];
          if (lastQ.role === 'user' && lastA.role === 'assistant') {
            fullQuestion = `Previous question: "${lastQ.text}"\nPrevious answer summary: "${lastA.text.slice(0, 300)}"\n\nFollow-up question: ${input}`;
          }
        }
        const res = await api.post('/query', { connectionId: connectionId, question: fullQuestion });
        const answer: string = res.data.data?.answer ?? res.data.answer ?? 'No answer available.';
        setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_a', role: 'assistant', text: answer, type: 'query' }]);
      } else {
        const res = await api.post('/dashboards/refine-spec', {
          connectionId: connectionId,
          refinement: input,
          currentSpec,
          ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}),
          ...(currentSpec.dataLayer === 'source' ? { dataLayer: 'source' as const } : {}),
        });
        const newSpec: DashboardSpec = res.data.data.spec;
        // Preserve the layer across refinements
        newSpec.dataLayer = currentSpec.dataLayer ?? 'product';
        const defaults = buildDefaultFilters(newSpec.filters);
        setCurrentSpec(newSpec);
        setFilterValues(defaults);
        setCrossFilter(null);
        setIsUnsaved(true);
        loadFilterOptions(newSpec.filters, connectionId, newSpec.dataLayer);
        executeAllWidgets(newSpec, defaults, null, connectionId);
        setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_a', role: 'assistant', text: `Dashboard updated -- "${newSpec.title}"`, type: 'refine' }]);
      }
    } catch {
      setChatMessages((prev) => [...prev, { id: Date.now().toString() + '_e', role: 'assistant', text: 'Something went wrong. Please try again.', type: intent }]);
    } finally {
      setChatLoading(false);
    }
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    setIsAdmin(getTokenPayload()?.role === 'admin');
    loadDashboards();
    api.get('/connections')
      .then((r) => {
        const conns = r.data.data as { id: number; name: string; domains?: string | string[] }[];
        if (conns.length > 0) {
          const parsed = conns.map((c) => ({
            id: c.id,
            name: c.name,
            domains: Array.isArray(c.domains)
              ? c.domains
              : c.domains
                ? JSON.parse(c.domains as string)
                : [],
          }));
          setConnections(parsed);
          setConnectionId(parsed[0].id);
          api.get(`/semantic/domains?connectionId=${conns[0].id}`)
            .then((dr) => setAvailableDomains(dr.data.data ?? []))
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [loadDashboards]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = () => setSettingsOpen(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [settingsOpen]);

  // ── Helper: discard unsaved dashboard ────────────────────────────────────

  function discardDashboard() {
    widgetCacheRef.current = {};
    setCurrentSpec(null);
    setIsUnsaved(false);
    setActiveId(null);
    setMode('empty');
    setWidgetData({});
    setCrossFilter(null);
    setChatMessages([]);
  }

  // ── Load folders + templates ────────────────────────────────────────────

  useEffect(() => {
    api.get('/dashboards/folders').then((r) => setFolders(r.data.data ?? [])).catch(() => {});
    api.get('/dashboards/templates/list').then((r) => setTemplates(r.data.data ?? [])).catch(() => {});
    api.get('/products').then((r) => {
      const prods = (r.data.data ?? []).filter((p: { status: string }) => ['approved', 'success'].includes(p.status));
      setProducts(prods);
    }).catch(() => {});
  }, []);

  // ── Auto-refresh effect ───────────────────────────────────────────────

  useEffect(() => {
    if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    if (!autoRefreshActive || !currentSpec) return;

    const saved = dashboards.find((d) => d.id === activeId);
    const interval = saved?.auto_refresh_seconds;
    if (!interval || interval < 10) return;

    autoRefreshRef.current = setInterval(() => {
      if (currentSpec) {
        executeAllWidgets(currentSpec, filterValues, crossFilter, connectionId);
      }
    }, interval * 1000);

    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current); };
  }, [autoRefreshActive, activeId, currentSpec, filterValues, crossFilter, connectionId, dashboards, executeAllWidgets]);

  // ── Duplicate dashboard ───────────────────────────────────────────────

  async function duplicateDashboard(id: number) {
    try {
      await api.post(`/dashboards/${id}/duplicate`);
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Toggle sharing ────────────────────────────────────────────────────

  async function toggleSharing(id: number) {
    const d = dashboards.find((x) => x.id === id);
    if (!d || !d.is_owner) return;
    try {
      await api.patch(`/dashboards/${id}`, { is_shared: !d.is_shared });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Update shared permission ──────────────────────────────────────────

  async function updateSharedPermission(id: number, perm: string) {
    try {
      await api.patch(`/dashboards/${id}`, { shared_permission: perm });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── Move to folder ────────────────────────────────────────────────────

  async function moveToFolder(id: number, folder: string | null) {
    try {
      await api.patch(`/dashboards/${id}`, { folder });
      await loadDashboards();
      api.get('/dashboards/folders').then((r) => setFolders(r.data.data ?? [])).catch(() => {});
    } catch { /* ignore */ }
  }

  // ── Set auto-refresh ──────────────────────────────────────────────────

  async function setAutoRefresh(id: number, seconds: number | null) {
    try {
      await api.patch(`/dashboards/${id}`, { auto_refresh_seconds: seconds });
      await loadDashboards();
    } catch { /* ignore */ }
  }

  // ── PDF export (client-side) ──────────────────────────────────────────

  async function exportPdf() {
    if (!dashboardGridRef.current || !currentSpec) return;
    const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
      import('html2canvas'),
      import('jspdf'),
    ]);

    const canvas = await html2canvas(dashboardGridRef.current, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
    });

    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({
      orientation: canvas.width > canvas.height ? 'landscape' : 'portrait',
      unit: 'px',
      format: [canvas.width, canvas.height],
    });
    pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
    pdf.save(`${currentSpec.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
  }

  // ── XLSX export (all widgets) ────────────────────────────────────────

  function exportAllXlsx() {
    if (!activeId || !currentSpec) return;
    const filterQs = Object.entries(filterValues).map(([k, v]) => `filter_${k}=${encodeURIComponent(v)}`).join('&');
    const url = `${BACKEND_URL}/api/dashboards/${activeId}/export/xlsx${filterQs ? '?' + filterQs : ''}`;
    downloadFile(url, `${currentSpec.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`);
  }

  // ── Create from template ──────────────────────────────────────────────

  async function createFromTemplate(templateId: number) {
    try {
      const res = await api.post('/dashboards/from-template', {
        templateId,
        connectionId,
      });
      const newId = res.data.data.id;
      await loadDashboards();
      openDashboard(newId);
      setShowTemplates(false);
    } catch { /* ignore */ }
  }

  // ── Helper: partition dashboards ─────────────────────────────────────────

  const visibleDashboards = dashboards.filter((d) => {
    if (showShared && !d.is_shared && !d.is_owner) return false;
    if (showShared && d.is_owner) return false;
    if (!showShared && !d.is_owner) return false;
    if (activeFolder !== null && d.folder !== activeFolder) return false;
    return true;
  });
  const favorites = visibleDashboards.filter((d) => d.is_favorite);
  const regular = visibleDashboards.filter((d) => !d.is_favorite);

  // ── Sidebar list item ─────────────────────────────────────────────────────

  function DashboardListItem({ d }: { d: SavedDashboard }) {
    const isActive = d.id === activeId && !isUnsaved;
    return (
      <button
        onClick={() => openDashboard(d.id)}
        className={`w-full text-left px-3 py-2.5 group flex items-start justify-between gap-1 transition-colors border-l-2 ${
          isActive
            ? 'bg-ocean-softer border-ocean'
            : 'border-transparent hover:bg-softer'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className={`text-[13px] truncate leading-snug ${isActive ? 'text-ink font-medium' : 'text-ink-2'}`}>
              {d.title}
            </p>
            {d.is_shared && <span className="shrink-0 text-[9px] font-mono tracking-[0.08em] uppercase bg-softer text-muted px-1.5 py-0.5 rounded border border-line">shared</span>}
            {!d.is_owner && <span className="shrink-0 text-[9px] font-mono tracking-[0.08em] uppercase bg-ai-soft text-ai px-1.5 py-0.5 rounded border border-line">{d.permission}</span>}
          </div>
          <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-1">
            {d.folder && <span className="mr-1">{d.folder} /</span>}
            {relTime(d.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
          {d.is_owner && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
                className="w-5 h-5 flex items-center justify-center text-muted-2 hover:text-ocean rounded transition-colors"
                title="Duplicate"
              >
                <Copy className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
              <button
                onClick={(e) => toggleFavorite(d.id, e)}
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${d.is_favorite ? 'text-amber-500' : 'text-muted-2 hover:text-amber-500'}`}
                title={d.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <Star className="w-3.5 h-3.5" strokeWidth={1.5} fill={d.is_favorite ? 'currentColor' : 'none'} />
              </button>
              <button
                onClick={(e) => deleteDashboard(d.id, e)}
                className="w-5 h-5 flex items-center justify-center text-muted-2 hover:text-err rounded transition-colors"
                title="Delete"
              >
                <X className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            </>
          )}
          {!d.is_owner && (
            <button
              onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
              className="w-5 h-5 flex items-center justify-center text-muted-2 hover:text-ocean rounded transition-colors"
              title="Duplicate to my dashboards"
            >
              <Copy className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          )}
        </div>
      </button>
    );
  }

  // ── Render widget by type ─────────────────────────────────────────────────

  function renderWidget(widget: WidgetSpec) {
    const data: WidgetData = widgetData[widget.id] ?? { rows: [], loading: true };

    const defaultCols: Record<string, number> = {
      kpi_card: 3, bar_chart: 6, vertical_bar_chart: 6, stacked_bar_chart: 6,
      line_chart: 6, pie_chart: 6, top_list: 6, data_table: 12,
      combo_chart: 6, radar_chart: 6, treemap_chart: 6, pivot_table: 12,
    };
    const SPAN_MAP: Record<number, number> = { 1: 3, 2: 6, 3: 9, 4: 12 };
    // Minimum width per type — guards against AI emitting too-narrow specs on
    // widgets whose contents need room (labels, tables, multi-series charts).
    const minCols: Record<string, number> = {
      top_list: 6, data_table: 12, pivot_table: 12, treemap_chart: 6,
      radar_chart: 6, stacked_bar_chart: 6, combo_chart: 6, line_chart: 6,
      bar_chart: 6, vertical_bar_chart: 6,
    };
    const requested = widget.colSpan ? (SPAN_MAP[widget.colSpan] ?? 6) : (defaultCols[widget.type] ?? 6);
    const col12 = Math.max(requested, minCols[widget.type] ?? 3);

    const isCrossFilterSource = crossFilter?.widgetId === widget.id;
    const isFiltered = crossFilter !== null && !isCrossFilterSource;

    const xfKey = widget.crossFilterKey ?? widget.id;
    const onCF = (val: string | null) => handleCrossFilter(widget.id, xfKey, val);
    const hasCrossFilter = Boolean(widget.crossFilterKey);

    // Widget export callbacks (only when dashboard is saved)
    const widgetIdx = currentSpec ? currentSpec.widgets.indexOf(widget) : -1;
    const canExport = activeId && !isUnsaved && widgetIdx >= 0;
    const filterQs = Object.entries(filterValues).map(([k, v]) => `filter_${k}=${encodeURIComponent(v)}`).join('&');
    const exportCsv = canExport ? () => {
      const url = `${BACKEND_URL}/api/dashboards/${activeId}/widget/${widgetIdx}/export/csv${filterQs ? '?' + filterQs : ''}`;
      downloadFile(url, `${widget.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`);
    } : undefined;
    const exportXlsx = canExport ? () => {
      const url = `${BACKEND_URL}/api/dashboards/${activeId}/widget/${widgetIdx}/export/xlsx${filterQs ? '?' + filterQs : ''}`;
      downloadFile(url, `${widget.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`);
    } : undefined;

    const widgetProps = { spec: widget, data };
    const canInvestigate = widget.type !== 'kpi_card' && widget.type !== 'pivot_table';
    const cardProps = {
      key: widget.id,
      spec: widget,
      data,
      colSpan: col12,
      isFiltered,
      isCrossFilterSource,
      revalidating: data.revalidating,
      onExportCsv: exportCsv,
      onExportXlsx: exportXlsx,
      onInvestigate: canInvestigate ? () => setInvestigationTarget(
        investigationTarget?.spec.id === widget.id ? null : { spec: widget, data }
      ) : undefined,
      isInvestigating: investigationTarget?.spec.id === widget.id,
      // Provenance modal context
      dataLayer: currentSpec?.dataLayer ?? 'product',
      isAdminOrAnalyst: isAdmin,
    };

    switch (widget.type) {
      case 'kpi_card':
        return (
          <WidgetCard {...cardProps}>
            <KpiCard
              {...widgetProps}
              onDrillDetail={widget.drillDownSql ? () => openDrillDetail(widget) : undefined}
            />
          </WidgetCard>
        );
      case 'bar_chart':
        return (
          <WidgetCard {...cardProps}>
            <BarChartWidget
              {...widgetProps}
              onCrossFilter={hasCrossFilter ? onCF : undefined}
              isCrossFilterActive={isCrossFilterSource}
              drillLabel={isCrossFilterSource ? crossFilter!.label : undefined}
            />
          </WidgetCard>
        );
      case 'line_chart':
        return (
          <WidgetCard {...cardProps}>
            <LineChartWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'vertical_bar_chart':
        return (
          <WidgetCard {...cardProps}>
            <VerticalBarChartWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'stacked_bar_chart':
        return (
          <WidgetCard {...cardProps}>
            <StackedBarChartWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'pie_chart':
        return (
          <WidgetCard {...cardProps}>
            <PieChartWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'top_list':
        return (
          <WidgetCard {...cardProps}>
            <TopListWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'data_table':
        return (
          <WidgetCard {...cardProps}>
            <DataTableWidget {...widgetProps} onCrossFilter={hasCrossFilter ? onCF : undefined} />
          </WidgetCard>
        );
      case 'combo_chart':
        return (
          <WidgetCard {...cardProps}>
            <ComboChartWidget {...widgetProps} />
          </WidgetCard>
        );
      case 'radar_chart':
        return (
          <WidgetCard {...cardProps}>
            <RadarChartWidget {...widgetProps} />
          </WidgetCard>
        );
      case 'treemap_chart':
        return (
          <WidgetCard {...cardProps}>
            <TreemapWidget {...widgetProps} />
          </WidgetCard>
        );
      case 'pivot_table':
        return (
          <WidgetCard {...cardProps}>
            <PivotTableWidget {...widgetProps} />
          </WidgetCard>
        );
      default:
        return null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const sidebarContent = (
    <div className="flex flex-col h-full">
      {/* Sidebar header */}
      <div className="px-4 pt-5 pb-3">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Dashboards</span>
          <button
            onClick={() => { setMode('empty'); setActiveId(null); setCurrentSpec(null); setIsUnsaved(false); }}
            className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors"
          >
            + New
          </button>
        </div>
        <CreateInput
          compact
          value={createInput}
          onChange={setCreateInput}
          onSubmit={initiateCreate}
          loading={createLoading}
        />
        {createError && <p className="text-[11px] text-err mt-1.5">{createError}</p>}
      </div>

      {/* My / Shared / Templates toggle */}
      <div className="px-3 flex gap-1">
        <button
          onClick={() => { setShowShared(false); setActiveFolder(null); }}
          className={`flex-1 text-[11px] font-mono tracking-[0.08em] uppercase py-1.5 rounded-md transition-colors ${!showShared ? 'text-ocean bg-ocean-softer' : 'text-muted hover:text-ink-2 hover:bg-softer'}`}
        >
          My
        </button>
        <button
          onClick={() => { setShowShared(true); setActiveFolder(null); }}
          className={`flex-1 text-[11px] font-mono tracking-[0.08em] uppercase py-1.5 rounded-md transition-colors ${showShared ? 'text-ocean bg-ocean-softer' : 'text-muted hover:text-ink-2 hover:bg-softer'}`}
        >
          Shared
        </button>
        <button
          onClick={() => setShowTemplates(true)}
          className="flex-1 text-[11px] font-mono tracking-[0.08em] uppercase py-1.5 rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors"
          title="Browse templates"
        >
          Templates
        </button>
      </div>

      {/* Folder filter */}
      {!showShared && folders.length > 0 && (
        <div className="px-3 pt-3 flex flex-wrap gap-1">
          <button
            onClick={() => setActiveFolder(null)}
            className={`text-[10px] font-mono tracking-[0.06em] uppercase px-2.5 py-0.5 rounded-full border transition-colors ${activeFolder === null ? 'bg-ocean-softer text-ocean border-ocean/30' : 'text-muted border-line hover:border-line-strong hover:text-ink-2'}`}
          >
            All
          </button>
          {folders.map((f) => (
            <button
              key={f}
              onClick={() => setActiveFolder(activeFolder === f ? null : f)}
              className={`text-[10px] font-mono tracking-[0.06em] uppercase px-2.5 py-0.5 rounded-full border transition-colors ${activeFolder === f ? 'bg-ocean-softer text-ocean border-ocean/30' : 'text-muted border-line hover:border-line-strong hover:text-ink-2'}`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      {/* Dashboard list */}
      <div className="flex-1 overflow-y-auto py-2 scrollbar-thin">
        {favorites.length > 0 && (
          <>
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted-2 px-4 py-1.5">Favorites</p>
            {favorites.map((d) => <DashboardListItem key={d.id} d={d} />)}
            {regular.length > 0 && <div className="my-2 border-t border-line mx-3" />}
          </>
        )}
        {regular.map((d) => <DashboardListItem key={d.id} d={d} />)}
        {visibleDashboards.length === 0 && (
          <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 text-center mt-6 px-4 leading-relaxed">
            {showShared ? 'No shared dashboards yet' : 'No saved dashboards yet'}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-1 overflow-hidden min-h-0 relative">

      {/* Story modal */}
      {storyOpen && currentSpec && (
        <StoryModal
          dashboardTitle={currentSpec.title}
          widgets={currentSpec.widgets}
          widgetData={widgetData}
          dashboardGridRef={dashboardGridRef}
          onClose={() => setStoryOpen(false)}
        />
      )}

      {/* Drill-to-detail modal */}
      {drillModal && (
        <DrillDetailModal
          title={drillModal.title}
          loading={drillModal.loading}
          rows={drillModal.rows}
          onClose={() => setDrillModal(null)}
        />
      )}

      {/* ── Left sidebar ── */}
      <aside className="w-60 bg-soft border-r border-line flex flex-col shrink-0 overflow-hidden">
        {sidebarContent}
      </aside>

      {/* ── Main area ── */}
      <main className="flex-1 overflow-hidden flex flex-col bg-bg">

          {/* Empty state — Observatory hero */}
          {mode === 'empty' && (
            <EmptyDashboardHero
              createInput={createInput}
              setCreateInput={setCreateInput}
              onInitiate={initiateCreate}
              onChooseDirect={() => setMode('choosing')}
              loading={createLoading}
              error={createError}
              inputRef={inputRef}
            />
          )}

          {/* Choosing: refine first or generate now */}
          {mode === 'choosing' && (
            <div className="flex-1 overflow-y-auto">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-lg w-full mx-auto px-6 pt-14 pb-10"
              >
                <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Your request</p>
                <p className="font-display text-[28px] leading-[1.15] tracking-[-0.02em] text-ink mb-8 [&_em]:italic [&_em]:text-ink-2">
                  <em>&ldquo;{createInput}&rdquo;</em>
                </p>

                {/* Data domain selector */}
                {connections.length > 1 && (() => {
                  const chips: { label: string; connId: number }[] = [];
                  for (const c of connections) {
                    if (c.domains.length > 0) {
                      c.domains.forEach((d) => chips.push({ label: d, connId: c.id }));
                    } else {
                      chips.push({ label: c.name, connId: c.id });
                    }
                  }
                  return (
                    <div className="mb-6">
                      <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Data domain</p>
                      <div className="flex flex-wrap gap-1.5">
                        {chips.map((chip) => (
                          <button
                            key={`${chip.connId}-${chip.label}`}
                            onClick={() => setConnectionId(chip.connId)}
                            className={`px-3 py-1.5 text-[12px] rounded-md border transition-colors capitalize ${
                              connectionId === chip.connId
                                ? 'bg-ocean text-white border-ocean'
                                : 'bg-raised text-ink-2 border-line hover:border-line-strong hover:bg-softer'
                            }`}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Data product selector — grouped by source so the picker
                    matches /catalog and /products. With <=1 source group the
                    eyebrow renders inline; with multiple, each source gets
                    its own subsection so the user immediately sees lineage
                    when picking a product to filter by. */}
                {products.length > 0 && (() => {
                  type ProductRow = (typeof products)[number];
                  type Group = { key: string; label: string; items: ProductRow[] };
                  const byKey = new Map<string, Group>();
                  for (const p of products) {
                    const k = productSourceGroupKey(p.source ?? null);
                    let g = byKey.get(k);
                    if (!g) {
                      g = { key: k, label: productSourceGroupLabel(k, p.source ?? null), items: [] };
                      byKey.set(k, g);
                    }
                    g.items.push(p);
                  }
                  const groups = Array.from(byKey.values()).sort((a, b) => {
                    const rank = (k: string) =>
                      k === 'multi' ? 1 : k === 'deleted' ? 2 : k === 'unassigned' ? 3 : 0;
                    const ra = rank(a.key), rb = rank(b.key);
                    if (ra !== rb) return ra - rb;
                    return a.label.localeCompare(b.label);
                  });
                  const showHeaders = groups.length > 1;
                  return (
                    <div className="mb-6">
                      <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">Data model(s)</p>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        <button
                          onClick={() => setSelectedProductIds([])}
                          className={`px-3 py-1.5 text-[12px] rounded-md border transition-colors ${
                            selectedProductIds.length === 0
                              ? 'bg-ocean text-white border-ocean'
                              : 'bg-raised text-ink-2 border-line hover:border-line-strong hover:bg-softer'
                          }`}
                        >
                          All products
                        </button>
                      </div>
                      <div className="space-y-3">
                        {groups.map((g) => (
                          <div key={g.key}>
                            {showHeaders && (
                              <p className={`text-[10px] font-mono tracking-[0.1em] uppercase mb-1.5 ${
                                g.key === 'multi' || g.key === 'deleted' || g.key === 'unassigned'
                                  ? 'text-muted-2'
                                  : 'text-ocean'
                              }`}>
                                {g.label}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1.5">
                              {g.items.map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => {
                                    setSelectedProductIds((prev) =>
                                      prev.includes(p.id)
                                        ? prev.filter((id) => id !== p.id)
                                        : [...prev, p.id],
                                    );
                                  }}
                                  className={`px-3 py-1.5 text-[12px] rounded-md border transition-colors inline-flex items-center gap-2 ${
                                    selectedProductIds.includes(p.id)
                                      ? 'bg-ai text-white border-ai'
                                      : 'bg-raised text-ink-2 border-line hover:border-line-strong hover:bg-softer'
                                  }`}
                                >
                                  <span>{p.name}</span>
                                  {p.source?.multiSource && (
                                    <span className={`text-[9px] font-mono px-1 py-0.5 rounded ${
                                      selectedProductIds.includes(p.id)
                                        ? 'bg-white/20 text-white'
                                        : 'bg-ocean-softer text-ocean'
                                    }`} title={`Also draws from: ${p.source?.otherSources?.map((s) => s.name).join(', ') ?? ''}`}>
                                      +{p.source?.otherSources?.length ?? 0}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      {selectedProductIds.length > 0 && (
                        <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-2">
                          {selectedProductIds.length} product{selectedProductIds.length > 1 ? 's' : ''} selected — dashboard limited to tables from {selectedProductIds.length > 1 ? 'these products' : 'this product'}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {/* Admin-only: query source data instead of data products */}
                {isAdmin && (
                  <div className="mb-6">
                    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2 hover:text-ink-3 transition-colors">
                      <input
                        type="checkbox"
                        checked={useSourceLayer}
                        onChange={(e) => setUseSourceLayer(e.target.checked)}
                        className="w-3 h-3 rounded-sm border border-line accent-ocean"
                      />
                      Query source data (skip data products)
                    </label>
                  </div>
                )}

                <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">How would you like to proceed?</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <button
                    onClick={askForRefinement}
                    className="flex flex-col items-start gap-2 p-4 rounded-lg bg-raised border border-line hover:border-ocean/40 hover:bg-ocean-softer text-left transition-colors group"
                  >
                    <div className="w-9 h-9 rounded-md bg-ocean-softer text-ocean border border-line flex items-center justify-center group-hover:bg-ocean group-hover:text-white group-hover:border-ocean transition-colors">
                      <Lightbulb className="w-[18px] h-[18px]" strokeWidth={1.5} />
                    </div>
                    <span className="text-[14px] font-medium text-ink">Refine with AI first</span>
                    <span className="text-[12px] text-ink-3 leading-relaxed">Answer a few questions so AI can tailor the dashboard exactly to your needs.</span>
                  </button>
                  <button
                    onClick={() => createDashboard()}
                    className="flex flex-col items-start gap-2 p-4 rounded-lg bg-raised border border-line hover:border-line-strong hover:bg-softer text-left transition-colors group"
                  >
                    <div className="w-9 h-9 rounded-md bg-softer text-ink-2 border border-line flex items-center justify-center group-hover:bg-ink group-hover:text-white group-hover:border-ink transition-colors">
                      <Zap className="w-[18px] h-[18px]" strokeWidth={1.5} />
                    </div>
                    <span className="text-[14px] font-medium text-ink">Generate now</span>
                    <span className="text-[12px] text-ink-3 leading-relaxed">Let AI decide what to include based on best practices and your schema.</span>
                  </button>
                </div>
                <button
                  onClick={() => setMode('empty')}
                  className="mt-5 text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ink-2 transition-colors"
                >
                  ← Back
                </button>
                {createError && <p className="text-[12px] text-err mt-3">{createError}</p>}
              </motion.div>
            </div>
          )}

          {/* Refining: AI questions */}
          {mode === 'refining' && (
            <div className="flex-1 overflow-y-auto">
              <motion.div
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                className="max-w-xl w-full mx-auto px-6 pt-14 pb-10"
              >
                <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Refining</p>
                <p className="font-display text-[28px] leading-[1.15] tracking-[-0.02em] text-ink mb-1.5 [&_em]:italic [&_em]:text-ink-2">
                  <em>&ldquo;{createInput}&rdquo;</em>
                </p>
                <p className="text-[12px] text-ink-3 mb-7 leading-relaxed">Answer what you can — skip anything that doesn&apos;t apply.</p>

                {refinementLoading ? (
                  <div className="flex items-center gap-3 py-8 justify-center">
                    <div className="w-4 h-4 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
                    <span className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted">Thinking of the right questions…</span>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {refinementQuestions.map((q, idx) => (
                      <div key={idx}>
                        <p className="text-[14px] text-ink mb-2 leading-relaxed">
                          <span className="text-muted font-mono mr-1.5">{String(idx + 1).padStart(2, '0')}</span>
                          {q.question}
                        </p>
                        {/* Suggestion chips */}
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {q.suggestions.map((s) => (
                            <button
                              key={s}
                              onClick={() => setRefinementAnswers((prev) => ({
                                ...prev,
                                [idx]: prev[idx] === s ? '' : s,
                              }))}
                              className={`px-3 py-1.5 text-[12px] rounded-md border transition-colors ${
                                refinementAnswers[idx] === s
                                  ? 'bg-ocean text-white border-ocean'
                                  : 'bg-raised text-ink-2 border-line hover:border-line-strong hover:bg-softer'
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                        <input
                          type="text"
                          value={refinementAnswers[idx] ?? ''}
                          onChange={(e) => setRefinementAnswers((prev) => ({ ...prev, [idx]: e.target.value }))}
                          placeholder="Or type your own answer…"
                          className="w-full px-3 py-2 text-[13px] rounded-md border border-line bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors"
                        />
                      </div>
                    ))}

                    <div className="flex gap-2 pt-2">
                      <button
                        onClick={() => createDashboard(Object.values(refinementAnswers).filter(Boolean))}
                        disabled={createLoading}
                        className="flex-1 py-2.5 text-[13px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {createLoading ? 'Generating…' : 'Generate Dashboard'}
                      </button>
                      <button
                        onClick={() => createDashboard()}
                        disabled={createLoading}
                        className="px-4 py-2.5 text-[13px] rounded-md border border-line text-ink-2 hover:bg-softer hover:border-line-strong transition-colors disabled:opacity-50"
                        title="Skip refinement and generate now"
                      >
                        Skip
                      </button>
                    </div>
                    <button
                      onClick={() => setMode('choosing')}
                      className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ink-2 transition-colors"
                    >
                      ← Back
                    </button>
                  </div>
                )}
              </motion.div>
            </div>
          )}

          {/* Generating state — wireframe preview */}
          {mode === 'creating' && (
            <div className="flex-1 overflow-y-auto">
              <div className="w-full max-w-3xl mx-auto px-6 pt-12 pb-10">
                <div className="mb-8 flex items-center gap-3">
                  <div className="w-4 h-4 border-2 border-ocean border-t-transparent rounded-full animate-spin" />
                  <div>
                    <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Generating</p>
                    <p className="text-[15px] text-ink leading-snug">AI is designing widgets, filters, and SQL queries…</p>
                  </div>
                </div>

                {/* Wireframe skeleton preview */}
                <div className="bg-raised border border-line rounded-lg p-6 space-y-5">
                  <div className="flex items-center justify-between">
                    <div className={`${shimmerClass} h-4 w-44 rounded`} />
                    <div className="flex gap-2">
                      <div className={`${shimmerClass} h-7 w-20 rounded-md`} />
                      <div className={`${shimmerClass} h-7 w-20 rounded-md`} />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    {[0.8, 1.0, 0.6, 0.9].map((delay, i) => (
                      <div key={i} className="rounded-md border border-line p-4 space-y-2">
                        <div className={`${shimmerClass} h-3 w-16 rounded`} style={{ animationDelay: `${delay}s` }} />
                        <div className={`${shimmerClass} h-6 w-20 rounded`} style={{ animationDelay: `${delay + 0.2}s` }} />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md border border-line p-4 space-y-3">
                      <div className={`${shimmerClass} h-3 w-24 rounded`} />
                      <div className="flex items-end gap-2 h-24">
                        {[40, 65, 45, 80, 55, 70, 50].map((h, i) => (
                          <div key={i} className={`flex-1 ${shimmerClass} rounded-t`} style={{ height: `${h}%`, animationDelay: `${i * 0.15}s` }} />
                        ))}
                      </div>
                    </div>
                    <div className="rounded-md border border-line p-4 space-y-3">
                      <div className={`${shimmerClass} h-3 w-28 rounded`} />
                      <div className="flex items-center justify-center h-24">
                        <div className="w-20 h-20 border-[6px] border-line border-t-ocean rounded-full animate-spin" style={{ animationDuration: '3s' }} />
                      </div>
                    </div>
                  </div>
                  <div className="rounded-md border border-line p-4 space-y-2">
                    <div className={`${shimmerClass} h-3 w-20 rounded`} />
                    <div className="space-y-1.5">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex gap-4">
                          <div className={`${shimmerClass} h-3 w-24 rounded`} style={{ animationDelay: `${i * 0.2}s` }} />
                          <div className={`${shimmerClass} h-3 w-16 rounded`} style={{ animationDelay: `${i * 0.2 + 0.1}s` }} />
                          <div className={`${shimmerClass} h-3 flex-1 rounded`} style={{ animationDelay: `${i * 0.2 + 0.2}s` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Dashboard view */}
          {mode === 'viewing' && currentSpec && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Top bar */}
              <div className="px-6 py-4 flex items-center justify-between gap-4 shrink-0 border-b border-line bg-raised">
                <div className="min-w-0">
                  <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] truncate">{currentSpec.title}</h1>
                  {currentSpec.description && (
                    <p className="text-[12px] text-ink-3 mt-0.5 truncate leading-relaxed">{currentSpec.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Settings dropdown (share, folder, auto-refresh) */}
                  {activeId && !isUnsaved && (() => {
                    const activeDash = dashboards.find((d) => d.id === activeId);
                    if (!activeDash?.is_owner) return null;
                    return (
                      <div className="relative">
                        <button
                          onClick={() => setSettingsOpen(!settingsOpen)}
                          className="w-8 h-8 flex items-center justify-center rounded-md border border-line text-ink-3 hover:bg-softer hover:text-ink-2 hover:border-line-strong transition-colors"
                          title="Dashboard settings"
                        >
                          <Settings className="w-4 h-4" strokeWidth={1.5} />
                        </button>
                        {settingsOpen && (
                          <div className="absolute right-0 top-10 z-50 w-80 bg-raised border border-line rounded-lg shadow-2 p-4 space-y-4"
                               onClick={(e) => e.stopPropagation()}>
                            <div>
                              <label className="flex items-center gap-2 text-[12px] text-ink-2">
                                <input
                                  type="checkbox"
                                  checked={activeDash.is_shared}
                                  onChange={() => toggleSharing(activeId)}
                                  className="rounded border-line accent-ocean"
                                />
                                Share with team
                              </label>
                              {activeDash.is_shared && (
                                <select
                                  value={activeDash.shared_permission}
                                  onChange={(e) => updateSharedPermission(activeId, e.target.value)}
                                  className="mt-2 w-full text-[12px] border border-line rounded-md px-2 py-1.5 bg-raised text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                                >
                                  <option value="viewer">Team can view</option>
                                  <option value="editor">Team can edit</option>
                                </select>
                              )}
                            </div>
                            <div>
                              <label className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted block mb-1.5">Folder</label>
                              <input
                                type="text"
                                defaultValue={activeDash.folder ?? ''}
                                placeholder="Uncategorized"
                                onBlur={(e) => moveToFolder(activeId, e.target.value || null)}
                                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                className="w-full text-[12px] border border-line rounded-md px-2 py-1.5 bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted block mb-1.5">Auto-refresh</label>
                              <select
                                value={activeDash.auto_refresh_seconds ?? 0}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setAutoRefresh(activeId, v || null);
                                  setAutoRefreshActive(v > 0);
                                }}
                                className="w-full text-[12px] border border-line rounded-md px-2 py-1.5 bg-raised text-ink-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
                              >
                                <option value={0}>Off</option>
                                <option value={30}>Every 30 seconds</option>
                                <option value={60}>Every minute</option>
                                <option value={300}>Every 5 minutes</option>
                                <option value={600}>Every 10 minutes</option>
                                <option value={1800}>Every 30 minutes</option>
                              </select>
                            </div>
                            <EmailSchedulePanel dashboardId={activeId as number} />
                            <button
                              onClick={() => setSettingsOpen(false)}
                              className="w-full text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ink-2 pt-1 transition-colors"
                            >
                              Close
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Export buttons */}
                  {!isUnsaved && (
                    <>
                      <button
                        onClick={() => setStoryOpen(true)}
                        className="h-8 px-2.5 flex items-center gap-1.5 rounded-md border border-ocean/40 bg-ocean-softer text-[10px] font-mono tracking-[0.1em] uppercase text-ocean hover:bg-ocean/10 transition-colors"
                        title="Generate AI story report"
                      >
                        Story
                      </button>
                      <button
                        onClick={exportPdf}
                        className="h-8 px-2.5 flex items-center justify-center rounded-md border border-line text-[10px] font-mono tracking-[0.1em] uppercase text-ink-3 hover:bg-softer hover:text-ink-2 hover:border-line-strong transition-colors"
                        title="Export as PDF"
                      >
                        PDF
                      </button>
                      <button
                        onClick={exportAllXlsx}
                        className="h-8 px-2.5 flex items-center justify-center rounded-md border border-line text-[10px] font-mono tracking-[0.1em] uppercase text-ink-3 hover:bg-softer hover:text-ink-2 hover:border-line-strong transition-colors"
                        title="Export all widgets as Excel"
                      >
                        XLSX
                      </button>
                    </>
                  )}

                  {/* Duplicate */}
                  {activeId && !isUnsaved && (
                    <button
                      onClick={() => duplicateDashboard(activeId)}
                      className="w-8 h-8 flex items-center justify-center rounded-md border border-line text-ink-3 hover:bg-softer hover:text-ink-2 hover:border-line-strong transition-colors"
                      title="Duplicate dashboard"
                    >
                      <Copy className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  )}

                  {/* Auto-refresh indicator */}
                  {autoRefreshActive && (
                    <span className="px-2.5 py-1 text-[10px] font-mono tracking-[0.1em] uppercase bg-ok-soft text-ok border border-line rounded-md flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-ok rounded-full animate-pulse" />
                      Live
                    </span>
                  )}

                  {isUnsaved ? (
                    <>
                      <button
                        onClick={discardDashboard}
                        className="px-3 py-1.5 text-[12px] rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors"
                      >
                        Discard
                      </button>
                      <button
                        onClick={saveDashboard}
                        disabled={saving}
                        className="px-4 py-1.5 text-[12px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover transition-colors disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <span className="px-2.5 py-1 text-[10px] font-mono tracking-[0.1em] uppercase bg-ok-soft text-ok border border-line rounded-md">
                      Saved
                    </span>
                  )}
                </div>
              </div>

              {/* Filter bar */}
              <FilterBar
                filters={currentSpec.filters}
                filterValues={filterValues}
                filterOptions={filterOptions}
                onFilterChange={handleFilterChange}
              />

              {/* Widget grid + investigation panel */}
              <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Grid area */}
                <div className="flex-1 overflow-y-auto bg-bg min-w-0">
                  {/* Insights strip */}
                  {!insightsDismissed && (insightsLoading || (insights && insights.length > 0)) && (
                    <div className="px-6 pt-6">
                      {insightsLoading ? (
                        <InsightsStripSkeleton />
                      ) : insights && insights.length > 0 ? (
                        <InsightsStrip insights={insights} onDismiss={() => setInsightsDismissed(true)} />
                      ) : null}
                    </div>
                  )}
                  <motion.div
                    ref={dashboardGridRef}
                    className="grid gap-4 p-6"
                    style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: 'min-content' }}
                    variants={containerVariants}
                    initial="hidden"
                    animate="visible"
                    key={currentSpec.title}
                  >
                    {currentSpec.widgets.map((widget) => renderWidget(widget))}
                  </motion.div>
                </div>

                {/* Investigation panel — slides in on the right */}
                {investigationTarget && (
                  <div className="w-[360px] shrink-0 overflow-y-auto">
                    <InvestigationPanel
                      widgetTitle={investigationTarget.spec.title}
                      widgetSql={investigationTarget.spec.sql}
                      widgetRows={investigationTarget.data.rows}
                      connectionId={connectionId!}
                      filterValues={filterValues}
                      onClose={() => setInvestigationTarget(null)}
                    />
                  </div>
                )}
              </div>

              {/* Bottom chat bar */}
              <div className="bg-raised border-t border-line shrink-0">
                {/* Chat history */}
                {chatMessages.length > 0 && (
                  <div className="px-6 pt-3 pb-1 max-h-52 overflow-y-auto space-y-2">
                    {chatMessages.map((msg) => (
                      <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        {msg.role === 'user' ? (
                          <p className="max-w-[75%] text-[14px] text-right text-ink-2 font-display italic leading-relaxed py-1.5">
                            {msg.text}
                          </p>
                        ) : (
                          <div className={`max-w-[85%] px-4 py-2.5 rounded-lg border text-[13px] ${
                            msg.type === 'refine'
                              ? 'bg-ok-soft border-line text-ink-2'
                              : 'bg-softer border-line text-ink'
                          }`}>
                            {msg.type === 'refine' && (
                              <span className="text-[10px] font-mono tracking-[0.08em] uppercase block mb-1 text-ok">Dashboard updated</span>
                            )}
                            <MarkdownAnswer text={msg.text} />
                          </div>
                        )}
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="bg-softer border border-line rounded-lg px-4 py-3 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                          <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0.15s' }} />
                          <span className="w-1.5 h-1.5 bg-ocean rounded-full animate-bounce" style={{ animationDelay: '0.3s' }} />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                )}
                {/* Input row */}
                <div className="px-6 py-3 flex gap-2">
                  <input
                    type="text"
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()}
                    placeholder="Ask about the data or say how to improve this dashboard…"
                    disabled={chatLoading}
                    className="flex-1 px-3 py-2 text-[13px] rounded-md border border-line bg-raised text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 disabled:opacity-50 transition-colors"
                  />
                  <button
                    onClick={handleChatSubmit}
                    disabled={chatLoading || !refineInput.trim()}
                    className="px-4 py-2 text-[13px] font-medium text-white rounded-md bg-ocean hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    {chatLoading ? '…' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

      {/* Template gallery modal */}
      <AnimatePresence>
        {showTemplates && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[2px] p-6"
            onClick={() => setShowTemplates(false)}
          >
            <motion.div
              variants={slideUp}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="bg-raised rounded-lg border border-line shadow-2 w-full max-w-2xl max-h-[82vh] overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-line flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Templates</p>
                  <h2 className="font-display text-[20px] text-ink leading-tight tracking-[-0.01em]">Dashboard gallery</h2>
                </div>
                <button
                  onClick={() => setShowTemplates(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-ink-2 hover:bg-softer transition-colors"
                  title="Close"
                >
                  <X className="w-4 h-4" strokeWidth={2} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                {templates.length === 0 ? (
                  <div className="text-center py-16">
                    <div className="w-14 h-14 mx-auto mb-4 rounded-md bg-softer border border-line flex items-center justify-center">
                      <FileText className="w-6 h-6 text-muted" strokeWidth={1.5} />
                    </div>
                    <p className="text-[14px] text-ink-2">No templates available yet.</p>
                    <p className="text-[12px] text-ink-3 mt-1">Admins can save dashboard specs as templates.</p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {(() => {
                      const categories = Array.from(new Set(templates.map((t) => t.category)));
                      return categories.map((cat) => (
                        <div key={cat}>
                          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">{cat}</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {templates.filter((t) => t.category === cat).map((t) => (
                              <button
                                key={t.id}
                                onClick={() => createFromTemplate(t.id)}
                                className="text-left p-4 rounded-md bg-softer border border-line hover:border-line-strong hover:bg-bg transition-colors"
                              >
                                <p className="text-[13px] font-medium text-ink">{t.name}</p>
                                {t.description && <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">{t.description}</p>}
                              </button>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
