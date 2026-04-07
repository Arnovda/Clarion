'use client';

import { useState, useEffect, useCallback } from 'react';
import api from '@/lib/api';

/**
 * Reusable banner that polls a BullMQ job for progress.
 *
 * Usage:
 *   <JobProgressBanner queue="schema-profiling" jobId="123" onDone={() => reload()} />
 */

interface JobProgressBannerProps {
  queue: string;
  jobId: string;
  label?: string;
  onDone?: (result: unknown) => void;
  onDismiss?: () => void;
}

interface JobStatus {
  state: string;
  progress: { phase?: string; message?: string } | number | null;
  result: unknown;
  failedReason: string | null;
  attempts: number;
}

const STATE_COLORS: Record<string, string> = {
  waiting: 'bg-amber-50 border-amber-200 text-amber-800',
  active: 'bg-blue-50 border-blue-200 text-blue-800',
  completed: 'bg-green-50 border-green-200 text-green-800',
  failed: 'bg-red-50 border-red-200 text-red-800',
  delayed: 'bg-slate-50 border-slate-200 text-slate-600',
};

const STATE_LABELS: Record<string, string> = {
  waiting: 'Queued',
  active: 'Running',
  completed: 'Complete',
  failed: 'Failed',
  delayed: 'Delayed',
};

export default function JobProgressBanner({ queue, jobId, label, onDone, onDismiss }: JobProgressBannerProps) {
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const poll = useCallback(async () => {
    try {
      const res = await api.get(`/jobs/${queue}/${jobId}`);
      if (res.data.ok) {
        const job = res.data.data as JobStatus;
        setStatus(job);
        if (job.state === 'completed' && onDone) {
          onDone(job.result);
        }
        return job.state;
      }
    } catch {
      // Job might not exist yet, keep polling
    }
    return 'unknown';
  }, [queue, jobId, onDone]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    let mounted = true;

    const startPolling = async () => {
      const state = await poll();
      if (!mounted) return;
      // Keep polling if job is not terminal
      if (state !== 'completed' && state !== 'failed') {
        timer = setInterval(async () => {
          if (!mounted) return;
          const s = await poll();
          if (s === 'completed' || s === 'failed') {
            clearInterval(timer);
          }
        }, 2000);
      }
    };

    startPolling();
    return () => { mounted = false; clearInterval(timer); };
  }, [poll]);

  if (dismissed || !status) return null;

  const colorClass = STATE_COLORS[status.state] ?? STATE_COLORS.delayed;
  const stateLabel = STATE_LABELS[status.state] ?? status.state;
  const progress = typeof status.progress === 'object' && status.progress !== null
    ? status.progress
    : null;

  async function handleRetry() {
    setRetrying(true);
    try {
      await api.post(`/jobs/${queue}/${jobId}/retry`);
      setStatus((prev) => prev ? { ...prev, state: 'waiting', failedReason: null } : prev);
    } catch {
      // ignore
    } finally {
      setRetrying(false);
    }
  }

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div className={`rounded-lg border px-4 py-3 flex items-center gap-3 text-sm ${colorClass}`}>
      {/* Spinner for active/waiting */}
      {(status.state === 'active' || status.state === 'waiting') && (
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{label ?? queue}</span>
          <span className="text-xs px-1.5 py-0.5 rounded-full bg-white/50 font-medium">{stateLabel}</span>
        </div>
        {progress?.message && (
          <p className="text-xs mt-0.5 opacity-80 truncate">{progress.message}</p>
        )}
        {status.failedReason && (
          <p className="text-xs mt-0.5 opacity-80 truncate">{status.failedReason}</p>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {status.state === 'failed' && (
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="px-2 py-1 text-xs bg-white/70 rounded hover:bg-white transition-colors"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        {(status.state === 'completed' || status.state === 'failed') && (
          <button
            onClick={handleDismiss}
            className="text-xs opacity-60 hover:opacity-100"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
