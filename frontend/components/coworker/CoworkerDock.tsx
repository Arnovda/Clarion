'use client';

/**
 * The Studio coworker's panel — docked on the right, one place for everything.
 *
 * Genie's shape, in Clarion's hand:
 *   - the mark IS the status: idle at rest, working while it looks things up,
 *     checking while it compiles or measures a proposal, done when it lands,
 *     uncertain when it stopped short;
 *   - its thinking is visible while it works — one short sentence before each
 *     step, then the step itself settling to a tick — and folds away into
 *     "Worked 14s · 5 steps" once the answer is there;
 *   - what it proposes lands as a card, with the evidence, and nothing is
 *     saved until the person keeps it;
 *   - "Follow along" lets the screen move to whatever it opens.
 *
 * Collapsed, it is a pill that keeps reporting what it is doing, so closing
 * the panel never means losing sight of the work.
 *
 * History: every conversation is kept (per person, server-side). The clock
 * button lists them; the empty panel shows the most recent few.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AlertTriangle, ArrowLeft, ArrowUp, ChevronDown, ChevronRight, Eye, EyeOff, History, Loader2, MessageSquare,
  PanelRightClose, Square, SquarePen, Trash2,
} from 'lucide-react';
import { formatRelative } from '@/lib/dates';
import { ClarionMark } from '@/components/brand/ClarionMark';
import {
  AssistantIdentity, LiveThought, WorkStep, assistantMarkState, fmtElapsed, useDoneMoment, useNow,
} from '@/components/brand/AssistantKit';
import { MarkdownAnswer } from '@/app/dashboards/components/MarkdownAnswer';
import ProposalCard from './ProposalCard';
import { useCoworker, type CwMessage, type CwStep, type CwThreadSummary } from '@/lib/coworker/CoworkerProvider';
import type { CoworkerFocus, CoworkerProposal } from '@/lib/contract';

export const COWORKER_WIDTH = 420;

const fmtSecs = fmtElapsed;

function runningStep(m: CwMessage | undefined): CwStep | undefined {
  if (!m) return undefined;
  for (let i = m.trail.length - 1; i >= 0; i--) {
    const t = m.trail[i];
    if (t.kind === 'step' && t.step.status === 'running') return t.step;
  }
  return undefined;
}

function focusOf(p: CoworkerProposal): CoworkerFocus | null {
  if (p.kind === 'sql') return { kind: 'table', tableId: p.tableId, tab: 'sql' };
  if (p.kind === 'table') return { kind: 'subject', productId: p.productId };
  if (p.kind === 'relationship') return { kind: 'relations', tableId: p.fromTableId };
  return null;
}

export default function CoworkerDock() {
  const cw = useCoworker();
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = useMemo(() => cw?.messages ?? [], [cw?.messages]);
  const busy = cw?.busy ?? false;
  const working = messages.find((m) => m.working);
  const last = messages[messages.length - 1];
  const step = runningStep(working);
  const now = useNow(!!working);
  const pendingCount = Object.values(cw?.proposals ?? {}).filter((p) => p.status === 'pending').length;

  // "Done" is a moment, not a state to sit in (shared rule: AssistantKit).
  const justDone = useDoneMoment(busy);
  const markState = assistantMarkState({
    busy,
    checking: step?.tool === 'propose',
    failed: last?.role === 'assistant' && !!(last.error || last.stoppedAtLimit),
    justDone,
  });

  useEffect(() => { if (cw?.open) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, cw?.open]);

  // A header action ("Change with AI") opens the panel with words ready.
  useEffect(() => {
    if (cw?.prefill && cw.open) {
      setInput(cw.prefill);
      cw.consumePrefill();
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [cw]);

  useEffect(() => { if (cw?.open) setTimeout(() => inputRef.current?.focus(), 60); }, [cw?.open]);

  // The history list is fetched when the panel first opens, and again every
  // time the full list is shown (another tab or device may have added one).
  const threadsLoaded = cw?.threads != null;
  const loadThreads = cw?.loadThreads;
  const panelOpen = cw?.open && cw?.enabled === true;
  useEffect(() => { if (panelOpen && !threadsLoaded) loadThreads?.(); }, [panelOpen, threadsLoaded, loadThreads]);
  useEffect(() => { if (showHistory) loadThreads?.(); }, [showHistory, loadThreads]);

  const suggestions = useMemo(() => {
    const ctx = cw?.pageContext;
    if (ctx?.tableId) return ['What does this table hold, and where does it come from?', 'Which dashboards use this table?', 'Add the customer’s country to this table'];
    if (ctx?.sourceTableId) return ['Which relationships of this table look wrong?', 'What does each column mean?', 'Which subject uses this table?'];
    if (ctx?.productId) return ['What can this subject answer?', 'Is anything in this subject broken?', 'Define “active customer” for this subject'];
    return ['What’s in this workspace?', 'Which synced tables are not used by any subject?', 'Make a subject for quotations'];
  }, [cw?.pageContext]);

  if (!cw || cw.enabled !== true) return null;

  const submit = (text?: string) => {
    const t = (text ?? input).trim();
    if (!t || busy) return;
    cw.send(t);
    setInput('');
    setShowHistory(false);
  };
  const newConversation = () => { cw.newChat(); setShowHistory(false); setTimeout(() => inputRef.current?.focus(), 30); };

  if (!cw.open) {
    return (
      <motion.button
        type="button"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={() => cw.setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2.5 pl-2.5 pr-4 py-2 rounded-full border border-line bg-raised shadow-[0_8px_28px_-10px_rgba(15,32,45,0.35)] hover:border-ocean-soft hover:shadow-[0_10px_32px_-10px_rgba(124,58,237,0.35)] transition-all max-w-[min(440px,calc(100vw-2.5rem))]"
        aria-label={busy ? 'Clarion is working — open to watch' : 'Open Clarion'}
      >
        <ClarionMark size={24} state={markState} className="shrink-0" />
        <span className="text-[13px] text-ink-2 truncate">
          {busy ? (step?.label ?? 'Thinking…') : 'Ask Clarion'}
        </span>
        {busy && working && <span className="text-[11px] font-mono text-muted-2 tabular-nums shrink-0">{fmtSecs(now - working.startedAt)}</span>}
        {!busy && pendingCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-ocean text-white text-[10px] font-mono shrink-0">{pendingCount} to review</span>
        )}
      </motion.button>
    );
  }

  return (
    <motion.aside
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      className="fixed right-0 top-12 bottom-0 z-40 flex flex-col border-l border-line bg-bg shadow-[-12px_0_40px_-24px_rgba(15,32,45,0.35)]"
      style={{ width: COWORKER_WIDTH }}
      aria-label="Clarion coworker"
    >
      {/* Header — the mark is the status. */}
      <div className="px-4 pt-3 pb-2.5 flex items-center gap-2.5 border-b border-line bg-raised shrink-0">
        <AssistantIdentity
          state={markState}
          status={busy ? (step?.tool === 'propose' ? 'Checking a proposal' : 'Working') : markState === 'uncertain' ? 'Stopped short' : 'Studio coworker'}
        />
        <button
          type="button"
          onClick={() => cw.setFollowAlong(!cw.followAlong)}
          className={`p-1.5 rounded-md transition-colors ${cw.followAlong ? 'text-ocean bg-ocean-softer' : 'text-muted-2 hover:text-ink-2 hover:bg-soft'}`}
          title={cw.followAlong ? 'Follow along: on — the screen moves to what I open' : 'Follow along: off'}
          aria-pressed={cw.followAlong}
          aria-label="Follow along"
        >
          {cw.followAlong ? <Eye className="w-4 h-4" strokeWidth={1.75} /> : <EyeOff className="w-4 h-4" strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className={`p-1.5 rounded-md transition-colors ${showHistory ? 'text-ocean bg-ocean-softer' : 'text-muted-2 hover:text-ink-2 hover:bg-soft'}`}
          title="Your conversations"
          aria-pressed={showHistory}
          aria-label="Your conversations"
        >
          <History className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={newConversation}
          disabled={(messages.length === 0 && !showHistory) || !cw.canSwitch}
          className="p-1.5 rounded-md text-muted-2 hover:text-ink-2 hover:bg-soft disabled:opacity-30 transition-colors"
          title={cw.canSwitch ? 'New conversation (this one stays in your history)' : 'Wait for the current work to finish'}
          aria-label="New conversation"
        >
          <SquarePen className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          onClick={() => cw.setOpen(false)}
          className="p-1.5 rounded-md text-muted-2 hover:text-ink-2 hover:bg-soft transition-colors"
          title="Hide (the work continues)"
          aria-label="Hide the coworker"
        >
          <PanelRightClose className="w-4 h-4" strokeWidth={1.75} />
        </button>
      </div>

      {/* Where the person is — what "this" means in the next message. */}
      {cw.pageContext.label && (
        <div className="px-4 py-1.5 flex items-center gap-2 border-b border-line bg-ocean-softer shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-ocean shrink-0" />
          <span className="text-[11.5px] text-ink-2 truncate">Looking at <span className="font-medium">{cw.pageContext.label}</span></span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {showHistory ? (
          <ThreadList onClose={() => setShowHistory(false)} onNew={newConversation} />
        ) : messages.length === 0 ? (
          <div className="pt-8 flex flex-col items-center text-center">
            <ClarionMark size={56} state="idle" />
            <h2 className="mt-4 font-display text-[22px] text-ink">What shall we work on?</h2>
            <p className="mt-2 text-[13px] text-muted leading-relaxed max-w-[320px]">
              I look things up and propose changes — SQL, relationships, definitions, new tables and subjects. Nothing is saved until you keep it.
            </p>
            <div className="mt-6 w-full space-y-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => submit(s)}
                  className="w-full text-left px-3.5 py-2.5 rounded-lg border border-line bg-raised text-[13px] text-ink-2 hover:border-ocean-soft hover:bg-ocean-softer transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
            <RecentThreads onShowAll={() => setShowHistory(true)} />
          </div>
        ) : (
          messages.map((m) => (m.role === 'user'
            ? <UserBubble key={m.id} m={m} />
            : <AssistantTurn key={m.id} m={m} now={now} />))
        )}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 border-t border-line bg-raised px-3 pt-3 pb-2.5">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-bg focus-within:border-ocean focus-within:ring-2 focus-within:ring-ocean-soft transition-colors pl-3 pr-1.5 py-1.5">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { if (busy) cw.stop(); else cw.setOpen(false); }
            }}
            placeholder={busy ? 'Working… press Stop to interrupt' : 'Ask, or tell me what to change…'}
            disabled={busy}
            className="flex-1 min-w-0 resize-none bg-transparent py-1 text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none disabled:opacity-60 leading-relaxed"
          />
          {busy ? (
            <button type="button" onClick={cw.stop} title="Stop (Esc)" aria-label="Stop"
              className="w-8 h-8 shrink-0 rounded-lg border border-line-strong text-ink-2 hover:border-warn hover:text-warn flex items-center justify-center transition-colors">
              <Square className="w-3 h-3 fill-current" strokeWidth={0} />
            </button>
          ) : (
            <button type="button" onClick={() => submit()} disabled={!input.trim()} aria-label="Send"
              className="w-8 h-8 shrink-0 rounded-lg bg-ocean text-white hover:bg-ocean-hover disabled:opacity-35 disabled:cursor-not-allowed flex items-center justify-center transition-colors">
              <ArrowUp className="w-4 h-4" strokeWidth={2.25} />
            </button>
          )}
        </div>
        {cw.saveError
          ? <p className="mt-1.5 px-1 text-[10.5px] text-warn truncate" title={cw.saveError}>Not saved to your history: {cw.saveError}</p>
          : <p className="mt-1.5 px-1 text-[10.5px] text-muted-2">Proposes only — you keep or discard every change.</p>}
      </div>
    </motion.aside>
  );
}

function UserBubble({ m }: { m: CwMessage }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[88%] px-3.5 py-2 rounded-2xl rounded-br-md bg-ocean text-white text-[13.5px] leading-relaxed whitespace-pre-wrap">
        {m.text}
      </div>
      {m.contextLabel && <span className="text-[10.5px] text-muted-2 pr-1">about {m.contextLabel}</span>}
    </div>
  );
}

function AssistantTurn({ m, now }: { m: CwMessage; now: number }) {
  const cw = useCoworker()!;
  const [showTrail, setShowTrail] = useState(false);
  const steps = m.trail.filter((t) => t.kind === 'step').length;
  const expanded = m.working || showTrail;
  const elapsed = m.working ? now - m.startedAt : (m.durationMs ?? 0);

  return (
    <div className="space-y-2.5">
      {/* The work: live while it happens, one line once it is done. */}
      {(m.trail.length > 0 || m.working) && (
        <div className="rounded-lg border border-line bg-raised">
          <button
            type="button"
            onClick={() => !m.working && setShowTrail((v) => !v)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left ${m.working ? 'cursor-default' : 'hover:bg-softer'}`}
          >
            {m.working
              ? <span className="w-2 h-2 rounded-full bg-ocean animate-pulse shrink-0" />
              : expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-2" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-2" />}
            <span className="text-[12px] text-muted flex-1">
              {m.working ? 'Working' : 'Worked'}{elapsed > 1000 ? ` ${fmtSecs(elapsed)}` : ''}{steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}
            </span>
          </button>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.ol
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="px-3 pb-2.5 space-y-1.5 overflow-hidden"
              >
                {m.trail.map((t) => (t.kind === 'thought'
                  ? <li key={t.id} className="pl-5"><LiveThought text={t.text} live={false} /></li>
                  : <StepRow key={t.step.id} step={t.step} />))}
                {m.working && m.live && (
                  <li className="pl-5"><LiveThought text={m.live} /></li>
                )}
                {m.working && !m.live && !m.trail.some((t) => t.kind === 'step' && t.step.status === 'running') && (
                  <li className="pl-5 text-[12.5px] italic text-muted-2">Thinking…</li>
                )}
              </motion.ol>
            )}
          </AnimatePresence>
        </div>
      )}

      {m.text && (
        <div className="text-[13.5px] text-ink leading-relaxed">
          <MarkdownAnswer text={m.text} />
        </div>
      )}

      {m.proposalIds.map((id) => {
        const st = cw.proposals[id];
        if (!st) return null;
        const f = focusOf(st.proposal);
        return (
          <ProposalCard
            key={id}
            state={st}
            onKeep={() => { void cw.keep(id); }}
            onDiscard={() => cw.discard(id)}
            onUndo={() => { void cw.undo(id); }}
            onOpen={f ? () => cw.goTo(f) : undefined}
          />
        );
      })}

      {m.stoppedAtLimit && (
        <p className="text-[12px] text-warn inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          I stopped at my step limit for one message. Ask me to continue if there is more to do.
        </p>
      )}
      {m.error && (
        <p className="text-[12px] text-warn inline-flex items-start gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{m.error}
        </p>
      )}
    </div>
  );
}

function StepRow({ step }: { step: CwStep }) {
  return (
    <WorkStep
      status={step.status}
      label={step.label}
      checking={step.tool === 'propose'}
      detail={step.detail ? <span className="truncate block" title={step.detail}>{step.detail}</span> : undefined}
    />
  );
}

/** The few most recent conversations, under the empty panel's suggestions. */
function RecentThreads({ onShowAll }: { onShowAll: () => void }) {
  const cw = useCoworker()!;
  const recent = (cw.threads ?? []).slice(0, 4);
  if (recent.length === 0) return null;
  return (
    <div className="mt-8 w-full text-left">
      <div className="flex items-center justify-between px-1 mb-1.5">
        <span className="text-[10.5px] font-mono tracking-[0.12em] uppercase text-muted-2">Recent</span>
        {(cw.threads?.length ?? 0) > recent.length && (
          <button type="button" onClick={onShowAll} className="text-[11.5px] text-ocean hover:underline">All conversations</button>
        )}
      </div>
      <div className="space-y-1">
        {recent.map((t) => <ThreadRow key={t.id} t={t} compact />)}
      </div>
    </div>
  );
}

/** Every conversation this person had with the coworker, newest first. */
function ThreadList({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const cw = useCoworker()!;
  const threads = cw.threads;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onClose} className="p-1 -ml-1 rounded text-muted-2 hover:text-ink-2" aria-label="Back to the conversation">
          <ArrowLeft className="w-4 h-4" strokeWidth={1.75} />
        </button>
        <h2 className="font-display text-[18px] text-ink flex-1">Your conversations</h2>
        <button
          type="button"
          onClick={onNew}
          disabled={!cw.canSwitch}
          className="px-2.5 py-1 rounded-md border border-line text-[12px] text-ink-2 hover:border-ocean-soft hover:bg-ocean-softer disabled:opacity-40 inline-flex items-center gap-1.5 transition-colors"
        >
          <SquarePen className="w-3.5 h-3.5" strokeWidth={1.75} /> New
        </button>
      </div>
      <p className="text-[11.5px] text-muted-2 leading-relaxed">
        Kept for you only. A proposal can be kept or undone only in the conversation where it was made, while it is open — reopened later, it shows what you decided.
      </p>
      {cw.threadsError && <p className="text-[12px] text-warn">{cw.threadsError}</p>}
      {threads == null && !cw.threadsError && (
        <p className="text-[12px] text-muted inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
      )}
      {threads != null && threads.length === 0 && (
        <p className="text-[12.5px] text-muted">Nothing yet — what you ask Clarion will appear here.</p>
      )}
      {threads != null && threads.length > 0 && (
        <div className="space-y-1">
          {threads.map((t) => <ThreadRow key={t.id} t={t} onOpened={onClose} />)}
        </div>
      )}
    </div>
  );
}

function ThreadRow({ t, compact, onOpened }: { t: CwThreadSummary; compact?: boolean; onOpened?: () => void }) {
  const cw = useCoworker()!;
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = cw.threadId === t.id;
  const questions = Math.ceil(t.messageCount / 2);

  const open = async () => {
    if (current) { onOpened?.(); return; }
    if (!cw.canSwitch) return;
    setOpening(true); setFailed(false);
    try { await cw.openThread(t.id); onOpened?.(); } catch { setFailed(true); } finally { setOpening(false); }
  };
  const remove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete “${t.title}” from your history?`)) return;
    try { await cw.deleteThread(t.id); } catch { setFailed(true); }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => { void open(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') void open(); }}
      title={cw.canSwitch || current ? t.title : 'Wait for the current work to finish'}
      className={`group flex items-start gap-2.5 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
        current ? 'border-ocean-soft bg-ocean-softer' : 'border-line bg-raised hover:border-ocean-soft hover:bg-ocean-softer'
      } ${!cw.canSwitch && !current ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      {opening
        ? <Loader2 className="w-3.5 h-3.5 mt-0.5 shrink-0 animate-spin text-muted-2" />
        : <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-2" strokeWidth={1.75} />}
      <div className="flex-1 min-w-0">
        <div className={`text-[12.5px] text-ink-2 ${compact ? 'truncate' : 'line-clamp-2'}`}>{t.title}</div>
        <div className="mt-0.5 text-[10.5px] text-muted-2 truncate">
          {formatRelative(t.updatedAt)}
          {!compact && questions > 0 ? ` · ${questions} question${questions === 1 ? '' : 's'}` : ''}
          {!compact && t.contextLabel ? ` · about ${t.contextLabel}` : ''}
          {current ? ' · open now' : ''}
          {failed ? ' · could not open' : ''}
        </div>
      </div>
      {!compact && (
        <button
          type="button"
          onClick={(e) => { void remove(e); }}
          className="p-1 rounded text-muted-2 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-err transition-opacity"
          aria-label={`Delete “${t.title}”`}
          title="Delete from your history"
        >
          <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
