'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { getToken, getTokenPayload } from '@/lib/auth';

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
} from './components/ChartWidgets';
import { FilterBar } from './components/FilterBar';
import { DashboardHeader } from './components/DashboardHeader';
import { MarkdownAnswer } from './components/MarkdownAnswer';

// ─── Constants ───────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

/** Authenticated file download helper */
function downloadFile(url: string, filename: string) {
  const token = getToken();
  fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then((r) => {
      if (!r.ok) throw new Error('Export failed');
      return r.blob();
    })
    .then((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(() => alert('Export failed'));
}

// ─── CreateInput (kept inline — tightly coupled to page state) ───────────────

function CreateInput({
  value, onChange, onSubmit, loading, compact, inputRef,
}: {
  value:     string;
  onChange:  (v: string) => void;
  onSubmit:  () => void;
  loading:   boolean;
  compact?:  boolean;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className={`flex gap-2 ${compact ? '' : 'w-full max-w-lg'}`}>
      <input
        ref={compact ? undefined : inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        placeholder={compact ? 'Describe a dashboard...' : 'e.g. Sales overview by product and region'}
        className={`flex-1 px-3 py-2 text-sm rounded-xl border transition-all
          ${compact
            ? 'bg-white/8 border-white/10 text-slate-200 placeholder-slate-500 focus:ring-cyan-400/30 focus:border-cyan-400/30'
            : 'bg-white/60 border-white/80 text-slate-800 placeholder-slate-400 focus:ring-cyan-400/30 focus:border-cyan-400/40'
          }
          focus:outline-none focus:ring-2
          shadow-sm disabled:opacity-50`}
        disabled={loading}
      />
      <button
        onClick={onSubmit}
        disabled={loading || !value.trim()}
        className={`px-4 py-2 text-sm font-bold rounded-xl transition-all
          ${compact
            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30'
            : 'gradient-primary text-white shadow-lg shadow-[#003358]/20 hover:shadow-xl hover:scale-[1.02]'
          }
          disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {loading ? '...' : 'Go'}
      </button>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function DashboardsPage() {
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
  const [products, setProducts] = useState<{ id: number; name: string; description: string; status: string }[]>([]);
  const [selectedProductIds, setSelectedProductIds] = useState<number[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [showShared, setShowShared] = useState(false);
  const [templates, setTemplates] = useState<DashboardTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [autoRefreshActive, setAutoRefreshActive] = useState(false);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const dashboardGridRef = useRef<HTMLDivElement>(null);

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

  // ── Execute a single widget ────────────────────────────────────────────────

  async function executeWidget(widgetId: string, sql: string, filters: Record<string, string>, connId: number) {
    setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: true } }));
    try {
      const res = await api.post('/dashboards/execute', {
        connectionId: connId,
        sql,
        filterValues: filters,
      });
      if (res.data.ok === false) {
        setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: false, error: res.data.error ?? 'Query failed' } }));
      } else {
        setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: res.data.data?.rows ?? [], loading: false } }));
      }
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Query failed';
      setWidgetData((prev) => ({ ...prev, [widgetId]: { rows: [], loading: false, error: msg } }));
    }
  }

  // ── Execute all widgets ───────────────────────────────────────────────────

  const executeAllWidgets = useCallback(
    async (
      spec: DashboardSpec,
      filters: Record<string, string>,
      xFilter: DrillState | null,
      connId: number,
    ) => {
      for (const widget of spec.widgets) {
        const isDrilled = xFilter?.widgetId === widget.id && widget.drillDownSql;
        const sql = isDrilled ? widget.drillDownSql! : widget.sql;
        const filterPayload: Record<string, string> = {
          ...filters,
          ...(isDrilled ? { drill_value: xFilter!.value } : {}),
          ...(xFilter ? { [`xf_${xFilter.key}`]: xFilter.value } : {}),
        };
        executeWidget(widget.id, sql, filterPayload, connId);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Load filter options ───────────────────────────────────────────────────

  async function loadFilterOptions(filters: FilterSpec[], connId: number) {
    for (const f of filters) {
      if (f.type === 'select' && f.table && f.column) {
        try {
          const res = await api.post('/dashboards/filter-options', {
            connectionId: connId,
            table: f.table,
            column: f.column,
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
      });
      const spec: DashboardSpec = res.data.data.spec;
      const defaults = buildDefaultFilters(spec.filters);
      setCurrentSpec(spec);
      setFilterValues(defaults);
      setCrossFilter(null);
      setChatMessages([]);
      setIsUnsaved(true);
      setMode('viewing');
      loadFilterOptions(spec.filters, connectionId);
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
      setIsUnsaved(false);
      setActiveId(res.data.data.id);
      await loadDashboards();
    } catch {
      // ignore
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
      loadFilterOptions(spec.filters, connectionId);
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

  // ── Handle cross-filter / drill-down ─────────────────────────────────────

  function handleCrossFilter(widgetId: string, xfKey: string, value: string | null) {
    if (!value || (crossFilter?.widgetId === widgetId && crossFilter?.value === value)) {
      setCrossFilter(null);
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
    if (currentSpec) executeAllWidgets(currentSpec, newFilters, crossFilter, connectionId);
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
        const res = await api.post('/dashboards/refine-spec', { connectionId: connectionId, refinement: input, currentSpec, ...(selectedProductIds.length > 0 ? { productIds: selectedProductIds } : {}) });
        const newSpec: DashboardSpec = res.data.data.spec;
        const defaults = buildDefaultFilters(newSpec.filters);
        setCurrentSpec(newSpec);
        setFilterValues(defaults);
        setCrossFilter(null);
        setIsUnsaved(true);
        loadFilterOptions(newSpec.filters, connectionId);
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
        className={`w-full text-left px-3 py-2.5 rounded-xl group flex items-start justify-between gap-1 transition-all duration-200 ${
          isActive
            ? 'bg-cyan-500/10 border-l-2 border-cyan-400 pl-2.5'
            : 'hover:bg-white/5 border-l-2 border-transparent'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <p className={`text-[13px] font-medium truncate ${isActive ? 'text-cyan-300' : 'text-slate-300'}`}>
              {d.title}
            </p>
            {d.is_shared && <span className="shrink-0 text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full font-semibold">shared</span>}
            {!d.is_owner && <span className="shrink-0 text-[9px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full font-semibold">{d.permission}</span>}
          </div>
          <p className="text-[11px] text-slate-600 mt-0.5">
            {d.folder && <span className="text-slate-600 mr-1">{d.folder} /</span>}
            {relTime(d.updated_at)}
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
          {d.is_owner && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
                className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-cyan-400 rounded text-xs transition-colors"
                title="Duplicate"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              <button
                onClick={(e) => toggleFavorite(d.id, e)}
                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${d.is_favorite ? 'text-amber-400' : 'text-slate-500 hover:text-amber-400'}`}
                title={d.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill={d.is_favorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5}>
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </button>
              <button
                onClick={(e) => deleteDashboard(d.id, e)}
                className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-red-400 rounded text-xs transition-colors"
                title="Delete"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </>
          )}
          {!d.is_owner && (
            <button
              onClick={(e) => { e.stopPropagation(); duplicateDashboard(d.id); }}
              className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-cyan-400 rounded text-xs transition-colors"
              title="Duplicate to my dashboards"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
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
      combo_chart: 6, radar_chart: 6, treemap_chart: 6,
    };
    const SPAN_MAP: Record<number, number> = { 1: 3, 2: 6, 3: 9, 4: 12 };
    const col12 = widget.colSpan ? (SPAN_MAP[widget.colSpan] ?? 6) : (defaultCols[widget.type] ?? 6);

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
    const cardProps = {
      key: widget.id,
      spec: widget,
      colSpan: col12,
      isFiltered,
      isCrossFilterSource,
      onExportCsv: exportCsv,
      onExportXlsx: exportXlsx,
    };

    switch (widget.type) {
      case 'kpi_card':
        return (
          <WidgetCard {...cardProps}>
            <KpiCard {...widgetProps} />
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
      default:
        return null;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen overflow-hidden flex flex-col"
      style={{ background: 'linear-gradient(135deg, #eef2ff 0%, #f8faff 40%, #f3f0ff 100%)' }}>
      <Nav />

      <div className="flex flex-1 overflow-hidden" style={{ height: 'calc(100vh - 57px)' }}>

        {/* ── Left sidebar ── */}
        <aside className="w-60 glass-sidebar flex flex-col shrink-0 overflow-hidden">
          {/* Sidebar header */}
          <div className="px-4 py-4 border-b border-white/8">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-cyan-400/80 uppercase tracking-[0.15em]">Dashboards</span>
              <button
                onClick={() => { setMode('empty'); setActiveId(null); setCurrentSpec(null); setIsUnsaved(false); }}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold transition-colors"
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
            {createError && <p className="text-xs text-red-400 mt-1">{createError}</p>}
          </div>

          {/* My / Shared toggle */}
          <div className="px-3 pt-3 flex gap-1">
            <button
              onClick={() => { setShowShared(false); setActiveFolder(null); }}
              className={`flex-1 text-[11px] py-1.5 rounded-lg font-semibold transition-all ${!showShared ? 'bg-cyan-500/15 text-cyan-400 shadow-sm ring-1 ring-cyan-500/20' : 'text-slate-500 hover:bg-white/5 hover:text-slate-400'}`}
            >
              My
            </button>
            <button
              onClick={() => { setShowShared(true); setActiveFolder(null); }}
              className={`flex-1 text-[11px] py-1.5 rounded-lg font-semibold transition-all ${showShared ? 'bg-cyan-500/15 text-cyan-400 shadow-sm ring-1 ring-cyan-500/20' : 'text-slate-500 hover:bg-white/5 hover:text-slate-400'}`}
            >
              Shared
            </button>
            <button
              onClick={() => setShowTemplates(true)}
              className="flex-1 text-[11px] py-1.5 rounded-lg font-semibold text-slate-500 hover:bg-white/5 hover:text-slate-400 transition-all"
              title="Browse templates"
            >
              Templates
            </button>
          </div>

          {/* Folder filter */}
          {!showShared && folders.length > 0 && (
            <div className="px-3 pt-2 flex flex-wrap gap-1">
              <button
                onClick={() => setActiveFolder(null)}
                className={`text-[10px] px-2.5 py-0.5 rounded-full border transition-all ${activeFolder === null ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'text-slate-500 border-white/8 hover:border-cyan-500/30 hover:text-cyan-400'}`}
              >
                All
              </button>
              {folders.map((f) => (
                <button
                  key={f}
                  onClick={() => setActiveFolder(activeFolder === f ? null : f)}
                  className={`text-[10px] px-2.5 py-0.5 rounded-full border transition-all ${activeFolder === f ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'text-slate-500 border-white/8 hover:border-cyan-500/30 hover:text-cyan-400'}`}
                >
                  {f}
                </button>
              ))}
            </div>
          )}

          {/* Dashboard list */}
          <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5 scrollbar-thin">
            {favorites.length > 0 && (
              <>
                <p className="text-[10px] text-slate-600 uppercase tracking-[0.15em] px-2 py-1.5 font-bold">Favorites</p>
                {favorites.map((d) => <DashboardListItem key={d.id} d={d} />)}
                {regular.length > 0 && <div className="my-2 border-t border-white/5" />}
              </>
            )}
            {regular.map((d) => <DashboardListItem key={d.id} d={d} />)}
            {visibleDashboards.length === 0 && (
              <p className="text-xs text-slate-600 text-center mt-6 px-2">
                {showShared ? 'No shared dashboards yet' : 'No saved dashboards yet'}
              </p>
            )}
          </div>
        </aside>

        {/* ── Main area ── */}
        <main className="flex-1 overflow-hidden flex flex-col">

          {/* Empty state */}
          {mode === 'empty' && (
            <div className="flex items-center justify-center h-full p-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="widget-card rounded-2xl p-10 max-w-md w-full text-center"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                  </svg>
                </div>
                <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-2">Build your first dashboard</h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
                  Describe what you want to see and let AI design it for you.
                </p>
                <div className="flex justify-center mb-6">
                  <CreateInput
                    value={createInput}
                    onChange={setCreateInput}
                    onSubmit={initiateCreate}
                    loading={createLoading}
                    inputRef={inputRef}
                  />
                </div>
                {createError && <p className="text-xs text-red-500 mb-4">{createError}</p>}
                <div className="flex flex-wrap justify-center gap-2">
                  {['Sales overview', 'Customer analysis', 'Product performance'].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => { setCreateInput(prompt); setMode('choosing'); }}
                      className="px-3.5 py-1.5 text-xs bg-slate-100/80 dark:bg-slate-700/50 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 text-slate-600 dark:text-slate-300 hover:text-indigo-700 dark:hover:text-indigo-300 rounded-full transition-all shadow-sm border border-slate-200/60 dark:border-slate-600/40"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </motion.div>
            </div>
          )}

          {/* Choosing: refine first or generate now */}
          {mode === 'choosing' && (
            <div className="flex items-center justify-center h-full p-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="widget-card rounded-2xl p-8 max-w-lg w-full"
              >
                <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Your request</p>
                <p className="text-base font-semibold text-slate-800 dark:text-slate-200 mb-4 leading-snug">&ldquo;{createInput}&rdquo;</p>

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
                    <div className="mb-5">
                      <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5 font-medium">Data domain</p>
                      <div className="flex flex-wrap gap-2">
                        {chips.map((chip) => (
                          <button
                            key={`${chip.connId}-${chip.label}`}
                            onClick={() => setConnectionId(chip.connId)}
                            className={`px-3 py-1.5 text-xs rounded-full border transition-all font-medium capitalize shadow-sm ${
                              connectionId === chip.connId
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-indigo-500/20'
                                : 'bg-white/80 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 border-slate-200/60 dark:border-slate-600/40 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'
                            }`}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Data product selector */}
                {products.length > 0 && (
                  <div className="mb-5">
                    <p className="text-xs text-slate-500 dark:text-slate-400 mb-1.5 font-medium">Data model(s)</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => setSelectedProductIds([])}
                        className={`px-3 py-1.5 text-xs rounded-full border transition-all font-medium shadow-sm ${
                          selectedProductIds.length === 0
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-indigo-500/20'
                            : 'bg-white/80 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 border-slate-200/60 dark:border-slate-600/40 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'
                        }`}
                      >
                        All products
                      </button>
                      {products.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => {
                            setSelectedProductIds((prev) =>
                              prev.includes(p.id)
                                ? prev.filter((id) => id !== p.id)
                                : [...prev, p.id],
                            );
                          }}
                          className={`px-3 py-1.5 text-xs rounded-full border transition-all font-medium shadow-sm ${
                            selectedProductIds.includes(p.id)
                              ? 'bg-violet-600 text-white border-violet-600 shadow-violet-500/20'
                              : 'bg-white/80 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 border-slate-200/60 dark:border-slate-600/40 hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-300'
                          }`}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                    {selectedProductIds.length > 0 && (
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                        {selectedProductIds.length} product{selectedProductIds.length > 1 ? 's' : ''} selected -- dashboard will only use tables from {selectedProductIds.length > 1 ? 'these products' : 'this product'}
                      </p>
                    )}
                  </div>
                )}

                <p className="text-sm text-slate-500 dark:text-slate-400 mb-5">How would you like to proceed?</p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={askForRefinement}
                    className="flex flex-col items-start gap-2 p-4 rounded-xl transition-all text-left
                      border-2 border-indigo-200/60 dark:border-indigo-700/40
                      bg-indigo-50/50 dark:bg-indigo-900/10
                      hover:border-indigo-400 dark:hover:border-indigo-500
                      hover:bg-indigo-50 dark:hover:bg-indigo-900/20
                      hover:shadow-lg hover:shadow-indigo-500/10"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-md shadow-indigo-500/20">
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                    </div>
                    <span className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">Refine with AI first</span>
                    <span className="text-xs text-indigo-600/80 dark:text-indigo-400/80">Answer a few questions so AI can tailor the dashboard exactly to your needs</span>
                  </button>
                  <button
                    onClick={() => createDashboard()}
                    className="flex flex-col items-start gap-2 p-4 rounded-xl transition-all text-left
                      border-2 border-slate-200/60 dark:border-slate-600/40
                      bg-slate-50/50 dark:bg-slate-800/30
                      hover:border-slate-400 dark:hover:border-slate-500
                      hover:bg-slate-50 dark:hover:bg-slate-800/50
                      hover:shadow-lg hover:shadow-slate-500/10"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-500 to-slate-700 flex items-center justify-center shadow-md shadow-slate-500/20">
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Generate now</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">Let AI decide what to include based on best practices and your schema</span>
                  </button>
                </div>
                <button
                  onClick={() => setMode('empty')}
                  className="mt-4 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                >
                  &larr; Back
                </button>
                {createError && <p className="text-xs text-red-500 mt-3">{createError}</p>}
              </motion.div>
            </div>
          )}

          {/* Refining: AI questions */}
          {mode === 'refining' && (
            <div className="flex items-center justify-center h-full p-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="widget-card rounded-2xl p-8 max-w-xl w-full"
              >
                <p className="text-xs text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">Refining</p>
                <p className="text-base font-semibold text-slate-800 dark:text-slate-200 mb-1">&ldquo;{createInput}&rdquo;</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mb-6">Answer what you can -- skip anything that doesn&apos;t apply</p>

                {refinementLoading ? (
                  <div className="flex items-center gap-3 py-8 justify-center">
                    <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm text-slate-500 dark:text-slate-400">Thinking of the right questions...</span>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {refinementQuestions.map((q, idx) => (
                      <div key={idx}>
                        <p className="text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">
                          <span className="text-indigo-500 font-bold mr-1.5">{idx + 1}.</span>
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
                              className={`px-3 py-1.5 text-xs rounded-full border transition-all shadow-sm ${
                                refinementAnswers[idx] === s
                                  ? 'bg-indigo-600 text-white border-indigo-600 shadow-indigo-500/20'
                                  : 'bg-white/80 dark:bg-slate-700/50 text-slate-600 dark:text-slate-300 border-slate-200/60 dark:border-slate-600/40 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300'
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
                          placeholder="Or type your own answer..."
                          className="w-full px-3 py-1.5 text-xs rounded-lg border
                            border-slate-200/60 dark:border-slate-600/40
                            bg-white/70 dark:bg-slate-800/60
                            focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400
                            text-slate-700 dark:text-slate-200 placeholder-slate-300 dark:placeholder-slate-600
                            transition-all"
                        />
                      </div>
                    ))}

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => createDashboard(Object.values(refinementAnswers).filter(Boolean))}
                        disabled={createLoading}
                        className="flex-1 py-2.5 text-sm font-semibold rounded-xl text-white transition-all
                          bg-gradient-to-r from-indigo-600 to-blue-600
                          hover:from-indigo-700 hover:to-blue-700
                          shadow-md shadow-indigo-500/20
                          disabled:opacity-50"
                      >
                        {createLoading ? 'Generating...' : 'Generate Dashboard'}
                      </button>
                      <button
                        onClick={() => createDashboard()}
                        disabled={createLoading}
                        className="px-4 py-2.5 border border-slate-200/60 dark:border-slate-600/40 hover:bg-slate-50 dark:hover:bg-slate-700/30 text-slate-500 dark:text-slate-400 text-sm rounded-xl transition-all"
                        title="Skip refinement and generate now"
                      >
                        Skip
                      </button>
                    </div>
                    <button
                      onClick={() => setMode('choosing')}
                      className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    >
                      &larr; Back
                    </button>
                  </div>
                )}
              </motion.div>
            </div>
          )}

          {/* Generating state -- wireframe preview */}
          {mode === 'creating' && (
            <div className="flex items-center justify-center h-full px-8">
              <div className="w-full max-w-3xl">
                <div className="text-center mb-6">
                  <div className="flex justify-center mb-3">
                    <div className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <p className="text-base font-semibold text-slate-700 dark:text-slate-200">Generating your dashboard...</p>
                  <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">AI is designing widgets, filters, and SQL queries</p>
                </div>

                {/* Wireframe skeleton preview */}
                <div className="widget-card rounded-2xl p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className={`${shimmerClass} h-5 w-48`} />
                    <div className="flex gap-2">
                      <div className={`${shimmerClass} h-7 w-20 rounded-lg`} />
                      <div className={`${shimmerClass} h-7 w-20 rounded-lg`} />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    {[0.8, 1.0, 0.6, 0.9].map((delay, i) => (
                      <div key={i} className="rounded-xl border border-slate-100/60 dark:border-slate-700/30 p-4 space-y-2">
                        <div className={`${shimmerClass} h-3 w-16`} style={{ animationDelay: `${delay}s` }} />
                        <div className={`${shimmerClass} h-6 w-20`} style={{ animationDelay: `${delay + 0.2}s` }} />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="rounded-xl border border-slate-100/60 dark:border-slate-700/30 p-4 space-y-3">
                      <div className={`${shimmerClass} h-3 w-24`} />
                      <div className="flex items-end gap-2 h-24">
                        {[40, 65, 45, 80, 55, 70, 50].map((h, i) => (
                          <div key={i} className={`flex-1 ${shimmerClass} rounded-t`} style={{ height: `${h}%`, animationDelay: `${i * 0.15}s` }} />
                        ))}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-100/60 dark:border-slate-700/30 p-4 space-y-3">
                      <div className={`${shimmerClass} h-3 w-28`} />
                      <div className="flex items-center justify-center h-24">
                        <div className="w-20 h-20 border-8 border-slate-100/60 dark:border-slate-700/30 border-t-indigo-200 dark:border-t-indigo-500/30 rounded-full animate-spin" style={{ animationDuration: '3s' }} />
                      </div>
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-100/60 dark:border-slate-700/30 p-4 space-y-2">
                    <div className={`${shimmerClass} h-3 w-20`} />
                    <div className="space-y-1.5">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex gap-4">
                          <div className={`${shimmerClass} h-3 w-24`} style={{ animationDelay: `${i * 0.2}s` }} />
                          <div className={`${shimmerClass} h-3 w-16`} style={{ animationDelay: `${i * 0.2 + 0.1}s` }} />
                          <div className={`${shimmerClass} h-3 flex-1`} style={{ animationDelay: `${i * 0.2 + 0.2}s` }} />
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
              {/* Top bar — gradient mesh header */}
              <div className="dashboard-topbar px-6 py-4 flex items-center justify-between gap-4 shrink-0 shadow-lg">
                <div className="min-w-0">
                  <h1 className="font-bold text-lg text-white leading-tight tracking-tight">{currentSpec.title}</h1>
                  {currentSpec.description && (
                    <p className="text-sm text-white/70 mt-0.5 truncate">{currentSpec.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Settings dropdown (share, folder, auto-refresh) */}
                  {activeId && !isUnsaved && (() => {
                    const activeDash = dashboards.find((d) => d.id === activeId);
                    if (!activeDash?.is_owner) return null;
                    return (
                      <div className="relative">
                        <button
                          onClick={() => setSettingsOpen(!settingsOpen)}
                          className="w-8 h-8 flex items-center justify-center rounded-lg
                            border border-white/20
                            bg-white/10
                            hover:bg-white/20
                            transition-colors"
                          title="Dashboard settings"
                        >
                          <svg className="w-4 h-4 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </button>
                        {settingsOpen && (
                          <div className="absolute right-0 top-10 z-50 w-64 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl border border-slate-200/60 dark:border-slate-700/40 rounded-xl shadow-2xl p-3 space-y-3"
                               onClick={(e) => e.stopPropagation()}>
                            <div>
                              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                                <input
                                  type="checkbox"
                                  checked={activeDash.is_shared}
                                  onChange={() => toggleSharing(activeId)}
                                  className="rounded border-slate-300"
                                />
                                Share with team
                              </label>
                              {activeDash.is_shared && (
                                <select
                                  value={activeDash.shared_permission}
                                  onChange={(e) => updateSharedPermission(activeId, e.target.value)}
                                  className="mt-1 w-full text-xs border border-slate-200/60 dark:border-slate-600/40 rounded-lg px-2 py-1 bg-white/80 dark:bg-slate-700/60"
                                >
                                  <option value="viewer">Team can view</option>
                                  <option value="editor">Team can edit</option>
                                </select>
                              )}
                            </div>
                            <div>
                              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Folder</label>
                              <input
                                type="text"
                                defaultValue={activeDash.folder ?? ''}
                                placeholder="Uncategorized"
                                onBlur={(e) => moveToFolder(activeId, e.target.value || null)}
                                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                className="w-full text-xs border border-slate-200/60 dark:border-slate-600/40 rounded-lg px-2 py-1 bg-white/80 dark:bg-slate-700/60"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Auto-refresh</label>
                              <select
                                value={activeDash.auto_refresh_seconds ?? 0}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setAutoRefresh(activeId, v || null);
                                  setAutoRefreshActive(v > 0);
                                }}
                                className="w-full text-xs border border-slate-200/60 dark:border-slate-600/40 rounded-lg px-2 py-1 bg-white/80 dark:bg-slate-700/60"
                              >
                                <option value={0}>Off</option>
                                <option value={30}>Every 30 seconds</option>
                                <option value={60}>Every minute</option>
                                <option value={300}>Every 5 minutes</option>
                                <option value={600}>Every 10 minutes</option>
                                <option value={1800}>Every 30 minutes</option>
                              </select>
                            </div>
                            <button
                              onClick={() => setSettingsOpen(false)}
                              className="w-full text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 pt-1 transition-colors"
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
                        onClick={exportPdf}
                        className="h-8 px-3 flex items-center justify-center rounded-lg
                          border border-white/20 bg-white/10
                          hover:bg-white/20
                          transition-colors text-[10px] font-bold text-white/80 tracking-wide"
                        title="Export as PDF"
                      >
                        PDF
                      </button>
                      <button
                        onClick={exportAllXlsx}
                        className="h-8 px-3 flex items-center justify-center rounded-lg
                          border border-white/20 bg-white/10
                          hover:bg-white/20
                          transition-colors text-[10px] font-bold text-white/80 tracking-wide"
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
                      className="w-8 h-8 flex items-center justify-center rounded-lg
                        border border-white/20 bg-white/10
                        hover:bg-white/20
                        transition-colors"
                      title="Duplicate dashboard"
                    >
                      <svg className="w-4 h-4 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  )}

                  {/* Auto-refresh indicator */}
                  {autoRefreshActive && (
                    <span className="px-2.5 py-1 text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full font-bold flex items-center gap-1.5 tracking-wide">
                      <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                      LIVE
                    </span>
                  )}

                  {isUnsaved ? (
                    <>
                      <button
                        onClick={discardDashboard}
                        className="px-3 py-1.5 text-xs font-medium rounded-lg
                          text-white/70 hover:text-white hover:bg-white/10
                          transition-colors"
                      >
                        Discard
                      </button>
                      <button
                        onClick={saveDashboard}
                        disabled={saving}
                        className="px-4 py-1.5 text-xs font-bold rounded-lg text-white transition-all
                          bg-white/20 hover:bg-white/30 border border-white/30
                          shadow-lg shadow-black/10
                          disabled:opacity-50"
                      >
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <span className="px-3 py-1 text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full font-bold tracking-wide">
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

              {/* Widget grid with stagger animation */}
              <div className="flex-1 overflow-y-auto">
                <motion.div
                  ref={dashboardGridRef}
                  className="dashboard-canvas grid gap-5 p-6"
                  style={{ gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gridAutoRows: 'min-content' }}
                  variants={containerVariants}
                  initial="hidden"
                  animate="visible"
                  key={currentSpec.title}
                >
                  {currentSpec.widgets.map((widget) => renderWidget(widget))}
                </motion.div>
              </div>

              {/* Bottom chat bar */}
              <div className="bg-white/80 backdrop-blur-xl border-t border-slate-200/50 shrink-0 shadow-[0_-4px_24px_rgba(0,51,88,0.04)]">
                {/* Chat history */}
                {chatMessages.length > 0 && (
                  <div className="px-6 pt-3 pb-1 max-h-52 overflow-y-auto space-y-2">
                    {chatMessages.map((msg) => (
                      <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl ${
                          msg.role === 'user'
                            ? 'gradient-primary text-white rounded-br-sm text-sm shadow-lg shadow-[#003358]/20'
                            : msg.type === 'refine'
                            ? 'bg-emerald-50/80 text-emerald-800 border border-emerald-200/60 rounded-bl-sm'
                            : 'glass-card text-slate-800 rounded-bl-sm ai-accent'
                        }`}>
                          {msg.role === 'assistant' && msg.type === 'refine' && (
                            <span className="text-xs font-semibold block mb-0.5 text-emerald-600 dark:text-emerald-400">Dashboard updated</span>
                          )}
                          {msg.role === 'assistant'
                            ? <MarkdownAnswer text={msg.text} />
                            : msg.text}
                        </div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="flex justify-start">
                        <div className="glass-card rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-2">
                          <span className="w-2 h-2 bg-cyan-500 rounded-full thinking-dot" />
                          <span className="w-2 h-2 bg-cyan-500 rounded-full thinking-dot" />
                          <span className="w-2 h-2 bg-cyan-500 rounded-full thinking-dot" />
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
                    placeholder='Ask about the data or say how to improve this dashboard...'
                    disabled={chatLoading}
                    className="flex-1 px-4 py-2.5 text-sm rounded-xl
                      bg-white/60 border border-white/80
                      focus:outline-none focus:ring-2 focus:ring-cyan-400/30 focus:border-cyan-400/40
                      text-slate-800
                      placeholder-slate-400
                      disabled:opacity-50 transition-all"
                  />
                  <button
                    onClick={handleChatSubmit}
                    disabled={chatLoading || !refineInput.trim()}
                    className="px-5 py-2.5 text-sm font-bold text-white rounded-xl
                      gradient-primary
                      shadow-lg shadow-[#003358]/20
                      hover:shadow-xl hover:shadow-[#003358]/25 hover:scale-[1.02]
                      disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap"
                  >
                    {chatLoading ? '...' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Template gallery modal */}
      <AnimatePresence>
        {showTemplates && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          >
            <motion.div
              variants={slideUp}
              initial="hidden"
              animate="visible"
              exit="exit"
              className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl rounded-2xl border border-slate-200/60 dark:border-slate-700/40 shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
            >
              <div className="px-6 py-4 border-b border-slate-100/60 dark:border-slate-700/30 flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Dashboard Templates</h2>
                <button onClick={() => setShowTemplates(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 text-xl transition-colors">&times;</button>
              </div>
              <div className="flex-1 overflow-y-auto p-6">
                {templates.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 flex items-center justify-center">
                      <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400">No templates available yet.</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Admins can save dashboard specs as templates.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-4">
                    {(() => {
                      const categories = Array.from(new Set(templates.map((t) => t.category)));
                      return categories.map((cat) => (
                        <div key={cat} className="col-span-2">
                          <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">{cat}</p>
                          <div className="grid grid-cols-2 gap-3">
                            {templates.filter((t) => t.category === cat).map((t) => (
                              <button
                                key={t.id}
                                onClick={() => createFromTemplate(t.id)}
                                className="text-left p-4 rounded-xl transition-all group
                                  border border-slate-200/60 dark:border-slate-700/40
                                  hover:border-indigo-400 dark:hover:border-indigo-500
                                  hover:shadow-lg hover:shadow-indigo-500/10
                                  bg-white/60 dark:bg-slate-800/40"
                              >
                                <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 group-hover:text-indigo-700 dark:group-hover:text-indigo-300 transition-colors">{t.name}</p>
                                {t.description && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t.description}</p>}
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
