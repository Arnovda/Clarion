'use client';

/**
 * <InvestigationPanel> — slide-over wrapper around <InvestigationView>.
 *
 * After the Ask AI ↔ Investigate merge, this component is a thin
 * shell: it owns the slide-over chrome (header, close button, status
 * pill) and the SSE driving lifecycle, but delegates the actual
 * rendering of the trail + conclusion to <InvestigationView>.
 *
 * Two modes:
 *   - Live run     : `question` + `dataProductId` are set. Spawns a
 *                    new investigation via POST /api/investigations
 *                    and streams events.
 *   - Replay mode  : `existingId` is set. Fetches the persisted
 *                    investigation via GET /api/investigations/:id
 *                    and shows it without re-running.
 *
 * Entry points wired today:
 *   - Morning brief bullets ("Why?" buttons)
 *   - Standalone /investigate page (free-form question + product picker)
 *
 * The /query chat now drives investigations directly via
 * `runInvestigation()` from `lib/investigateRunner.ts` and renders
 * them inline using <InvestigationView>, bypassing this slide-over.
 */

import { useEffect, useRef, useState } from 'react';
import { X, Search } from 'lucide-react';
import api from '@/lib/api';
import InvestigationView from './InvestigationView';
import { runInvestigation } from '@/lib/investigateRunner';
import {
  type Investigation,
  type InvestigationStep,
  type InvestigationStreamStatus,
  upsertStep,
} from '@/lib/investigationTypes';

interface Props {
  open: boolean;
  onClose: () => void;
  /** What to investigate. If `existingId` is set, we replay an
   *  existing investigation (no new SSE stream). Otherwise we kick
   *  off a new run from the question + product context. */
  question?: string;
  focus?: string | null;
  dataProductId?: number;
  pulseEntryId?: number | null;
  briefId?: number | null;
  /** Replay an already-completed investigation. */
  existingId?: number;
}

export default function InvestigationPanel({
  open, onClose,
  question, focus, dataProductId, pulseEntryId, briefId,
  existingId,
}: Props) {
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const [steps, setSteps] = useState<InvestigationStep[]>([]);
  const [streamStatus, setStreamStatus] = useState<InvestigationStreamStatus>('idle');
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Side-effect: kick off the right path when opened ────────────────────
  useEffect(() => {
    if (!open) return;

    if (existingId) {
      // Replay — no new run.
      setStreamStatus('starting');
      api.get(`/investigations/${existingId}`)
        .then((res) => {
          const inv = res.data.data as Investigation;
          setInvestigation(inv);
          setSteps(inv.steps);
          setStreamStatus(inv.status === 'concluded' ? 'done' : inv.status === 'failed' ? 'failed' : 'running');
        })
        .catch((err) => {
          setStreamStatus('failed');
          setErrorReason(err?.message ?? 'Failed to load');
        });
      return;
    }

    if (!question || !dataProductId) return;

    // New run — POST + consume SSE.
    setStreamStatus('starting');
    setErrorReason(null);
    setInvestigation(null);
    setSteps([]);

    const controller = new AbortController();
    abortRef.current = controller;

    void runInvestigation({
      question,
      focus: focus ?? null,
      dataProductId,
      pulseEntryId: pulseEntryId ?? null,
      briefId: briefId ?? null,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.type === 'step_started') {
          setSteps((prev) => upsertStep(prev, evt.step));
          setStreamStatus('running');
        } else if (evt.type === 'step_completed') {
          setSteps((prev) => upsertStep(prev, evt.step));
        } else if (evt.type === 'concluded') {
          setInvestigation(evt.investigation);
          setSteps(evt.investigation.steps);
          setStreamStatus('done');
        } else if (evt.type === 'failed') {
          setErrorReason(evt.reason);
          setStreamStatus('failed');
        }
      },
    });

    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingId]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[640px] bg-bg border-l border-line shadow-2xl flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3.5 border-b border-line bg-raised">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Search className="w-4 h-4 text-ocean" strokeWidth={1.75} />
              <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
                Investigation
              </span>
              <StatusPill status={streamStatus} />
            </div>
            <h2 className="font-display text-[18px] leading-snug text-ink">
              {question || investigation?.question || 'Investigating…'}
            </h2>
            {(focus || investigation?.focus) && (
              <p className="text-[12px] text-muted mt-1">
                <span className="font-mono uppercase tracking-[0.1em] text-[10px] text-muted-2 mr-1.5">Focus</span>
                {focus || investigation?.focus}
              </p>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink" title="Close">
            <X className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <InvestigationView
          investigation={investigation}
          steps={steps}
          streamStatus={streamStatus}
          errorReason={errorReason}
        />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: InvestigationStreamStatus }) {
  const map: Record<InvestigationStreamStatus, { label: string; cls: string }> = {
    starting:  { label: 'starting',  cls: 'bg-ocean/10 text-ocean' },
    running:   { label: 'running',   cls: 'bg-ocean/10 text-ocean' },
    done:      { label: 'concluded', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    failed:    { label: 'failed',    cls: 'bg-red-50 text-red-700 border-red-200' },
    idle:      { label: '',          cls: '' },
  };
  const v = map[status] ?? map.idle;
  if (!v.label) return null;
  return (
    <span className={`px-1.5 py-0.5 text-[9.5px] font-mono uppercase tracking-[0.1em] rounded border ${v.cls}`}>
      {v.label}
    </span>
  );
}
