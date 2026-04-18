'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  type: 'table' | 'column' | 'kpi' | 'dashboard' | 'product' | 'action';
  id: number | string;
  title: string;
  subtitle?: string;
  href?: string;
  icon: string; // emoji shorthand
}

// ─── Static actions ───────────────────────────────────────────────────────────

const ACTIONS: SearchResult[] = [
  { type: 'action', id: 'ask',        title: 'Ask a question',       subtitle: 'Query your data with AI', icon: '💬', href: '/query' },
  { type: 'action', id: 'dashboard',  title: 'Create dashboard',     subtitle: 'Build a new AI dashboard', icon: '📊', href: '/dashboards' },
  { type: 'action', id: 'connect',    title: 'Connect a source',     subtitle: 'Add a new database',       icon: '🔌', href: '/setup' },
  { type: 'action', id: 'dictionary', title: 'Data Dictionary',      subtitle: 'Browse definitions',       icon: '📖', href: '/semantic' },
  { type: 'action', id: 'products',   title: 'Organized Data',       subtitle: 'Data models & processing', icon: '⭐', href: '/products' },
  { type: 'action', id: 'team',       title: 'Team management',      subtitle: 'Users & invites',          icon: '👥', href: '/users' },
];

// ─── Component ────────────────────────────────────────────────────────────────

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Cmd+K / Ctrl+K toggle ─────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // ── Search logic ──────────────────────────────────────────────────────────
  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(ACTIONS);
      setLoading(false);
      return;
    }

    setLoading(true);
    const lower = q.toLowerCase();

    // Filter static actions
    const actionMatches = ACTIONS.filter(
      (a) => a.title.toLowerCase().includes(lower) || (a.subtitle ?? '').toLowerCase().includes(lower),
    );

    try {
      // Search backend for tables, columns, KPIs, dashboards
      const res = await api.get(`/semantic/search?q=${encodeURIComponent(q)}&limit=8`);
      const items: SearchResult[] = (res.data.data ?? []).map((item: { type: string; id: number; name: string; parent?: string; connectionName?: string }) => ({
        type: item.type as SearchResult['type'],
        id: item.id,
        title: item.name,
        subtitle: item.parent ?? item.connectionName ?? '',
        icon: item.type === 'table' ? '🗂️' : item.type === 'column' ? '📋' : item.type === 'kpi' ? '📈' : item.type === 'dashboard' ? '📊' : item.type === 'product' ? '⭐' : '🔍',
        href: item.type === 'dashboard' ? `/dashboards?id=${item.id}` : item.type === 'kpi' ? '/semantic' : '/semantic',
      }));

      setResults([...items, ...actionMatches].slice(0, 10));
    } catch {
      // Fallback to action-only results if search endpoint doesn't exist yet
      setResults(actionMatches);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(ACTIONS);
      return;
    }
    debounceRef.current = setTimeout(() => search(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, search]);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[selectedIdx]) {
      e.preventDefault();
      selectResult(results[selectedIdx]);
    }
  }

  function selectResult(r: SearchResult) {
    setOpen(false);
    if (r.href) {
      router.push(r.href);
    } else if (r.type === 'table' || r.type === 'column') {
      router.push('/semantic');
    }
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />

      {/* Palette */}
      <div className="fixed inset-x-0 top-[15%] z-50 mx-auto w-full max-w-lg">
        <div className="bg-surface-container-lowest rounded-2xl shadow-2xl overflow-hidden border border-outline-variant/15">
          {/* Search input */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-outline-variant/10">
            <svg className="w-5 h-5 text-on-surface-variant/50 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search tables, columns, dashboards, or type a command..."
              className="flex-1 bg-transparent text-body-md text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none"
            />
            <kbd className="hidden sm:inline-block text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant/50 font-mono">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[360px] overflow-y-auto py-2">
            {loading && (
              <div className="px-5 py-4 text-body-sm text-on-surface-variant/50 text-center">Searching...</div>
            )}

            {!loading && results.length === 0 && query.trim() && (
              <div className="px-5 py-8 text-center">
                <p className="text-body-sm text-on-surface-variant/50">No results found</p>
                <button
                  onClick={() => { setOpen(false); router.push(`/query?q=${encodeURIComponent(query)}`); }}
                  className="mt-2 text-label-lg text-secondary hover:text-primary transition-colors"
                >
                  Ask AI instead →
                </button>
              </div>
            )}

            {!loading && results.map((r, i) => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => selectResult(r)}
                onMouseEnter={() => setSelectedIdx(i)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors ${
                  i === selectedIdx ? 'bg-surface-container-low' : 'hover:bg-surface-container-low/50'
                }`}
              >
                <span className="text-lg flex-shrink-0 w-7 text-center">{r.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-body-sm font-medium text-on-surface truncate">{r.title}</div>
                  {r.subtitle && (
                    <div className="text-label-sm text-on-surface-variant/60 truncate">{r.subtitle}</div>
                  )}
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant/40 flex-shrink-0 capitalize">
                  {r.type}
                </span>
              </button>
            ))}
          </div>

          {/* Footer hint */}
          <div className="px-5 py-2 border-t border-outline-variant/10 flex items-center gap-4 text-[10px] text-on-surface-variant/40">
            <span><kbd className="font-mono bg-surface-container px-1 rounded">↑↓</kbd> navigate</span>
            <span><kbd className="font-mono bg-surface-container px-1 rounded">↵</kbd> select</span>
            <span><kbd className="font-mono bg-surface-container px-1 rounded">esc</kbd> close</span>
          </div>
        </div>
      </div>
    </>
  );
}
