'use client';

/**
 * "Ask about your subjects" — the Build page's chat.
 *
 * Two jobs, both in human language:
 *   1. Coverage questions ("is quotation data in a subject?") — answered by
 *      the backend from the real catalog, never guessed.
 *   2. Additions — the assistant may return a PROPOSAL, rendered as a card
 *      with one button. Nothing is built until the user clicks Add; the
 *      button calls the guarded extend endpoint, which can only ADD a
 *      subject (collisions with anything existing are refused in code).
 *
 * Changes to existing subjects are deliberately not offered here — the
 * assistant explains why (dashboards and saved questions depend on them)
 * and points at the topic's own Manage mode.
 *
 * Vocabulary: business words only, same rule as the rest of /build.
 */

import { useCallback, useRef, useState } from 'react';
import { ArrowRight, Loader2, MessageSquare, Plus, Sparkles } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';

interface Proposal {
  connection_id: number;
  name: string;
  description: string;
  focus?: string | null;
  entities: string[];
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  /** Assistant messages only — a validated addition the user can approve. */
  proposal?: Proposal | null;
  /** Set once this message's proposal was sent to build (button disarms). */
  proposalUsed?: boolean;
  error?: boolean;
}

export default function AskPanel({ building, onAttach }: {
  /** A build is running — sending and adding are paused until it finishes. */
  building: boolean;
  /** Hand a started extend job to the page's run panel (SSE attach). */
  onAttach: (jobId: string, connectionId: number) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const scrollDown = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  };

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || busy || building) return;
    setInput('');
    const history = [...messages, { role: 'user' as const, content: q }];
    setMessages(history);
    setBusy(true);
    scrollDown();
    try {
      const payload = history
        .filter((m) => !m.error)
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await api.post('/products/build-chat', { messages: payload });
      const data = res.data?.data as { reply: string; proposal: Proposal | null };
      setMessages((ms) => [...ms, { role: 'assistant', content: data.reply, proposal: data.proposal }]);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string } } };
      setMessages((ms) => [...ms, {
        role: 'assistant',
        content: ax?.response?.data?.error ?? 'Something went wrong — please try again.',
        error: true,
      }]);
    } finally {
      setBusy(false);
      scrollDown();
    }
  }, [input, busy, building, messages]);

  const addSubject = useCallback(async (msgIndex: number, p: Proposal) => {
    if (adding || building) return;
    setAdding(true);
    try {
      const res = await api.post('/products/bus-matrix/extend-start', {
        connectionId: p.connection_id,
        name: p.name,
        description: p.description,
        focus: p.focus ?? undefined,
        entities: p.entities,
      });
      const jobId = res.data?.data?.jobId as string | undefined;
      if (!jobId) throw new Error('No job id returned');
      setMessages((ms) => ms.map((m, i) => (i === msgIndex ? { ...m, proposalUsed: true } : m)));
      onAttach(jobId, p.connection_id);
    } catch (err) {
      const ax = err as { response?: { data?: { error?: string; jobId?: string } } };
      const existingJobId = ax?.response?.data?.jobId;
      if (existingJobId) {
        setMessages((ms) => ms.map((m, i) => (i === msgIndex ? { ...m, proposalUsed: true } : m)));
        onAttach(existingJobId, p.connection_id);
      } else {
        setMessages((ms) => [...ms, {
          role: 'assistant',
          content: ax?.response?.data?.error ?? 'Could not start the build — please try again.',
          error: true,
        }]);
      }
    } finally {
      setAdding(false);
      scrollDown();
    }
  }, [adding, building, onAttach]);

  return (
    <section className="mb-8 rounded-[10px] border border-line bg-raised shadow-1">
      {messages.length > 0 && (
        <div ref={listRef} className="max-h-[340px] overflow-y-auto px-4 pt-4">
          {messages.map((m, i) => (
            <div key={i} className={cn('mb-3 flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div className={cn('max-w-[85%]', m.role === 'user' ? 'text-right' : '')}>
                <div
                  className={cn(
                    'inline-block rounded-[10px] px-3.5 py-2 text-left text-[13px] leading-[1.55]',
                    m.role === 'user'
                      ? 'bg-ocean text-white'
                      : m.error
                        ? 'border border-line bg-canvas text-err'
                        : 'border border-line bg-canvas text-ink-2',
                  )}
                >
                  {m.content}
                </div>
                {m.proposal && (
                  <div className="mt-2 rounded-[10px] border border-ocean/40 bg-ocean-softer/40 p-3.5 text-left">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 shrink-0 text-ocean" strokeWidth={1.8} aria-hidden />
                      <span className="text-[13.5px] font-medium text-ink">New subject: {m.proposal.name}</span>
                    </div>
                    {m.proposal.description && (
                      <p className="mt-1 text-[12.5px] leading-[1.5] text-ink-3">{m.proposal.description}</p>
                    )}
                    <p className="mt-1.5 text-[11.5px] text-muted">
                      Built from: {m.proposal.entities.join(', ')} · your existing subjects stay untouched.
                    </p>
                    <button
                      type="button"
                      disabled={m.proposalUsed || adding || building}
                      onClick={() => void addSubject(i, m.proposal as Proposal)}
                      className={cn(
                        'mt-2.5 inline-flex items-center gap-1.5 rounded-[8px] px-3.5 py-1.5 text-[12.5px] font-medium',
                        m.proposalUsed
                          ? 'cursor-default border border-line bg-canvas text-muted'
                          : 'bg-ocean text-white hover:opacity-90 disabled:opacity-50',
                      )}
                    >
                      {m.proposalUsed
                        ? 'Build started'
                        : adding
                          ? <><Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden /> Starting…</>
                          : <><Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden /> Add this subject</>}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {busy && (
            <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />
              Checking your subjects…
            </div>
          )}
        </div>
      )}

      <div className={cn('flex h-[46px] items-center gap-2.5 pl-3.5 pr-1.5', messages.length > 0 && 'border-t border-line')}>
        <MessageSquare className="h-[15px] w-[15px] shrink-0 text-muted-2" strokeWidth={1.7} aria-hidden />
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
          disabled={building}
          placeholder={building
            ? 'A build is running — ask again when it finishes.'
            : 'Is something covered already? Want a new subject? Ask here…'}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-ink placeholder:text-muted-2 focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || building || !input.trim()}
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] bg-ocean text-white hover:opacity-90 disabled:opacity-40"
          aria-label="Ask"
        >
          <ArrowRight className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </section>
  );
}
