'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, Flag, Inbox, RefreshCw } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { formatRelative } from '@/lib/dates';

interface PendingItem {
  id: number;
  type: 'table' | 'column';
  name: string;
  description: string;
  status: string;
  updated_at: string;
}

function ReviewQueueInner() {
  const toast = useToast();
  const [items, setItems] = useState<PendingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'table' | 'column'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/semantic/pending-approvals');
      setItems((res.data.data ?? []) as PendingItem[]);
    } catch {
      toast.error('Could not load review queue');
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const confirm = async (item: PendingItem) => {
    const key = `${item.type}-${item.id}`;
    setActing(key);
    try {
      const path = item.type === 'table' ? `/semantic/tables/${item.id}` : `/semantic/columns/${item.id}`;
      await api.patch(path, { ai_draft: false, approval_status: 'approved' });
      setItems((prev) => prev.filter((i) => !(i.type === item.type && i.id === item.id)));
      toast.success('Confirmed');
    } catch {
      toast.error('Confirm failed');
    } finally { setActing(null); }
  };

  const flag = async (item: PendingItem) => {
    const key = `${item.type}-${item.id}`;
    setActing(key);
    try {
      const path = item.type === 'table' ? `/semantic/tables/${item.id}` : `/semantic/columns/${item.id}`;
      await api.patch(path, { approval_status: 'flagged' });
      setItems((prev) => prev.filter((i) => !(i.type === item.type && i.id === item.id)));
      toast.success('Flagged for review');
    } catch {
      toast.error('Flag failed');
    } finally { setActing(null); }
  };

  const filtered = filter === 'all' ? items : items.filter((i) => i.type === filter);
  const tableCount = items.filter((i) => i.type === 'table').length;
  const colCount = items.filter((i) => i.type === 'column').length;

  return (
    <AppShell>
      <>
        {/* Top bar */}
        <div className="bg-raised border-b border-line px-6 py-4 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Curate</p>
            <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em]">AI review queue</h1>
            <p className="text-[12px] text-muted mt-1 leading-relaxed">
              {items.length} item{items.length === 1 ? '' : 's'} awaiting confirmation · AI-suggested descriptions for tables and columns
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-ink-2 hover:bg-softer transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
            Refresh
          </button>
        </div>

        {/* Filter pills */}
        <div className="bg-raised border-b border-line px-6 flex items-center gap-0">
          {(['all', 'table', 'column'] as const).map((f) => {
            const count = f === 'all' ? items.length : f === 'table' ? tableCount : colCount;
            const active = filter === f;
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-3 text-[13px] transition-colors whitespace-nowrap relative ${
                  active ? 'text-ink font-medium' : 'text-muted hover:text-ink-2'
                }`}
              >
                {f === 'all' ? 'All' : f === 'table' ? 'Tables' : 'Columns'}
                <span className="ml-1.5 text-[11px] font-mono text-muted-2 tabular-nums">({count})</span>
                {active && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />}
              </button>
            );
          })}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-5 h-5 text-ocean animate-spin" strokeWidth={2} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-96 text-center px-6">
              <Inbox className="w-10 h-10 text-muted-2 mb-3" strokeWidth={1.5} />
              <p className="font-display text-[18px] text-ink tracking-[-0.01em]">All caught up</p>
              <p className="text-[13px] text-muted mt-1.5 max-w-md leading-relaxed">
                No AI-suggested definitions waiting for review. New suggestions appear here when sources are profiled.
              </p>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
              {filtered.map((item) => {
                const key = `${item.type}-${item.id}`;
                const isActing = acting === key;
                return (
                  <div
                    key={key}
                    className="bg-raised border border-line rounded-lg px-5 py-4 flex items-start gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-ocean bg-ocean-softer px-1.5 py-0.5 rounded">
                          ✦ AI suggested
                        </span>
                        <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 bg-softer px-1.5 py-0.5 rounded">
                          {item.type}
                        </span>
                        <span className="text-[11px] text-muted-2 font-mono">
                          {formatRelative(item.updated_at)}
                        </span>
                      </div>
                      <p className="font-mono text-[12px] text-ink-2 mb-1.5 truncate">{item.name}</p>
                      <p className="text-[13px] text-ink leading-relaxed">
                        {item.description || <span className="italic text-muted">No description</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => confirm(item)}
                        disabled={isActing}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-ok-soft text-ok hover:bg-ok hover:text-white transition-colors disabled:opacity-50"
                        title="Confirm AI suggestion"
                      >
                        {isActing ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} /> : <Check className="w-3 h-3" strokeWidth={2.5} />}
                        Confirm
                      </button>
                      <button
                        onClick={() => flag(item)}
                        disabled={isActing}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium bg-warn-soft text-warn hover:bg-warn hover:text-white transition-colors disabled:opacity-50"
                        title="Flag for issue"
                      >
                        <Flag className="w-3 h-3" strokeWidth={2} />
                        Flag
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>
    </AppShell>
  );
}

export default function ReviewPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <ReviewQueueInner />
    </RequireRole>
  );
}
