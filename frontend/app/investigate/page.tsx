'use client';

/**
 * /investigate — standalone page for ad-hoc investigations.
 *
 * Pick a data product, type a question ("why did X drop last month?"),
 * watch Clarion run the agent loop. Re-uses the InvestigationPanel
 * for the actual rendering — same component is used as a slide-over
 * from the morning brief; here it lives in the main column.
 *
 * Recent investigations list at the bottom — tap any to replay it
 * without re-running.
 */

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Search, ArrowRight, Loader2, Sparkles } from 'lucide-react';
import api from '@/lib/api';
import { formatRelative } from '@/lib/dates';
import AppShell from '@/components/layout/AppShell';

const InvestigationPanel = dynamic(
  () => import('@/components/investigate/InvestigationPanel'),
  { ssr: false },
);

interface DataProduct {
  id: number;
  name: string;
}

interface RecentInvestigation {
  id: number;
  question: string;
  focus: string | null;
  status: 'running' | 'concluded' | 'failed' | 'cancelled';
  conclusion: string | null;
  conclusion_confidence: 'high' | 'medium' | 'low' | null;
  created_at: string;
  product_name: string | null;
}

export default function InvestigatePage() {
  const [products, setProducts] = useState<DataProduct[]>([]);
  const [productId, setProductId] = useState<number | null>(null);
  const [question, setQuestion] = useState('');
  const [recent, setRecent] = useState<RecentInvestigation[]>([]);
  // Active investigation — either a fresh run (open=true with question)
  // or a replay of an existing one (open=true with existingId).
  const [active, setActive] = useState<
    | { kind: 'new'; question: string; productId: number }
    | { kind: 'replay'; id: number }
    | null
  >(null);

  const loadProducts = useCallback(async () => {
    try {
      const res = await api.get('/products');
      const list = (res.data.data ?? []) as DataProduct[];
      setProducts(list);
      if (list.length && productId == null) setProductId(list[0].id);
    } catch { /* ignore */ }
  }, [productId]);

  const loadRecent = useCallback(async () => {
    try {
      const res = await api.get('/investigations?limit=15');
      setRecent(res.data.data ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadProducts(); loadRecent(); }, [loadProducts, loadRecent]);

  const start = useCallback(() => {
    if (!question.trim() || !productId) return;
    setActive({ kind: 'new', question: question.trim(), productId });
  }, [question, productId]);

  return (
    <AppShell>
      <div className="max-w-3xl mx-auto px-6 py-10">
        <header className="mb-8">
          <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-ocean">
            Investigate
          </span>
          <h1 className="font-display text-[36px] font-medium tracking-[-0.02em] mt-1 mb-2">
            Ask <em className="italic text-ink-2">why.</em>
          </h1>
          <p className="text-[14px] text-muted leading-relaxed max-w-[560px]">
            Type a question about your data. Clarion runs a few diagnostic queries
            in sequence and writes a conclusion in plain English. Best for "why did X
            change" or "what's driving Y."
          </p>
        </header>

        {/* Composer */}
        <section className="bg-raised border border-line rounded-md overflow-hidden mb-10">
          <div className="px-5 py-4 border-b border-line">
            <label className="block">
              <span className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 mb-2 block">
                Question
              </span>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); start(); }
                }}
                rows={2}
                placeholder='e.g. "Why did gross margin drop last month?"'
                className="w-full px-3 py-2 text-[14px] bg-bg border border-line rounded resize-y focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
              />
            </label>
          </div>

          <div className="px-5 py-3.5 flex items-center gap-3">
            <select
              value={productId ?? ''}
              onChange={(e) => setProductId(Number(e.target.value) || null)}
              className="flex-1 px-3 py-1.5 text-[12.5px] bg-bg border border-line rounded focus:outline-none focus:border-ocean"
            >
              {products.length === 0 && <option value="">No products yet</option>}
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={start}
              disabled={!question.trim() || !productId}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium bg-ocean text-on-ocean rounded hover:bg-ocean-dark disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Search className="w-3.5 h-3.5" strokeWidth={2} />
              Investigate
              <span className="text-[10px] font-mono opacity-60 ml-1">⌘⏎</span>
            </button>
          </div>
        </section>

        {/* Recent */}
        <section>
          <div className="text-[10.5px] font-mono uppercase tracking-[0.14em] text-muted-2 mb-3">
            Recent investigations
          </div>
          {recent.length === 0 ? (
            <div className="text-[12.5px] text-muted py-6">
              Nothing yet — your first investigation will appear here.
            </div>
          ) : (
            <ul className="space-y-2">
              {recent.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setActive({ kind: 'replay', id: r.id })}
                    className="w-full text-left p-3 rounded-md border border-line bg-raised hover:bg-soft transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex-shrink-0 mt-0.5 w-6 h-6 rounded-full bg-ocean/10 flex items-center justify-center">
                        <Sparkles className="w-3 h-3 text-ocean" strokeWidth={1.75} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-medium text-ink leading-snug">{r.question}</div>
                        {r.conclusion && (
                          <p className="text-[12px] text-muted leading-relaxed mt-1 line-clamp-2">
                            {r.conclusion}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5 text-[10.5px] font-mono uppercase tracking-[0.1em] text-muted-2">
                          <span>{r.status}</span>
                          {r.product_name && <><span>·</span><span>{r.product_name}</span></>}
                          <span>·</span>
                          <span>{formatRelative(new Date(r.created_at))}</span>
                        </div>
                      </div>
                      <ArrowRight className="w-3.5 h-3.5 mt-1 text-muted-2" strokeWidth={1.75} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Active investigation */}
        {active && (
          <InvestigationPanel
            open={true}
            onClose={() => { setActive(null); loadRecent(); }}
            {...(active.kind === 'new'
              ? { question: active.question, dataProductId: active.productId }
              : { existingId: active.id })}
          />
        )}
      </div>
    </AppShell>
  );
}
