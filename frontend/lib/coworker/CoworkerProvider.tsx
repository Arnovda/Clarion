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
import type {
  CoworkerEvent, CoworkerFocus, CoworkerPageContext, CoworkerProposal,
} from '@/lib/contract';

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

/** Where the coworker lives. Studio is the curators' part of the product. */
const STUDIO_PREFIXES = [
  '/catalog', '/sources', '/build', '/relationships', '/definitions',
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

export type ProposalStatus = 'pending' | 'keeping' | 'kept' | 'discarded' | 'undoing' | 'undone' | 'failed';

export interface ProposalState {
  proposal: CoworkerProposal;
  status: ProposalStatus;
  error?: string;
  /** What Keep produced that Undo needs (a new row's id, the SQL it replaced). */
  undo?: { kind: 'sql'; tableId: number; sql: string } | { kind: 'relationship'; id: number } | { kind: 'glossary'; id: number };
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
  /** Go to something now (a card's "show it"), whatever Follow along says. */
  goTo: (f: CoworkerFocus) => void;
  /** A decision taken OUTSIDE the panel — the declaration's own Keep/Discard. */
  markDecided: (id: string, decision: 'kept' | 'discarded', undoSql?: string) => void;
  pageContext: CoworkerPageContext;
  setPageContext: (ctx: CoworkerPageContext | null) => void;
  registerFocusHandler: (fn: FocusHandler | null) => void;
  subscribeChanged: (fn: () => void) => () => void;
  /** Ask the panel to open and put words in the box (a header action). */
  prefill: string | null;
  openWith: (text?: string) => void;
  consumePrefill: () => void;
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
  }
}

const CoworkerContext = createContext<CoworkerValue | null>(null);

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const OPEN_KEY = 'clarion:coworker:open';
const FOLLOW_KEY = 'clarion:coworker:follow';

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
  const [prefill, setPrefill] = useState<string | null>(null);
  const [pageContext, setPageContextState] = useState<CoworkerPageContext>({ path: '' });

  const abortRef = useRef<AbortController | null>(null);
  const focusHandlerRef = useRef<FocusHandler | null>(null);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const changedRef = useRef(new Set<() => void>());
  const followRef = useRef(true);
  const messagesRef = useRef<CwMessage[]>([]);
  messagesRef.current = messages;

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
    setMessages((prev) => [...prev, userMsg, assistant].slice(-40));
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
  }, [busy, pageContext, pathname, patch, follow]);

  const newChat = useCallback(() => {
    stop();
    setMessages([]);
    // Undecided proposals go with the chat — nothing can decide them any more.
    setProposals((prev) => Object.fromEntries(Object.entries(prev).filter(([, p]) => p.status !== 'pending')));
  }, [stop]);

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
      if (p.kind === 'sql') {
        await api.put(`/products/tables/${p.tableId}/sql`, { sql: p.after });
        setProposal(id, { status: 'kept', undo: p.before.trim() ? { kind: 'sql', tableId: p.tableId, sql: p.before } : undefined });
      } else if (p.kind === 'relationship') {
        const r = await api.post('/semantic/relationships', {
          from_table_id: p.fromTableId, from_column_id: p.fromColumnId,
          to_table_id: p.toTableId, to_column_id: p.toColumnId,
          relationship_type: p.measurement.cardinality?.type ?? 'many_to_one',
          description: p.reason, kind: 'join', measured: p.measurement,
        });
        setProposal(id, { status: 'kept', undo: { kind: 'relationship', id: Number(r.data?.data?.id) } });
      } else if (p.kind === 'glossary') {
        const r = await api.post('/semantic/glossary', { term: p.term, meaning: p.meaning, links: p.links });
        setProposal(id, { status: 'kept', undo: { kind: 'glossary', id: Number(r.data?.data?.id) } });
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
        setProposal(id, { status: 'kept', followHref: '/build', followLabel: 'Follow the build' });
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
    const u = state.undo;
    setProposal(id, { status: 'undoing' });
    try {
      if (u.kind === 'sql') await api.put(`/products/tables/${u.tableId}/sql`, { sql: u.sql });
      else if (u.kind === 'relationship') await api.delete(`/semantic/relationships/${u.id}`);
      else if (u.kind === 'glossary') await api.delete(`/semantic/glossary/${u.id}`);
      setProposal(id, { status: 'undone' });
      notifyChanged();
    } catch (err) {
      setProposal(id, { status: 'kept', error: errorText(err, 'Undo failed.') });
    } finally {
      inFlightRef.current.delete(id);
    }
  }, [proposals, setProposal, notifyChanged]);

  const markDecided = useCallback((id: string, decision: 'kept' | 'discarded', undoSql?: string) => {
    setProposals((prev) => {
      const cur = prev[id];
      if (!cur) return prev;
      const p = cur.proposal;
      const undoState = decision === 'kept' && p.kind === 'sql' && (undoSql ?? p.before).trim()
        ? { kind: 'sql' as const, tableId: p.tableId, sql: undoSql ?? p.before } : undefined;
      return { ...prev, [id]: { ...cur, status: decision, undo: undoState } };
    });
    if (decision === 'kept') notifyChanged();
  }, [notifyChanged]);

  const openWith = useCallback((text?: string) => {
    setOpen(true);
    if (text) setPrefill(text);
  }, [setOpen]);
  const consumePrefill = useCallback(() => setPrefill(null), []);

  const value = useMemo<CoworkerValue>(() => ({
    enabled: inStudio ? enabled : false,
    open, setOpen, followAlong, setFollowAlong, messages, proposals, busy,
    send, stop, newChat, keep, discard, undo, markDecided, goTo,
    pageContext, setPageContext, registerFocusHandler, subscribeChanged,
    prefill, openWith, consumePrefill,
  }), [inStudio, enabled, open, setOpen, followAlong, setFollowAlong, messages, proposals, busy,
    send, stop, newChat, keep, discard, undo, markDecided, goTo, pageContext, setPageContext,
    registerFocusHandler, subscribeChanged, prefill, openWith, consumePrefill]);

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
