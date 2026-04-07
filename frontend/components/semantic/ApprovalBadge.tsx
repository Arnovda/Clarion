'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { isAdmin } from '@/lib/auth';

type ApprovalStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';

interface Props {
  entityType: 'table' | 'column' | 'kpi';
  entityId: number;
  status: ApprovalStatus | undefined;
  aiDraft: boolean;
  rejectionReason?: string;
  onChanged: () => void;
}

export default function ApprovalBadge({ entityType, entityId, status, aiDraft, rejectionReason, onChanged }: Props) {
  const [acting, setActing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState('');
  const [localStatus, setLocalStatus] = useState<ApprovalStatus | null>(null);
  const [localRejection, setLocalRejection] = useState<string | null>(null);
  const admin = isAdmin();

  // Use local override if set, otherwise use prop
  const current = localStatus ?? status ?? 'draft';
  const rejMsg = localRejection ?? rejectionReason;

  const label = current === 'approved' ? 'Approved'
    : current === 'rejected' ? 'Rejected'
    : aiDraft ? 'AI Draft' : 'Draft';
  const style = current === 'approved' ? 'bg-green-100 text-green-700'
    : current === 'rejected' ? 'bg-red-100 text-red-700'
    : aiDraft ? 'bg-amber-100 text-amber-700'
    : 'bg-slate-100 text-slate-600';

  async function doAction(action: 'approve' | 'reject', rejectReason?: string) {
    setActing(true);
    try {
      await api.post('/semantic/approve', {
        entityType,
        entityId,
        action,
        reason: rejectReason,
      });
      // Optimistic update
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

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${style}`}>
        {label}
      </span>

      {current === 'rejected' && rejMsg && (
        <span className="text-xs text-red-500 italic" title={rejMsg}>
          {rejMsg.length > 40 ? rejMsg.slice(0, 40) + '...' : rejMsg}
        </span>
      )}

      {admin && !acting && (
        <div className="flex items-center gap-1">
          {current !== 'approved' && (
            <button
              onClick={() => doAction('approve')}
              className="text-xs px-2 py-0.5 bg-green-50 text-green-600 border border-green-200 rounded hover:bg-green-100"
            >
              Approve
            </button>
          )}
          {current !== 'rejected' && (
            <button
              onClick={() => setShowReject(!showReject)}
              className="text-xs px-2 py-0.5 bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100"
            >
              Reject
            </button>
          )}
        </div>
      )}

      {acting && <span className="text-xs text-slate-400">Updating...</span>}

      {showReject && (
        <div className="flex items-center gap-2 mt-1 w-full">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Rejection reason..."
            className="flex-1 border border-red-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-red-400"
          />
          <button
            onClick={() => doAction('reject', reason)}
            className="text-xs px-2 py-1 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Confirm
          </button>
          <button onClick={() => setShowReject(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        </div>
      )}
    </div>
  );
}
