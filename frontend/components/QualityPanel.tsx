'use client';

/**
 * QualityPanel — full quality UI as a self-contained component.
 * Receives connId + tableName from the parent (Semantic page) so it can live
 * inside the "Quality" tab without its own sidebar or navigation.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { CONNECTOR_LABELS } from '@/lib/connectorIcons';
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
  user_bk:      string | null;   // the user's own pick
  suggested_bk: string | null;   // what the last profile run actually used
  /** What the SOURCE declares for this table, if it declares anything. */
  declared_bk?: string | null;
  connector_type?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rag(score: number | null): string {
  if (score === null) return 'bg-softer text-muted';
  if (score >= 0.9)   return 'bg-ok-soft text-ok border border-line';
  if (score >= 0.7)   return 'bg-warn-soft text-warn border border-line';
  return 'bg-err-soft text-err border border-line';
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
  if (!s) return <span className="text-muted text-xs">—</span>;
  const cls =
    s === 'PASS'           ? 'bg-ok-soft text-ok border border-line' :
    s === 'WARNING'        ? 'bg-warn-soft text-warn border border-line'     :
    s === 'NOT_CONFIGURED' ? 'bg-softer text-muted border border-line'     :
                             'bg-err-soft text-err border border-line';
  return <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${cls}`}>{s}</span>;
}

function Sparkbar({ data }: { data: Array<{ count: number }> }) {
  if (!data?.length) return <span className="text-muted text-xs">—</span>;
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
  if (!data?.length) return <span className="text-muted text-xs">—</span>;
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
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between px-5 py-4 cursor-pointer select-none hover:bg-softer"
        onClick={onToggle}
      >
        <span className="font-semibold text-ink">{title}</span>
        <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
          {action}
          <span className="text-muted text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && <div className="border-t border-line">{children}</div>}
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

  const inp = 'bg-raised border border-line rounded-md px-3 py-2 text-[13px] w-full text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors';

  const needsField     = ['null_check', 'range', 'format', 'uniqueness'].includes(form.rule_type);
  const needsFreshness = form.rule_type === 'freshness';
  const needsCustom    = form.rule_type === 'custom';

  return (
    <div className="p-5 bg-softer border-t border-line grid grid-cols-2 gap-3">
      <div className="col-span-2">
        <label className="block text-xs text-muted mb-1">Rule name *</label>
        <input className={inp} value={form.rule_name}
          onChange={(e) => set('rule_name', e.target.value)}
          placeholder="e.g. Email must not be null" />
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">Dimension</label>
        <select className={inp} value={form.dimension} onChange={(e) => set('dimension', e.target.value)}>
          {DIMENSIONS.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Rule type</label>
        <select className={inp} value={form.rule_type} onChange={(e) => set('rule_type', e.target.value)}>
          {RULE_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>

      {needsField && (
        <div>
          <label className="block text-xs text-muted mb-1">Field *</label>
          <select className={inp} value={form.field_name} onChange={(e) => set('field_name', e.target.value)}>
            <option value="">— select field —</option>
            {fields.map((f) => <option key={f.field_name} value={f.field_name}>{f.field_name}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs text-muted mb-1">Pass threshold</label>
        <input className={inp} type="number" min="0" max="1" step="0.01"
          value={form.pass_threshold}
          onChange={(e) => set('pass_threshold', e.target.value)} />
      </div>

      {form.rule_type === 'range' && (
        <>
          <div>
            <label className="block text-xs text-muted mb-1">Min value</label>
            <input className={inp} type="number" value={form.range_min}
              onChange={(e) => set('range_min', e.target.value)} placeholder="e.g. 0" />
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Max value</label>
            <input className={inp} type="number" value={form.range_max}
              onChange={(e) => set('range_max', e.target.value)} placeholder="e.g. 1000" />
          </div>
        </>
      )}

      {form.rule_type === 'format' && (
        <div className="col-span-2">
          <label className="block text-xs text-muted mb-1">Regex pattern</label>
          <input className={inp} value={form.format_pattern}
            onChange={(e) => set('format_pattern', e.target.value)}
            placeholder={String.raw`e.g. ^[A-Z]{2}\d{4}$`} />
        </div>
      )}

      {needsFreshness && (
        <>
          <div>
            <label className="block text-xs text-muted mb-1">Date field *</label>
            <select className={inp} value={form.freshness_field} onChange={(e) => set('freshness_field', e.target.value)}>
              <option value="">— select field —</option>
              {fields.map((f) => <option key={f.field_name} value={f.field_name}>{f.field_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-muted mb-1">Max age (hours)</label>
            <input className={inp} type="number" min="1" value={form.freshness_max_hours}
              onChange={(e) => set('freshness_max_hours', e.target.value)} placeholder="48" />
          </div>
        </>
      )}

      {needsCustom && (
        <div className="col-span-2">
          <label className="block text-xs text-muted mb-1">
            SQL — must return failing record IDs as <code className="bg-softer px-1 rounded">record_id</code>
          </label>
          <textarea className={`${inp} font-mono h-20 resize-none`} value={form.custom_sql}
            onChange={(e) => set('custom_sql', e.target.value)}
            placeholder="SELECT id AS record_id FROM table WHERE condition" />
        </div>
      )}

      <div>
        <label className="block text-xs text-muted mb-1">Description</label>
        <input className={inp} value={form.description}
          onChange={(e) => set('description', e.target.value)} />
      </div>
      <div>
        <label className="block text-xs text-muted mb-1">Owner</label>
        <input className={inp} value={form.owner_name}
          onChange={(e) => set('owner_name', e.target.value)} />
      </div>

      <div className="col-span-2 flex gap-2 justify-end">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-md bg-raised border border-line hover:bg-softer">
          Cancel
        </button>
        <button
          onClick={() => onSave(form)}
          disabled={!form.rule_name.trim()}
          className="px-3 py-1.5 text-sm rounded-md bg-ocean text-white hover:bg-ocean-hover disabled:opacity-40"
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
    <div className="fixed inset-0 z-50 flex justify-end backdrop-blur-sm" onClick={onClose}>
      <div className="w-96 bg-raised border-line shadow-2 h-full border-l border-line p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-semibold text-ink">Failure detail</span>
          <button onClick={onClose} className="text-muted hover:text-ink text-lg">✕</button>
        </div>
        <dl className="space-y-3 text-sm">
          <div><dt className="text-muted text-xs">Rule</dt><dd className="font-medium">{failure.rule_name}</dd></div>
          <div><dt className="text-muted text-xs">Field</dt><dd>{failure.field_name ?? '—'}</dd></div>
          <div><dt className="text-muted text-xs">Actual value</dt><dd className="font-mono bg-softer rounded px-2 py-1">{failure.actual_value ?? '—'}</dd></div>
          <div><dt className="text-muted text-xs">Expected</dt><dd>{failure.expected_description ?? '—'}</dd></div>
          <div><dt className="text-muted text-xs">First detected</dt><dd>{new Date(failure.first_detected).toLocaleString()}</dd></div>
          <div>
            <dt className="text-muted text-xs mb-1">Status</dt>
            <dd className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button key={s}
                  onClick={() => onStatusChange(failure.id, s)}
                  className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                    failure.status === s
                      ? 'bg-ocean text-white hover:bg-ocean-hover border-transparent'
                      : 'border-line bg-raised hover:bg-softer'
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
  displayName,
  productTableId,
}: {
  connId:         number;
  tableName:      string;
  displayName?:   string;
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
      // Product tables route through the DuckDB-aware endpoint that
      // resolves the parquet/delta URI via the catalog and runs rules
      // against the warehouse. Source tables keep using the SQLite-only
      // route. Same pattern as runProfile.
      const evaluateUrl = productTableId
        ? `/quality/product/${productTableId}/evaluate`
        : `${base}/evaluate`;
      await api.post(evaluateUrl);
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

  // Where the key came from. Derived rather than stored: "the source declares
  // X" and "we guessed X from your data" are different claims and only one is
  // worth trusting unread, but the difference is already implied by the data
  // we hold — the declaration and what the profile actually used.
  const declaredBk = bkSettings?.declared_bk ?? null;
  const sourceLabel = CONNECTOR_LABELS[bkSettings?.connector_type ?? ''] ?? 'the source';
  const bkOrigin: 'user' | 'declared' | 'guessed' | 'none' =
    bkSettings?.user_bk ? 'user'
      : effectiveBk && declaredBk && effectiveBk.toLowerCase() === declaredBk.toLowerCase() ? 'declared'
        : effectiveBk ? 'guessed'
          : 'none';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-softer">
      <div className="p-6 space-y-4 max-w-6xl">

        {/* ── Business Key Selector ── */}
        <div className="bg-raised border border-line rounded-lg px-5 py-4">
          <div className="flex items-start gap-6 flex-wrap">
            <div className="flex-1 min-w-60">
              <p className="text-sm font-semibold text-ink mb-0.5">Business Key</p>
              <p className="text-xs text-muted">
                The unique identifier for each record. Completeness and uniqueness scores are measured on this column.
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-xs text-muted mb-1">
                  Column
                  {bkOrigin === 'user' && (
                    <span className="ml-2 px-1.5 py-0.5 bg-ocean-softer text-ocean border border-line rounded text-[10px] font-semibold">SET BY YOU</span>
                  )}
                  {bkOrigin === 'declared' && (
                    <span className="ml-2 px-1.5 py-0.5 bg-ok-soft text-ok border border-line rounded text-[10px] font-semibold uppercase">
                      From {sourceLabel}
                    </span>
                  )}
                  {bkOrigin === 'guessed' && (
                    <span className="ml-2 px-1.5 py-0.5 bg-softer text-muted border border-line rounded text-[10px] font-semibold">GUESSED FROM YOUR DATA</span>
                  )}
                </label>
                <select
                  className="bg-raised border border-line rounded-md px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean min-w-40"
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
                  className="px-3 py-1.5 text-sm rounded-md bg-ocean text-white hover:bg-ocean-hover disabled:opacity-50"
                >
                  {bkSaving ? 'Saving…' : 'Save'}
                </button>
              )}
              {!bkDirty && bkSettings?.user_bk && (
                <button
                  onClick={() => { setBkDraft(''); setBkDirty(true); }}
                  className="px-2.5 py-1.5 text-xs rounded-md bg-raised border border-line text-muted hover:bg-softer"
                  title="Clear override — revert to auto-detection"
                >
                  Reset to auto
                </button>
              )}
            </div>
          </div>
          {!bkDirty && bkOrigin === 'declared' && (
            <p className="text-xs text-muted mt-2">
              {sourceLabel} documents <span className="font-mono text-ink-2">{declaredBk}</span> as the identifier for this
              table, so it is used as-is. Pick another column only if you know better.
            </p>
          )}
          {!bkDirty && bkOrigin === 'guessed' && (
            <p className="text-xs text-muted mt-2">
              {sourceLabel} does not document an identifier for this table, so this column was inferred from your
              data — worth a look before you trust the scores below.
            </p>
          )}
          {!bkDirty && bkOrigin === 'none' && (
            <p className="text-xs text-warn mt-2">
              {/* Deliberately not a guess. A wrong key scores 100% complete and
                  100% unique while measuring nothing, and that reads as a good
                  table rather than an unmeasured one. */}
              No identifier could be established for this table — nothing here is both unique and shaped like a key,
              so completeness and uniqueness are not scored. Pick the column that identifies a record and run the
              profile again.
            </p>
          )}
        </div>

        {/* ── Panel 1: Quality Summary ── */}
        <div className="bg-raised border border-line rounded-lg overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-ink text-lg">{displayName || tableName}</h2>
              <p className="text-xs text-muted mt-0.5">
                {summary
                  ? `${summary.row_count.toLocaleString()} rows · last profiled ${new Date(summary.profiled_at).toLocaleString()}`
                  : 'Not yet profiled'}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                onClick={runProfile}
                disabled={profiling}
                className="px-3 py-1.5 text-sm rounded-md bg-ocean text-white hover:bg-ocean-hover disabled:opacity-50 flex items-center gap-1.5"
              >
                {profiling ? (
                  <><span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full" />Profiling…</>
                ) : '▶ Run profile'}
              </button>
              {actionError && <p className="text-xs text-err max-w-xs text-right">{actionError}</p>}
            </div>
          </div>

          {summary && (
            <div className="border-t border-line px-5 pb-5">
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
                  <p className="text-xs text-muted mb-2 font-medium">90-day score trend</p>
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
            <div className="border-t border-line px-5 py-8 text-center text-muted text-sm">
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
                className="bg-raised border border-line rounded-md px-4 py-2.5 text-xs w-32 focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean"
                placeholder="Search fields…"
                value={fieldSearch}
                onChange={(e) => setFieldSearch(e.target.value)}
              />
              <select
                className="bg-raised border border-line rounded-md px-4 py-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean"
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
            <p className="px-5 py-6 text-sm text-muted">No field profile data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-softer text-xs text-muted border-b border-line">
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
                    const completeColour = completeness >= 0.9 ? 'text-ok' : completeness >= 0.7 ? 'text-warn' : 'text-err';
                    const uniqueColour   = f.distinct_pct >= 0.9 ? 'text-ok' : f.distinct_pct >= 0.5 ? 'text-ink' : 'text-muted';
                    return (
                      <React.Fragment key={f.id}>
                        <tr
                          className={`border-b border-line cursor-pointer hover:bg-softer transition-colors ${highlighted ? 'ring-1 ring-inset ring-ocean/30 bg-ocean-softer' : ''}`}
                          onClick={() => setExpandedField(isExp ? null : f.id)}
                        >
                          <td className="px-4 py-2.5 font-medium text-ink">
                            <div className="flex items-center gap-1.5">
                              <span className="text-muted">{isExp ? '▾' : '▸'}</span>
                              {f.field_name}
                              {isBk && <span className="px-1 py-0 bg-ocean-softer text-ocean border border-line text-[10px] rounded font-semibold">BK</span>}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted text-xs font-mono">{f.data_type || '—'}</td>
                          <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${completeColour}`}>{pct(completeness)}</td>
                          <td className={`px-4 py-2.5 text-right font-mono text-xs ${uniqueColour}`}>{pct(f.distinct_pct)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted">{f.min_value ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted">{f.max_value ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted">{fmt(f.mean_value)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs text-muted">{fmt(f.median_value)}</td>
                          <td className="px-4 py-2.5"><Sparkbar data={f.histogram} /></td>
                        </tr>
                        {isExp && (
                          <tr className="bg-softer">
                            <td colSpan={9} className="px-6 py-4">
                              <div className="grid grid-cols-2 gap-6">
                                <div>
                                  <p className="text-xs font-medium text-muted mb-2">Top values</p>
                                  {f.top_values?.length ? (
                                    <div className="space-y-1">
                                      {f.top_values.map((tv, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs">
                                          <span className="w-32 truncate text-ink font-mono">{tv.value}</span>
                                          <div className="flex-1 bg-softer rounded-full h-1.5">
                                            <div className="bg-ocean h-1.5 rounded-full" style={{ width: `${tv.pct * 100}%` }} />
                                          </div>
                                          <span className="text-muted w-10 text-right">{pct(tv.pct)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : <span className="text-xs text-muted">—</span>}
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-muted mb-2">Distribution</p>
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
                                        <span key={i} className="px-1.5 py-0.5 bg-ocean-softer text-ocean text-xs rounded font-mono">
                                          {tv.value} <span className="opacity-60">({tv.count})</span>
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                              <button
                                className="mt-3 text-xs text-ocean hover:underline"
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
              {/* Evaluate rules works against both layers: source tables
                  via SQLite (shells into the file directly), product
                  tables via DuckDB (catalog-resolved parquet/delta URI).
                  runEvaluate routes to the right endpoint based on
                  productTableId. */}
              <button
                onClick={runEvaluate}
                disabled={evaluating || !rules.length}
                className="px-2.5 py-1 text-xs rounded-md bg-raised border border-line text-ink hover:bg-softer disabled:opacity-40 font-medium flex items-center gap-1"
              >
                {evaluating
                  ? <><span className="animate-spin inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full" />Evaluating…</>
                  : '▶ Evaluate rules'}
              </button>
              <button
                className="px-2.5 py-1 text-xs rounded-md bg-ocean text-white hover:bg-ocean-hover font-medium"
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
            <p className="px-5 py-6 text-sm text-muted">No rules configured yet. Add a rule to start monitoring data quality.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-softer text-xs text-muted border-b border-line">
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
                          className={`border-b border-line cursor-pointer hover:bg-softer ${fieldMatch ? 'ring-1 ring-inset ring-ocean/30 bg-ocean-softer' : ''}`}
                          onClick={() => setExpandedRule(isExp ? null : rule.id)}
                        >
                          <td className="px-4 py-2.5 font-medium text-ink">
                            <span className="text-muted mr-1.5">{isExp ? '▾' : '▸'}</span>
                            {rule.rule_name}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="px-1.5 py-0.5 bg-softer text-ink border border-line rounded text-xs">{rule.dimension}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs font-mono text-muted">{rule.rule_type}</td>
                          <td className="px-4 py-2.5 text-xs text-muted max-w-[8rem] truncate">
                            {rule.field_names?.join(', ') || '—'}
                          </td>
                          <td className="px-4 py-2.5 text-center">{statusBadge(rule.latest_status ?? null)}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs">{pct(rule.latest_pass_rate)}</td>
                          <td className="px-4 py-2.5"><Sparkline data={rule.sparkline} /></td>
                          <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => toggleRule(rule)}
                              className={`w-8 h-4 rounded-full transition-colors ${rule.is_active ? 'bg-ocean' : 'bg-line'}`}
                              title={rule.is_active ? 'Disable' : 'Enable'}
                            />
                          </td>
                          <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => { setEditingRule(rule); setAddingRule(false); }}
                                className="text-muted hover:text-ocean text-xs transition-colors"
                                title="Edit rule"
                              >✎</button>
                              <button
                                onClick={() => deleteRule(rule.id)}
                                className="text-muted hover:text-err text-xs transition-colors"
                                title="Delete rule"
                              >✕</button>
                            </div>
                          </td>
                        </tr>
                        {isExp && (
                          <tr className="bg-softer">
                            <td colSpan={9} className="px-6 py-4">
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <dl className="space-y-1.5">
                                  {rule.description && (
                                    <div><dt className="text-xs text-muted">Description</dt><dd>{rule.description}</dd></div>
                                  )}
                                  <div><dt className="text-xs text-muted">Pass threshold</dt><dd>{pct(rule.pass_threshold)}</dd></div>
                                  {rule.owner_name && (
                                    <div><dt className="text-xs text-muted">Owner</dt><dd>{rule.owner_name}</dd></div>
                                  )}
                                </dl>
                                <div>
                                  <button
                                    className="text-xs text-ocean hover:underline"
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
                className="bg-raised border border-line rounded-md px-4 py-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean"
                value={failRuleFilter}
                onChange={(e) => { setFailRuleFilter(e.target.value); setFailPage(1); }}
              >
                <option value="">All rules</option>
                {rules.map((r) => <option key={r.id} value={String(r.id)}>{r.rule_name}</option>)}
              </select>
              <select
                className="bg-raised border border-line rounded-md px-4 py-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean"
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
                className="bg-raised border border-line rounded-md px-4 py-2.5 text-xs w-28 focus:outline-none focus:ring-1 focus:ring-ocean/30 focus:border-ocean"
                placeholder="Filter by field…"
                value={failFieldFilter}
                onChange={(e) => { setFailFieldFilter(e.target.value); setFailPage(1); }}
              />
            </div>
          }
        >
          {!failures.length ? (
            <p className="px-5 py-6 text-sm text-muted">No failures found for the selected filters.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-softer text-xs text-muted border-b border-line">
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
                        className="border-b border-line cursor-pointer hover:bg-softer"
                        onClick={() => setDrawerFailure(f)}
                      >
                        <td className="px-4 py-2.5 text-ink">{f.rule_name}</td>
                        <td className="px-4 py-2.5 text-muted font-mono text-xs">{f.field_name ?? '—'}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-ink max-w-[12rem] truncate">{f.actual_value ?? '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-muted max-w-[16rem] truncate">{f.expected_description ?? '—'}</td>
                        <td className="px-4 py-2.5 text-xs text-muted">{new Date(f.first_detected).toLocaleDateString()}</td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            f.status === 'resolved'       ? 'bg-ok-soft text-ok border border-line' :
                            f.status === 'in_remediation' ? 'bg-blue-500/15 text-blue-600 border border-blue-500/20' :
                            f.status === 'known'          ? 'bg-warn-soft text-warn border border-line' :
                                                            'bg-err-soft text-err border border-line'
                          }`}>{f.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-line text-xs text-muted">
                <span>Showing {(failPage - 1) * PAGE_SIZE + 1}–{Math.min(failPage * PAGE_SIZE, failTotal)} of {failTotal}</span>
                <div className="flex gap-1">
                  <button disabled={failPage === 1} onClick={() => setFailPage((p) => p - 1)}
                    className="px-2 py-1 rounded-md bg-raised border border-line disabled:opacity-40 hover:bg-softer">← Prev</button>
                  <span className="px-2 py-1">Page {failPage} / {failPages}</span>
                  <button disabled={failPage >= failPages} onClick={() => setFailPage((p) => p + 1)}
                    className="px-2 py-1 rounded-md bg-raised border border-line disabled:opacity-40 hover:bg-softer">Next →</button>
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
        <div className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-md shadow-lg text-sm font-medium flex items-center gap-2 backdrop-blur-sm ${
          toast.ok ? 'bg-ok text-white' : 'bg-err text-white'
        }`}>
          <span>{toast.ok ? '✓' : '✕'}</span>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
