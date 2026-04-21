'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Schedule {
  id: number;
  product_id: number;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface RunHistory {
  id: number;
  triggered_by: string;
  status: string;
  tables_transformed: number;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
}

// ---------------------------------------------------------------------------
// Cron presets
// ---------------------------------------------------------------------------

const PRESETS = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 6:00', cron: '0 6 * * *' },
  { label: 'Daily at midnight', cron: '0 0 * * *' },
  { label: 'Monday–Friday at 7:00', cron: '0 7 * * 1-5' },
  { label: 'Weekly (Sunday midnight)', cron: '0 0 * * 0' },
  { label: 'Monthly (1st at midnight)', cron: '0 0 1 * *' },
];

function describeCron(cron: string): string {
  const preset = PRESETS.find((p) => p.cron === cron);
  if (preset) return preset.label;
  return cron;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SchedulePanel({ productId }: { productId: number }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [runs, setRuns] = useState<RunHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cronInput, setCronInput] = useState('0 6 * * *');
  const [tzInput, setTzInput] = useState('Europe/Brussels');
  const [enabledInput, setEnabledInput] = useState(true);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    loadData();
  }, [productId]);

  async function loadData() {
    setLoading(true);
    try {
      const [schedRes, runsRes] = await Promise.all([
        api.get(`/schedules/product/${productId}`),
        api.get(`/schedules/product/${productId}/runs?limit=10`),
      ]);
      const s = schedRes.data.data;
      setSchedule(s);
      setRuns(runsRes.data.data ?? []);
      if (s) {
        setCronInput(s.cron_expression);
        setTzInput(s.timezone);
        setEnabledInput(s.enabled);
      }
    } catch {
      // endpoint might not exist yet
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.put(`/schedules/product/${productId}`, {
        cron_expression: cronInput,
        timezone: tzInput,
        enabled: enabledInput,
      });
      await loadData();
      setEditing(false);
    } catch {
      alert('Failed to save schedule');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm('Remove the schedule? Transformations will only run manually.')) return;
    try {
      await api.delete(`/schedules/product/${productId}`);
      setSchedule(null);
      setEditing(false);
    } catch {
      alert('Failed to remove schedule');
    }
  }

  async function handleTrigger() {
    setTriggering(true);
    try {
      await api.post(`/schedules/product/${productId}/run`);
      // Reload runs after a short delay
      setTimeout(loadData, 2000);
    } catch {
      alert('Failed to trigger run');
    } finally {
      setTriggering(false);
    }
  }

  async function handleToggle() {
    if (!schedule) return;
    try {
      await api.put(`/schedules/product/${productId}`, {
        cron_expression: schedule.cron_expression,
        timezone: schedule.timezone,
        enabled: !schedule.enabled,
      });
      await loadData();
    } catch { /* ignore */ }
  }

  if (loading) return <div className="text-xs text-on-surface-variant py-2">Loading schedule…</div>;

  return (
    <div className="bg-raised border border-line rounded-md">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-line bg-softer rounded-t-md">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-on-surface">Schedule</span>
          {schedule && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full ${
              schedule.enabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-white/60 text-on-surface-variant'
            }`}>
              {schedule.enabled ? 'Active' : 'Paused'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleTrigger}
            disabled={triggering}
            className="px-2 py-1 text-xs bg-emerald-500/15 text-emerald-600 rounded-lg hover:bg-emerald-500/25 disabled:opacity-50 transition-colors"
          >
            {triggering ? 'Running…' : 'Run now'}
          </button>
          <button
            onClick={() => setEditing(!editing)}
            className="px-2 py-1 text-xs bg-white/60 border border-white/80 text-on-surface-variant rounded-lg hover:bg-white/80 transition-colors"
          >
            {editing ? 'Cancel' : schedule ? 'Edit' : 'Set up'}
          </button>
        </div>
      </div>

      {/* Current schedule display */}
      {schedule && !editing && (
        <div className="px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm text-on-surface">{describeCron(schedule.cron_expression)}</p>
            <p className="text-xs text-on-surface-variant">{schedule.cron_expression} ({schedule.timezone})</p>
          </div>
          <button
            onClick={handleToggle}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              schedule.enabled ? 'bg-emerald-500' : 'bg-slate-300'
            }`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              schedule.enabled ? 'left-5' : 'left-0.5'
            }`} />
          </button>
        </div>
      )}

      {/* No schedule */}
      {!schedule && !editing && (
        <div className="px-4 py-4 text-center text-xs text-on-surface-variant">
          No schedule configured. Transformations run manually only.
        </div>
      )}

      {/* Edit form */}
      {editing && (
        <div className="px-4 py-4 space-y-3">
          {/* Presets */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1.5">Quick presets</label>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button
                  key={p.cron}
                  onClick={() => setCronInput(p.cron)}
                  className={`px-2 py-1 text-xs rounded-lg border transition-colors ${
                    cronInput === p.cron
                      ? 'bg-cyan-500/15 border-cyan-500/20 text-cyan-700'
                      : 'border-white/80 text-on-surface-variant bg-white/60 hover:bg-white/80'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Cron input */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1">Cron expression</label>
            <input
              type="text"
              value={cronInput}
              onChange={(e) => setCronInput(e.target.value)}
              placeholder="0 6 * * *"
              className="w-full bg-white/60 border border-white/80 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
            />
            <p className="text-[10px] text-on-surface-variant mt-0.5">minute hour day month weekday</p>
          </div>

          {/* Timezone */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant mb-1">Timezone</label>
            <select
              value={tzInput}
              onChange={(e) => setTzInput(e.target.value)}
              className="w-full bg-white/60 border border-white/80 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
            >
              <option value="Europe/Brussels">Europe/Brussels (CET)</option>
              <option value="Europe/Amsterdam">Europe/Amsterdam (CET)</option>
              <option value="Europe/London">Europe/London (GMT)</option>
              <option value="Europe/Paris">Europe/Paris (CET)</option>
              <option value="UTC">UTC</option>
            </select>
          </div>

          {/* Enabled toggle */}
          <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
            <input
              type="checkbox"
              checked={enabledInput}
              onChange={(e) => setEnabledInput(e.target.checked)}
              className="rounded border-white/80 text-cyan-600 focus:ring-cyan-400/30"
            />
            Enable schedule
          </label>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving || !cronInput.trim()}
              className="px-3 py-1.5 text-xs bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save schedule'}
            </button>
            {schedule && (
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 text-xs text-red-600 bg-red-500/10 border border-red-500/20 rounded-xl hover:bg-red-500/20 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {/* Run history */}
      {runs.length > 0 && (
        <div className="border-t border-white/40">
          <div className="px-4 py-2 bg-surface-container">
            <span className="text-xs font-medium text-on-surface-variant">Recent runs</span>
          </div>
          <div className="divide-y divide-white/40">
            {runs.slice(0, 5).map((run) => (
              <div key={run.id} className="px-4 py-2 flex items-center gap-3 text-xs">
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  run.status === 'completed' ? 'bg-emerald-400' :
                  run.status === 'failed' ? 'bg-red-400' :
                  'bg-amber-400 animate-pulse'
                }`} />
                <span className="text-on-surface-variant flex-1">
                  {run.triggered_by === 'schedule' ? 'Scheduled' : run.triggered_by}
                </span>
                <span className="text-on-surface-variant">
                  {run.tables_transformed > 0 && `${run.tables_transformed} tables`}
                  {run.status === 'failed' && (
                    <span className="text-red-500 ml-1" title={run.error_message ?? ''}>failed</span>
                  )}
                </span>
                <span className="text-on-surface-variant/60">
                  {new Date(run.started_at).toLocaleString('en-GB', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
