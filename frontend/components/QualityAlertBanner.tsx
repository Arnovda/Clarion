'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import api from '@/lib/api';

interface QualityAlert {
  id: number;
  connection_id: number;
  table_name: string;
  alert_type: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  ai_context: string | null;
  previous_score: number | null;
  current_score: number | null;
  threshold: number | null;
  dismissed: boolean;
  created_at: string;
}

export default function QualityAlertBanner() {
  const [alerts, setAlerts] = useState<QualityAlert[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    loadAlerts();
    // Poll every 60 seconds
    const interval = setInterval(loadAlerts, 60000);
    return () => clearInterval(interval);
  }, []);

  async function loadAlerts() {
    try {
      const res = await api.get('/quality/alerts?dismissed=false');
      setAlerts(res.data.data ?? []);
    } catch {
      // Quality alerts not available (migration not run, etc.)
    }
  }

  async function dismiss(id: number) {
    try {
      await api.patch(`/quality/alerts/${id}/dismiss`);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // ignore
    }
  }

  async function dismissAll() {
    try {
      await api.post('/quality/alerts/dismiss-all');
      setAlerts([]);
    } catch {
      // ignore
    }
  }

  if (alerts.length === 0) return null;

  const critical = alerts.filter((a) => a.severity === 'critical');
  const warnings = alerts.filter((a) => a.severity === 'warning');

  const severityColor = critical.length > 0
    ? 'border-red-300 bg-red-50'
    : 'border-amber-300 bg-amber-50';

  const iconColor = critical.length > 0 ? 'text-red-500' : 'text-amber-500';

  return (
    <div className={`border rounded-lg ${severityColor} mb-4`}>
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className={`w-4 h-4 ${iconColor}`} strokeWidth={2} />
          <span className="text-sm font-medium text-slate-700">
            {alerts.length} quality alert{alerts.length !== 1 ? 's' : ''}
            {critical.length > 0 && (
              <span className="text-red-600 ml-1">({critical.length} critical)</span>
            )}
            {warnings.length > 0 && critical.length === 0 && (
              <span className="text-amber-600 ml-1">({warnings.length} warning{warnings.length !== 1 ? 's' : ''})</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); dismissAll(); }}
            className="text-xs text-slate-500 hover:text-slate-700 px-2 py-0.5 rounded hover:bg-white/50"
          >
            Dismiss all
          </button>
          <ChevronDown
            className={`w-4 h-4 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            strokeWidth={2}
          />
        </div>
      </div>

      {/* Alert list */}
      {expanded && (
        <div className="border-t border-slate-200/50 divide-y divide-slate-200/50">
          {alerts.map((alert) => (
            <div key={alert.id} className="px-4 py-2 flex items-start gap-3">
              <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${
                alert.severity === 'critical' ? 'bg-red-500' : 'bg-amber-400'
              }`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700">{alert.message}</p>
                {alert.ai_context && (
                  <p className="text-xs text-slate-600 italic mt-1 leading-relaxed">{alert.ai_context}</p>
                )}
                <p className="text-xs text-slate-400 mt-0.5">
                  {alert.table_name} &middot;{' '}
                  {new Date(alert.created_at).toLocaleString('en-GB', {
                    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                </p>
              </div>
              <button
                onClick={() => dismiss(alert.id)}
                className="text-xs text-slate-400 hover:text-slate-600 px-1.5 py-0.5 rounded hover:bg-white/50 shrink-0"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
