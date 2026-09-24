'use client';

/**
 * The assistant's one look — shared by every place Clarion's AI talks:
 * the Studio coworker, Ask, and the dashboard assistant.
 *
 * Owner, 2026-09-24: "the same symbol in Ask and in dashboards for the AI
 * chat, with the thinking animation and the working animation". So the pieces
 * that make the coworker legible live HERE, once, and each surface composes
 * them instead of re-drawing its own spinner:
 *
 *   assistantMarkState — the mark IS the status: working while it looks
 *                        things up, checking while it verifies, done for a
 *                        moment when it finishes, uncertain when it stopped
 *                        short. Same rule everywhere.
 *   useDoneMoment      — "done" is a beat, not a state to sit in.
 *   useNow / fmtElapsed— a ticking "Working 6s": "is it working or stuck?" is
 *                        the only question asked during the wait, and a
 *                        spinner cannot answer it.
 *   AssistantIdentity  — the mark + the Clarion wordmark + one status line.
 *   WorkStep           — a step: spinner → tick (or warning), pending hollow.
 *   LiveThought        — streamed reasoning with the blinking cursor.
 *
 * A surface that draws its own version of any of these is how the three drift
 * apart again — extend this file instead.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { ClarionMark, type ClarionMarkState } from './ClarionMark';

/** Milliseconds now, ticking once a second while `active`. Read in an effect,
 *  never during render (a render-time clock tears hydration). 0 until then. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState<number>(0);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** True for a short while after `busy` goes from true to false. */
export function useDoneMoment(busy: boolean, ms = 2600): boolean {
  const [justDone, setJustDone] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !busy) {
      was.current = busy;
      setJustDone(true);
      const t = setTimeout(() => setJustDone(false), ms);
      return () => clearTimeout(t);
    }
    was.current = busy;
    return undefined;
  }, [busy, ms]);
  return justDone;
}

/** The one rule for what the mark shows. */
export function assistantMarkState(s: {
  busy: boolean;
  checking?: boolean;
  failed?: boolean;
  justDone?: boolean;
}): ClarionMarkState {
  if (s.busy) return s.checking ? 'checking' : 'working';
  if (s.failed) return 'uncertain';
  return s.justDone ? 'done' : 'idle';
}

/** The mark, the name, and what it is doing right now. */
export function AssistantIdentity({
  state, status, size = 32, trailing,
}: {
  state: ClarionMarkState;
  /** One short line under the name: "Working", "Checking", "Dashboard assistant". */
  status: string;
  size?: 24 | 32;
  /** e.g. the elapsed counter, right-aligned on the status line. */
  trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 min-w-0 flex-1">
      <ClarionMark size={size} state={state} title="Clarion" className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className={`font-brand leading-none text-ink ${size === 32 ? 'text-[19px]' : 'text-[16px]'}`}>Clarion</div>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted-2 truncate">{status}</span>
          {trailing}
        </div>
      </div>
    </div>
  );
}

export type WorkStepStatus = 'pending' | 'running' | 'done' | 'failed';

/** One step of the work: a spinner while it runs, a tick when it lands. */
export function WorkStep({
  status, label, detail, checking, trailing, indent,
}: {
  status: WorkStepStatus;
  label: ReactNode;
  detail?: ReactNode;
  /** A verification step spins in the checking colour, like the mark. */
  checking?: boolean;
  trailing?: ReactNode;
  /** Pixels — a step the server appended under its parent. */
  indent?: number;
}) {
  return (
    <li className="flex items-start gap-2 text-[12.5px] leading-snug" style={indent ? { paddingLeft: indent } : undefined}>
      <span className="w-3.5 h-3.5 mt-[2px] shrink-0 flex items-center justify-center">
        {status === 'running'
          ? <span className={`w-3 h-3 rounded-full border-2 border-t-transparent animate-spin ${checking ? 'border-sky-400' : 'border-ocean'}`} />
          : status === 'done'
            ? <Check className="w-3.5 h-3.5 text-ok" strokeWidth={2.5} />
            : status === 'failed'
              ? <AlertTriangle className="w-3.5 h-3.5 text-warn" />
              : <span className="w-2.5 h-2.5 rounded-full border border-line-strong" />}
      </span>
      <div className="min-w-0 flex-1">
        <span className={status === 'running' ? 'text-ink' : status === 'pending' ? 'text-muted-2' : 'text-ink-2'}>{label}</span>
        {detail && <div className="text-[11px] text-muted-2">{detail}</div>}
      </div>
      {trailing}
    </li>
  );
}

/** Reasoning as it streams — the part that makes the wait followable. */
export function LiveThought({ text, live = true, className = '' }: { text: string; live?: boolean; className?: string }) {
  return (
    <span className={`italic text-[12.5px] leading-snug ${live ? 'text-ink-2' : 'text-muted'} ${className}`}>
      {text}
      {live && <span className="inline-block w-[2px] h-[13px] bg-ocean align-[-2px] ml-0.5 animate-pulse" aria-hidden />}
    </span>
  );
}
