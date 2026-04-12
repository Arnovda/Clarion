'use client';

/**
 * QualityPanel — full quality UI as a self-contained component.
 * Receives connId + tableName from the parent (Semantic page) so it can live
 * inside the "Quality" tab without its own sidebar or navigation.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DimScore {
  completeness_score: number | null;
  uniqueness_score:   number | null;
  validity_score:     number | null;
}
interface Summary extends DimScore {
  id:            number;
  row_count:     number;
  overall_score: number;
  profiled_at:   string;
}

interface FieldProfile {
  id:             number;
  field_name:     string;
  data_type:      string;
  null_count:     number;
  null_pct:       number;
  distinct_count: number;
  distinct_pct:   number;
  min_value:      string | null;
  max_value:      string | null;
  mean_value:     number | null;
  median_value:   number | null;
  top_values:     Array<{ value: string; count: number; pct: number }>;
  histogram:      Array<{ label: string; count: number }>;
}

interface HistoryPoint {
  score_date:         string;
  overall_score:      number | null;
  completeness_score: number | null;
  uniqueness_score:   number | null;
  validity_score:     number | null;
}

interface QualityRule {
  id:               number;
  rule_name:        string;
  dimension:        string;
  rule_type:        string;
  field_names:      string[];
  rule_config:      Record<string, unknown>;
  description:      string | null;
  pass_threshold:   number;
  owner_name:       string | null;
  is_active:        boolean;
  latest_status:    string | null | undefined;
  latest_pass_rate: number | null | undefined;
  sparkline:        Array<{ score_date: string; pass_rate: number | null }>;
}

interface Failure {
  id:                   number;
  rule_id:              number;
  rule_name:            string;
  field_name:           string | null;
  actual_value:         string | null;
  expected_description: string | null;
  first_detected:       string;
  status:               string;
}

interface NewRule {
  rule_name:           string;
  dimension:           string;
  rule_type:           string;
  field_name:          string;
  description:         string;
  pass_threshold:      string;
  owner_name:          string;
  range_min:           string;
  range_max:           string;
  format_pattern:      string;
  freshness_field:     string;
  freshness_max_hours: string;
  custom_sql:          string;
}

interface BkSettings {
  user_bk:      string | null;   // user-configured override
  suggested_bk: string | null;   // auto-detected by last profile run
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rag(score: number | null): string {
  if (score === null) return 'bg-slate-200 text-slate-500';
  if (score >= 0.9)   return 'bg-emerald-100 text-emerald-700';
  if (score >= 0.7)   return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
}

function pct(v: number | null | undefined, decimals = 1) {
  if (v == null || isNaN(v)) return '—';
  return (v * 100).toFixed(decimals) + '%';
}

function fmt(v: number | null | undefined, decimals = 2) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}

function statusBadge(s: string | null) {
  if (!s) return <span className="text-slate-400 text-xs">—</span>;
  const cls =
    s === 'PASS'           ? 'bg-emerald-100 text-emerald-700' :
    s === 'WARNING'        ? 'bg-amber-100 text-amber-700'     :
    s === 'NOT_CONFIGURED' ? 'bg-slate-100 text-slate-500'     :
                             'bg-red-100 text-red-700';
  return <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${cls}`}>{s}</span>;
}

function Sparkbar({ data }: { data: Array<{ count: number }> }) {
  if (!data?.length) return <span className="text-slate-300 text-xs">—</span>;
  const max = Math.max(...data.map((d) => d.count), 1);
  const W = 80, H = 24, bw = W / data.length;
  return (
    <svg width={W} height={H} className="shrink-0">
      {data.map((d, i) => {
        const h = Math.max(2, (d.count / max) * H);
        return (
          <rect key={i} x={i * bw + 1} y={H - h} width={bw - 2} height={h}
            fill="#6366f1" opacity={0.7} rx={1} />
        );
      })}
    </svg>
  );
}

function Sparkline({ data }: { data: Array<{ score_date: string; pass_rate: number | null }> }) {
  if (!data?.length) return <span className="text-slate-300 text-xs">—</span>;
  const clean = data.map((d) => ({ ...d, pass_rate: d.pass_rate ?? 0 }));
  return (
    <ResponsiveContainer width={80} height={24}>
      <LineChart data={clean} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line type="monotone" dataKey="pass_rate" stroke="#6366f1" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── Panel shell ─────────────────────────────────────────────────────────────

function Panel({
  title, open, onToggle, children, action,
}: {
  title: string; open: boolean; onToggle: () => void;
  children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer select-none hover:bg-slate-50"
        onClick={onToggle}
      >
        <span className="font-semibold text-slate-800">{title}</span>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          {action}
          <span className="text-slate-400 text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && <div className="border-t border-slate-100">{children}</div>}
    </div>
  );
}

function DimCard({ label, score, hint }: { label: string; score: number | null; hint?: string }) {
  return (
    <div className={`rounded-lg p-3 ${rag(score)}`} title={hint}>
      <div className="text-xs font-medium opacity-70 mb-1">{label}</div>
      <div className="text-2xl font-bold">{score !== null ? pct(score, 0) : '—'}</div>
    </div>
  );
}

// ─── Add / Edit Rule Form ─────────────────────────────────────────────────────

const RULE_TYPES  = ['null_check', 'range', 'format', 'uniqueness', 'freshness', 'custom'];
const DIMENSIONS  = ['completeness', 'validity', 'uniqueness', 'consistency', 'timeliness', 'accuracy'];

function AddRuleForm({
  fields,
  onSave,
  onCancel,
  initial,
  saveLabel = 'Save rule',
}: {
  fields: FieldProfile[];
  onSave: (r: NewRule) => void;
  onCancel: () => void;
  initial?: Partial<NewRule>;
  saveLabel?: string;
}) {
  const [form, setForm] = useState<NewRule>({
    rule_name:           initial?.rule_name           ?? '',
    dimension:           initial?.dimension           ?? 'completeness',
    rule_type:           initial?.rule_type           ?? 'null_check',
    field_name:          initial?.field_name          ?? '',
    description:         initial?.description         ?? '',
    pass_threshold:      initial?.pass_threshold      ?? '0.95',
    owner_name:          initial?.owner_name          ?? '',
    range_min:           initial?.range_min           ?? '',
    range_max:           initial?.range_max           ?? '',
    format_pattern:      initial?.format_pattern      ?? '',
    freshness_field:     initial?.freshness_field     ?? '',
    freshness_max_hours: initial?.freshness_max_hours ?? '48',
    custom_sql:          initial?.custom_sql          ?? '',
  });

  function set<K extends keyof NewRule>(k: K, v: NewRule[K]) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  const inp = 'border border-slate-200 rounded-md px-2 py-1 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-400';

  const needsField     = ['null_check', 'range', 'format', 'uniqueness'].includes(form.rule_type);
  const needsFreshness = form.rule_type === 'freshness';
  const needsCustom    = form.rule_type === 'custom';

  return (
    <div className="p-5 bg-slate-50 border-t border-slate-200 grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className="block text-xs text-slate-500 mb-1">Rule name *</label>
        <input className={inp} value={form.rule_name}
          onChange={(e) => set('rule_name', e.target.value)}
          placeholder="e.g. Email must not be null" />
      </div>

      <div>
        <label className="block text-xs text-slate-500 mb-1">Dimension</label>
        <select className={inp} value={form.dimension} onChange={(e) => set('dimension', e.target.value)}>
          {DIMENSIONS.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1">Rule type</label>
        <select className={inp} value={form.rule_type} onChange={(e) => set('rule_type', e.target.value)}>
          {RULE_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>

      {needsField && (
        <div>
          <label className="block text-xs text-slate-500 mb-1">Field *</label>
          <select className={inp} value={form.field_name} onChange={(e) => set('field_name', e.target.value)}>
            <option value="">— select field —</option>
            {fields.map((f) => <option key={f.field_name} value={f.field_name}>{f.field_name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs text-slate-500 mb-1">Pass threshold</label>
        <input className={inp} type="number" min="0" max="1" step="0.01"
          value={form.pass_threshold}
          onChange={(e) => set('pass_threshold', e.target.value)} />
      </div>

      {form.rule_type === 'range' && (
        <>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Min value</label>
            <input className={inp} type="number" value={form.range_min}
              onChange={(e) => set('range_min', e.target.value)} placeholder="e.g. 0" />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Max value</label>
            <input className={inp} type="number" value={form.range_max}
              onChange={(e) => set('range_max', e.target.value)} placeholder="e.g. 1000" />
          </div>
        </>
      )}

      {form.rule_type === 'format' && (
        <div className="col-span-2">
          <label className="block text-xs text-slate-500 mb-1">Regex pattern</label>
          <input className={inp} value={form.format_pattern}
            onChange={(e) => set('format_pattern', e.target.value)}
            placeholder={String.raw`e.g. ^[A-Z]{2}\d{4}$`} />
        </div>
      )}

      {needsFreshness && (
        <>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Date field *</label>
            <select className={inp} value={form.freshness_field} onChange={(e) => set('freshness_field', e.target.value)}>
              <option value="">— select field —</option>
              {fields.map((f) => <option key={f.field_name} value={f.field_name}>{f.field_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Max age (hours)</label>
            <input className={inp} type="number" min="1" value={form.freshness_max_hours}
              onChange={(e) => set('freshness_max_hours', e.target.value)} placeholder="48" />
          </div>
        </>
      )}

      {needsCustom && (
        <div className="col-span-2">
          <label className="block text-xs text-slate-500 mb-1">
            SQL — must return failing record IDs as <code className="bg-slate-100 px-1 rounded">record_id</code>
          </label>
          <textarea className={`${inp} font-mono h-20 resize-none`} value={form.custom_sql}
            onChange={(e) => set('custom_sql', e.target.value)}
            placeholder="SELECT id AS record_id FROM table WHERE condition" />
        </div>
      )}

      <div>
        <label className="block text-xs text-slate-500 mb-1">Description</label>
        <input className={inp} value={form.description}
          onChange={(e) => set('description', e.target.value)} />
      </div>
      <div>
        <label className="block text-xs text-slate-500 mb-1">Owner</label>
        <input className={inp} value={form.owner_name}
          onChange={(e) => set('owner_name', e.target.value)} />
      </div>

      <div className="col-span-2 flex gap-2 justify-end">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-md border border-slate-200 hover:bg-slate-100">
          Cancel
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={!form.rule_name.trim()}
          className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

// ─── Failure side drawer ──────────────────────────────────────────────────────

function FailureDrawer({ failure, onClose, onStatusChange }: {
  failure: Failure;
  onClose: () => void;
  onStatusChange: (id: number, status: string) => void;
}) {
  const STATUSES = ['new', 'known', 'in_remediation', 'resolved'];
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="w-96 bg-white h-full shadow-xl border-l border-slate-200 p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-semibold text-slate-800">Failure detail</span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-lg">✕</button>
        </div>
        <dl className="space-y-3 text-sm">
          <div><dt className="text-slate-500 text-xs">Rule</dt><dd className="font-medium">{failure.rule_name}</dd></div>
          <div><dt className="text-slate-500 text-xs">Field</dt><dd>{failure.field_name ?? '—'}</dd></div>
          <div><dt className="text-slate-500 text-xs">Actual value</dt><dd className="font-mono bg-slate-50 rounded px-2 py-1">{failure.actual_value ?? '—'}</dd></div>
          <div><dt className="text-slate-500 text-xs">Expected</dt><dd>{failure.expected_description ?? '—'}</dd></div>
          <div><dt className="text-slate-500 text-xs">First detected</dt><dd>{new Date(failure.first_detected).toLocaleString()}</dd></div>
          <div>
            <dt className="text-slate-500 text-xs mb-1">Status</dt>
            <dd className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button key={s}
                  onClick={() => onStatusChange(failure.id, s)}
                  className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                    failure.status === s
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >{s}</button>
              ))}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

// ─── Main QualityPanel ────────────────────────────────────────────────────────

export default function QualityPanel({
  connId,
  tableName,
  productTableId,
}: {
  connId:         number;
  tableName:      string;
  productTableId?: number;
}) {
  const base = `/quality/${connId}/${encodeURIComponent(tableName)}`;

  // ── Data ──────────────────────────────────────────────────────────────────
  const [summary,   setSummary]   = useState<Summary | null>(null);
  const [fields,    setFields]    = useState<FieldProfile[]>([]);
  const [history,   setHistory]   = useState<HistoryPoint[]>([]);
  const [rules,     setRules]     = useState<QualityRule[]>([]);
  const [failures,  setFailures]  = useState<Failure[]>([]);
  const [failTotal, setFailTotal] = useState(0);
  const [bkSettings, setBkSettings] = useState<BkSettings | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [panels, setPanels]               = useState({ profile: true, rules: true, failures: false });
  const [profiling,      setProfiling]    = useState(false);
  const [evaluating,     setEvaluating]   = useState(false);
  const [actionError,    setActionError]  = useState<string | null>(null);
  const [toast,          setToast]        = useState<{ msg: string; ok: boolean } | null>(null);
  const [expandedField,  setExpandedField]  = useState<number | null>(null);
  const [fieldSearch,    setFieldSearch]    = useState('');
  const [fieldTypeFilter, setFieldTypeFilter] = useState('all');
  const [expandedRule,   setExpandedRule]   = useState<number | null>(null);
  const [addingRule,     setAddingRule]     = useState(false);
  const [editingRule,    setEditingRule]    = useState<QualityRule | null>(null);
  const [failPage,       setFailPage]       = useState(1);
  const [failRuleFilter, setFailRuleFilter] = useState('');
  const [failFieldFilter, setFailFieldFilter] = useState('');
  const [failStatusFilter, setFailStatusFilter] = useState('');
  const [drawerFailure,  setDrawerFailure]  = useState<Failure | null>(null);
  const [highlightField, setHighlightField] = useState<string | null>(null);
  // Business key picker
  const [bkDraft,   setBkDraft]   = useState<string>('');
  const [bkSaving,  setBkSaving]  = useState(false);
  const [bkDirty,   setBkDirty]   = useState(false);

  const PAGE_SIZE = 20;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  }

  function extractError(err: unknown): string {
    const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
    return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Unknown error';
  }

  // ── Load all data when connId / tableName changes ─────────────────────────
  const loadQuality = useCallback(async () => {
    const [sumR, fieldsR, histR, rulesR] = await Promise.allSettled([
      api.get(`${base}/summary`),
      api.get(`${base}/fields`),
      api.get(`${base}/history?days=90`),
      api.get(`${base}/rules`),
    ]);
    if (sumR.status    === 'fulfilled') setSummary(sumR.value.data.data ?? null);
    if (fieldsR.status === 'fulfilled') setFields(fieldsR.value.data.data ?? []);
    if (histR.status   === 'fulfilled') setHistory(histR.value.data.data ?? []);
    if (rulesR.status  === 'fulfilled') setRules(rulesR.value.data.data ?? []);
  }, [base]);

  const loadBkSettings = useCallback(async () => {
    try {
      const r = await api.get(`${base}/settings`);
      const s: BkSettings = r.data.data;
      setBkSettings(s);
      // Pre-fill the draft: user_bk if set, else the suggestion
      setBkDraft(s.user_bk ?? s.suggested_bk ?? '');
      setBkDirty(false);
    } catch { /* settings may not exist yet — ignore */ }
  }, [base]);

  useEffect(() => {
    setSummary(null); setFields([]); setHistory([]); setRules([]); setFailures([]);
    setFailTotal(0); setFailPage(1); setActionError(null);
    setBkSettings(null); setBkDraft(''); setBkDirty(false);
    loadQuality();
    loadBkSettings();
  }, [loadQuality, loadBkSettings]);

  // ── Load failures ─────────────────────────────────────────────────────────
  const loadFailures = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(failPage),
      ...(failRuleFilter   ? { ruleId: failRuleFilter }  : {}),
      ...(failFieldFilter  ? { field:  failFieldFilter }  : {}),
      ...(failStatusFilter ? { status: failStatusFilter } : {}),
    });
    try {
      const r = await api.get(`${base}/failures?${params}`);
      setFailures(r.data.data?.rows ?? []);
      setFailTotal(r.data.data?.total ?? 0);
    } catch {}
  }, [base, failPage, failRuleFilter, failFieldFilter, failStatusFilter]);

  useEffect(() => { loadFailures(); }, [loadFailures]);

  // ── Refresh rules only (called after profile / evaluate) ──────────────────
  async function refreshRules() {
    try {
      const r = await api.get(`${base}/rules`);
      const fetched = r.data.data ?? [];
      if (fetched.length) setRules(fetched);
    } catch {}
  }

  // ── Profile ───────────────────────────────────────────────────────────────
  async function runProfile() {
    setActionError(null);
    setProfiling(true);
    try {
      const profileUrl = productTableId
        ? `/quality/product/${productTableId}/profile`
        : `${base}/profile`;
      await api.post(profileUrl);
      await loadQuality();
      await refreshRules();
      await loadFailures();
      await loadBkSettings();
      showToast('Profile complete', true);
    } catch (err: unknown) {
      const msg = extractError(err);
      setActionError(msg);
      showToast(msg, false);
    }
    setProfiling(false);
  }

  async function runEvaluate() {
    setActionError(null);
    setEvaluating(true);
    try {
      await api.post(`${base}/evaluate`);
      await loadQuality();
      await refreshRules();
      await loadFailures();
      showToast('Rules evaluated', true);
    } catch (err: unknown) {
      const msg = extractError(err);
      setActionError(msg);
      showToast(msg, false);
    }
    setEvaluating(false);
  }

  // ── Business key ──────────────────────────────────────────────────────────
  async function saveBk() {
    setBkSaving(true);
    try {
      await api.patch(`${base}/settings`, { business_key_column: bkDraft || null });
      setBkSettings((prev) => prev ? { ...prev, user_bk: bkDraft || null } : prev);
      setBkDirty(false);
      showToast('Business key saved — re-run profile to apply', true);
    } catch (err: unknown) {
      showToast(extractError(err), false);
    }
    setBkSaving(false);
  }

  // ── Rules CRUD ────────────────────────────────────────────────────────────
  function buildRulePayload(form: NewRule) {
    let field_names: string[] = [];
    let rule_config: Record<string, unknown> = {};
    switch (form.rule_type) {
      case 'null_check':
      case 'uniqueness':
        field_names = form.field_name ? [form.field_name] : [];
        rule_config = {};
        break;
      case 'range':
        field_names = form.field_name ? [form.field_name] : [];
        rule_config = {
          ...(form.range_min !== '' ? { min: Number(form.range_min) } : {}),
          ...(form.range_max !== '' ? { max: Number(form.range_max) } : {}),
        };
        break;
      case 'format':
        field_names = form.field_name ? [form.field_name] : [];
        rule_config = { pattern: form.format_pattern };
        break;
      case 'freshness':
        field_names = form.freshness_field ? [form.freshness_field] : [];
        rule_config = {
          date_field:    form.freshness_field,
          max_age_hours: Number(form.freshness_max_hours) || 48,
        };
        break;
      case 'custom':
        field_names = [];
        rule_config = { sql: form.custom_sql };
        break;
      default:
        field_names = [];
        rule_config = {};
    }
    return { field_names, rule_config };
  }

  async function saveRule(form: NewRule) {
    const { field_names, rule_config } = buildRulePayload(form);
    try {
      const res = await api.post(`${base}/rules`, {
        rule_name:      form.rule_name,
        dimension:      form.dimension,
        rule_type:      form.rule_type,
        field_names,
        description:    form.description || null,
        rule_config,
        pass_threshold: Number(form.pass_threshold),
        owner_name:     form.owner_name || null,
      });
      const saved = res.data.data;
      const normalized: QualityRule = {
        ...saved,
        field_names:      Array.isArray(saved.field_names) ? saved.field_names : (saved.field_names ? JSON.parse(saved.field_names) : []),
        rule_config:      typeof saved.rule_config === 'string' ? JSON.parse(saved.rule_config) : (saved.rule_config ?? {}),
        latest_status:    null,
        latest_pass_rate: null,
        sparkline:        [],
      };
      setRules((prev) => [...prev, normalized]);
      setAddingRule(false);
      showToast('Rule saved', true);
    } catch (err: unknown) {
      showToast(extractError(err), false);
    }
  }

  async function deleteRule(id: number) {
    if (!confirm('Delete this rule?')) return;
    try {
      await api.delete(`/quality/rules/${id}`);
      setRules((prev) => prev.filter((r) => r.id !== id));
      showToast('Rule deleted', true);
    } catch (err: unknown) {
      showToast(extractError(err), false);
    }
  }

  async function toggleRule(rule: QualityRule) {
    try {
      await api.patch(`/quality/rules/${rule.id}`, { is_active: !rule.is_active });
      setRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, is_active: !r.is_active } : r));
    } catch (err: unknown) {
      showToast(extractError(err), false);
    }
  }

  async function updateRule(form: NewRule) {
    if (!editingRule) return;
    const { field_names, rule_config } = buildRulePayload(form);
    try {
      await api.patch(`/quality/rules/${editingRule.id}`, {
        rule_name:      form.rule_name,
        dimension:      form.dimension,
        rule_type:      form.rule_type,
        field_names,
        description:    form.description || null,
        rule_config,
        pass_threshold: Number(form.pass_threshold),
        owner_name:     form.owner_name || null,
      });
      setRules((prev) => prev.map((r) => r.id === editingRule.id ? {
        ...r, rule_name: form.rule_name, dimension: form.dimension,
        rule_type: form.rule_type, field_names,
        description: form.description || null,
        pass_threshold: Number(form.pass_threshold),
        owner_name: form.owner_name || null,
      } : r));
      setEditingRule(null);
      showToast('Rule updated', true);
    } catch (err: unknown) {
      showToast(extractError(err), false);
    }
  }

  // ── Failure status ────────────────────────────────────────────────────────
  async function updateFailureStatus(id: number, status: string) {
    await api.patch(`/quality/failures/${id}`, { status });
    setDrawerFailure((prev) => prev ? { ...prev, status } : null);
    setFailures((prev) => prev.map((f) => f.id === id ? { ...f, status } : f));
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const filteredFields = fields.filter((f) => {
    const nameOk = f.field_name.toLowerCase().includes(fieldSearch.toLowerCase());
    const typeOk = fieldTypeFilter === 'all' ||
      (fieldTypeFilter === 'numeric' && /int|float|real|double|numeric|decimal/i.test(f.data_type)) ||
      (fieldTypeFilter === 'text'    && !/int|float|real|double|numeric|decimal|date|time/i.test(f.data_type)) ||
      (fieldTypeFilter === 'date'    && /date|time/i.test(f.data_type));
    return nameOk && typeOk;
  });

  const sortedHistory = [...history].sort((a, b) => a.score_date.localeCompare(b.score_date));
  const failPages = Math.max(1, Math.ceil(failTotal / PAGE_SIZE));

  // The effective BK column shown in the picker
  const effectiveBk = bkSettings?.user_bk ?? bkSettings?.suggested_bk ?? null;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
      <div className="p-6 space-y-4 max-w-6xl">

        {/* ── Business Key Selector ── */}
        <div className="bg-white border border-slate-200 rounded-xl px-5 py-4">
          <div className="flex items-start gap-6 flex-wrap">
            <div className="flex-1 min-w-60">
              <p className="text-sm font-semibold text-slate-800 mb-0.5">Business Key</p>
              <p className="text-xs text-slate-500">
                The unique identifier for each record. Completeness and uniqueness scores are measured on this column.
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-xs text-slate-500 mb-1">
                  Column
                  {bkSettings?.user_bk && (
                    <span className="ml-2 px-1.5 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[10px] font-semibold">USER-SET</span>
                  )}
                  {!bkSettings?.user_bk && bkSettings?.suggested_bk && (
                    <span className="ml-2 px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-semibold">AUTO-DETECTED</span>
                  )}
                </label>
                <select
                  className="border border-slate-200 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 min-w-40"
                  value={bkDraft}
                  onChange={(e) => { setBkDraft(e.target.value); setBkDirty(true); }}
                >
                  <option value="">— select column —</option>
                  {fields.map((f) => (
                    <option key={f.field_name} value={f.field_name}>{f.field_name}</option>
                  ))}
                  {/* If fields aren't loaded yet but we have a known BK, show it */}
                  {!fields.length && effectiveBk && (
                    <option value={effectiveBk}>{effectiveBk}</option>
                  )}
                </select>
              </div>
              {bkDirty && (
                <button
                  onClick={saveBk}
                  disabled={bkSaving}
                  className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {bkSaving ? 'Saving…' : 'Save'}
                </button>
              )}
              {!bkDirty && bkSettings?.user_bk && (
                <button
                  onClick={() => { setBkDraft(''); setBkDirty(true); }}
                  className="px-2.5 py-1.5 text-xs rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50"
                  title="Clear override — revert to auto-detection"
                >
                  Reset to auto
                </button>
              )}
            </div>
          </div>
          {!bkDirty && !effectiveBk && (
            <p className="text-xs text-amber-600 mt-2">
              No profile has been run yet. Run a profile to auto-detect the business key, or select one manually.
            </p>
          )}
        </div>

        {/* ── Panel 1: Quality Summary ── */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-800 text-lg">{tableName}</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {summary
                  ? `${summary.row_count.toLocaleString()} rows · last profiled ${new Date(summary.profiled_at).toLocaleString()}`
                  : 'Not yet profiled'}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={runProfile}
                disabled={profiling}
                className="px-3 py-1.5 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-1.5"
              >
                {profiling ? (
                  <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" />Profiling…</>
                ) : '▶ Run profile'}
              </button>
              {actionError && <p className="text-xs text-red-500 max-w-xs text-right">{actionError}</p>}
            </div>
          </div>

          {summary && (
            <div className="border-t border-slate-100 px-5 pb-5">
              <div className="mt-4 flex items-center gap-4">
                <div className={`w-20 h-20 rounded-full flex flex-col items-center justify-center text-center shrink-0 ${rag(summary.overall_score)}`}>
                  <span className="text-2xl font-bold">{pct(summary.overall_score, 0)}</span>
                  <span className="text-xs opacity-60">Overall</span>
                </div>
                <div className="grid grid-cols-3 gap-2 flex-1">
                  <DimCard label="BK Completeness" score={summary.completeness_score}
                    hint={`% of rows with a non-null value in the business key column (${effectiveBk ?? 'not set'})`} />
                  <DimCard label="BK Uniqueness"   score={summary.uniqueness_score}
                    hint={`% of distinct values in the business key column (${effectiveBk ?? 'not set'}). Should be 100% for a true primary key.`} />
                  <DimCard label="Rules Pass Rate" score={summary.validity_score}
                    hint="Average pass rate across all active business rules." />
                </div>
              </div>

              {sortedHistory.length > 1 && (
                <div className="mt-5">
                  <p className="text-xs text-slate-500 mb-2 font-medium">90-day score trend</p>
                  <ResponsiveContainer width="100%" height={120}>
                    <LineChart data={sortedHistory} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                      <XAxis dataKey="score_date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
                        tickFormatter={(v: string) => v.slice(5)} />
                      <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
                        tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} width={36} />
                      <Tooltip formatter={(v: unknown) => pct(v as number)} labelFormatter={(l: unknown) => String(l)} />
                      <Line dataKey="overall_score"      name="Overall"         stroke="#6366f1" strokeWidth={2}   dot={false} />
                      <Line dataKey="completeness_score" name="BK Completeness" stroke="#10b981" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                      <Line dataKey="uniqueness_score"   name="BK Uniqueness"   stroke="#f59e0b" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                      <Line dataKey="validity_score"     name="Rules Pass Rate" stroke="#8b5cf6" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}

          {!summary && (
            <div className="border-t border-slate-100 px-5 py-8 text-center text-slate-400 text-sm">
              Click <strong>Run profile</strong> to generate quality metrics for this table.
            </div>
          )}
        </div>

        {/* ── Panel 2: Data Profile ── */}
        <Panel
          title={`Data Profile${fields.length ? ` (${fields.length} fields)` : ''}`}
          open={panels.profile}
          onToggle={() => setPanels((p) => ({ ...p, profile: !p.profile }))}
          action={
            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
              <input
                className="border border-slate-200 rounded-md px-2 py-0.5 text-xs w-32"
                placeholder="Search fields…"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
              />
              <select
                className="border border-slate-200 rounded-md px-2 py-0.5 text-xs"
                value={fieldTypeFilter}
                onChange={(e) => setFieldTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                <option value="numeric">Numeric</option>
                <option value="text">Text</option>
                <option value="date">Date</option>
              </select>
            </div>
          }
        >
          {!fields.length ? (
            <p className="px-5 py-6 text-sm text-slate-400">No field profile data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-xs text-slate-500 border-b border-slate-100">
                    <th className="px-4 py-2 text-left">Field</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-right" title="% of rows with a non-null value">Complete</th>
                    <th className="px-4 py-2 text-right" title="% of distinct values">Unique</th>
                    <th className="px-4 py-2 text-right">Min</th>
                    <th className="px-4 py-2 text-right">Max</th>
                    <th className="px-4 py-2 text-right">Mean</th>
                    <th className="px-4 py-2 text-right">Median</th>
                    <th className="px-4 py-2">Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFields.map((f) => {
                    const isExp        = expandedField === f.id;
                    const highlighted  = highlightField === f.field_name;
                    const isBk         = effectiveBk === f.field_name;
                    const completeness = 1 - f.null_pct;
                    const completeColour = completeness >= 0.9 ? 'text-emerald-600' : completeness >= 0.7 ? 'text-amber-600' : 'text-red-600';
                    const uniqueColour   = f.distinct_pct >= 0.9 ? 'text-emerald-600' : f.distinct_pct >= 0.5 ? 'text-slate-600' : 'text-slate-400';
                    return (
                      <React.Fragment key={f.id}>
                        <tr
                          className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 transition-colors ${highlighted ? 'ring-1 ring-inset ring-indigo-300 bg-indigo-50/30' : ''}`}
                          onClick={() => setExpandedField(isExp ? null : f.id)}
                        >
                          <td className="px-4 py-2.5 font-medium text-slate-800">
                            <div className="flex items-center gap-1.5">
                              <span className="text-slate-400">{isExp ? '▾' : '▸'}</span>
                              {f.field_name}
                              {isBk && <span className="px-1 py-0 bg-indigo-100 text-indigo-600 text-[10px] rounded font-semibold">BK</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs font-mono">{f.data_type || '—'}</td>
                          <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${completeColour}`}>{pct(completeness)}</td>
                          <td className={`px-4 py-2.5 text-right font-mono text-xs ${uniqueColour}`}>{pct(f.distinct_pct)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{f.min_value ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{f.max_value ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{fmt(f.mean_value)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-slate-500">{fmt(f.median_value)}</td>
                          <td className="px-4 py-2.5"><Sparkbar data={f.histogram} /></td>
                        </tr>
                        {isExp && (
                          <tr className="bg-slate-50">
                            <td colSpan={9} className="px-6 py-4">
                              <div className="grid grid-cols-2 gap-6">
                                <div>
                                  <p className="text-xs font-medium text-slate-500 mb-2">Top values</p>
                                  {f.top_values?.length ? (
                                    <div className="space-y-1">
                                      {f.top_values.map((tv, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs">
                                          <span className="w-32 truncate text-slate-700 font-mono">{tv.value}</span>
                                          <div className="flex-1 bg-slate-200 rounded-full h-1.5">
                                            <div className="bg-indigo-400 h-1.5 rounded-full" style={{ width: `${tv.pct * 100}%` }} />
                                          </div>
                                          <span className="text-slate-500 w-10 text-right">{pct(tv.pct)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <span className="text-xs text-slate-400">—</span>}
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-slate-500 mb-2">Distribution</p>
                                  {f.histogram?.length ? (
                                    <ResponsiveContainer width="100%" height={100}>
                                      <BarChart data={f.histogram} margin={{ top: 2, right: 2, bottom: 2, left: 0 }}>
                                        <XAxis dataKey="label" tick={{ fontSize: 9 }} tickLine={false} axisLine={false} />
                                        <YAxis hide />
                                        <Tooltip />
                                        <Bar dataKey="count" fill="#6366f1" radius={[2, 2, 0, 0]} />
                                      </BarChart>
                                    </ResponsiveContainer>
                                  ) : (
                                    <div className="flex flex-wrap gap-1.5">
                                      {f.top_values?.map((tv, i) => (
                                        <span key={i} className="px-1.5 py-0.5 bg-indigo-50 text-indigo-700 text-xs rounded font-mono">
                                          {tv.value} <span className="opacity-60">({tv.count})</span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <button
                                className="mt-3 text-xs text-indigo-600 hover:underline"
                                onClick={() => {
                                  setHighlightField(f.field_name);
                                  setPanels((p) => ({ ...p, rules: true }));
                                  setExpandedField(null);
                                }}
                              >
                                View rules for {f.field_name} →
                              </button>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── Panel 3: Business Rules ── */}
        <Panel
          title={`Business Rules${rules.length ? ` (${rules.length})` : ''}`}
          open={panels.rules}
          onToggle={() => setPanels((p) => ({ ...p, rules: !p.rules }))}
          action={
            <div className="flex gap-2">
              <button
                onClick={runEvaluate}
                disabled={evaluating || !rules.length}
                className="px-2.5 py-1 text-xs rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 font-medium flex items-center gap-1"
              >
                {evaluating
                  ? <><span className="animate-spin inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full" />Evaluating…</>
                  : '▶ Evaluate rules'}
              </button>
              <button
                className="px-2.5 py-1 text-xs rounded-md bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium"
                onClick={() => setAddingRule(true)}
              >
                + Add rule
              </button>
            </div>
          }
        >
          {addingRule && (
            <AddRuleForm fields={fields} onSave={saveRule} onCancel={() => setAddingRule(false)} />
          )}
          {editingRule && (
            <AddRuleForm
              fields={fields}
              initial={{
                rule_name:           editingRule.rule_name,
                dimension:           editingRule.dimension,
                rule_type:           editingRule.rule_type,
                field_name:          editingRule.field_names?.[0] ?? '',
                description:         editingRule.description ?? '',
                pass_threshold:      String(editingRule.pass_threshold ?? 0.95),
                owner_name:          editingRule.owner_name ?? '',
                range_min:           editingRule.rule_config?.min != null ? String(editingRule.rule_config.min) : '',
                range_max:           editingRule.rule_config?.max != null ? String(editingRule.rule_config.max) : '',
                format_pattern:      typeof editingRule.rule_config?.pattern === 'string' ? editingRule.rule_config.pattern : '',
                freshness_field:     typeof editingRule.rule_config?.date_field === 'string' ? editingRule.rule_config.date_field : (editingRule.field_names?.[0] ?? ''),
                freshness_max_hours: editingRule.rule_config?.max_age_hours != null ? String(editingRule.rule_config.max_age_hours) : '48',
                custom_sql:          typeof editingRule.rule_config?.sql === 'string' ? editingRule.rule_config.sql : '',
              }}
              onSave={updateRule}
              onCancel={() => setEditingRule(null)}
              saveLabel="Update rule"
            />
          )}
          {!rules.length && !addingRule ? (
            <p className="px-5 py-6 text-sm text-slate-400">No rules configured yet. Add a rule to start monitoring data quality.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-xs text-slate-500 border-b border-slate-100">
                    <th className="px-4 py-2 text-left">Rule</th>
                    <th className="px-4 py-2 text-left">Dimension</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-left">Fields</th>
                    <th className="px-4 py-2 text-center">Status</th>
                    <th className="px-4 py-2 text-right">Pass rate</th>
                    <th className="px-4 py-2 text-center">Trend</th>
                    <th className="px-4 py-2 text-center">Active</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => {
                    const isExp      = expandedRule === rule.id;
                    const fieldMatch = highlightField && rule.field_names?.includes(highlightField);
                    return (
                      <React.Fragment key={rule.id}>
                        <tr
                          className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${fieldMatch ? 'ring-1 ring-inset ring-indigo-300 bg-indigo-50/30' : ''}`}
                          onClick={() => setExpandedRule(isExp ? null : rule.id)}
                        >
                          <td className="px-4 py-2.5 font-medium text-slate-800">
                            <span className="text-slate-400 mr-1.5">{isExp ? '▾' : '▸'}</span>
                            {rule.rule_name}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">{rule.dimension}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs font-mono text-slate-500">{rule.rule_type}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[8rem] truncate">
                            {rule.field_names?.join(', ') || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-center">{statusBadge(rule.latest_status ?? null)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">{pct(rule.latest_pass_rate)}</td>
                          <td className="px-4 py-2.5"><Sparkline data={rule.sparkline} /></td>
                          <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => toggleRule(rule)}
                              className={`w-8 h-4 rounded-full transition-colors ${rule.is_active ? 'bg-indigo-500' : 'bg-slate-200'}`}
                              title={rule.is_active ? 'Disable' : 'Enable'}
                            />
                          </td>
                          <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => { setEditingRule(rule); setAddingRule(false); }}
                                className="text-slate-300 hover:text-indigo-500 text-xs transition-colors"
                                title="Edit rule"
                              >✎</button>
                              <button
                                onClick={() => deleteRule(rule.id)}
                                className="text-slate-300 hover:text-red-500 text-xs transition-colors"
                                title="Delete rule"
                              >✕</button>
                            </div>
                          </td>
                        </tr>
                        {isExp && (
                          <tr className="bg-slate-50">
                            <td colSpan={9} className="px-6 py-4">
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <dl className="space-y-1.5">
                                  {rule.description && (
                                    <div><dt className="text-xs text-slate-400">Description</dt><dd>{rule.description}</dd></div>
                                  )}
                                  <div><dt className="text-xs text-slate-400">Pass threshold</dt><dd>{pct(rule.pass_threshold)}</dd></div>
                                  {rule.owner_name && (
                                    <div><dt className="text-xs text-slate-400">Owner</dt><dd>{rule.owner_name}</dd></div>
                                  )}
                                </dl>
                                <div>
                                  <button
                                    className="text-xs text-indigo-600 hover:underline"
                                    onClick={() => {
                                      setFailRuleFilter(String(rule.id));
                                      setPanels((p) => ({ ...p, failures: true }));
                                      setExpandedRule(null);
                                    }}
                                  >
                                    View failures for this rule →
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* ── Panel 4: Failed Records ── */}
        <Panel
          title={`Failed Records${failTotal ? ` (${failTotal})` : ''}`}
          open={panels.failures}
          onToggle={() => setPanels((p) => ({ ...p, failures: !p.failures }))}
          action={
            <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
              <select
                className="border border-slate-200 rounded-md px-2 py-0.5 text-xs"
                value={failRuleFilter}
                onChange={(e) => { setFailRuleFilter(e.target.value); setFailPage(1); }}
              >
                <option value="">All rules</option>
                {rules.map((r) => <option key={r.id} value={String(r.id)}>{r.rule_name}</option>)}
              </select>
              <select
                className="border border-slate-200 rounded-md px-2 py-0.5 text-xs"
                value={failStatusFilter}
                onChange={(e) => { setFailStatusFilter(e.target.value); setFailPage(1); }}
              >
                <option value="">All statuses</option>
                <option value="new">new</option>
                <option value="known">known</option>
                <option value="in_remediation">in_remediation</option>
                <option value="resolved">resolved</option>
              </select>
              <input
                className="border border-slate-200 rounded-md px-2 py-0.5 text-xs w-28"
                placeholder="Filter by field…"
                value={failFieldFilter}
                onChange={(e) => { setFailFieldFilter(e.target.value); setFailPage(1); }}
              />
            </div>
          }
        >
          {!failures.length ? (
            <p className="px-5 py-6 text-sm text-slate-400">No failures found for the selected filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 text-xs text-slate-500 border-b border-slate-100">
                      <th className="px-4 py-2 text-left">Rule</th>
                      <th className="px-4 py-2 text-left">Field</th>
                      <th className="px-4 py-2 text-left">Actual value</th>
                      <th className="px-4 py-2 text-left">Expected</th>
                      <th className="px-4 py-2 text-left">Detected</th>
                      <th className="px-4 py-2 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {failures.map((f) => (
                      <tr
                        key={f.id}
                        className="border-b border-slate-50 cursor-pointer hover:bg-slate-50"
                        onClick={() => setDrawerFailure(f)}
                      >
                        <td className="px-4 py-2.5 text-slate-700">{f.rule_name}</td>
                        <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{f.field_name ?? '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-slate-700 max-w-[12rem] truncate">{f.actual_value ?? '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[16rem] truncate">{f.expected_description ?? '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">{new Date(f.first_detected).toLocaleDateString()}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            f.status === 'resolved'       ? 'bg-emerald-100 text-emerald-700' :
                            f.status === 'in_remediation' ? 'bg-blue-100 text-blue-700' :
                            f.status === 'known'          ? 'bg-amber-100 text-amber-700' :
                                                            'bg-red-100 text-red-700'
                          }`}>{f.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 text-xs text-slate-500">
                <span>Showing {(failPage - 1) * PAGE_SIZE + 1}–{Math.min(failPage * PAGE_SIZE, failTotal)} of {failTotal}</span>
                <div className="flex gap-1">
                  <button disabled={failPage === 1} onClick={() => setFailPage((p) => p - 1)}
                    className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50">← Prev</button>
                  <span className="px-2 py-1">Page {failPage} / {failPages}</span>
                  <button disabled={failPage >= failPages} onClick={() => setFailPage((p) => p + 1)}
                    className="px-2 py-1 rounded border border-slate-200 disabled:opacity-40 hover:bg-slate-50">Next →</button>
                </div>
              </div>
            </>
          )}
        </Panel>

      </div>

      {/* Failure side drawer */}
      {drawerFailure && (
        <FailureDrawer
          failure={drawerFailure}
          onClose={() => setDrawerFailure(null)}
          onStatusChange={updateFailureStatus}
        />
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium flex items-center gap-2 ${
          toast.ok ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
        }`}>
          <span>{toast.ok ? '✓' : '✕'}</span>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
