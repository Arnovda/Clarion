'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { getTokenPayload } from '@/lib/auth';
import { useT } from '@/lib/i18n';
import type { Dictionary } from '@/lib/i18n/en';

type Role = 'admin' | 'analyst' | 'viewer';

/* ── Types ─────────────────────────────────────────────────────────── */

interface SearchResult {
  type: 'table' | 'column' | 'kpi' | 'dashboard' | 'product' | 'action';
  id: number | string;
  title: string;
  subtitle?: string;
  href?: string;
  icon: IconKey;
}

type IconKey = 'chat' | 'grid' | 'plug' | 'book' | 'star' | 'users' | 'stack' | 'columns' | 'chart' | 'bolt';

/* ── Icons (14px, stroke 1.5) ──────────────────────────────────────── */

import {
  MessageSquare, LayoutGrid, Plug, BookOpen, Star, Users, Layers,
  Columns3, BarChart3, Zap, Search,
} from 'lucide-react';

const ICON_CLASS = 'w-[14px] h-[14px]';

const PALETTE_ICONS: Record<IconKey, React.ReactNode> = {
  chat:    <MessageSquare className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  grid:    <LayoutGrid    className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  plug:    <Plug          className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  book:    <BookOpen      className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  star:    <Star          className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  users:   <Users         className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  stack:   <Layers        className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  columns: <Columns3      className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  chart:   <BarChart3     className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
  bolt:    <Zap           className={ICON_CLASS} strokeWidth={1.5} aria-hidden="true" />,
};

/* ── Static actions (role-aware) ───────────────────────────────────── */
// Business-first ordering: the things everyone does come first; builder/admin
// actions are role-gated so a viewer never sees "Connect a source" or "Team".

// Titles/subtitles live in the i18n dictionary (t.palette.actions), looked up
// by this id at render — the config here stays translation-free (P2-1). The
// trailing comments record the English titles for grep-ability.
interface ActionDef {
  id: keyof Dictionary['palette']['actions'];
  icon: IconKey;
  href: string;
  roles: Role[];
}

const ALL: ['admin', 'analyst', 'viewer'] = ['admin', 'analyst', 'viewer'];

const ACTIONS_ALL: ActionDef[] = [
  { id: 'ask',        icon: 'chat',  href: '/query',      roles: ALL },                  // Ask a question
  { id: 'dashboard',  icon: 'grid',  href: '/dashboards', roles: ALL },                  // Create a dashboard
  { id: 'subjects',   icon: 'grid',  href: '/subjects',   roles: ALL },                  // Subjects
  { id: 'catalog',    icon: 'book',  href: '/catalog',    roles: ALL },                  // Browse the catalog
  { id: 'glossary',   icon: 'book',  href: '/glossary',   roles: ALL },                  // Business glossary
  { id: 'connect',    icon: 'plug',  href: '/sources',    roles: ['admin', 'analyst'] }, // Connect a source
  { id: 'shared',     icon: 'book',  href: '/shared-data', roles: ['admin', 'analyst'] }, // Shared data
  { id: 'grids',      icon: 'columns', href: '/grids',    roles: ['admin', 'analyst'] }, // Your tables
  // The topic rows in the rail replaced this as the way IN to a subject area;
  // the workshop is still where a NEW topic gets built, so it keeps a door here.
  { id: 'products',   icon: 'star',  href: '/products',   roles: ['admin', 'analyst'] }, // Build workshop
  { id: 'suggestions', icon: 'bolt', href: '/review',     roles: ['admin', 'analyst'] }, // Suggestions
  { id: 'team',       icon: 'users', href: '/users',      roles: ['admin'] },            // Team & roles
];

function iconForType(type: SearchResult['type']): IconKey {
  switch (type) {
    case 'table':     return 'stack';
    case 'column':    return 'columns';
    case 'kpi':       return 'chart';
    case 'dashboard': return 'grid';
    case 'product':   return 'star';
    case 'action':    return 'bolt';
  }
}

/* ── Component ─────────────────────────────────────────────────────── */

export default function CommandPalette() {
  const router = useRouter();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [role, setRole] = useState<Role>('viewer');
  useEffect(() => { setRole(getTokenPayload()?.role ?? 'viewer'); }, []);
  // Role-filtered actions — viewers never see builder/admin commands. The
  // display text resolves from the dictionary HERE so the query filter
  // below matches what the user actually reads, in their language.
  const actions = useMemo<SearchResult[]>(
    () => ACTIONS_ALL
      .filter((a) => a.roles.includes(role))
      .map((a) => ({
        type: 'action' as const,
        id: a.id,
        title: t.palette.actions[a.id].title,
        subtitle: t.palette.actions[a.id].subtitle,
        icon: a.icon,
        href: a.href,
      })),
    [role, t],
  );

  // Cmd+K / Ctrl+K toggle (unchanged keybinds)
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

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults(actions);
      setLoading(false);
      return;
    }

    setLoading(true);
    const lower = q.toLowerCase();
    const actionMatches = actions.filter(
      (a) => a.title.toLowerCase().includes(lower) || (a.subtitle ?? '').toLowerCase().includes(lower),
    );

    try {
      const res = await api.get(`/semantic/search?q=${encodeURIComponent(q)}&limit=8`);
      const items: SearchResult[] = (res.data.data ?? []).map((item: { type: string; id: number; name: string; parent?: string; connectionName?: string }) => {
        // `rt`, not `t` — the dictionary is `t` in this component's scope.
        const rt = item.type as SearchResult['type'];
        return {
          type: rt,
          id: item.id,
          title: item.name,
          subtitle: item.parent ?? item.connectionName ?? '',
          icon: iconForType(rt),
          href: rt === 'dashboard' ? `/dashboards?id=${item.id}` : '/catalog',
        };
      });
      setResults([...items, ...actionMatches].slice(0, 10));
    } catch {
      setResults(actionMatches);
    }
    setLoading(false);
  }, [actions]);

  useEffect(() => {
    if (!open) return;
    clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults(actions);
      return;
    }
    debounceRef.current = setTimeout(() => search(query), 200);
    return () => clearTimeout(debounceRef.current);
  }, [query, open, search, actions]);

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
      router.push('/catalog');
    }
  }

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]"
        onMouseDown={() => setOpen(false)}
      />
      <div className="fixed inset-x-0 top-[15%] z-50 mx-auto w-full max-w-[560px] px-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t.palette.ariaLabel}
          className="bg-raised rounded-lg shadow-3 border border-line overflow-hidden"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Input */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-softer">
            <Search className={`${ICON_CLASS} text-muted-2 shrink-0`} strokeWidth={1.5} aria-hidden="true" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedIdx(0); }}
              onKeyDown={onKeyDown}
              placeholder={t.palette.placeholder}
              className="flex-1 bg-transparent text-[14px] text-ink placeholder:text-muted-2 focus:outline-none font-sans"
            />
            <kbd className="hidden sm:inline-block font-mono text-[10px] tracking-[0.04em] text-muted-2 uppercase">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[360px] overflow-y-auto py-1.5">
            {loading && (
              <div className="px-5 py-4 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 text-center">
                {t.palette.searching}
              </div>
            )}

            {!loading && results.length === 0 && query.trim() && (
              <div className="px-5 py-8 text-center">
                <div className="font-display text-[18px] text-ink tracking-[-0.01em]">{t.palette.noResults}</div>
                <button
                  type="button"
                  onClick={() => { setOpen(false); router.push(`/query?q=${encodeURIComponent(query)}`); }}
                  className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors duration-1"
                >
                  {t.palette.askAiInstead}
                </button>
              </div>
            )}

            {!loading && results.map((r, i) => (
              <button
                key={`${r.type}-${r.id}`}
                type="button"
                onClick={() => selectResult(r)}
                onMouseEnter={() => setSelectedIdx(i)}
                className={cn(
                  'w-full flex items-center gap-3 px-5 py-2 text-left transition-colors duration-1 ease-observatory',
                  i === selectedIdx ? 'bg-softer' : 'hover:bg-softer'
                )}
              >
                <span className="w-6 text-muted shrink-0 flex items-center justify-center">
                  {PALETTE_ICONS[r.icon]}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block font-sans font-medium text-[13.5px] text-ink truncate">{r.title}</span>
                  {r.subtitle && (
                    <span className="block text-[12px] text-muted truncate">{r.subtitle}</span>
                  )}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-muted-2 bg-softer px-1.5 py-0.5 rounded shrink-0">
                  {t.palette.types[r.type]}
                </span>
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="px-5 py-2.5 border-t border-softer flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-2">
            <span className="flex items-center gap-1.5"><kbd className="text-ink-3 bg-softer px-1 rounded normal-case tracking-normal">↑↓</kbd> {t.palette.navigate}</span>
            <span className="flex items-center gap-1.5"><kbd className="text-ink-3 bg-softer px-1 rounded normal-case tracking-normal">↵</kbd> {t.palette.select}</span>
            <span className="flex items-center gap-1.5"><kbd className="text-ink-3 bg-softer px-1 rounded normal-case tracking-normal">esc</kbd> {t.palette.close}</span>
          </div>
        </div>
      </div>
    </>
  );
}
