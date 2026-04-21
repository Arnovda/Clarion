'use client';

import { useState, useEffect, useCallback } from 'react';
import { Mail, Plus, Trash2, Send } from 'lucide-react';
import api from '../../../lib/api';
import { useToast } from '../../../components/ui/Toast';

interface EmailSchedule {
  id: number;
  dashboard_id: number;
  name: string;
  recipients: string[] | string;
  cron_expression: string;
  enabled: boolean;
  ai_summary: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
}

interface Props {
  dashboardId: number;
}

const CRON_PRESETS = [
  { label: 'Daily at 08:00',        value: '0 8 * * *' },
  { label: 'Weekly — Monday 08:00', value: '0 8 * * 1' },
  { label: 'Monthly — 1st at 08:00', value: '0 8 1 * *' },
];

function parseRecipients(raw: string[] | string): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

export function EmailSchedulePanel({ dashboardId }: Props) {
  const toast = useToast();
  const [schedules, setSchedules] = useState<EmailSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  // New schedule form state
  const [name, setName] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const [cronExpression, setCronExpression] = useState('0 8 * * 1');
  const [aiSummary, setAiSummary] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get(`/api/email-schedules?dashboardId=${dashboardId}`);
      setSchedules(res.data.data ?? []);
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => { load(); }, [load]);

  function addRecipient() {
    const email = recipientInput.trim().toLowerCase();
    if (!email || recipients.includes(email)) { setRecipientInput(''); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error('Invalid email address');
      return;
    }
    setRecipients((r) => [...r, email]);
    setRecipientInput('');
  }

  async function createSchedule() {
    if (!name.trim()) { toast.error('Name is required'); return; }
    if (!recipients.length) { toast.error('Add at least one recipient'); return; }
    setSaving(true);
    try {
      await api.post('/api/email-schedules', {
        dashboard_id: dashboardId,
        name,
        recipients,
        cron_expression: cronExpression,
        ai_summary: aiSummary,
      });
      toast.success('Schedule created');
      setShowForm(false);
      setName('');
      setRecipients([]);
      setCronExpression('0 8 * * 1');
      setAiSummary(true);
      load();
    } catch {
      toast.error('Failed to create schedule');
    } finally {
      setSaving(false);
    }
  }

  async function deleteSchedule(id: number) {
    try {
      await api.delete(`/api/email-schedules/${id}`);
      setSchedules((s) => s.filter((x) => x.id !== id));
      toast.success('Schedule deleted');
    } catch {
      toast.error('Failed to delete');
    }
  }

  async function sendNow(id: number) {
    try {
      await api.post(`/api/email-schedules/${id}/send-now`);
      toast.success('Report queued — check your inbox shortly');
    } catch {
      toast.error('Failed to trigger send');
    }
  }

  async function toggleEnabled(s: EmailSchedule) {
    try {
      await api.put(`/api/email-schedules/${s.id}`, { enabled: !s.enabled });
      setSchedules((list) => list.map((x) => x.id === s.id ? { ...x, enabled: !s.enabled } : x));
    } catch {
      toast.error('Failed to update schedule');
    }
  }

  return (
    <div className="mt-6 pt-6 border-t border-line">
      {/* Section heading */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Mail className="w-4 h-4 text-ink-3" strokeWidth={1.5} />
          <span className="text-[13px] font-medium text-ink">Email Reports</span>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded border border-line text-ink-3 hover:bg-softer hover:text-ink-2 transition-colors"
        >
          <Plus className="w-3 h-3" />
          New schedule
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="mb-4 p-4 rounded-lg border border-line bg-surface space-y-3">
          {/* Name */}
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Schedule name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly sales report"
              className="w-full px-3 py-1.5 text-[12px] rounded-md border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean transition-colors"
            />
          </div>

          {/* Cron picker */}
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Frequency</label>
            <div className="flex gap-1.5 flex-wrap">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setCronExpression(p.value)}
                  className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                    cronExpression === p.value
                      ? 'border-ocean bg-ocean-softer text-ocean'
                      : 'border-line text-ink-3 hover:bg-softer'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              placeholder="0 8 * * 1"
              className="mt-1.5 w-full px-3 py-1 text-[11px] font-mono rounded-md border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean transition-colors"
            />
          </div>

          {/* Recipients */}
          <div>
            <label className="block text-[11px] text-ink-3 mb-1">Recipients</label>
            <div className="flex gap-1.5">
              <input
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addRecipient(); } }}
                placeholder="name@company.com"
                className="flex-1 px-3 py-1.5 text-[12px] rounded-md border border-line bg-base text-ink placeholder-ink-4 focus:outline-none focus:border-ocean transition-colors"
              />
              <button
                onClick={addRecipient}
                className="px-3 py-1.5 text-[12px] rounded-md border border-line text-ink-2 hover:bg-softer transition-colors"
              >
                Add
              </button>
            </div>
            {recipients.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {recipients.map((r) => (
                  <span key={r} className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full bg-softer border border-line text-ink-2">
                    {r}
                    <button onClick={() => setRecipients((x) => x.filter((e) => e !== r))} className="text-muted-2 hover:text-error ml-0.5">×</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* AI summary toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={aiSummary}
              onChange={(e) => setAiSummary(e.target.checked)}
              className="rounded border-line accent-ocean"
            />
            <span className="text-[12px] text-ink-2">Include AI executive summary</span>
          </label>

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={createSchedule}
              disabled={saving}
              className="px-4 py-1.5 text-[12px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover disabled:opacity-50 transition-colors"
            >
              {saving ? 'Creating…' : 'Create schedule'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 text-[12px] text-muted hover:text-ink-2 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Schedule list */}
      {loading ? (
        <p className="text-[12px] text-ink-4">Loading…</p>
      ) : schedules.length === 0 ? (
        <p className="text-[12px] text-ink-4">No schedules yet. Create one to send this dashboard by email automatically.</p>
      ) : (
        <ul className="space-y-2">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-line bg-surface">
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink truncate">{s.name}</p>
                <p className="text-[11px] text-ink-4 font-mono mt-0.5">{s.cron_expression}</p>
                <p className="text-[11px] text-ink-4 mt-0.5">{parseRecipients(s.recipients).join(', ')}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* Enabled toggle */}
                <button
                  onClick={() => toggleEnabled(s)}
                  title={s.enabled ? 'Pause schedule' : 'Resume schedule'}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded-full border transition-colors ${
                    s.enabled
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-line bg-softer text-ink-4'
                  }`}
                >
                  {s.enabled ? 'Active' : 'Paused'}
                </button>
                {/* Send now */}
                <button
                  onClick={() => sendNow(s.id)}
                  title="Send now"
                  className="p-1.5 rounded text-ink-4 hover:text-ocean hover:bg-ocean-softer transition-colors"
                >
                  <Send className="w-3.5 h-3.5" strokeWidth={1.5} />
                </button>
                {/* Delete */}
                <button
                  onClick={() => deleteSchedule(s.id)}
                  title="Delete schedule"
                  className="p-1.5 rounded text-ink-4 hover:text-error hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
