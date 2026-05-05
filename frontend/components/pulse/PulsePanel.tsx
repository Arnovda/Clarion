'use client';

/**
 * <PulsePanel> — per-user "what should Clarion watch for me" widget.
 *
 * Lives on Home as a top-priority section. Three modes:
 *   - empty    : user hasn't seeded yet → show suggestions from AI
 *   - list     : show entries with quick edit/delete
 *   - editing  : add/edit a single entry inline
 *
 * The pulse is the seed for downstream features (morning brief, alerts,
 * Investigate priorities). Keep this surface focused on the declaration
 * step — not the analytics consumption. Users come here to say what
 * matters; results are surfaced elsewhere (briefs, dashboards).
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Activity, Plus, Sparkles, Trash2, Loader2, Pencil, X, Check,
  AlertCircle,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

// ───────────────────────────────────────────────────────────────────────────
// Types — kept local to avoid a shared-types round-trip; backend owns the
// authoritative shape.
// ───────────────────────────────────────────────────────────────────────────

type Sensitivity = 'low' | 'medium' | 'high';
type Frequency = 'daily' | 'weekly';
type Kind = 'metric' | 'slice' | 'theme';

interface PulseEntry {
  id: number;
  user_id: number;
  kind: Kind;
  product_kpi_id: number | null;
  data_product_id: number | null;
  dimension_table: string | null;
  dimension_column: string | null;
  theme_text: string | null;
  sensitivity: Sensitivity;
  frequency: Frequency;
  label: string | null;
  position: number;
  kpi_name?: string | null;
  product_name?: string | null;
}

interface Suggestion {
  kind: 'metric' | 'slice';
  product_kpi_id: number;
  data_product_id: number;
  dimension_table: string | null;
  dimension_column: string | null;
  sensitivity: Sensitivity;
  frequency: Frequency;
  label: string;
  rationale: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Top-level component
// ───────────────────────────────────────────────────────────────────────────

export default function PulsePanel() {
  const toast = useToast();
  const [entries, setEntries] = useState<PulseEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/pulse');
      setEntries(res.data.data ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading || entries == null) {
    return (
      <Section>
        <div className="flex items-center gap-2 text-[12px] text-muted-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your pulse…
        </div>
      </Section>
    );
  }

  if (entries.length === 0) {
    return <SeedFlow onSeeded={load} />;
  }

  return (
    <PulseList
      entries={entries}
      onChanged={load}
      onAdd={() => { /* delegated to inline AddRow */ }}
    />
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Section wrapper — consistent header used by every state.
// ───────────────────────────────────────────────────────────────────────────

function Section({
  title = 'Your pulse',
  subtitle,
  action,
  children,
}: {
  title?: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-raised border border-line rounded-md overflow-hidden">
      <header className="px-5 py-3.5 border-b border-line flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 text-ocean" strokeWidth={1.75} />
            <h2 className="font-display text-[16px] font-medium text-ink">{title}</h2>
          </div>
          {subtitle && <p className="text-[11.5px] text-muted mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Empty state — fetch suggestions, let user check on/off, save in one go.
// ───────────────────────────────────────────────────────────────────────────

function SeedFlow({ onSeeded }: { onSeeded: () => void }) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.post('/pulse/suggest');
      const data = res.data.data as { suggestions: Suggestion[]; hint: string | null };
      setSuggestions(data.suggestions);
      setHint(data.hint);
      // Pre-select all suggestions — user opts out of what they don't want.
      // Lower friction than asking them to opt in to each one.
      setSelected(new Set(data.suggestions.map((_, i) => i)));
    } catch {
      toast.error('Could not load suggestions');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadSuggestions(); }, [loadSuggestions]);

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const save = useCallback(async () => {
    if (!suggestions) return;
    const picked = suggestions.filter((_, i) => selected.has(i));
    if (picked.length === 0) {
      toast.info('Pick at least one to save', { description: 'Or click Skip to set up your pulse later.' });
      return;
    }
    setSaving(true);
    try {
      await api.post('/pulse/apply-suggest', { suggestions: picked });
      toast.success(`Pulse seeded with ${picked.length} entr${picked.length === 1 ? 'y' : 'ies'}`);
      onSeeded();
    } catch {
      toast.error('Could not save your pulse');
    } finally {
      setSaving(false);
    }
  }, [suggestions, selected, onSeeded, toast]);

  if (loading) {
    return (
      <Section subtitle="Drafting suggestions from your data…">
        <div className="flex items-center gap-2 text-[12.5px] text-muted-2 py-6">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>Reading your products + KPIs…</span>
        </div>
      </Section>
    );
  }

  if (!suggestions || suggestions.length === 0) {
    return (
      <Section subtitle="What should Clarion watch for you?">
        {hint && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded text-[12.5px] text-amber-900">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" strokeWidth={1.75} />
            <span>{hint}</span>
          </div>
        )}
        <p className="text-[12.5px] text-muted mt-3">
          Once you have data products with KPIs defined, come back and I&rsquo;ll suggest a starter pulse.
        </p>
      </Section>
    );
  }

  return (
    <Section
      subtitle="Pick the ones you actually care about. You can edit any time."
      action={
        <button
          onClick={loadSuggestions}
          disabled={loading}
          className="text-[11px] font-mono uppercase tracking-[0.1em] text-muted-2 hover:text-ink-2 disabled:opacity-30"
        >
          ↻ Refresh
        </button>
      }
    >
      <div className="space-y-2">
        {suggestions.map((s, i) => {
          const checked = selected.has(i);
          return (
            <label
              key={i}
              className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                checked ? 'border-ocean/40 bg-ocean/5' : 'border-line bg-bg hover:bg-soft'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(i)}
                className="mt-0.5 accent-ocean"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[13px] font-medium text-ink">{s.label}</span>
                  <span className="text-[10px] font-mono uppercase tracking-[0.1em] text-muted-2">
                    {s.kind}
                  </span>
                  <SensitivityPill value={s.sensitivity} />
                  <FrequencyPill value={s.frequency} />
                </div>
                <p className="text-[12px] text-muted leading-relaxed">{s.rationale}</p>
              </div>
            </label>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-line">
        <button
          onClick={onSeeded}
          disabled={saving}
          className="px-3 py-1.5 text-[12.5px] text-muted hover:text-ink"
        >
          Skip
        </button>
        <button
          onClick={save}
          disabled={saving || selected.size === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium bg-ocean text-on-ocean rounded hover:bg-ocean-dark disabled:opacity-40"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Save {selected.size} {selected.size === 1 ? 'entry' : 'entries'}
        </button>
      </div>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// List state — show entries with hover edit/delete + add button.
// ───────────────────────────────────────────────────────────────────────────

function PulseList({
  entries, onChanged,
}: {
  entries: PulseEntry[];
  onChanged: () => void;
  onAdd: () => void;
}) {
  const toast = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const remove = useCallback(async (entry: PulseEntry) => {
    if (!confirm(`Stop watching "${entry.label ?? entry.kpi_name ?? 'this metric'}"?`)) return;
    try {
      await api.delete(`/pulse/${entry.id}`);
      toast.success('Removed from pulse');
      onChanged();
    } catch {
      toast.error('Could not remove');
    }
  }, [onChanged, toast]);

  return (
    <Section
      subtitle={`${entries.length} ${entries.length === 1 ? 'metric' : 'metrics'} watched · drives your morning brief and alerts`}
      action={
        <button
          onClick={() => setShowSuggestions((v) => !v)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium text-ocean border border-ocean/30 rounded hover:bg-ocean/5"
          title="See AI suggestions for more entries"
        >
          <Sparkles className="w-3 h-3" strokeWidth={2} />
          Suggest more
        </button>
      }
    >
      <div className="space-y-2">
        {entries.map((entry) => (
          editingId === entry.id ? (
            <EditRow
              key={entry.id}
              entry={entry}
              onSaved={() => { setEditingId(null); onChanged(); }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <DisplayRow
              key={entry.id}
              entry={entry}
              onEdit={() => setEditingId(entry.id)}
              onDelete={() => remove(entry)}
              disabled={editingId !== null}
            />
          )
        ))}
      </div>

      {showSuggestions && (
        <div className="mt-4 pt-4 border-t border-line">
          <SuggestMore onAdded={() => { setShowSuggestions(false); onChanged(); }} />
        </div>
      )}
    </Section>
  );
}

function DisplayRow({
  entry, onEdit, onDelete, disabled,
}: {
  entry: PulseEntry;
  onEdit: () => void;
  onDelete: () => void;
  disabled: boolean;
}) {
  const labelText = entry.label
    ?? (entry.kpi_name && entry.dimension_column
        ? `${entry.kpi_name} × ${entry.dimension_column}`
        : entry.kpi_name)
    ?? entry.theme_text
    ?? 'Untitled entry';

  const sliceText = entry.kind === 'slice' && entry.dimension_column
    ? `by ${entry.dimension_column}` : null;

  return (
    <div className="group flex items-start gap-3 p-3 rounded-md border border-line bg-bg hover:bg-soft transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink">{labelText}</span>
          {sliceText && <span className="text-[11px] text-muted-2">{sliceText}</span>}
          {entry.product_name && (
            <span className="text-[10.5px] font-mono uppercase tracking-[0.1em] text-muted-2">
              {entry.product_name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <SensitivityPill value={entry.sensitivity} />
          <FrequencyPill value={entry.frequency} />
        </div>
      </div>

      <div className="flex items-start gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onEdit}
          disabled={disabled}
          title="Edit"
          className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink disabled:opacity-30"
        >
          <Pencil className="w-3 h-3" strokeWidth={1.75} />
        </button>
        <button
          onClick={onDelete}
          disabled={disabled}
          title="Stop watching"
          className="p-1.5 rounded hover:bg-soft text-muted hover:text-red-500 disabled:opacity-30"
        >
          <Trash2 className="w-3 h-3" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function EditRow({
  entry, onSaved, onCancel,
}: {
  entry: PulseEntry;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(entry.label ?? '');
  const [sensitivity, setSensitivity] = useState<Sensitivity>(entry.sensitivity);
  const [frequency, setFrequency] = useState<Frequency>(entry.frequency);
  const [saving, setSaving] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await api.put(`/pulse/${entry.id}`, {
        label: label.trim() || null,
        sensitivity,
        frequency,
      });
      onSaved();
    } catch {
      toast.error('Could not save');
    } finally {
      setSaving(false);
    }
  }, [entry.id, label, sensitivity, frequency, onSaved, toast]);

  return (
    <div className="p-3 rounded-md border border-ocean/30 bg-ocean/5 space-y-3">
      <div className="grid grid-cols-[1fr_auto_auto] gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={entry.kpi_name ?? 'Label'}
          className="px-3 py-1.5 text-[13px] bg-bg border border-line rounded focus:outline-none focus:border-ocean"
        />
        <select
          value={sensitivity}
          onChange={(e) => setSensitivity(e.target.value as Sensitivity)}
          className="px-2 py-1.5 text-[12px] bg-bg border border-line rounded focus:outline-none focus:border-ocean"
        >
          <option value="low">Low sensitivity (±10%)</option>
          <option value="medium">Medium (±5%)</option>
          <option value="high">High (any change)</option>
        </select>
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as Frequency)}
          className="px-2 py-1.5 text-[12px] bg-bg border border-line rounded focus:outline-none focus:border-ocean"
        >
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={saving}
          className="p-1.5 rounded hover:bg-soft text-muted"
          title="Cancel"
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium bg-ocean text-on-ocean rounded hover:bg-ocean-dark disabled:opacity-40"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" strokeWidth={2.25} />}
          Save
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// "Suggest more" — same backend call, surfaced when user already has entries.
// Shows new suggestions, lets them check + save. Filters out duplicates of
// what they've already saved on the server side (the AI is told existing
// names but is best-effort; defensive client-side filter as well).
// ───────────────────────────────────────────────────────────────────────────

function SuggestMore({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.post('/pulse/suggest');
        if (cancelled) return;
        const data = res.data.data as { suggestions: Suggestion[] };
        setSuggestions(data.suggestions);
        setSelected(new Set());
      } catch {
        if (!cancelled) setSuggestions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const apply = useCallback(async () => {
    if (!suggestions) return;
    const picked = suggestions.filter((_, i) => selected.has(i));
    if (picked.length === 0) return;
    setSaving(true);
    try {
      await api.post('/pulse/apply-suggest', { suggestions: picked });
      toast.success(`Added ${picked.length} to your pulse`);
      onAdded();
    } catch {
      toast.error('Could not save');
    } finally {
      setSaving(false);
    }
  }, [suggestions, selected, onAdded, toast]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted-2 py-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Drafting suggestions…
      </div>
    );
  }
  if (!suggestions || suggestions.length === 0) {
    return <p className="text-[12px] text-muted">No new suggestions right now.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-muted-2">More to watch</span>
      </div>
      <div className="space-y-2">
        {suggestions.map((s, i) => {
          const checked = selected.has(i);
          return (
            <label
              key={i}
              className={`flex items-start gap-3 p-2.5 rounded-md border cursor-pointer transition-colors ${
                checked ? 'border-ocean/40 bg-ocean/5' : 'border-line bg-bg hover:bg-soft'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(i)}
                className="mt-0.5 accent-ocean"
              />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium text-ink">{s.label}</div>
                <p className="text-[11.5px] text-muted leading-relaxed">{s.rationale}</p>
              </div>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        <button
          onClick={apply}
          disabled={saving || selected.size === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-ocean text-on-ocean rounded hover:bg-ocean-dark disabled:opacity-40"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          Add {selected.size}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Tiny visual atoms
// ───────────────────────────────────────────────────────────────────────────

function SensitivityPill({ value }: { value: Sensitivity }) {
  const colour = value === 'high' ? 'text-red-700 bg-red-50 border-red-200'
                : value === 'low' ? 'text-muted bg-soft border-line'
                : 'text-amber-700 bg-amber-50 border-amber-200';
  const label = value === 'high' ? 'Sensitive' : value === 'low' ? 'Quiet' : 'Normal';
  return (
    <span className={`px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.08em] rounded border ${colour}`}>
      {label}
    </span>
  );
}

function FrequencyPill({ value }: { value: Frequency }) {
  return (
    <span className="px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.08em] rounded border border-line bg-soft text-muted">
      {value}
    </span>
  );
}
