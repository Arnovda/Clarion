'use client';

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getToken, getTokenPayload } from '@/lib/auth';
import { formatRelativeTime, getOverallFreshnessStatus, getFreshnessTextColor } from '@/lib/freshness';
import { X, Loader2, ArrowRight } from 'lucide-react';
import { SourceSelector, type DataSource } from './components';
import MessageBubble from './MessageBubble';
import { ThinkingBubble, ThinkingPanel } from './thinking';
import ChatSidebar from './ChatSidebar';
import EmptyState from './EmptyState';
import type {
  DebugInfo,
  EntityMismatch,
  EntityAmbiguity,
  Message,
  Conversation,
  RepairState,
} from './types';

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
  const [isAdmin,        setIsAdmin]        = useState(false);
  const [starFilter,     setStarFilter]     = useState(false);
  // Default = product layer (cleaner star schema).
  // Toggle visible to admin/analyst only — viewers always stay on the product layer.
  const [useSourceLayer, setUseSourceLayer] = useState(false);

  // URL params (e.g. ?connectionId=5&productId=3&productName=Sales from Data Products)
  const searchParams = useSearchParams();
  const urlConnectionId = searchParams.get('connectionId');
  const urlProductId = searchParams.get('productId');
  const urlProductName = searchParams.get('productName');

  // Product context — shown when navigating from Data Products page
  const [productContext, setProductContext] = useState<{ name: string; kpis: string[] } | null>(null);

  // Data source selection (silent — no UI picker)
  const [sources,       setSources]       = useState<DataSource[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('');

  // Domain filter
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);
  const [selectedDomains,  setSelectedDomains]  = useState<string[]>([]);

  // Ephemeral repair state — never persisted
  const [repairState, setRepairState] = useState<RepairState | null>(null);

  // Data freshness indicator
  const [freshnessDates, setFreshnessDates] = useState<(string | null)[]>([]);

  // Live thinking state — shown while /think SSE stream is open
  const [thinkingPhase, setThinkingPhase] = useState<string>('');
  const [thinkingText,  setThinkingText]  = useState<string>('');
  const [thinkingSql,   setThinkingSql]   = useState<string | null>(null);
  const [thinkingConf,  setThinkingConf]  = useState<number | null>(null);

  const nextId      = useRef(0);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);

  useEffect(() => { setIsAdmin(getTokenPayload()?.role === 'admin'); }, []);

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
      setSources(all);

      // Priority: URL param > localStorage > first source
      if (urlConnectionId && all.some((s) => s.type === 'connection' && s.id === Number(urlConnectionId))) {
        const key = `c:${urlConnectionId}`;
        setSelectedSource(key);
        localStorage.setItem('databridge_query_source', key);
      } else {
        const saved = localStorage.getItem('databridge_query_source');
        if (saved && all.some((s) => `${s.type === 'connection' ? 'c' : 'v'}:${s.id}` === saved)) {
          setSelectedSource(saved);
        } else if (all.length > 0) {
          setSelectedSource(`c:${all[0].id}`);
        }
      }
      // Load domain tags for the first connection
      const firstConn = conns[0];
      if (firstConn) {
        api.get(`/semantic/domains?connectionId=${firstConn.id}`)
          .then((r) => setAvailableDomains(r.data.data ?? []))
          .catch(() => {});
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

  // Helper: persist a message to the server
  async function persistMessage(conversationId: number, msg: Partial<Message> & { role: string; text: string }): Promise<number | undefined> {
    try {
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
      setRepairState(null);
      nextId.current = 0;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // Fallback: still allow local usage
      const tempId = -Date.now();
      setConversations((prev) => [{ id: tempId, title: 'New conversation', starred: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }, ...prev]);
      setActiveId(tempId);
      setMessages([]);
      setRepairState(null);
      nextId.current = 0;
    }
  }

  async function selectConversation(id: number) {
    if (id === activeId) return;
    setActiveId(id);
    setRepairState(null);
    try {
      const res = await api.get(`/conversations/${id}`);
      const data = res.data.data;
      const msgs: Message[] = (data.messages ?? []).map((m: Record<string, unknown>) => ({
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
        debug: m.debug ? (typeof m.debug === 'string' ? JSON.parse(m.debug as string) : m.debug) : undefined,
        rows: m.rows ? (typeof m.rows === 'string' ? JSON.parse(m.rows as string) : m.rows) : undefined,
        wasRepaired: m.was_repaired as boolean | undefined,
        reasoning: m.reasoning as string | undefined,
        queryLayer: m.query_layer as 'product' | 'source' | undefined,
        feedback: m.feedback as 'up' | 'down' | null,
        feedbackComment: m.feedback_comment as string | undefined,
      }));
      setMessages(msgs);
      nextId.current = msgs.length > 0 ? Math.max(...msgs.map((m) => m.id)) + 1 : 0;
    } catch {
      setMessages([]);
      nextId.current = 0;
    }
  }

  async function deleteConversation(id: number) {
    try { await api.delete(`/conversations/${id}`); } catch { /* non-fatal */ }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (id === activeId) {
        if (next.length > 0) { selectConversation(next[0].id); }
        else { setActiveId(null); setMessages([]); }
        setRepairState(null);
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
        a.download = `databridge-export-${conversationId}.${format}`;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => alert('Export failed'));
  }

  // ── Repair stream ──

  async function startRepair(params: {
    messageId: number;
    question: string;
    originalSql: string;
    originalRows: Record<string, unknown>[];
    warning: string;
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    clarificationAnswer?: string;
  }) {
    setRepairState({ forMessageId: params.messageId, events: [], isActive: true });

    const token = getToken();
    let response: Response;
    try {
      response = await fetch(`${BACKEND_URL}/api/query/repair`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId:        selectedSource.startsWith('c:') ? Number(selectedSource.split(':')[1]) : 1,
          question:            params.question,
          originalSql:         params.originalSql,
          originalRows:        params.originalRows,
          warning:             params.warning,
          conversationHistory: params.conversationHistory,
          clarificationAnswer: params.clarificationAnswer,
          ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
        }),
      });
    } catch {
      setRepairState((prev) => prev
        ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: '⚠ Could not reach the backend. Please try again.' }] }
        : null,
      );
      return;
    }

    const reader  = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';

    // Defined before the loop so it can be called from inside it cleanly
    const handleEvent = (event: Record<string, unknown>) => {
      const type = event.type as string;

      if (type === 'thinking') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'thinking', text: event.text as string }] }
          : null);

      } else if (type === 'data_query') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'data_query', sql: event.sql as string }] }
          : null);

      } else if (type === 'query_result') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, {
              kind: 'query_result',
              rows: event.rows as Record<string, unknown>[],
              rowCount: event.rowCount as number,
            }] }
          : null);

      } else if (type === 'revised_sql') {
        setRepairState((prev) => prev
          ? { ...prev, events: [...prev.events, { kind: 'revised_sql', sql: event.sql as string }] }
          : null);

      } else if (type === 'clarification') {
        setRepairState((prev) => prev
          ? {
              ...prev,
              isActive: false,
              events: [...prev.events, { kind: 'clarification', question: event.question as string }],
              pendingClarification: event.question as string,
              pendingHistory: event.conversationHistory as Array<{ role: 'user' | 'assistant'; content: string }>,
            }
          : null);

      } else if (type === 'revised_answer') {
        setMessages((prev) => prev.map((m) =>
          m.id === params.messageId
            ? {
                ...m,
                text:        event.answer as string,
                sql:         event.sql    as string,
                rows:        event.rows   as Record<string, unknown>[],
                confidence:  event.confidence as number,
                warning:     (event.warning as string | null) ?? undefined,
                wasRepaired: true,
              }
            : m,
        ));
        setRepairState((prev) => prev ? { ...prev, isActive: false } : null);

      } else if (type === 'error') {
        setRepairState((prev) => prev
          ? { ...prev, isActive: false, events: [...prev.events, { kind: 'thinking', text: `⚠ ${event.text as string}` }] }
          : null);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });

      // When done=true keep ALL lines (no trailing pop); otherwise keep the last
      // incomplete line in buffer for the next chunk
      const lines = buffer.split('\n');
      buffer = done ? '' : (lines.pop() ?? '');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try { handleEvent(JSON.parse(line.slice(6)) as Record<string, unknown>); }
        catch { /* skip malformed line */ }
      }

      if (done) break;
    }

    setRepairState((prev) => prev ? { ...prev, isActive: false } : null);
  }

  function handleClarify(answer: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    if (!repairState) return;
    // Find the question for this message
    const msgId = repairState.forMessageId;
    const assistantMsg = messages.find((m) => m.id === msgId);
    if (!assistantMsg) return;

    setRepairState((prev) => prev
      ? { ...prev, isActive: true, pendingClarification: undefined, pendingHistory: undefined }
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
    });
  }

  // ── Send a question ──

  const send = useCallback(async (question: string) => {
    const q = question.trim();
    if (!q || loading) return;

    setRepairState(null); // clear any active repair when asking a new question

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
          needsClarification: d.needsClarification,
          ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
          queryLayer: d.queryLayer,
        };
        // Persist to server
        if (cid && cid > 0) {
          const serverId = await persistMessage(cid, assistantMsg);
          if (serverId) assistantMsg.serverId = serverId;
        }
        setMessages((prev) => [...prev, assistantMsg]);
        if (d.warning && !d.blocked && d.sql && d.rows) {
          startRepair({ messageId: assistantId, question: q, originalSql: d.sql, originalRows: d.rows, warning: d.warning });
        }
        return;
      }

      // Forecast detection — lightweight keyword check before the main query path
      const FORECAST_KEYWORDS = [
        'predict', 'forecast', 'will be', 'next quarter', 'next month', 'next year',
        'next week', 'expect', 'project', 'projection', 'trend going forward',
        'future', 'going to be', 'estimated', 'estimation', 'outlook',
        'projected', 'anticipated', 'upcoming', 'trajectory',
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
          setTimeout(() => inputRef.current?.focus(), 50);
        }
        return;
      }

      // Single-source: use the streaming /think endpoint
      const token = getToken();
      const response = await fetch(`${BACKEND_URL}/api/query/think`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          connectionId: sourceId,
          question:     q,
          ...(cid && cid > 0 ? { conversationId: cid } : {}),
          ...(selectedDomains.length > 0 ? { domains: selectedDomains } : {}),
          ...(useSourceLayer ? { dataLayer: 'source' as const } : {}),
        }),
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        console.error('[chat] /think failed', { status: response.status, detail });
        const friendly = response.status === 401
          ? 'Your session expired. Please sign in again.'
          : response.status >= 500
            ? 'The server hit an error processing your question. Please try again in a moment.'
            : `Could not run your question (HTTP ${response.status}). Please try again.`;
        setMessages((prev) => [...prev, {
          id: nextId.current++, role: 'assistant', text: friendly, error: true,
        }]);
        return;
      }

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';
      let   assistantId = -1;
      let   accumulatedThinking = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });

        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)) as Record<string, unknown>; }
          catch { continue; }

          const type = event.type as string;

          if (type === 'phase') {
            setThinkingPhase(event.text as string);

          } else if (type === 'thinking') {
            accumulatedThinking += event.text as string;
            setThinkingText((prev) => prev + (event.text as string));

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
            };
            assistantId = nextId.current++;
            const assistantMsg: Message = {
              id: assistantId, role: 'assistant', text: d.answer, question: q,
              sql: d.sql, tablesUsed: d.tablesUsed, confidence: d.confidence, warning: d.warning,
              blocked: d.blocked, flagReason: d.flagReason, subScores: d.subScores, uncertaintyNotes: d.uncertaintyNotes,
              needsClarification: d.needsClarification,
              ambiguities: d.ambiguities, mismatches: d.mismatches, debug: d.debug, rows: d.rows,
              reasoning: accumulatedThinking || undefined,
              queryLayer: d.queryLayer,
            };
            // Persist to server
            if (cid && cid > 0) {
              persistMessage(cid, assistantMsg).then((serverId) => {
                if (serverId) {
                  setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, serverId } : m));
                }
              });
            }
            setMessages((prev) => [...prev, assistantMsg]);
            if (d.warning && !d.blocked && d.sql && d.rows) {
              startRepair({ messageId: assistantId, question: q, originalSql: d.sql, originalRows: d.rows, warning: d.warning });
            }

          } else if (type === 'error') {
            setMessages((prev) => [...prev, {
              id: nextId.current++, role: 'assistant',
              text: (event.message as string) || 'Something went wrong. Please try again.',
              error: true,
            }]);
          }
        }

        if (done) break;
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
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, activeId, selectedSource]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

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
        {/* Sub-header: source selector + show SQL toggle */}
        <div className="flex-shrink-0 px-6 py-2.5 flex items-center justify-between border-b border-line bg-raised">
          <div className="flex items-center gap-3">
            {productContext ? (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-ai-soft border border-line rounded-md">
                <span className="text-[13px] font-medium text-ink">{productContext.name}</span>
                <span className="text-[10px] font-mono tracking-[0.08em] uppercase text-ai bg-raised px-1.5 py-0.5 rounded border border-line">Product</span>
                <button
                  onClick={() => setProductContext(null)}
                  className="text-muted-2 hover:text-ink-2 ml-1 transition-colors"
                  title="Switch to all sources"
                >
                  <X className="w-3.5 h-3.5" strokeWidth={2} />
                </button>
              </div>
            ) : sources.length > 1 ? (
              <SourceSelector sources={sources} selectedId={selectedSource} onChange={(id) => { setSelectedSource(id); localStorage.setItem('databridge_query_source', id); }} />
            ) : null}
          </div>
          <div className="flex items-center gap-4">
            {isAdmin && (
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
                if (activeId && activeId > 0) {
                  api.delete(`/conversations/${activeId}`).catch(() => {});
                  setConversations((prev) => prev.filter((c) => c.id !== activeId));
                }
                setActiveId(null); setMessages([]); setRepairState(null);
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
                isAdmin={isAdmin}
                useSourceLayer={useSourceLayer}
                setUseSourceLayer={setUseSourceLayer}
              />
            ) : (
              <div className="space-y-4">
                {messages.map((m) => (
                  <div key={m.id}>
                    <MessageBubble msg={m} showSql={showSql} isAdmin={isAdmin} onSend={send} onFeedback={handleFeedback} onExport={handleExport} conversationId={activeId} />
                    {repairState?.forMessageId === m.id && (
                      <div className="mt-3">
                        <ThinkingPanel repair={repairState} onClarify={handleClarify} />
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
                  />
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input (pinned at bottom during active conversation) */}
        {(messages.length > 0 || loading) && (
          <div className="flex-shrink-0 px-4 py-3 border-t border-line bg-raised">
            {/* Freshness banner */}
            {(() => {
              const validDates = freshnessDates.filter(Boolean) as string[];
              if (validDates.length === 0) return null;
              const mostRecent = new Date(Math.max(...validDates.map(d => new Date(d).getTime())));
              const status = getOverallFreshnessStatus(freshnessDates);
              if (status === 'fresh' || status === 'unknown') return null;
              return (
                <div className={`max-w-2xl mx-auto mb-2 text-center font-mono text-[10.5px] uppercase tracking-[0.08em] ${getFreshnessTextColor(status)}`}>
                  Data last refreshed {formatRelativeTime(mostRecent)}
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
            {isAdmin && (
              <div className="max-w-2xl mx-auto mt-2 flex items-center justify-end gap-2">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none text-[11px] font-mono uppercase tracking-[0.08em] text-muted-2 hover:text-ink-3 transition-colors">
                  <input
                    type="checkbox"
                    checked={useSourceLayer}
                    onChange={(e) => setUseSourceLayer(e.target.checked)}
                    className="w-3 h-3 rounded-sm border border-line accent-ocean"
                  />
                  Query source data
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function QueryPage() { return <Suspense><QueryPageInner /></Suspense>; }
