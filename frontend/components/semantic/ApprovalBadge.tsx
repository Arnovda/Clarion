'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { isAdmin } from '@/lib/auth';

type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';

interface Props {
  entityType: 'table' | 'column' | 'kpi' | 'product_table' | 'product_column';
  entityId: number;
  status: ApprovalStatus | undefined;
  aiDraft: boolean;
  rejectionReason?: string;
  onChanged: () => void;
  /** Compact mode: show only the orb, no text */
  compact?: boolean;
}

export default function ApprovalBadge({ entityType, entityId, status, aiDraft, rejectionReason, onChanged, compact = false }: Props) {
  const [acting, setActing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [localStatus, setLocalStatus] = useState<ApprovalStatus | null>(null);
  const [localRejection, setLocalRejection] = useState<string | null>(null);
  const admin = isAdmin();

  const current = localStatus ?? status ?? 'draft';
  const rejMsg = localRejection ?? rejectionReason;

  // Orb + label config
  const orbClass = current === 'approved' ? 'orb-approved'
    : current === 'rejected' ? 'orb-rejected'
    : aiDraft ? 'orb-draft'
    : 'orb-neutral';

  const label = current === 'approved' ? 'Confirmed'
    : current === 'rejected' ? 'Flagged'
    : aiDraft ? 'AI Suggested' : 'Draft';

  async function doAction(action: 'approve' | 'reject', rejectReason?: string) {
    setActing(true);
    try {
      await api.post('/semantic/approve', { entityType, entityId, action, reason: rejectReason });
      setLocalStatus(action === 'approve' ? 'approved' : 'rejected');
      if (action === 'reject') setLocalRejection(rejectReason ?? null);
      else setLocalRejection(null);
      setShowReject(false);
      setReason('');
      onChanged();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? String(err);
      console.error('Approve error:', msg, err);
      alert(`Approval failed: ${msg}`);
    }
    setActing(false);
  }

  if (compact) {
    return (
      <span className={orbClass} title={label} />
    );
  }

  return (
    <div className="flex items-center gap-2.5 flex-wrap">
      {/* Glowing orb */}
      <div className="flex items-center gap-2">
        <span className={orbClass} />
        <span className="text-xs font-medium text-slate-500">{label}</span>
      </div>

      {current === 'rejected' && rejMsg && (
        <span className="text-xs text-red-400 italic max-w-[180px] truncate" title={rejMsg}>
          {rejMsg}
        </span>
      )}

      {admin && !acting && (
        <div className="flex items-center gap-1">
          {current !== 'approved' && (
            <button
              onClick={() => doAction('approve')}
              className="text-[10px] px-2.5 py-1 bg-emerald-500/10 text-emerald-600 rounded-lg hover:bg-emerald-500/20 font-semibold transition-all hover:shadow-glow-green"
            >
              Confirm
            </button>
          )}
          {current !== 'rejected' && (
            <button
              onClick={() => setShowReject(!showReject)}
              className="text-[10px] px-2.5 py-1 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20 font-semibold transition-all hover:shadow-glow-red"
            >
              Flag Issue
            </button>
          )}
        </div>
      )}

      {acting && (
        <span className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          Updating...
        </span>
      )}

      {showReject && (
        <div className="flex items-center gap-2 mt-1 w-full">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What's the issue?"
            className="flex-1 bg-red-500/5 border border-red-200/50 rounded-lg px-3 py-1.5 text-xs text-slate-700 placeholder:text-red-300 focus:outline-none focus:ring-1 focus:ring-red-400/50"
          />
          <button
            onClick={() => doAction('reject', reason)}
            className="text-xs px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium transition-colors"
          >
            Confirm
          </button>
          <button onClick={() => setShowReject(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        </div>
      )}
    </div>
  );
}
