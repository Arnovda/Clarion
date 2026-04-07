'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { KpiDefinition } from './types';
import ApprovalBadge from './ApprovalBadge';
import HistoryPanel from './HistoryPanel';

interface Props {
  connectionId: string;
  kpis: KpiDefinition[];
  onSaved: () => void;
}

const BLANK = { name: '', description: '', formula_plain_text: '', formula_sql: '' };

export default function KpiPanel({ connectionId, kpis, onSaved }: Props) {
  const [adding, setAdding]     = useState(false);
  const [form, setForm]         = useState(BLANK);
  const [saving, setSaving]     = useState(false);
  const [showHistory, setShowHistory] = useState<number | null>(null);

  async function save() {
    setSaving(true);
    await api.post('/semantic/kpis', { connection_id: connectionId, ...form });
    setForm(BLANK);
    setAdding(false);
    setSaving(false);
    onSaved();
  }


  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-2xl space-y-3">
        {kpis.length === 0 && !adding && (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
            No KPI definitions yet. Add your first one below.
          </div>
        )}

        {kpis.map((k) => (
          <div key={k.id} className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-slate-800">{k.name}</span>
              <ApprovalBadge
                entityType="kpi"
                entityId={k.id}
                status={k.approval_status}
                aiDraft={k.ai_draft}
                rejectionReason={k.rejection_reason}
                onChanged={onSaved}
              />
            </div>
            {k.description && <p className="text-sm text-slate-500 mb-2">{k.description}</p>}
            {k.formula_plain_text && (
              <p className="text-xs text-slate-500 mb-1">
                <span className="font-medium">Plain: </span>{k.formula_plain_text}
              </p>
            )}
            {k.formula_sql && (
              <p className="text-xs font-mono bg-slate-50 border border-slate-100 rounded px-2 py-1 text-slate-600 mt-1">{k.formula_sql}</p>
            )}
            <button
              onClick={() => setShowHistory(showHistory === k.id ? null : k.id)}
              className="mt-2 px-2 py-1 text-xs text-slate-400 border border-slate-200 rounded-lg hover:bg-slate-50"
            >
              {showHistory === k.id ? 'Hide History' : 'History'}
            </button>
            {showHistory === k.id && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <HistoryPanel entityType="kpi" entityId={k.id} entityName={k.name} />
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <div className="bg-white rounded-xl border border-blue-200 p-5 space-y-3">
            <p className="font-medium text-slate-800 text-sm">New KPI</p>
            {([
              { key: 'name',                label: 'KPI name',                   ph: 'e.g. Gross Margin' },
              { key: 'description',         label: 'Description',                ph: 'What does this measure?' },
              { key: 'formula_plain_text',  label: 'Formula (plain language)',   ph: 'e.g. Revenue minus cost of goods sold' },
              { key: 'formula_sql',         label: 'Formula (SQL)',              ph: 'e.g. SUM(revenue) - SUM(cogs)' },
            ] as const).map(({ key, label, ph }) => (
              <div key={key}>
                <label className="block text-xs font-medium text-slate-500 mb-1">{label}</label>
                <input
                  value={form[key]}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  placeholder={ph}
                  className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            ))}
            <div className="flex gap-3 pt-1">
              <button onClick={save} disabled={saving || !form.name}
                className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Save KPI'}
              </button>
              <button onClick={() => { setAdding(false); setForm(BLANK); }}
                className="px-4 py-1.5 border border-slate-200 text-sm rounded-lg hover:bg-slate-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="w-full py-3 border-2 border-dashed border-slate-300 rounded-xl text-sm text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
            + Add KPI definition
          </button>
        )}
      </div>
    </div>
  );
}
