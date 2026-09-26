'use client';

/**
 * The Studio coworker's state — one conversation that survives navigation.
 *
 * Mounted in the ROOT layout, not in a shell: every Studio page has its own
 * route-group layout, so a provider in the shell would be torn down (and the
 * conversation lost) the moment the coworker opened something on another
 * page. Here it lives as long as the tab.
 *
 * Three things pages can plug into, none of which they have to:
 *   useCoworkerPageContext  — "this is what the person is looking at"
 *   useCoworkerFocusHandler — "when the coworker opens something, let ME
 *                              navigate" (the catalog and the Relations
 *                              canvas do; a handler returns false for what
 *                              it cannot show and the provider falls back
 *                              to that thing's own page)
 *   useCoworkerChanged      — "something was kept; refresh what you show"
 *
 * WRITES happen here, and only on a person's click: Keep calls the same route
 * the screens call. Undo calls the inverse route. Nothing the model streams
 * can write anything by itself.
 *
 * HISTORY. Every conversation is a thread, saved server-side per person
 * (/api/coworker/threads) after each turn and each decision, so a reload, a
 * new conversation or another device never loses what was asked. The open
 * thread's id is remembered in this browser and reopened on the next visit.
 *
 * One rule for reopened threads: a proposal can only be KEPT or UNDONE in the
 * session it was made. A thread read back from the server shows its proposals
 * as a record — an undecided one reads "no longer open", a kept one loses its
 * Undo — because the table, the relationship or the glossary may have moved on
 * since, and keeping stale SQL (or restoring a stale "before") would silently
 * overwrite whatever happened in between. Switching between threads within the
 * same session keeps them fully live (a per-session cache).
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import { streamSSE, SSEHttpError } from '@/lib/sse';
import { catalogHref } from '@/lib/catalogUrl';
import { applyProposal, replay, type UndoCall } from '@/lib/coworker/applyProposal';
import type {
  CoworkerEvent, CoworkerFocus, CoworkerPageContext, CoworkerProposal,
} from '@/lib/contract';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

/** Where the coworker lives. Studio is the curators' part of the product. */
const STUDIO_PREFIXES = [
  '/catalog', '/sources', '/relationships', '/definitions',
  '/grids', '/pipelines', '/review', '/semantic', '/shared-data',
];
export function isStudioPath(path: string | null): boolean {
  if (!path) return false;
  return STUDIO_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

// ─── the conversation's shape ───────────────────────────────────────────────

export interface CwStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  tool?: 'read' | 'propose';
  detail?: string;
}

export type CwTrailItem =
  | { kind: 'thought'; id: string; text: string }
  | { kind: 'step'; step: CwStep };

export interface CwMessage {
  id: string;
  role: 'user' | 'assistant';
  /** The user's words, or the assistant's settled answer. */
  text: string;
  /** How the assistant got there — narration and steps, in order. */
  trail: CwTrailItem[];
  /** Text streaming right now, not yet settled into a thought or the answer. */
  live: string;
  proposalIds: string[];
  working: boolean;
  startedAt: number;
  durationMs?: number;
  error?: string;
  stoppedAtLimit?: boolean;
  /** Where the person was when they asked — the chip on the message. */
  contextLabel?: string | null;
}

export type ProposalStatus = 'pending' | 'keeping' | 'kept' | 'discarded' | 'undoing' | 'undone' | 'failed'
  /** Reopened from history undecided — it can no longer be kept (see header). */
  | 'expired';

/** One entry of the history list. */
export interface CwThreadSummary {
  id: string;
  title: string;
  contextLabel: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalState {
  proposal: CoworkerProposal;
  status: ProposalStatus;
  error?: string;
  /** The calls that put things back, recorded by Keep (a new row's id, the text it replaced). */
  undo?: UndoCall[];
  /**
   * A kept SQL change is saved but not built: the table keeps serving its old
   * result until it is rebuilt. The card offers the rebuild right there.
   */
  rebuild?: { status: 'running' | 'done' | 'failed'; error?: string };
  /** After Keep: a place to follow the result (a started build). */
  followHref?: string;
  followLabel?: string;
}

interface CoworkerValue {
  /** null while unknown. */
  enabled: boolean | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  followAlong: boolean;
  setFollowAlong: (on: boolean) => void;
  messages: CwMessage[];
  proposals: Record<string, ProposalState>;
  busy: boolean;
  send: (text: string) => void;
  stop: () => void;
  newChat: () => void;
  keep: (id: string) => Promise<void>;
  discard: (id: string) => void;
  undo: (id: string) => Promise<void>;
  /** Build the table a kept SQL change touched, so the change is live. */
  rebuild: (id: string) => Promise<void>;
  /** Go to something now (a card's "show it"), whatever Follow along says. */
  goTo: (f: CoworkerFocus) => void;
  /** A decision taken OUTSIDE the panel — the declaration's own Keep/Discard. */
  markDecided: (id: string, decision: 'kept' | 'discarded', undoSql?: string) => void;
  pageContext: CoworkerPageContext;
  setPageContext: (ctx: CoworkerPageContext | null) => void;
  registerFocusHandler: (fn: FocusHandler | null) => void;
  subscribeChanged: (fn: () => void) => () => void;
  // ─ history ─
  /** The open thread, or null before the first message of a new one. */
  threadId: string | null;
  /** null until loaded. */
  threads: CwThreadSummary[] | null;
  threadsError: string | null;
  loadThreads: () => void;
  openThread: (id: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  /** A save that failed — shown quietly under the composer. */
  saveError: string | null;
  /** Switching threads waits for a turn, a Keep or an Undo to finish. */
  canSwitch: boolean;
}

/** A page's own navigation. Return false for a target this page cannot show. */
export type FocusHandler = (f: CoworkerFocus) => boolean | void;

/** Where a target lives when no page on screen takes it. */
export function coworkerFocusHref(target: CoworkerFocus): string {
  switch (target.kind) {
    case 'table': return catalogHref({ kind: 'table', tableId: target.tableId });
    case 'subject': return catalogHref({ kind: 'subject', productId: target.productId });
    case 'source': return catalogHref({ kind: 'source', connectionId: target.connectionId });
    case 'source-table': return catalogHref({ kind: 'source-table', tableId: target.tableId, connectionId: target.connectionId });
    case 'relations': return `/relationships?table=${target.tableId}${target.relationshipId ? `&rel=${target.relationshipId}` : ''}`;
    case 'grid': return `/grids/${target.gridId}`;
    case 'definitions': return '/definitions';
  }
}

const CoworkerContext = createContext<CoworkerValue | null>(null);

/** A v4 UUID — thread ids are validated as UUIDs by the server. */
function newId(): string {
  const c: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const OPEN_KEY = 'clarion:coworker:open';
const FOLLOW_KEY = 'clarion:coworker:follow';
const THREAD_KEY = 'clarion:coworker:thread';

function readStr(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStr(key: string, v: string | null) {
  try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key); } catch { /* convenience only */ }
}

type ThreadState = { messages: CwMessage[]; proposals: Record<string, ProposalState> };

/** What goes to the server: settled text, no streaming residue, only the proposals this thread shows. */
function snapshotThread(messages: CwMessage[], proposals: Record<string, ProposalState>) {
  const ids = new Set(messages.flatMap((m) => m.proposalIds));
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    title: (firstUser?.text ?? 'Conversation').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Conversation',
    contextLabel: firstUser?.contextLabel ?? null,
    messages: messages.map((m) => ({ ...m, live: '' })),
    proposals: Object.fromEntries(Object.entries(proposals).filter(([id]) => ids.has(id))),
  };
}

/** A thread read back from the server — a record, not a live session (see header). */
export function restoreThread(raw: { messages?: unknown; proposals?: unknown }): ThreadState {
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).map((x) => {
    const m = x as Partial<CwMessage>;
    return {
      id: String(m.id ?? newId()),
      role: m.role === 'user' ? 'user' : 'assistant',
      text: String(m.text ?? ''),
      trail: Array.isArray(m.trail) ? m.trail : [],
      live: '',
      proposalIds: Array.isArray(m.proposalIds) ? m.proposalIds.map(String) : [],
      working: false,
      startedAt: Number(m.startedAt) || Date.now(),
      durationMs: m.durationMs,
      // A turn that was still running when the page went away never finished.
      error: m.working && !m.text ? 'This answer was interrupted before it finished.' : m.error,
      stoppedAtLimit: m.stoppedAtLimit,
      contextLabel: m.contextLabel ?? null,
    } as CwMessage;
  });
  const proposals: Record<string, ProposalState> = {};
  const rawProps = (raw.proposals && typeof raw.proposals === 'object' ? raw.proposals : {}) as Record<string, ProposalState>;
  for (const [id, p] of Object.entries(rawProps)) {
    if (!p?.proposal) continue;
    const status: ProposalStatus =
      p.status === 'pending' || p.status === 'failed' || p.status === 'keeping' ? 'expired'
        : p.status === 'undoing' ? 'kept'
          : p.status;
    proposals[id] = {
      proposal: p.proposal, status, followHref: p.followHref, followLabel: p.followLabel,
      // A finished rebuild stays said; one still running when the page went
      // away is unknown, so the card offers it again (rebuilding is safe).
      rebuild: p.rebuild?.status === 'done' ? p.rebuild : undefined,
    };
  }
  return { messages, proposals };
}

function readBool(key: string, fallback: boolean): boolean {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v === '1'; } catch { return fallback; }
}
function writeBool(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* per-viewer convenience only */ }
}

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e?.response?.data?.error ?? fallback;
}

export function CoworkerProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpenState] = useState(false);
  const [followAlong, setFollowState] = useState(true);
  const [messages, setMessages] = useState<CwMessage[]>([]);
  const [proposals, setProposals] = useState<Record<string, ProposalState>>({});
  const [busy, setBusy] = useState(false);
  const [pageContext, setPageContextState] = useState<CoworkerPageContext>({ path: '' });
  const [threadId, setThreadIdState] = useState<string | null>(null);
  const [threads, setThreads] = useState<CwThreadSummary[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const focusHandlerRef = useRef<FocusHandler | null>(null);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const changedRef = useRef(new Set<() => void>());
  const followRef = useRef(true);
  const messagesRef = useRef<CwMessage[]>([]);
  messagesRef.current = messages;
  const proposalsRef = useRef<Record<string, ProposalState>>({});
  proposalsRef.current = proposals;
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = threadId;
  /** Threads touched in THIS session, fully live (proposals still actionable). */
  const sessionThreadsRef = useRef(new Map<string, ThreadState>());
  const restoredRef = useRef(false);
  /** The state as last loaded from history — merely LOOKING at a thread must not re-save it (and reorder the list). */
  const loadedRef = useRef<ThreadState | null>(null);

  const setThreadId = useCallback((id: string | null) => {
    setThreadIdState(id);
    threadIdRef.current = id;
    writeStr(THREAD_KEY, id);
  }, []);

  useEffect(() => {
    setOpenState(readBool(OPEN_KEY, false));
    const f = readBool(FOLLOW_KEY, true);
    setFollowState(f);
    followRef.current = f;
  }, []);

  // Is it on for me? Asked on entering Studio and whenever the tab regains
  // focus — so switching the flag off takes the panel away within moments.
  const inStudio = isStudioPath(pathname);
  useEffect(() => {
    if (!inStudio || !getToken()) return;
    let cancelled = false;
    const check = () => {
      api.get('/coworker/status')
        .then((r) => { if (!cancelled) setEnabled(!!r.data?.data?.enabled); })
        .catch(() => { if (!cancelled) setEnabled(false); });
    };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [inStudio, pathname]);

  // A page that does not report a context still gets its path.
  useEffect(() => { setPageContextState((c) => (c.path === pathname ? c : { path: pathname ?? '' })); }, [pathname]);

  const setOpen = useCallback((v: boolean) => { setOpenState(v); writeBool(OPEN_KEY, v); }, []);
  const setFollowAlong = useCallback((v: boolean) => { setFollowState(v); followRef.current = v; writeBool(FOLLOW_KEY, v); }, []);
  const setPageContext = useCallback((ctx: CoworkerPageContext | null) => {
    setPageContextState(ctx ?? { path: window.location.pathname });
  }, []);
  const registerFocusHandler = useCallback((fn: FocusHandler | null) => { focusHandlerRef.current = fn; }, []);
  const subscribeChanged = useCallback((fn: () => void) => {
    changedRef.current.add(fn);
    return () => { changedRef.current.delete(fn); };
  }, []);
  const notifyChanged = useCallback(() => { changedRef.current.forEach((fn) => { try { fn(); } catch { /* one listener must not stop the rest */ } }); }, []);

  const goTo = useCallback((target: CoworkerFocus) => {
    if (focusHandlerRef.current && focusHandlerRef.current(target) !== false) return;
    router.push(coworkerFocusHref(target));
  }, [router]);
  const follow = useCallback((target: CoworkerFocus) => {
    if (!followRef.current) return;
    // The canvas is followed only by someone already on it: measuring a link
    // from the catalog must not pull the person out of the table they are on.
    if (target.kind === 'relations' && !(pathRef.current ?? '').startsWith('/relationships')) return;
    goTo(target);
  }, [goTo]);

  const patch = useCallback((id: string, fn: (m: CwMessage) => CwMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const setProposal = useCallback((id: string, p: Partial<ProposalState>) => {
    setProposals((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...p } } : prev));
  }, []);

  const stop = useCallback(() => { abortRef.current?.abort(); abortRef.current = null; }, []);

  // ─── history ──────────────────────────────────────────────────────────────
  const persist = useCallback(async (id: string, msgs: CwMessage[], props: Record<string, ProposalState>) => {
    if (msgs.length === 0) return;
    const body = snapshotThread(msgs, props);
    try {
      await api.put(`/coworker/threads/${id}`, body);
      setSaveError(null);
      const now = new Date().toISOString();
      setThreads((prev) => {
        if (!prev) return prev;
        const existing = prev.find((t) => t.id === id);
        const entry: CwThreadSummary = {
          id, title: body.title, contextLabel: existing?.contextLabel ?? body.contextLabel,
          messageCount: body.messages.length, createdAt: existing?.createdAt ?? now, updatedAt: now,
        };
        return [entry, ...prev.filter((t) => t.id !== id)];
      });
    } catch (err) {
      setSaveError(errorText(err, 'This conversation could not be saved to your history.'));
    }
  }, []);

  // Keep the session cache current, and save once things have settled. While
  // a turn streams, text changes many times a second — the save waits for it.
  useEffect(() => {
    if (!threadId || messages.length === 0) return;
    sessionThreadsRef.current.set(threadId, { messages, proposals });
    if (busy) return;
    if (loadedRef.current && loadedRef.current.messages === messages && loadedRef.current.proposals === proposals) return;
    const t = setTimeout(() => { void persist(threadId, messages, proposals); }, 500);
    return () => clearTimeout(t);
  }, [threadId, messages, proposals, busy, persist]);

  const loadThreads = useCallback(() => {
    setThreadsError(null);
    api.get('/coworker/threads')
      .then((r) => setThreads(Array.isArray(r.data?.data) ? r.data.data : []))
      .catch((err) => setThreadsError(errorText(err, 'Your conversations could not be loaded.')));
  }, []);

  const hasInFlight = Object.values(proposals).some((p) => p.status === 'keeping' || p.status === 'undoing');
  const canSwitch = !busy && !hasInFlight;

  const openThread = useCallback(async (id: string) => {
    if (!canSwitch || id === threadIdRef.current) return;
    const cached = sessionThreadsRef.current.get(id);
    let next: ThreadState;
    if (cached) {
      next = cached;
    } else {
      const r = await api.get(`/coworker/threads/${id}`);
      next = restoreThread(r.data?.data ?? {});
    }
    loadedRef.current = next;
    setMessages(next.messages);
    setProposals(next.proposals);
    setThreadId(id);
  }, [canSwitch, setThreadId]);

  const deleteThread = useCallback(async (id: string) => {
    await api.delete(`/coworker/threads/${id}`);
    sessionThreadsRef.current.delete(id);
    setThreads((prev) => (prev ? prev.filter((t) => t.id !== id) : prev));
    if (threadIdRef.current === id) {
      stop();
      setMessages([]);
      setProposals({});
      setThreadId(null);
    }
  }, [stop, setThreadId]);

  // Reopen the thread this browser was last on — once, when the coworker is on.
  const isOn = enabled === true && inStudio;
  useEffect(() => {
    if (!isOn || restoredRef.current) return;
    restoredRef.current = true;
    const id = readStr(THREAD_KEY);
    if (!id || messagesRef.current.length > 0) return;
    api.get(`/coworker/threads/${id}`)
      .then((r) => {
        // The person may have started typing while this loaded.
        if (messagesRef.current.length > 0) return;
        const next = restoreThread(r.data?.data ?? {});
        loadedRef.current = next;
        setMessages(next.messages);
        setProposals(next.proposals);
        setThreadIdState(id);
        threadIdRef.current = id;
      })
      .catch(() => writeStr(THREAD_KEY, null));
  }, [isOn]);

  const send = useCallback((raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    const history = messagesRef.current
      .filter((m) => !m.working && (m.text || m.proposalIds.length))
      .slice(-10)
      .map((m) => ({
        role: m.role,
        // Earlier turns come back as TEXT only — never their tool traffic.
        content: (m.text || '(proposed changes)').slice(0, 1500),
      }));
    const ctx = pageContext.path ? pageContext : { path: pathname ?? '' };
    const userMsg: CwMessage = {
      id: newId(), role: 'user', text, trail: [], live: '', proposalIds: [], working: false,
      startedAt: Date.now(), contextLabel: ctx.label ?? null,
    };
    const aId = newId();
    const assistant: CwMessage = { id: aId, role: 'assistant', text: '', trail: [], live: '', proposalIds: [], working: true, startedAt: Date.now() };
    const tid = threadIdRef.current ?? newId();
    if (tid !== threadIdRef.current) setThreadId(tid);
    const nextMessages = [...messagesRef.current, userMsg, assistant].slice(-40);
    setMessages(nextMessages);
    // Save the question now: a reload mid-turn must not lose what was asked.
    void persist(tid, nextMessages, proposalsRef.current);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const onEvent = (e: CoworkerEvent) => {
      switch (e.type) {
        case 'text':
          patch(aId, (m) => ({ ...m, live: m.live + e.delta }));
          break;
        case 'segment':
          patch(aId, (m) => (e.kind === 'answer'
            ? { ...m, live: '', text: e.text }
            : { ...m, live: '', trail: e.text ? [...m.trail, { kind: 'thought', id: newId(), text: e.text }] : m.trail }));
          break;
        case 'step':
          patch(aId, (m) => {
            const i = m.trail.findIndex((t) => t.kind === 'step' && t.step.id === e.id);
            const step: CwStep = { id: e.id, label: e.label, status: e.status, tool: e.tool, detail: e.detail };
            if (i === -1) return { ...m, trail: [...m.trail, { kind: 'step', step }] };
            const trail = m.trail.slice();
            trail[i] = { kind: 'step', step };
            return { ...m, trail };
          });
          break;
        case 'focus':
          follow(e.target);
          break;
        case 'proposal':
          setProposals((prev) => ({ ...prev, [e.proposal.id]: { proposal: e.proposal, status: 'pending' } }));
          patch(aId, (m) => ({ ...m, proposalIds: [...m.proposalIds, e.proposal.id] }));
          break;
        case 'done':
          patch(aId, (m) => ({ ...m, working: false, durationMs: e.durationMs, stoppedAtLimit: e.stoppedAtLimit, live: '' }));
          break;
        case 'error':
          patch(aId, (m) => ({ ...m, working: false, error: e.message, live: '' }));
          break;
      }
    };

    streamSSE(`${BACKEND_URL}/api/coworker/turn`, {
      body: { message: text, history, context: ctx },
      signal: controller.signal,
      onEvent: onEvent as (e: unknown) => void,
    })
      .catch((err) => {
        if ((err as { name?: string })?.name === 'AbortError') {
          patch(aId, (m) => ({ ...m, working: false, live: '', error: m.text ? undefined : 'Stopped.' }));
          return;
        }
        const detail = err instanceof SSEHttpError ? (safeJson(err.detail)?.error ?? `The coworker did not answer (${err.status}).`) : 'The coworker did not answer.';
        patch(aId, (m) => ({ ...m, working: false, live: '', error: detail }));
      })
      .finally(() => {
        // A stream that ended without `done` must not leave a spinner behind.
        patch(aId, (m) => (m.working ? { ...m, working: false, durationMs: Date.now() - m.startedAt } : m));
        if (abortRef.current === controller) abortRef.current = null;
        setBusy(false);
      });
  }, [busy, pageContext, pathname, patch, follow, persist, setThreadId]);

  const newChat = useCallback(() => {
    stop();
    // The thread stays in the history (and in this session's cache, live).
    setMessages([]);
    setProposals({});
    setThreadId(null);
  }, [stop, setThreadId]);

  const addAssistantNote = useCallback((text: string, proposalIds: string[] = []) => {
    setMessages((prev) => [...prev, {
      id: newId(), role: 'assistant', text, trail: [], live: '', proposalIds, working: false, startedAt: Date.now(),
    }]);
  }, []);

  // A second click must not write twice: the status check below reads state
  // from the last render, so an in-flight set closes the gap between clicks.
  const inFlightRef = useRef(new Set<string>());
  const keep = useCallback(async (id: string) => {
    const state = proposals[id];
    if (!state || (state.status !== 'pending' && state.status !== 'failed')) return;
    if (inFlightRef.current.has(id)) return;
    inFlightRef.current.add(id);
    const p = state.proposal;
    setProposal(id, { status: 'keeping', error: undefined });
    try {
      if (p.kind !== 'table' && p.kind !== 'subject') {
        const outcome = await applyProposal(p);
        setProposal(id, { status: 'kept', undo: outcome.undo, followHref: outcome.followHref, followLabel: outcome.followLabel });
        if (p.kind === 'grid-new' || p.kind === 'grid-rows') {
          const gridId = p.kind === 'grid-rows' ? p.gridId : Number(outcome.followHref?.split('/').pop());
          if (gridId) follow({ kind: 'grid', gridId });
        }
      } else if (p.kind === 'table') {
        const r = await api.post(`/products/${p.productId}/tables`, { tableName: p.tableName, tableRole: p.tableRole, description: p.description });
        const tableId = Number(r.data?.data?.id);
        setProposal(id, { status: 'kept' });
        follow({ kind: 'table', tableId, tab: 'sql' });
        // The table exists; its SQL is the next proposal, reviewed like any other.
        try {
          const d = await api.post(`/products/tables/${tableId}/sql/propose`, { instruction: p.sqlInstruction });
          const data = d.data?.data ?? {};
          if (data.proposed) {
            const sqlProposal: CoworkerProposal = {
              id: newId(), kind: 'sql', tableId, tableName: p.tableName, label: p.tableName,
              before: '', after: String(data.sql ?? ''), summary: String(data.summary ?? ''),
              compiled: !!data.compiled, error: data.error ?? null, impact: { dashboards: [], savedQuestions: [] },
            };
            setProposals((prev) => ({ ...prev, [sqlProposal.id]: { proposal: sqlProposal, status: 'pending' } }));
            addAssistantNote(`The table **${p.tableName}** exists now. Here is the SQL I drafted for it — keep it to save it.`, [sqlProposal.id]);
          } else {
            addAssistantNote(`The table **${p.tableName}** exists now. I could not draft its SQL: ${data.summary ?? 'no change was proposed'}.`);
          }
        } catch (err) {
          addAssistantNote(`The table **${p.tableName}** exists now, but drafting its SQL failed: ${errorText(err, 'unknown error')}. Ask me again or write it on the SQL tab.`);
        }
      } else if (p.kind === 'subject') {
        await api.post('/products/bus-matrix/extend-start', {
          connectionId: p.connectionId, name: p.name, description: p.description, entities: p.entities,
          ...(p.focus ? { focus: p.focus } : {}),
        });
        setProposal(id, { status: 'kept', followHref: '/catalog', followLabel: 'Follow the build' });
      }
      notifyChanged();
    } catch (err) {
      setProposal(id, { status: 'failed', error: errorText(err, 'Keeping it failed.') });
    } finally {
      inFlightRef.current.delete(id);
    }
  }, [proposals, setProposal, follow, notifyChanged, addAssistantNote]);

  const discard = useCallback((id: string) => { setProposal(id, { status: 'discarded' }); }, [setProposal]);

  const undo = useCallback(async (id: string) => {
    const state = proposals[id];
    if (!state?.undo || state.status !== 'kept') return;
    if (inFlightRef.current.has(id)) return;
    inFlightRef.current.add(id);
    const calls = state.undo;
    setProposal(id, { status: 'undoing' });
    try {
      await replay(calls);
      setProposal(id, { status: 'undone', rebuild: undefined });
      notifyChanged();
    } catch (err) {
      setProposal(id, { status: 'kept', error: errorText(err, 'Undo failed.') });
    } finally {
      inFlightRef.current.delete(id);
    }
  }, [proposals, setProposal, notifyChanged]);

  const rebuild = useCallback(async (id: string) => {
    const state = proposals[id];
    if (!state || state.status !== 'kept' || state.proposal.kind !== 'sql') return;
    const key = `rebuild:${id}`;
    if (inFlightRef.current.has(key)) return;
    inFlightRef.current.add(key);
    setProposal(id, { rebuild: { status: 'running' } });
    try {
      await api.post(`/products/tables/${state.proposal.tableId}/run`);
      setProposal(id, { rebuild: { status: 'done' } });
      notifyChanged();
    } catch (err) {
      setProposal(id, { rebuild: { status: 'failed', error: errorText(err, 'The rebuild failed.') } });
    } finally {
      inFlightRef.current.delete(key);
    }
  }, [proposals, setProposal, notifyChanged]);

  const markDecided = useCallback((id: string, decision: 'kept' | 'discarded', undoSql?: string) => {
    setProposals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const p = cur.proposal;
      const undoState: UndoCall[] | undefined = decision === 'kept' && p.kind === 'sql' && (undoSql ?? p.before).trim()
        ? [{ method: 'put', path: `/products/tables/${p.tableId}/sql`, body: { sql: undoSql ?? p.before } }] : undefined;
      return { ...prev, [id]: { ...cur, status: decision, undo: undoState } };
    });
    if (decision === 'kept') notifyChanged();
  }, [notifyChanged]);

  const value = useMemo<CoworkerValue>(() => ({
    enabled: inStudio ? enabled : false,
    open, setOpen, followAlong, setFollowAlong, messages, proposals, busy,
    send, stop, newChat, keep, discard, undo, rebuild, markDecided, goTo,
    pageContext, setPageContext, registerFocusHandler, subscribeChanged,
    threadId, threads, threadsError, loadThreads, openThread, deleteThread, saveError, canSwitch,
  }), [inStudio, enabled, open, setOpen, followAlong, setFollowAlong, messages, proposals, busy,
    send, stop, newChat, keep, discard, undo, rebuild, markDecided, goTo, pageContext, setPageContext,
    registerFocusHandler, subscribeChanged,
    threadId, threads, threadsError, loadThreads, openThread, deleteThread, saveError, canSwitch]);

  return <CoworkerContext.Provider value={value}>{children}</CoworkerContext.Provider>;
}

function safeJson(s: string): { error?: string } | null {
  try { return JSON.parse(s); } catch { return null; }
}

/** The coworker, or a quiet "off" outside the provider (tests, isolated pages). */
export function useCoworker(): CoworkerValue | null {
  return useContext(CoworkerContext);
}

/** A page says what the person is looking at. Cleared when the page goes. */
export function useCoworkerPageContext(ctx: CoworkerPageContext | null) {
  const cw = useCoworker();
  const key = JSON.stringify(ctx);
  useEffect(() => {
    if (!cw) return;
    cw.setPageContext(ctx);
    return () => cw.setPageContext(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cw?.setPageContext]);
}

/** A page takes over navigation when the coworker opens something. */
export function useCoworkerFocusHandler(fn: FocusHandler | null) {
  const cw = useCoworker();
  const register = cw?.registerFocusHandler;
  useEffect(() => {
    if (!register) return;
    register(fn);
    return () => register(null);
  }, [register, fn]);
}

/** Refresh when a proposal was kept or undone. */
export function useCoworkerChanged(fn: () => void) {
  const cw = useCoworker();
  const subscribe = cw?.subscribeChanged;
  useEffect(() => (subscribe ? subscribe(fn) : undefined), [subscribe, fn]);
}
