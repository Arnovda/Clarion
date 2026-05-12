'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star,
  Plug, Inbox, Users, Shield, Library, Package, Workflow, Search,
  Home as HomeIcon, DollarSign, ChevronLeft,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';
import api from '@/lib/api';

type Role = 'admin' | 'analyst' | 'viewer';
type Group = 'home' | 'discover' | 'analyze' | 'build' | 'curate' | 'settings';

const ICON_CLASS = 'w-[14px] h-[14px] shrink-0';

const ICONS = {
  home:    <HomeIcon      className={ICON_CLASS} strokeWidth={1.5} />,
  chat:    <MessageSquare className={ICON_CLASS} strokeWidth={1.5} />,
  grid:    <LayoutGrid    className={ICON_CLASS} strokeWidth={1.5} />,
  code:    <Code2         className={ICON_CLASS} strokeWidth={1.5} />,
  book:    <BookOpen      className={ICON_CLASS} strokeWidth={1.5} />,
  star:    <Star          className={ICON_CLASS} strokeWidth={1.5} />,
  library: <Library       className={ICON_CLASS} strokeWidth={1.5} />,
  plug:    <Plug          className={ICON_CLASS} strokeWidth={1.5} />,
  inbox:   <Inbox         className={ICON_CLASS} strokeWidth={1.5} />,
  users:   <Users         className={ICON_CLASS} strokeWidth={1.5} />,
  shield:  <Shield        className={ICON_CLASS} strokeWidth={1.5} />,
  package: <Package        className={ICON_CLASS} strokeWidth={1.5} />,
  workflow: <Workflow      className={ICON_CLASS} strokeWidth={1.5} />,
  search:   <Search         className={ICON_CLASS} strokeWidth={1.5} />,
  dollar:   <DollarSign     className={ICON_CLASS} strokeWidth={1.5} />,
};

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: React.ReactNode;
  roles: Role[];
  group: Group;
  badgeKey?: 'review' | 'sources';
}

const NAV_ITEMS: NavItem[] = [
  { key: 'home',       href: '/home',       label: 'Home',            icon: ICONS.home,    roles: ['admin', 'analyst', 'viewer'],  group: 'home' },
  { key: 'catalog',    href: '/catalog',    label: 'Catalog',         icon: ICONS.book,    roles: ['admin', 'analyst', 'viewer'],  group: 'discover' },
  { key: 'glossary',   href: '/glossary',   label: 'Glossary',        icon: ICONS.library, roles: ['admin', 'analyst', 'viewer'],  group: 'discover' },
  { key: 'ask',        href: '/query',      label: 'Ask AI',          icon: ICONS.chat,    roles: ['admin', 'analyst', 'viewer'],  group: 'analyze' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',      icon: ICONS.grid,    roles: ['admin', 'analyst', 'viewer'],  group: 'analyze' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',       icon: ICONS.code,    roles: ['admin', 'analyst'],            group: 'analyze' },
  { key: 'products',   href: '/products',   label: 'Build',           icon: ICONS.package, roles: ['admin', 'analyst'],            group: 'build' },
  { key: 'pipelines',  href: '/pipelines',  label: 'Refresh',         icon: ICONS.workflow,roles: ['admin', 'analyst'],            group: 'build' },
  { key: 'sources',    href: '/sources',    label: 'Sources',         icon: ICONS.plug,    roles: ['admin', 'analyst'],            group: 'curate', badgeKey: 'sources' },
  { key: 'review',     href: '/review',     label: 'AI review queue', icon: ICONS.inbox,   roles: ['admin', 'analyst'],            group: 'curate', badgeKey: 'review' },
  { key: 'team',       href: '/users',      label: 'Team & roles',    icon: ICONS.users,   roles: ['admin'],                       group: 'settings' },
  { key: 'policies',   href: '/policies',   label: 'Policies',        icon: ICONS.shield,  roles: ['admin'],                       group: 'settings' },
  { key: 'ai-usage',   href: '/admin/ai-usage', label: 'AI usage',     icon: ICONS.dollar,  roles: ['admin'],                       group: 'settings' },
];

const ROUTE_ALIASES: Record<string, string[]> = {
  '/home':       ['/home'],
  '/query':      ['/query', '/ask'],
  '/dashboards': ['/dashboards'],
  '/notebooks':  ['/notebooks'],
  '/catalog':    ['/catalog', '/semantic'],
  '/products':   ['/products'],
  '/pipelines':  ['/pipelines'],
  '/glossary':   ['/glossary'],
  '/sources':    ['/sources', '/setup'],
  '/review':     ['/review', '/gaps', '/suggestions'],
  '/users':      ['/users'],
  '/policies':   ['/policies'],
};

const GROUP_LABELS: Record<Group, string> = {
  home:     '',
  discover: 'Discover',
  analyze:  'Analyze',
  build:    'Build',
  curate:   'Curate',
  settings: 'Settings',
};

const GROUP_ORDER: Group[] = ['home', 'discover', 'analyze', 'build', 'curate', 'settings'];

// ─── Sizing constants ─────────────────────────────────────────────────────
// Width range for the resize handle. Below MIN we'd start clipping labels;
// above MAX the rail starts to feel like a sidebar instead of a nav.
const NAV_DEFAULT_WIDTH   = 220;
const NAV_MIN_WIDTH       = 180;
const NAV_MAX_WIDTH       = 360;
const NAV_COLLAPSED_WIDTH = 56;
const STORAGE_KEY         = 'clarion:navRail';

interface PersistedState {
  width: number;
  collapsed: boolean;
}

export default function IconRail() {
  const pathname = usePathname();
  const [payload, setPayload] = useState<TokenPayload | null>(null);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [sourcesCount, setSourcesCount] = useState<number>(0);

  // Width + collapsed state — hydrated from localStorage on first effect
  // so the SSR render stays deterministic (avoids hydration warnings).
  const [width, setWidth] = useState<number>(NAV_DEFAULT_WIDTH);
  const [collapsed, setCollapsed] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    setPayload(getTokenPayload());
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        if (typeof parsed.width === 'number' && parsed.width >= NAV_MIN_WIDTH && parsed.width <= NAV_MAX_WIDTH) {
          setWidth(parsed.width);
        }
        if (typeof parsed.collapsed === 'boolean') {
          setCollapsed(parsed.collapsed);
        }
      }
    } catch { /* ignore — fall back to defaults */ }
    setHydrated(true);
  }, []);

  // Persist on change (but skip until after hydration so we don't immediately
  // overwrite the stored value with a default-state snapshot).
  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, collapsed } satisfies PersistedState));
    } catch { /* ignore */ }
  }, [width, collapsed, hydrated]);

  // Badge counts for analyst+
  useEffect(() => {
    const role = payload?.role;
    if (role !== 'admin' && role !== 'analyst') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/semantic/pending-approvals');
        if (!cancelled) setReviewCount((res.data.data ?? []).length);
      } catch { /* noop */ }
      try {
        const res = await api.get('/connections');
        const conns = (res.data.data ?? []) as Array<{ profiling_status?: string | null }>;
        const pending = conns.filter((c) => !c.profiling_status || c.profiling_status === 'pending' || c.profiling_status === 'failed').length;
        if (!cancelled) setSourcesCount(pending);
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [payload?.role]);

  const role: Role = payload?.role ?? 'viewer';
  const visible = NAV_ITEMS.filter((i) => i.roles.includes(role));

  function isActive(href: string) {
    const aliases = ROUTE_ALIASES[href] ?? [href];
    return aliases.some((a) => pathname === a || pathname.startsWith(a + '/'));
  }

  function badgeFor(item: NavItem): number {
    if (item.badgeKey === 'review') return reviewCount;
    if (item.badgeKey === 'sources') return sourcesCount;
    return 0;
  }

  // ─── Drag-to-resize handle ─────────────────────────────────────────────
  // While the user drags we attach window-level listeners so the gesture
  // continues even when the cursor leaves the handle. body cursor + select
  // overrides give visual + interaction feedback during the drag.
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startResize = (e: React.MouseEvent) => {
    if (collapsed) return;
    e.preventDefault();
    dragStateRef.current = { startX: e.clientX, startWidth: width };
    const onMove = (ev: MouseEvent) => {
      const s = dragStateRef.current;
      if (!s) return;
      const next = Math.min(NAV_MAX_WIDTH, Math.max(NAV_MIN_WIDTH, s.startWidth + ev.clientX - s.startX));
      setWidth(next);
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const effectiveWidth = collapsed ? NAV_COLLAPSED_WIDTH : width;

  return (
    <div
      className="relative h-full shrink-0 transition-[width] duration-150 ease-out"
      style={{ width: effectiveWidth }}
    >
      <aside
        aria-label="Primary navigation"
        className={cn(
          'h-full w-full flex flex-col overflow-hidden',
          // Ocean-blue chrome — same brand colour the rest of the app uses
          // for primary actions and active states. Sets a clear visual
          // anchor for the navigation surface.
          'bg-[var(--ocean)]',
          // A slightly darker right edge so the rail visually separates
          // from the main content without a hard line.
          'border-r border-[var(--ocean-hover)]/70',
        )}
      >
        <nav className="flex-1 flex flex-col gap-0.5 px-2 py-3.5 overflow-y-auto scrollbar-thin">
          {GROUP_ORDER.map((g) => {
            const items = visible.filter((i) => i.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g} className="contents">
                {/* Group eyebrow — hidden when collapsed; replaced with a
                    subtle horizontal divider so the visual grouping still
                    reads even without the label. */}
                {GROUP_LABELS[g] && (
                  collapsed ? (
                    <div className="mx-3 my-2 border-t border-white/10" aria-hidden />
                  ) : (
                    <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/55 px-2.5 pt-3 pb-1.5 font-medium">
                      {GROUP_LABELS[g]}
                    </div>
                  )
                )}
                {items.map((it) => {
                  const active = isActive(it.href);
                  const badge = badgeFor(it);
                  return (
                    <Link
                      key={it.key}
                      href={it.href}
                      // The native title is the accessibility + power-user
                      // hover hint for the collapsed mode. Cheap, works
                      // without a tooltip component, screen-reader friendly.
                      title={collapsed ? `${it.label}${badge > 0 ? ` · ${badge}` : ''}` : undefined}
                      className={cn(
                        'group flex items-center rounded-sm text-[13.5px]',
                        'transition-colors duration-1 ease-observatory',
                        'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_rgba(255,255,255,0.25)]',
                        collapsed
                          ? 'justify-center px-2 py-2'
                          : 'gap-2.5 px-2.5 py-2',
                        active
                          // Active: brighter overlay + crisp white text — the
                          // route the user is on gets the loudest voice in
                          // the rail.
                          ? 'bg-white/15 text-white font-medium'
                          // Inactive: ocean-soft for text (the natural light
                          // tint of the brand) with a gentle hover overlay.
                          : 'text-[var(--ocean-soft)] hover:bg-white/10 hover:text-white',
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className={cn(
                        active ? 'text-white' : 'text-[var(--ocean-soft)] group-hover:text-white',
                      )}>
                        {it.icon}
                      </span>
                      {!collapsed && (
                        <>
                          <span className="truncate flex-1">{it.label}</span>
                          {badge > 0 && (
                            <span className={cn(
                              'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-medium tabular-nums',
                              // Active row: white pill, ocean text — high
                              // contrast against the active overlay.
                              // Inactive: dark-tinted pill that pops out of
                              // the inactive text without competing with
                              // the active state.
                              active
                                ? 'bg-white text-[var(--ocean)]'
                                : 'bg-[var(--ocean-hover)] text-white',
                            )}>
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                        </>
                      )}
                      {/* Collapsed-mode badge — small dot in the top-right
                          corner of the icon tile so the user still sees
                          "something's waiting" without the count. */}
                      {collapsed && badge > 0 && (
                        <span
                          className="absolute mt-[-12px] ml-[14px] w-[8px] h-[8px] rounded-full bg-white border border-[var(--ocean)]"
                          aria-label={`${badge} pending`}
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Collapse toggle pinned to the bottom. Borders use a faint white
            overlay so they harmonise with the ocean chrome rather than
            cutting it with a hard line. */}
        <div className="px-2 py-2 border-t border-white/10">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              'w-full flex items-center rounded-sm py-1.5 text-[12px]',
              'text-[var(--ocean-soft)] hover:text-white hover:bg-white/10 transition-colors',
              collapsed ? 'justify-center px-2' : 'gap-2 px-2.5',
            )}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            <ChevronLeft
              className={cn('w-4 h-4 transition-transform duration-150', collapsed && 'rotate-180')}
              strokeWidth={1.75}
            />
            {!collapsed && (
              <span className="font-mono uppercase tracking-[0.1em] text-[10.5px]">
                Collapse
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Drag handle — sits on the right edge, slim by default, lights up
          on hover/drag. Hidden when collapsed because resizing only makes
          sense in expanded mode. */}
      {!collapsed && (
        <div
          onMouseDown={startResize}
          className={cn(
            'absolute top-0 right-0 h-full w-1.5 -mr-[2px] cursor-col-resize',
            'transition-colors duration-150',
            'hover:bg-white/30 active:bg-white/40',
          )}
          title="Drag to resize"
          aria-hidden
        />
      )}
    </div>
  );
}
