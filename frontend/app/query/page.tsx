'use client';

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getToken } from '@/lib/auth';
import { useRole, canCurate } from '@/lib/role';
import { streamSSE, SSEHttpError } from '@/lib/sse';
import { getItem, setItem, storageKeys } from '@/lib/storage';
import { formatRelativeTime, getOverallFreshnessStatus } from '@/lib/freshness';
import { X, Loader2, ArrowRight } from 'lucide-react';
import { type DataSource } from './components';
import MessageBubble from './MessageBubble';
import { ThinkingBubble, ThinkingPanel } from './thinking';
import ChatSidebar from './ChatSidebar';
import EmptyState from './EmptyState';
import type {
  AnswerSource,
  DebugInfo,
  EntityMismatch,
  EntityAmbiguity,
  Message,
  Conversation,
  RepairState,
} from './types';
import { classifyQuestion, type QuestionMode } from '@/lib/questionMode';
import { runInvestigation } from '@/lib/investigateRunner';
import { upsertStep } from '@/lib/investigationTypes';

// ─── Constants ────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.NEXT_PUBLIC_API_URL?.replace('/api', '') ?? 'http://localhost:3001';

// ─── Main page ────────────────────────────────────────────────────────────────

function QueryPageInner() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId,      setActiveId]      = useState<number | null>(null);
  const [messages,      setMessages]      = useState<Message[]>([]);
  const [input,         setInput]         = useState('');
  const [loading,        setLoading]        = useState(false);
  const [showSql,        setShowSql]        = useState(false);
  // Role model (lib/role.ts) — the chat used to key EVERYTHING off a local
  // isAdmin flag, which treated analysts as viewers against the role table.
  // canSeeSql (admin + analyst) gates SQL, confidence detail, error detail
  // and the source-layer toggle; isAdmin keeps only the debug panel.
  const role = useRole();
  const isAdmin = role === 'admin';
  const canSeeSql = canCurate(role);
  const [starFilter,     setStarFilter]     = useState(false);
  // Default = product layer (cleaner star schema).
  // Toggle visible to admin/analyst — viewers always stay on the product layer.
  const [useSourceLayer, setUseSourceLayer] = useState(false);

  // URL params (e.g. ?connectionId=5&productId=3&productName=Sales from Data Products)
  const searchParams = useSearchParams();
  const urlConnectionId = searchParams.get('connectionId');
  const urlProductId = searchParams.get('productId');
  const urlProductName = searchParams.get('productName');

  // Product context — shown when navigating from Data Products page
  const [productContext, setProductContext] = useState<{ name: string; kpis: string[] } | null>(null);

  // Data source selection (silent — no UI picker)
  const [selectedSource, setSelectedSource] = useState<string>('');

  // Domain filter — sent with every request; there has never been UI to set
  // it, so it stays empty (kept for the request contract).
  const [selectedDomains] = useState<string[]>([]);

  // Repair state — the live event feed is ephemeral; the corrected ANSWER
  // is persisted (server-side by /query/repair). See the repair section below.
  const [repairState, setRepairState] = useState<RepairState | null>(null);

  // Data freshness indicator
  const [freshnessDates, setFreshnessDates] = useState<(string | null)[]>([]);

  // Live thinking state — shown while /think SSE stream is open
  const [thinkingPhase, setThinkingPhase] = useState<string>('');
  const [thinkingText,  setThinkingText]  = useState<string>('');
  const [thinkingSql,   setThinkingSql]   = useState<string | null>(null);
  const [thinkingConf,  setThinkingConf]  = useState<number | null>(null);
  // Table names from the `tables` SSE event — labels the timeline's
  // "Looking at Sales, Receivables" step for every role.
  const [thinkingTables, setThinkingTables] = useState<string[]>([]);

  // Mode override for the next question. 'auto' uses the heuristic
  // classifier; 'ask' / 'investigate' force a specific path. Resets to
  // 'auto' after each send so users don't get stuck in one mode.
  const [modeOverride, setModeOverride] = useState<'auto' | QuestionMode>('auto');

  // Investigate requires a data product. Most users land on /query without
  // a productId in the URL — they pick a CONNECTION via the source dropdown.
  // We resolve a default product per connection so investigate just works
  // for them, without surfacing yet another picker.
  const [productsByConnection, setProductsByConnection] = useState<Record<number, number>>({});
  useEffect(() => {
    api.get('/products').then((res) => {
      const list = (res.data.data ?? []) as Array<{ id: number; source?: { id?: number | null } }>;
      const map: Record<number, number> = {};
      // First product per connection wins. Good enough for MVP — when a
      // connection has multiple products we'd want to pick the most-used
      // or let the user choose, but a sensible default beats nothing.
      for (const p of list) {
        const cid = p.source?.id;
        if (cid != null && !(cid in map)) map[cid] = p.id;
      }
      setProductsByConnection(map);
    }).catch(() => {});
  }, []);

  // Resolve the productId we'd pass to investigate, in priority order:
  //   1. Explicit `?productId=N` on the URL (came from /products).
  //   2. First product for the currently selected connection.
  const resolvedProductId: number | null = (() => {
    if (urlProductId) return Number(urlProductId);
    if (selectedSource.startsWith('c:')) {
      const cid = Number(selectedSource.split(':')[1]);
      return productsByConnection[cid] ?? null;
    }
    return null;
  })();

  // Live preview of which mode the current input would route to.
  const detectedMode: QuestionMode = classifyQuestion(input);
  const canInvestigate = resolvedProductId != null;

  const nextId      = useRef(0);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);

  // In-flight SSE streams (/think + /repair) — aborted on unmount so a
  // navigated-away chat doesn't keep streaming into dead state setters.
  const thinkAbortRef  = useRef<AbortController | null>(null);
  const repairAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    thinkAbortRef.current?.abort();
    repairAbortRef.current?.abort();
  }, []);

  // Fetch data freshness info
  useEffect(() => {
    api.get('/connections/freshness').then(r => {
      const d = r.data.data;
      const dates = [
        ...(d.connections ?? []).map((c: { last_synced_at: string | null }) => c.last_synced_at),
        ...(d.products ?? []).map((p: { last_run_at: string | null }) => p.last_run_at),
      ];
      setFreshnessDates(dates);
    }).catch(() => {});
  }, []);

  // Load product context (KPIs) when navigating from Data Products
  useEffect(() => {
    if (urlProductId && urlProductName) {
      api.get(`/products/${urlProductId}/kpis`)
        .then((res) => {
          const kpiNames = (res.data.data ?? []).map((k: { name: string }) => k.name);
          setProductContext({ name: urlProductName, kpis: kpiNames });
        })
        .catch(() => {
          setProductContext({ name: urlProductName, kpis: [] });
        });
    }
  }, [urlProductId, urlProductName]);

  // Seed the prompt input from a query param so deep-links can pre-fill
  // the chat. Used today by the dashboard widget provenance modal's
  // "Ask a follow-up" button — turns the explainer into action instead of
  // a dead-end. Runs once per param value so we don't fight the user's typing.
  const seedQuestion = searchParams.get('seedQuestion');
  useEffect(() => {
    if (!seedQuestion) return;
    setInput(seedQuestion);
    setTimeout(() => inputRef.current?.focus(), 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuestion]);

  // Load available connections + integration views (silent — no UI picker shown)
  useEffect(() => {
    Promise.all([
      api.get('/connections').catch(() => ({ data: { data: [] } })),
      api.get('/cross-views').catch(() => ({ data: { data: [] } })),
    ]).then(([connRes, viewRes]) => {
      const conns = (connRes.data.data ?? []) as { id: number; name: string }[];
      const views = (viewRes.data.data ?? []) as { id: number; name: string }[];
      const all: DataSource[] = [
        ...conns.map((c) => ({ type: 'connection' as const, id: c.id, label: c.name })),
        ...views.map((v) => ({ type: 'view' as const, id: v.id, label: v.name })),
      ];

      // Priority: URL param > localStorage > first source
      if (urlConnectionId && all.some((s) => s.type === 'connection' && s.id === Number(urlConnectionId))) {
        const key = `c:${urlConnectionId}`;
        setSelectedSource(key);
        setItem(storageKeys.querySource, key);
      } else {
        const saved = getItem(storageKeys.querySource);
        if (saved && all.some((s) => `${s.type === 'connection' ? 'c' : 'v'}:${s.id}` === saved)) {
          setSelectedSource(saved);
        } else if (all.length > 0) {
          setSelectedSource(`c:${all[0].id}`);
        }
      }
    });
  }, []);

  // Load conversations from server
  const loadConversations = useCallback(async (filterStarred?: boolean) => {
    try {
      const url = filterStarred ? '/conversations?starred=true' : '/conversations';
      const res = await api.get(url);
      const convs = (res.data.data ?? []).map((c: Record<string, unknown>) => ({
        id: c.id as number,
        title: c.title as string,
        starred: c.starred as boolean,
        createdAt: c.created_at as string,
        updatedAt: c.updated_at as string,
        messages: [], // loaded on select
      }));
      setConversations(convs);
      return convs as Conversation[];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    loadConversations(starFilter).then((convs) => {
      if (convs.length > 0 && !activeId) {
        selectConversation(convs[0].id);
      }
      initialized.current = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starFilter]);

  // Helper: persist a message to the server. The `meta` bundle carries the
  // display metadata that used to be DROPPED on persist (assumptions, clarify
  // options, sub-scores, visualization, forecast, sources, …) — on reload
  // the answer no longer looks more certain than it was.
  async function persistMessage(conversationId: number, msg: Partial<Message> & { role: string; text: string }): Promise<number | undefined> {
    try {
      const meta: Record<string, unknown> = {
        ...(msg.assumptions?.length ? { assumptions: msg.assumptions } : {}),
        ...(msg.subScores ? { subScores: msg.subScores } : {}),
        ...(msg.uncertaintyNotes?.length ? { uncertaintyNotes: msg.uncertaintyNotes } : {}),
        ...(msg.intent && msg.intent !== 'data' ? { intent: msg.intent } : {}),
        ...(msg.options?.length ? { options: msg.options } : {}),
        ...(msg.ambiguity ? { ambiguity: msg.ambiguity } : {}),
        ...(msg.visualization ? { visualization: msg.visualization } : {}),
        ...(msg.forecast ? { forecast: msg.forecast } : {}),
        ...(msg.flagReason ? { flagReason: msg.flagReason } : {}),
        ...(msg.sources?.length ? { sources: msg.sources } : {}),
        ...(msg.answeredInMs ? { answeredInMs: msg.answeredInMs } : {}),
        ...(msg.policyNotice ? { policyNotice: msg.policyNotice } : {}),
        ...(msg.adminNotified ? { adminNotified: msg.adminNotified } : {}),
        ...(msg.repairSummary?.length ? { repairSummary: msg.repairSummary } : {}),
      };
      const res = await api.post(`/conversations/${conversationId}/messages`, {
        role: msg.role,
        content: msg.text,
        question: msg.question,
        sql: msg.sql,
        tablesUsed: msg.tablesUsed,
        confidence: msg.confidence,
        warning: msg.warning,
        blocked: msg.blocked,
        needsClarification: msg.needsClarification,
        mismatches: msg.mismatches,
        ambiguities: msg.ambiguities,
        error: msg.error,
        debug: msg.debug,
        rows: msg.rows,
        wasRepaired: msg.wasRepaired,
        reasoning: msg.reasoning,
        queryLayer: msg.queryLayer,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      });
      return res.data.data?.id as number | undefined;
    } catch (err) {
      console.error('[chat] persistMessage failed', { conversationId, role: msg.role, err });
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, repairState?.events.length]);

  // ── Conversation management (server-side) ──

  async function startNewConversation() {
    try {
      const res = await api.post('/conversations', { sourceKey: selectedSource });
      const conv: Conversation = {
        id: res.data.data.id,
        title: res.data.data.title,
        starred: false,
        createdAt: res.data.data.created_at,
        updatedAt: res.data.data.updated_at,
        messages: [],
      };
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setMessages([]);
      resetRepair();
      nextId.current = 0;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // Fallback: still allow local usage
      const tempId = -Date.now();
      setConversations((prev) => [{ id: tempId, title: 'New conversation', starred: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }, ...prev]);
      setActiveId(tempId);
      setMessages([]);
      resetRepair();
      nextId.current = 0;
    }
  }

  async function selectConversation(id: number) {
    if (id === activeId) return;
    setActiveId(id);
    resetRepair();
    try {
      const res = await api.get(`/conversations/${id}`);
      const data = res.data.data;
      const msgs: Message[] = (data.messages ?? []).map((m: Record<string, unknown>) => {
        const debug = m.debug ? (typeof m.debug === 'string' ? JSON.parse(m.debug as string) : m.debug) : undefined;
        // The meta bundle (migration 82) — restore what the answer card needs.
        const meta = (m.meta
          ? (typeof m.meta === 'string' ? JSON.parse(m.meta as string) : m.meta)
          : {}) as Record<string, unknown>;
        // Rehydrate investigate-mode messages from the `debug` marker we
        // wrote on persist. Steps aren't stored — `Replay full trail`
        // re-fetches them from /api/investigations/:id on demand.
        const isInvestigation = !!(debug && (debug as Record<string, unknown>).investigation_mode);
        const investigation = isInvestigation ? (() => {
          const d = debug as Record<string, unknown>;
          const status = d.investigation_status === 'failed' ? 'failed' : 'done';
          return {
            id: (d.investigation_id as number | undefined) ?? undefined,
            question: (m.question as string | undefined) ?? '',
            focus: null,
            productId: 0, // unknown on reload; only used for live runs
            streamStatus: status as 'done' | 'failed',
            steps: [],
            conclusion: status === 'done' ? (m.content as string) : null,
            conclusionConfidence: (d.investigation_confidence as 'high' | 'medium' | 'low' | null) ?? null,
            failureReason: (d.investigation_failure_reason as string | null) ?? null,
            full: null,
          };
        })() : undefined;
        return {
          id: m.id as number,
          serverId: m.id as number,
          role: m.role as 'user' | 'assistant',
          text: m.content as string,
          question: m.question as string | undefined,
          sql: m.sql as string | undefined,
          tablesUsed: m.tables_used ? (typeof m.tables_used === 'string' ? JSON.parse(m.tables_used as string) : m.tables_used) : undefined,
          confidence: m.confidence as number | undefined,
          warning: m.warning as string | undefined,
          blocked: m.blocked as boolean | undefined,
          needsClarification: m.needs_clarification as boolean | undefined,
          mismatches: m.mismatches ? (typeof m.mismatches === 'string' ? JSON.parse(m.mismatches as string) : m.mismatches) : undefined,
          ambiguities: m.ambiguities ? (typeof m.ambiguities === 'string' ? JSON.parse(m.ambiguities as string) : m.ambiguities) : undefined,
          error: m.error as boolean | undefined,
          debug,
          rows: m.rows ? (typeof m.rows === 'string' ? JSON.parse(m.rows as string) : m.rows) : undefined,
          wasRepaired: m.was_repaired as boolean | undefined,
          reasoning: m.reasoning as string | undefined,
          queryLayer: m.query_layer as 'product' | 'source' | undefined,
          feedback: m.feedback as 'up' | 'down' | null,
          feedbackComment: m.feedback_comment as string | undefined,
          // Restored meta — assumptions, clarify chips, chart hint, forecast,
          // sources and the repair trail all survive a reload now.
          assumptions: meta.assumptions as string[] | undefined,
          subScores: meta.subScores as Message['subScores'],
          uncertaintyNotes: meta.uncertaintyNotes as string[] | undefined,
          intent: meta.intent as Message['intent'],
          options: meta.options as Message['options'],
          ambiguity: meta.ambiguity as string | undefined,
          visualization: meta.visualization as Message['visualization'],
          forecast: meta.forecast as Message['forecast'],
          sources: meta.sources as AnswerSource[] | undefined,
          answeredInMs: meta.answeredInMs as number | undefined,
          policyNotice: meta.policyNotice as string | undefined,
          adminNotified: meta.adminNotified as boolean | undefined,
          repairSummary: meta.repairSummary as string[] | undefined,
          flagReason: meta.flagReason as string | undefined,
          ...(isInvestigation ? { mode: 'investigate' as const, investigation } : {}),
        };
      });
      setMessages(msgs);
      nextId.current = msgs.length > 0 ? Math.max(...msgs.map((m) => m.id)) + 1 : 0;
    } catch {
      setMessages([]);
      nextId.current = 0;
    }
  }

  async function deleteConversation(id: number) {
    if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
    try { await api.delete(`/conversations/${id}`); } catch { /* non-fatal */ }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeId) {
        if (next.length > 0) { selectConversation(next[0].id); }
        else { setActiveId(null); setMessages([]); }
        resetRepair();
      }
      return next;
    });
  }

  async function toggleStar(id: number) {
    try {
      const res = await api.patch(`/conversations/${id}/star`);
      const newStarred = res.data.data.starred;
      setConversations((prev) =>
        prev.map((c) => c.id === id ? { ...c, starred: newStarred } : c)
          .filter((c) => !starFilter || c.starred)
      );
    } catch { /* non-fatal */ }
  }

  async function handleFeedback(msgId: number, serverId: number, feedback: 'up' | 'down' | null, comment?: string) {
    try {
      await api.patch(`/conversations/messages/${serverId}/feedback`, { feedback, comment });
      setMessages((prev) => prev.map((m) =>
        m.id === msgId ? { ...m, feedback, feedbackComment: comment } : m
      ));
    } catch { /* non-fatal */ }
  }

  /**
   * Re-fetch a persisted investigation's full trail and hydrate the
   * matching message in place. Used by MessageBubble's "Replay full
   * trail" button on rehydrated investigate-mode messages — steps
   * aren't persisted row-by-row, only the conclusion + investigation_id
   * survive in `debug` JSONB.
   */
  async function handleReplayInvestigation(msgId: number, investigationId: number) {
    try {
      const res = await api.get(`/investigations/${investigationId}`);
      const inv = res.data.data as import('@/lib/investigationTypes').Investigation | null;
      if (!inv) return;
      setMessages((prev) => prev.map((m) => {
        if (m.id !== msgId || !m.investigation) return m;
        return {
          ...m,
          investigation: {
            ...m.investigation,
            steps: inv.steps,
            full: inv,
          },
        };
      }));
    } catch (err) {
      console.error('[chat] replay investigation failed', err);
    }
  }

  function handleExport(format: 'csv' | 'xlsx', conversationId: number, messageServerId?: number) {
    const params = messageServerId ? `?messageId=${messageServerId}` : '';
    const url = `${BACKEND_URL}/api/conversations/${conversationId}/export/${format}${params}`;
    // Open in new tab to trigger download, with auth token
    const token = getToken();
    // Use fetch + blob for authenticated download
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.blob())
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        // Per-message filename — two exports from one chat must not collide.
        a.download = `clarion-export-${conversationId}${messageServerId ? `-${messageServerId}` : ''}.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => alert('Export failed'));
  }

  // ── Repair stream — the "double-checking" flow ────────────────────────────
  //
  // Owner decision (2026-08-27 assessment §8.1): when the validator flags an
  // answer, HOLD it out of the transcript while the repair loop runs, up to
  // ~10 seconds — a wrong number must never be shown, read, and then silently
  // swapped under the reader. If the loop settles inside the hold the answer
  // appears ONCE, already corrected. If it runs long, the provisional answer
  // is revealed clearly marked "being double-checked" and updated in place.
  //
  // The authoritative copy of the repair state lives in a ref (all writers
  // are SSE callbacks and timers, not renders); setRepairState mirrors it.
  const repairRef = useRef<RepairState | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const REPAIR_HOLD_MS = 10_000;

  function updateRepair(mutator: (prev: RepairState | null) => RepairState | null) {
    repairRef.current = mutator(repairRef.current);
    setRepairState(repairRef.current);
  }

  function clearHoldTimer() {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  }

  /** Append the held answer to the transcript, marked as still being checked. */
  function revealProvisional() {
    clearHoldTimer();
    const prev = repairRef.current;
    if (!prev || prev.revealed || !prev.holdMsg) return;
    const provisional: Message = { ...prev.holdMsg, checking: true };
    setMessages((ms) => [...ms, provisional]);
    updateRepair((p) => p ? { ...p, revealed: true, holdMsg: provisional } : p);
  }

  /** The repair loop ended without a correction — release the original answer. */
  function releaseHeldAnswer() {
    clearHoldTimer();
    const prev = repairRef.current;
    if (!prev) return;
    if (!prev.revealed && prev.holdMsg) {
      const original = { ...prev.holdMsg, checking: false };
      setMessages((ms) => [...ms, original]);
      updateRepair((p) => p ? { ...p, revealed: true, holdMsg: original, isActive: false } : p);
    } else if (prev.revealed) {
      setMessages((ms) => ms.map((m) => m.id === prev.forMessageId ? { ...m, checking: false } : m));
      updateRepair((p) => p ? { ...p, isActive: false } : p);
    }
  }

  /** Drop all repair state — timer, stream, panel. */
  function resetRepair() {
    clearHoldTimer();
    repairAbortRef.current?.abort();
    repairAbortRef.current = null;
    repairRef.current = null;
    setRepairState(null);
  }

  async function startRepair(params: {
    messageId: number;
    question: string;
    originalSql: string;
    originalRows: Record<string, unknown>[];
    warning: string;
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    clarificationAnswer?: string;
    /** Server-side persistence of the correction (see /query/repair). */
    conversationId?: number;
    messageServerId?: number;
  }) {
    // Fresh loop (not a clarification resume): initialise the panel state.
    // The /think done-handler pre-seeds it with the HELD message; callers
    // whose message is already in the transcript (cross-view) start revealed.
    if (!repairRef.current || repairRef.current.forMessageId !== params.messageId) {
      updateRepair(() => ({ forMessageId: params.messageId, events: [], isActive: true, revealed: true }));
    }

    let sawRevisedAnswer = false;
    let sawClarification = false;

    const handleEvent = (event: Record<string, unknown>) => {
      const type = event.type as string;

      if (type === 'thinking') {
        updateRepair((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'thinking', text: event.text as string, detail: event.detail as string | undefined }] }
          : null);

      } else if (type === 'data_query') {
        updateRepair((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'data_query', sql: event.sql as string | undefined }] }
          : null);

      } else if (type === 'query_result') {
        updateRepair((prev) => prev
          ? { ...prev, events: [...prev.events, {
              kind: 'query_result',
              rowCount: event.rowCount as number,
              rows: event.rows as Record<string, unknown>[] | undefined,
            }] }
          : null);

      } else if (type === 'revised_sql') {
        updateRepair((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'revised_sql', sql: event.sql as string | undefined }] }
          : null);

      } else if (type === 'clarification') {
        // The agent needs the user's input — reveal the provisional answer so
        // the question has visible context, then pause for the inline reply.
        sawClarification = true;
        revealProvisional();
        updateRepair((prev) => prev
          ? {
              ...prev,
              isActive: false,
              events: [...prev.events, { kind: 'clarification', question: event.question as string }],
              pendingClarification: event.question as string,
              pendingHistory: event.conversationHistory as Array<{ role: 'user' | 'assistant'; content: string }>,
            }
          : null);

      } else if (type === 'revised_answer') {
        sawRevisedAnswer = true;
        clearHoldTimer();
        const corrected = (base: Message): Message => ({
          ...base,
          text:          event.answer as string,
          sql:           (event.sql as string | undefined) ?? base.sql,
          rows:          event.rows as Record<string, unknown>[],
          confidence:    event.confidence as number,
          warning:       (event.warning as string | null) ?? undefined,
          wasRepaired:   true,
          checking:      false,
          repairSummary: (event.repairSummary as string[] | undefined) ?? [],
        });
        const prev = repairRef.current;
        if (prev && !prev.revealed && prev.holdMsg) {
          // Settled inside the hold — the answer appears once, correct.
          setMessages((ms) => [...ms, corrected(prev.holdMsg!)]);
          updateRepair((p) => p ? { ...p, revealed: true, isActive: false } : p);
        } else {
          setMessages((ms) => ms.map((m) => m.id === params.messageId ? corrected(m) : m));
          updateRepair((p) => p ? { ...p, isActive: false } : p);
        }
        // The backend persisted the correction when it had the ids; fall back
        // to a client-side PATCH when it reported otherwise.
        if (event.persisted !== true && params.conversationId && params.messageServerId) {
          api.patch(`/conversations/${params.conversationId}/messages/${params.messageServerId}`, {
            content: event.answer,
            ...(event.sql ? { sql: event.sql } : {}),
            rows: event.rows,
            confidence: event.confidence,
            warning: (event.warning as string | null) ?? null,
            wasRepaired: true,
            meta: { repairSummary: (event.repairSummary as string[] | undefined) ?? [] },
          }).catch(() => {});
        }

      } else if (type === 'error') {
        updateRepair((prev) => prev
          ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: `⚠ ${event.text as string}`, detail: event.detail as string | undefined }] }
          : null);
      }
    };

    const ctrl = new AbortController();
    repairAbortRef.current = ctrl;
    try {
      await streamSSE(`${BACKEND_URL}/api/query/repair`, {
        body: {
          connectionId:        selectedSource.startsWith('c:') ? Number(selectedSource.split(':')[1]) : 1,
          question:            params.question,
          originalSql:         params.originalSql,
          originalRows:        params.originalRows,
          warning:             params.warning,
          conversationHistory: params.conversationHistory,
          clarificationAnswer: params.clarificationAnswer,
          conversationId:      params.conversationId,
          messageServerId:     params.messageServerId,
          ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
        },
        signal: ctrl.signal,
        onEvent: (event) => handleEvent(event as Record<string, unknown>),
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return; // unmounted mid-repair
      updateRepair((prev) => prev
        ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: '⚠ Could not reach the backend. Please try again.' }] }
        : null,
      );
      releaseHeldAnswer();
      return;
    } finally {
      if (repairAbortRef.current === ctrl) repairAbortRef.current = null;
    }

    // Stream ended. If no correction (and no pending clarification), the
    // original answer stands — release it with its warning intact.
    if (!sawRevisedAnswer && !sawClarification) releaseHeldAnswer();
    else updateRepair((prev) => prev ? { ...prev, isActive: false } : null);
  }

  function handleClarify(answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    const prev = repairRef.current;
    if (!prev) return;
    const msgId = prev.forMessageId;
    // The held/revealed message carries the original question + SQL.
    const assistantMsg = prev.holdMsg ?? messages.find((m) => m.id === msgId);
    if (!assistantMsg) return;

    // Keep the existing event trail — answering a clarifying question used to
    // wipe the whole visible investigation and restart the panel from scratch.
    updateRepair((p) => p
      ? { ...p, isActive: true, pendingClarification: undefined, pendingHistory: undefined }
      : null,
    );

    startRepair({
      messageId:           msgId,
      question:            assistantMsg.question ?? '',
      originalSql:         assistantMsg.sql ?? '',
      originalRows:        assistantMsg.rows ?? [],
      warning:             assistantMsg.warning ?? '',
      conversationHistory: history,
      clarificationAnswer: answer,
      conversationId:      activeId && activeId > 0 ? activeId : undefined,
      messageServerId:     assistantMsg.serverId,
    });
  }

  // ── Send a question ──

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;

    // A new question ends any running double-check: release a still-held
    // answer into the transcript first (its original form was persisted), then
    // drop the panel.
    if (repairRef.current && !repairRef.current.revealed) releaseHeldAnswer();
    resetRepair();

    let cid = activeId;
    if (!cid) {
      // Create a new conversation on the server
      try {
        const res = await api.post('/conversations', { title: q.slice(0, 80), sourceKey: selectedSource });
        cid = res.data.data.id;
        const conv: Conversation = {
          id: cid!,
          title: q.slice(0, 80),
          starred: false,
          createdAt: res.data.data.created_at,
          updatedAt: res.data.data.updated_at,
          messages: [],
        };
        setConversations((prev) => [conv, ...prev]);
      } catch {
        cid = -Date.now();
        setConversations((prev) => [{
          id: cid!, title: q.slice(0, 80), starred: false,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [],
        }, ...prev]);
      }
      setActiveId(cid);
    }

    setInput('');
    const userMsgId = nextId.current++;
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text: q }]);
    // Persist user message to server — await so any failure is visible in console
    // and the message is durable before the assistant streams (avoids vanishing on reload)
    if (cid && cid > 0) {
      const userServerId = await persistMessage(cid, { role: 'user', text: q });
      if (userServerId) {
        setMessages((prev) => prev.map((m) => m.id === userMsgId ? { ...m, serverId: userServerId } : m));
      }
    }
    setLoading(true);
    setThinkingPhase('');
    setThinkingText('');
    setThinkingSql(null);
    setThinkingConf(null);
    setThinkingTables([]);

    // Resolve mode: explicit override > heuristic. Investigate also requires
    // a resolved product (URL `productId` or default product for the active
    // connection); otherwise we silently fall back to ask mode.
    const resolvedMode: QuestionMode = (() => {
      if (modeOverride === 'investigate' && resolvedProductId != null) return 'investigate';
      if (modeOverride === 'ask') return 'ask';
      // 'auto' — classify
      const classified = classifyQuestion(q);
      return classified === 'investigate' && resolvedProductId != null ? 'investigate' : 'ask';
    })();
    // Reset override after each send.
    if (modeOverride !== 'auto') setModeOverride('auto');

    // ── Investigate path: spawn an in-bubble investigation ────────────────────
    if (resolvedMode === 'investigate' && resolvedProductId != null) {
      const productIdNum = resolvedProductId;
      const investigateMsgId = nextId.current++;
      setMessages((prev) => [
        ...prev,
        {
          id: investigateMsgId,
          role: 'assistant',
          text: '',
          question: q,
          mode: 'investigate',
          investigation: {
            question: q,
            focus: null,
            productId: productIdNum,
            streamStatus: 'starting',
            steps: [],
            conclusion: null,
            conclusionConfidence: null,
            failureReason: null,
            full: null,
          },
        },
      ]);
      const controller = new AbortController();
      // Capture the final state so we can persist after the stream ends.
      // Using local refs avoids racing the React state batch.
      let finalConclusion: string | null = null;
      let finalFailure: string | null = null;
      let finalInvestigationId: number | null = null;
      let finalConfidence: 'high' | 'medium' | 'low' | null = null;
      try {
        await runInvestigation({
          question: q,
          focus: null,
          dataProductId: productIdNum,
          pulseEntryId: null,
          briefId: null,
          signal: controller.signal,
          onEvent: (evt) => {
            setMessages((prev) => prev.map((m) => {
              if (m.id !== investigateMsgId || !m.investigation) return m;
              const inv = m.investigation;
              if (evt.type === 'step_started') {
                return { ...m, investigation: { ...inv, streamStatus: 'running', steps: upsertStep(inv.steps, evt.step) } };
              }
              if (evt.type === 'step_completed') {
                return { ...m, investigation: { ...inv, steps: upsertStep(inv.steps, evt.step) } };
              }
              if (evt.type === 'concluded') {
                finalConclusion = evt.investigation.conclusion;
                finalInvestigationId = evt.investigation.id;
                finalConfidence = evt.investigation.conclusion_confidence;
                return {
                  ...m,
                  text: evt.investigation.conclusion ?? '',
                  investigation: {
                    ...inv,
                    id: evt.investigation.id,
                    streamStatus: 'done',
                    steps: evt.investigation.steps,
                    conclusion: evt.investigation.conclusion,
                    conclusionConfidence: evt.investigation.conclusion_confidence,
                    full: evt.investigation,
                  },
                };
              }
              if (evt.type === 'failed') {
                finalFailure = evt.reason;
                return {
                  ...m,
                  investigation: { ...inv, streamStatus: 'failed', failureReason: evt.reason },
                };
              }
              return m;
            }));
          },
        });
        // Persist the result. We store the conclusion as the message text
        // so it shows on reload as a regular assistant reply, and stash
        // the investigation_id + flags in `debug` (a free-form JSON
        // column) so the loader can re-render the 🕵️ eyebrow and offer
        // "Replay full trail" without a schema migration.
        if (cid && cid > 0) {
          const text = finalConclusion ?? (finalFailure ? `Investigation failed: ${finalFailure}` : 'Investigation produced no conclusion.');
          const persistDebug: Record<string, unknown> = {
            investigation_id: finalInvestigationId,
            investigation_mode: true,
            investigation_status: finalFailure ? 'failed' : 'concluded',
            investigation_confidence: finalConfidence,
            investigation_failure_reason: finalFailure,
          };
          const serverId = await persistMessage(cid, {
            role: 'assistant',
            text,
            question: q,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            debug: persistDebug as any,
          });
          if (serverId) {
            setMessages((prev) => prev.map((m) => m.id === investigateMsgId ? { ...m, serverId } : m));
          }
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Investigation failed';
        setMessages((prev) => prev.map((m) =>
          m.id === investigateMsgId && m.investigation
            ? { ...m, investigation: { ...m.investigation, streamStatus: 'failed', failureReason: reason } }
            : m,
        ));
      } finally {
        setLoading(false);
        setThinkingPhase('');
        setThinkingText('');
        setThinkingSql(null);
        setThinkingConf(null);
        setThinkingTables([]);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      return;
    }

    try {
      const isCrossView = selectedSource.startsWith('v:');
      const sourceId    = Number(selectedSource.split(':')[1]);

      // Cross-view queries use the regular (non-streaming) route
      if (isCrossView) {
        const res = await api.post('/query/cross-view', {
          viewId: sourceId,
          question: q,
          ...(cid && cid > 0 ? { conversationId: cid } : {}),
        });
        const d   = res.data.data;
        const assistantId = nextId.current++;
        const assistantMsg: Message = {
          id: assistantId, role: 'assistant', text: d.answer, question: q,
          sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence, warning: d.warning,
          blocked: d.blocked, flagReason: d.flagReason, subScores: d.subScores, uncertaintyNotes: d.uncertaintyNotes,
          assumptions: d.assumptions,
          intent: d.intent, ambiguity: d.ambiguity, options: d.options,
          needsClarification: d.needsClarification,
          ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
          queryLayer: d.queryLayer,
          visualization: d.visualization,
        };
        // Persist to server
        if (cid && cid > 0) {
          const serverId = await persistMessage(cid, assistantMsg);
          if (serverId) assistantMsg.serverId = serverId;
        }
        setMessages((prev) => [...prev, assistantMsg]);
        if (d.warning && !d.blocked && d.sql && d.rows) {
          startRepair({
            messageId: assistantId, question: q, originalSql: d.sql, originalRows: d.rows, warning: d.warning,
            conversationId: cid && cid > 0 ? cid : undefined,
            messageServerId: assistantMsg.serverId,
          });
        }
        return;
      }

      // Forecast detection — lightweight keyword check before the main query path
      // NOTE: bare 'project' was removed — it substring-matched "projects"
      // and misrouted ordinary questions to the forecast path. Dutch keywords
      // added: the user base is Belgian.
      const FORECAST_KEYWORDS = [
        'predict', 'forecast', 'will be', 'next quarter', 'next month', 'next year',
        'next week', 'expect', 'projection', 'trend going forward',
        'future', 'going to be', 'estimated', 'estimation', 'outlook',
        'projected', 'anticipated', 'upcoming', 'trajectory',
        'voorspel', 'prognose', 'verwacht', 'volgend kwartaal', 'volgende maand',
        'volgend jaar', 'volgende week', 'toekomst', 'schatting', 'vooruitzicht',
      ];
      const qLower = q.toLowerCase();
      const isForecast = FORECAST_KEYWORDS.some((kw) => qLower.includes(kw));

      if (isForecast) {
        try {
          setThinkingPhase('Generating forecast...');
          const res = await api.post('/query/forecast', {
            connectionId: sourceId,
            question: q,
            ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
          });
          const d = res.data.data;
          const assistantId = nextId.current++;
          const assistantMsg: Message = {
            id: assistantId, role: 'assistant', text: d.answer, question: q,
            sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence,
            blocked: d.blocked, rows: d.rows,
            forecast: d.forecast,
          };
          if (cid && cid > 0) {
            persistMessage(cid, assistantMsg).then((serverId) => {
              if (serverId) setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, serverId } : m));
            });
          }
          setMessages((prev) => [...prev, assistantMsg]);
        } catch {
          setMessages((prev) => [...prev, {
            id: nextId.current++, role: 'assistant',
            text: 'Something went wrong generating the forecast. Please try again.',
            error: true,
          }]);
        } finally {
          setLoading(false);
          setThinkingPhase('');
          setThinkingText('');
          setThinkingSql(null);
          setThinkingConf(null);
          setThinkingTables([]);
          setTimeout(() => inputRef.current?.focus(), 50);
        }
        return;
      }

      // Single-source: use the streaming /think endpoint
      let   assistantId = -1;
      let   accumulatedThinking = '';

      const ctrl = new AbortController();
      thinkAbortRef.current = ctrl;
      try {
        await streamSSE(`${BACKEND_URL}/api/query/think`, {
          body: {
            connectionId: sourceId,
            question:     q,
            ...(cid && cid > 0 ? { conversationId: cid } : {}),
            ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
            ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
          },
          signal: ctrl.signal,
          onEvent: (raw) => {
          const event = raw as Record<string, unknown>;
          const type = event.type as string;

          if (type === 'phase') {
            setThinkingPhase(event.text as string);

          } else if (type === 'thinking') {
            accumulatedThinking += event.text as string;
            setThinkingText((prev) => prev + (event.text as string));

          } else if (type === 'tables') {
            setThinkingTables((event.tables as string[]) ?? []);

          } else if (type === 'sql_ready') {
            setThinkingSql(event.sql as string);
            setThinkingConf(event.confidence as number);

          } else if (type === 'done') {
            const d = event.data as {
              answer: string; confidence: number; blocked?: boolean; sql?: string;
              tablesUsed?: string[]; warning?: string; rows?: Record<string, unknown>[];
              debug?: DebugInfo; needsClarification?: boolean;
              ambiguities?: EntityAmbiguity[]; mismatches?: EntityMismatch[];
              queryLayer?: 'product' | 'source';
              flagReason?: string;
              subScores?: { schema?: number; join?: number; formula?: number };
              uncertaintyNotes?: string[];
              assumptions?: string[];
              intent?: 'data' | 'explain' | 'clarify';
              ambiguity?: string;
              options?: import('./types').ClarifyOption[];
              visualization?: import('./types').VisualizationHint;
              sources?: AnswerSource[];
              answeredInMs?: number;
              policyNotice?: string;
              adminNotified?: boolean;
            };
            assistantId = nextId.current++;
            const assistantMsg: Message = {
              id: assistantId, role: 'assistant', text: d.answer, question: q,
              sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence, warning: d.warning,
              blocked: d.blocked, flagReason: d.flagReason, subScores: d.subScores, uncertaintyNotes: d.uncertaintyNotes,
              assumptions: d.assumptions,
              intent: d.intent, ambiguity: d.ambiguity, options: d.options,
              needsClarification: d.needsClarification,
              ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
              reasoning: accumulatedThinking || undefined,
              queryLayer: d.queryLayer,
              visualization: d.visualization,
              sources: d.sources,
              answeredInMs: d.answeredInMs,
              policyNotice: d.policyNotice,
              adminNotified: d.adminNotified,
            };

            const needsRepair = !!(d.warning && !d.blocked && d.sql && d.rows);
            if (!needsRepair) {
              // Persist to server
              if (cid && cid > 0) {
                persistMessage(cid, assistantMsg).then((serverId) => {
                  if (serverId) {
                    setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, serverId } : m));
                  }
                });
              }
              setMessages((prev) => [...prev, assistantMsg]);
            } else {
              // The double-checking flow: HOLD the flagged answer out of the
              // transcript (owner decision — up to ~10s, then reveal it
              // clearly marked). Persist the original first so the repair
              // route can persist its correction onto the same row.
              void (async () => {
                let serverId: number | undefined;
                if (cid && cid > 0) {
                  serverId = await persistMessage(cid, assistantMsg);
                  if (serverId) assistantMsg.serverId = serverId;
                }
                updateRepair(() => ({
                  forMessageId: assistantMsg.id,
                  events: [],
                  isActive: true,
                  holdMsg: assistantMsg,
                  revealed: false,
                }));
                clearHoldTimer();
                holdTimerRef.current = setTimeout(revealProvisional, REPAIR_HOLD_MS);
                startRepair({
                  messageId: assistantMsg.id,
                  question: q,
                  originalSql: d.sql!,
                  originalRows: d.rows!,
                  warning: d.warning!,
                  conversationId: cid && cid > 0 ? cid : undefined,
                  messageServerId: serverId,
                });
              })();
            }

          } else if (type === 'error') {
            setMessages((prev) => [...prev, {
              id: nextId.current++, role: 'assistant',
              text: (event.message as string) || 'Something went wrong. Please try again.',
              error: true,
              errorDetail: event.errorDetail as string | undefined,
              errorStack: event.errorStack as string | undefined,
            }]);
          }
          },
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return; // unmounted mid-stream
        if (err instanceof SSEHttpError) {
          console.error('[chat] /think failed', { status: err.status, detail: err.detail });
          const friendly = err.status === 401
            ? 'Your session expired. Please sign in again.'
            : err.status >= 500
              ? 'The server hit an error processing your question. Please try again in a moment.'
              : `Could not run your question (HTTP ${err.status}). Please try again.`;
          setMessages((prev) => [...prev, {
            id: nextId.current++, role: 'assistant', text: friendly, error: true,
          }]);
          return;
        }
        throw err; // network / stream errors → generic handler below
      } finally {
        if (thinkAbortRef.current === ctrl) thinkAbortRef.current = null;
      }

    } catch {
      setMessages((prev) => [
        ...prev,
        { id: nextId.current++, role: 'assistant', text: 'Something went wrong. Please try again.', error: true },
      ]);
    } finally {
      setLoading(false);
      setThinkingPhase('');
      setThinkingText('');
      setThinkingSql(null);
      setThinkingConf(null);
      setThinkingTables([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // useSourceLayer is a dep on purpose: it used to be read through a stale
  // closure, so the first question after flipping the toggle ran against the
  // PREVIOUS layer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeId, selectedSource, modeOverride, resolvedProductId, useSourceLayer]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  // Auto-submit deep link — `?q=…&autoSubmit=1`, used by the topic page's
  // "Try asking" rows. Distinct from `seedQuestion`, which only pre-fills:
  // the topic page promises that clicking a question ANSWERS it, and landing
  // on a filled-in box the user still has to submit breaks that promise.
  //
  // Waits for the source list so the question runs against the right layer,
  // and fires at most once per (q, product) pair — `autoSentRef` is what
  // stops a re-render or a state change from asking twice.
  const autoQuestion = searchParams.get('q');
  const autoSubmit = searchParams.get('autoSubmit');
  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoQuestion || autoSubmit !== '1') return;
    if (!selectedSource) return;           // sources still loading
    if (urlProductId && !productContext) return; // product context still loading
    const key = `${urlProductId ?? ''}:${autoQuestion}`;
    if (autoSentRef.current === key) return;
    autoSentRef.current = key;
    send(autoQuestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoQuestion, autoSubmit, selectedSource, productContext, urlProductId]);

  // ── Render ──

  const sidebarContent = (
    <ChatSidebar
      conversations={conversations}
      activeId={activeId}
      onSelect={selectConversation}
      onNew={startNewConversation}
      onDelete={deleteConversation}
      onStar={toggleStar}
      starFilter={starFilter}
      onToggleStarFilter={() => setStarFilter((f) => !f)}
    />
  );

  return (
    <AppShell
      title="Ask your Data"
      showSearch={false}
      contextPanel={sidebarContent}
    >
      <div className="flex flex-col flex-1 min-h-0">
        {/* Sub-header: optional product-context pill + show SQL toggle.
            The source picker used to live here. It was removed —
            users shouldn't be deciding which source to query against
            up front. The backend defaults to the user's primary
            connection (URL param > last-used > first). If a question
            is ambiguous across sources, the AI clarifies via its
            existing intent='clarify' response shape rather than
            forcing the user to pre-select. */}
        <div className="flex-shrink-0 px-6 py-2.5 flex items-center justify-between border-b border-line bg-raised">
          <div className="flex items-center gap-3">
            {productContext ? (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-ai-soft border border-line rounded-md">
                <span className="text-[13px] font-medium text-ink">{productContext.name}</span>
                <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ai bg-raised px-1.5 py-0.5 rounded border border-line">Product</span>
                <button
                  onClick={() => setProductContext(null)}
                  className="text-muted-2 hover:text-ink-2 ml-1 transition-colors"
                  title="Clear product focus"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-4">
            {canSeeSql && (
              <label className="flex items-center gap-2 text-[11px] font-mono tracking-[0.08em] uppercase text-muted cursor-pointer select-none">
                <div onClick={() => setShowSql((s) => !s)}
                  className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${showSql ? 'bg-ocean' : 'bg-line-strong'}`}>
                  <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow-1 transition-transform ${showSql ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                Show SQL
              </label>
            )}
            {messages.length > 0 && (
              <button onClick={() => {
                // This DELETES the conversation, it doesn't just clear the view.
                if (!window.confirm('Delete this conversation? This cannot be undone.')) return;
                if (activeId && activeId > 0) {
                  api.delete(`/conversations/${activeId}`).catch(() => {});
                  setConversations((prev) => prev.filter((c) => c.id !== activeId));
                }
                setActiveId(null); setMessages([]); resetRepair();
              }}
                className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ink-2 transition-colors">
                Clear chat
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto w-full px-4 py-6">
            {messages.length === 0 && !loading ? (
              <EmptyState
                onStarter={send}
                productContext={productContext}
                input={input}
                setInput={setInput}
                onSubmit={handleSubmit}
                loading={loading}
                canQuerySource={canSeeSql}
                useSourceLayer={useSourceLayer}
                setUseSourceLayer={setUseSourceLayer}
              />
            ) : (
              <div className="space-y-4">
                {messages.map((m) => (
                  <div key={m.id}>
                    <MessageBubble msg={m} showSql={showSql} isAdmin={isAdmin} canSeeSql={canSeeSql} onSend={send} onFeedback={handleFeedback} onExport={handleExport} conversationId={activeId} onReplayInvestigation={handleReplayInvestigation} />
                    {/* The live double-check panel shows only WHILE the loop
                        runs (or waits on a clarification). Once settled it
                        disappears — the answer card's trust line and "What I
                        checked" are the durable receipt, so a corrected
                        answer costs one card, not 2,000px of transcript. */}
                    {repairState?.forMessageId === m.id && repairState.revealed
                      && (repairState.isActive || repairState.pendingClarification) && (
                      <div className="mt-3">
                        <ThinkingPanel repair={repairState} onClarify={handleClarify} canSeeSql={canSeeSql} />
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <ThinkingBubble
                    phase={thinkingPhase}
                    liveText={thinkingText}
                    sql={thinkingSql}
                    confidence={thinkingConf}
                    tables={thinkingTables}
                    canSeeSql={canSeeSql}
                  />
                )}
                {/* Double-checking panel while the answer is still HELD —
                    it has no message to attach to yet. */}
                {repairState && !repairState.revealed && (
                  <ThinkingPanel repair={repairState} onClarify={handleClarify} canSeeSql={canSeeSql} />
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input (pinned at bottom during active conversation) */}
        {(messages.length > 0 || loading) && (
          <div className="flex-shrink-0 px-4 py-3 border-t border-line bg-raised">
            {/* Freshness banner — worst-source status with the OLDEST date, so the
                sentence and the colour describe the same thing (it used to show
                the NEWEST date coloured by the worst unrelated source). The
                per-answer "Data as of …" on each card is the primary signal;
                this is the tenant-wide catch-all. */}
            {(() => {
              const validDates = freshnessDates.filter(Boolean) as string[];
              if (validDates.length === 0) return null;
              const status = getOverallFreshnessStatus(freshnessDates);
              if (status === 'fresh' || status === 'unknown') return null;
              const oldest = new Date(Math.min(...validDates.map(d => new Date(d).getTime())));
              const colour = status === 'old' ? 'text-err' : 'text-warn';
              return (
                <div className={`max-w-2xl mx-auto mb-2 text-center font-mono text-[10.5px] uppercase tracking-[0.08em] ${colour}`}>
                  Some of your data was last refreshed {formatRelativeTime(oldest)}
                </div>
              );
            })()}
            <form onSubmit={handleSubmit} className="max-w-2xl mx-auto flex gap-2 items-end">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask a follow-up…"
                disabled={loading}
                autoComplete="off"
                className="flex-1 font-sans text-[14px] px-[13px] py-[10px] rounded-sm border border-line bg-raised text-ink outline-none transition-all duration-1 ease-observatory placeholder:text-muted-2 focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none px-4 py-[10px] rounded-sm border bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover transition-all duration-1 ease-observatory disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
                ) : (
                  <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.8} aria-hidden="true" />
                )}
                {loading ? 'Thinking…' : 'Ask'}
              </button>
            </form>
            {/* Mode hint — shows the auto-detected mode for the current input,
                lets the user flip it. Investigate requires a product context. */}
            <div className="max-w-2xl mx-auto mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2">
                {input.trim() ? (
                  modeOverride !== 'auto' ? (
                    <span className="flex items-center gap-1.5">
                      <span>{modeOverride === 'investigate' ? '🕵️ Investigate' : '💬 Ask'} (forced)</span>
                      <button
                        type="button"
                        onClick={() => setModeOverride('auto')}
                        className="text-ocean hover:underline normal-case font-sans tracking-normal"
                      >
                        reset
                      </button>
                    </span>
                  ) : detectedMode === 'investigate' && canInvestigate ? (
                    <span className="flex items-center gap-1.5">
                      <span>🕵️ Investigate mode</span>
                      <button
                        type="button"
                        onClick={() => setModeOverride('ask')}
                        className="text-ocean hover:underline normal-case font-sans tracking-normal"
                      >
                        switch to ask
                      </button>
                    </span>
                  ) : detectedMode === 'investigate' && !canInvestigate ? (
                    <span className="text-amber-700">
                      🕵️ Investigate needs a product · ask mode used
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span>💬 Ask mode</span>
                      {canInvestigate && (
                        <button
                          type="button"
                          onClick={() => setModeOverride('investigate')}
                          className="text-ocean hover:underline normal-case font-sans tracking-normal"
                        >
                          switch to investigate
                        </button>
                      )}
                    </span>
                  )
                ) : (
                  <span>&nbsp;</span>
                )}
              </div>
              {canSeeSql && (
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2 hover:text-ink-3 transition-colors">
                  <input
                    type="checkbox"
                    checked={useSourceLayer}
                    onChange={(e) => setUseSourceLayer(e.target.checked)}
                    className="w-3 h-3 rounded-sm border border-line accent-ocean"
                  />
                  Query source data
                </label>
              )}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function QueryPage() { return <Suspense><QueryPageInner /></Suspense>; }
