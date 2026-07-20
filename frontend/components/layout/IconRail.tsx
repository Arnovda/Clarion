'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star,
  Plug, Inbox, Users, Shield, Library, Package, Workflow, Search,
  Home as HomeIcon, DollarSign, ChevronLeft, ChevronDown,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';
import api from '@/lib/api';
import { getItem, setItem, storageKeys } from '@/lib/storage';

type Role = 'admin' | 'analyst' | 'viewer';
// IA model (2026-06 redesign): the rail is business-first.
//   • workspace — the calm default surface every business data-owner lives in
//     (no eyebrow; it IS the app). Ask / see / understand your data.
//   • studio    — builder + technical tools (sources, modelling, refresh,
//     review, notebooks), visually demoted under a "Studio" header so they're
//     out of the business owner's way. analyst+ only.
//   • settings  — admin-only org config.
// Every existing route is preserved — this is a regrouping, not a removal.
type Group = 'workspace' | 'studio' | 'settings';

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
  // ── Workspace — the business data-owner's default surface ───────────────
  { key: 'home',       href: '/home',       label: 'Home',            icon: ICONS.home,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  { key: 'ask',        href: '/query',      label: 'Ask AI',          icon: ICONS.chat,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',      icon: ICONS.grid,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  // Catalog is the single "understand your data" surface. Glossary + Trust are
  // facets inside it (see /catalog), not separate destinations.
  { key: 'catalog',    href: '/catalog',    label: 'Catalog',         icon: ICONS.book,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  // ── Studio — builder + technical tools (analyst+), demoted out of the way ─
  { key: 'sources',    href: '/sources',    label: 'Sources',         icon: ICONS.plug,    roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'sources' },
  { key: 'products',   href: '/products',   label: 'Data products',   icon: ICONS.package, roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'pipelines',  href: '/pipelines',  label: 'Refresh',         icon: ICONS.workflow,roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'review',     href: '/review',     label: 'Suggestions',     icon: ICONS.inbox,   roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'review' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',       icon: ICONS.code,    roles: ['admin', 'analyst'],            group: 'studio' },
  // ── Settings — admin-only org config ────────────────────────────────────
  { key: 'team',       href: '/users',      label: 'Team & roles',    icon: ICONS.users,   roles: ['admin'],                       group: 'settings' },
  { key: 'policies',   href: '/policies',   label: 'Policies',        icon: ICONS.shield,  roles: ['admin'],                       group: 'settings' },
  { key: 'ai-usage',   href: '/admin/ai-usage', label: 'AI usage',     icon: ICONS.dollar,  roles: ['admin'],                       group: 'settings' },
];

const ROUTE_ALIASES: Record<string, string[]> = {
  '/home':       ['/home'],
  '/query':      ['/query', '/ask'],
  '/dashboards': ['/dashboards'],
  '/notebooks':  ['/notebooks'],
  // /glossary + /health are facets of Catalog now — keep them highlighting
  // the Catalog rail item so deep links don't orphan the active state.
  '/catalog':    ['/catalog', '/semantic', '/glossary', '/health'],
  '/products':   ['/products'],
  '/pipelines':  ['/pipelines'],
  '/sources':    ['/sources', '/setup'],
  '/review':     ['/review', '/gaps', '/suggestions'],
  '/users':      ['/users'],
  '/policies':   ['/policies'],
};

const GROUP_LABELS: Record<Group, string> = {
  // No eyebrow on the workspace group — it's the unlabelled default surface,
  // which keeps the top of the rail calm. Studio + Settings are labelled so
  // the builder/admin tools read as a clearly separate, secondary area.
  workspace: '',
  studio:    'Studio',
  settings:  'Settings',
};

const GROUP_ORDER: Group[] = ['workspace', 'studio', 'settings'];

// Groups that render as collapsible disclosures (collapsed by default) so the
// business owner's rail is just the calm Workspace items until they choose to
// open the builder/admin tools. `workspace` is never collapsible — it's the app.
const COLLAPSIBLE_GROUPS: Group[] = ['studio', 'settings'];

// ─── Sizing constants ─────────────────────────────────────────────────────
// Width range for the resize handle. Below MIN we'd start clipping labels;
// above MAX the rail starts to feel like a sidebar instead of a nav.
const NAV_DEFAULT_WIDTH   = 220;
const NAV_MIN_WIDTH       = 180;
const NAV_MAX_WIDTH       = 360;
const NAV_COLLAPSED_WIDTH = 56;
const STORAGE_KEY         = storageKeys.navRail;

interface PersistedState {
  width: number;
  collapsed: boolean;
  /** Which collapsible groups (studio/settings) are expanded. Default: none. */
  openGroups?: Group[];
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
  const [openGroups, setOpenGroups] = useState<Group[]>([]); // studio/settings collapsed by default
  const [hydrated, setHydrated] = useState<boolean>(false);

  useEffect(() => {
    setPayload(getTokenPayload());
    try {
      const raw = getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        if (typeof parsed.width === 'number' && parsed.width >= NAV_MIN_WIDTH && parsed.width <= NAV_MAX_WIDTH) {
          setWidth(parsed.width);
        }
        if (typeof parsed.collapsed === 'boolean') {
          setCollapsed(parsed.collapsed);
        }
        if (Array.isArray(parsed.openGroups)) {
          setOpenGroups(parsed.openGroups.filter((g): g is Group => COLLAPSIBLE_GROUPS.includes(g as Group)));
        }
      } else {
        // First-ever load (no saved preference): open Studio for builders so a
        // brand-new admin can immediately find Sources / Data products to set
        // up their data. Viewers never see Studio, so their calm 4-item
        // Workspace is unaffected. Once the user collapses it, the choice is
        // persisted and respected.
        const r = getTokenPayload()?.role;
        if (r === 'admin' || r === 'analyst') setOpenGroups(['studio']);
      }
    } catch { /* ignore — fall back to defaults */ }
    setHydrated(true);
  }, []);

  // Persist on change (but skip until after hydration so we don't immediately
  // overwrite the stored value with a default-state snapshot).
  useEffect(() => {
    if (!hydrated) return;
    setItem(STORAGE_KEY, JSON.stringify({ width, collapsed, openGroups } satisfies PersistedState));
  }, [width, collapsed, openGroups, hydrated]);

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
        // 'structural' = synced, tables in the catalog, but the AI analyse
        // step is still pending — the user has an action to take there.
        const pending = conns.filter((c) => !c.profiling_status || c.profiling_status === 'pending' || c.profiling_status === 'failed' || c.profiling_status === 'structural').length;
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

  function toggleGroup(g: Group) {
    setOpenGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));
  }

  // Sum of pending badges inside a group — shown as an attention dot on a
  // collapsed disclosure header so "something needs you" is visible without
  // expanding the section.
  function groupBadgeTotal(items: NavItem[]): number {
    return items.reduce((sum, it) => sum + badgeFor(it), 0);
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

  // One nav row (the Link). Extracted so the workspace items and the
  // disclosure groups render identical rows.
  function renderNavLink(it: NavItem) {
    const active = isActive(it.href);
    const badge = badgeFor(it);
    return (
      <Link
        key={it.key}
        href={it.href}
        title={collapsed ? `${it.label}${badge > 0 ? ` · ${badge}` : ''}` : undefined}
        className={cn(
          'group flex items-center rounded-sm text-[13.5px]',
          'transition-colors duration-1 ease-observatory',
          'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_rgba(255,255,255,0.25)]',
          collapsed ? 'justify-center px-2 py-2' : 'gap-2.5 px-2.5 py-2',
          active
            ? 'bg-white/15 text-white font-medium'
            : 'text-[var(--ocean-soft)] hover:bg-white/10 hover:text-white',
        )}
        aria-current={active ? 'page' : undefined}
      >
        <span className={cn(active ? 'text-white' : 'text-[var(--ocean-soft)] group-hover:text-white')}>
          {it.icon}
        </span>
        {!collapsed && (
          <>
            <span className="truncate flex-1">{it.label}</span>
            {badge > 0 && (
              <span className={cn(
                'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-medium tabular-nums',
                active ? 'bg-white text-[var(--ocean)]' : 'bg-[var(--ocean-hover)] text-white',
              )}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </>
        )}
        {collapsed && badge > 0 && (
          <span
            className="absolute mt-[-12px] ml-[14px] w-[8px] h-[8px] rounded-full bg-white border border-[var(--ocean)]"
            aria-label={`${badge} pending`}
          />
        )}
      </Link>
    );
  }

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

            const isCollapsible = COLLAPSIBLE_GROUPS.includes(g);
            // In icon-only rail mode we can't show a disclosure header, so
            // every group just renders its rows (separated by a divider).
            // In expanded mode, collapsible groups hide their rows until the
            // user opens the section — keeping the default rail calm.
            const showRows = !isCollapsible || collapsed || openGroups.includes(g);
            const pending = isCollapsible ? groupBadgeTotal(items) : 0;

            return (
              <div key={g} className="contents">
                {/* Group header. Workspace has none (it's the default surface).
                    Studio/Settings are clickable disclosures; collapsed-rail
                    mode falls back to a plain divider. */}
                {GROUP_LABELS[g] && (
                  collapsed ? (
                    <div className="mx-3 my-2 border-t border-white/10" aria-hidden />
                  ) : isCollapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleGroup(g)}
                      aria-expanded={openGroups.includes(g)}
                      className="group/disc mt-2 flex items-center gap-1.5 rounded-sm px-2.5 pt-2 pb-1.5 text-left hover:bg-white/5 transition-colors"
                    >
                      <ChevronDown
                        className={cn(
                          'w-3 h-3 text-white/45 transition-transform duration-150',
                          !openGroups.includes(g) && '-rotate-90',
                        )}
                        strokeWidth={2}
                      />
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/55 font-medium">
                        {GROUP_LABELS[g]}
                      </span>
                      {/* Attention dot when the section is closed but something
                          inside needs the user (pending reviews / sources). */}
                      {!openGroups.includes(g) && pending > 0 && (
                        <span className="ml-1 w-[7px] h-[7px] rounded-full bg-white/80" aria-label={`${pending} pending`} />
                      )}
                    </button>
                  ) : (
                    <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/55 px-2.5 pt-3 pb-1.5 font-medium">
                      {GROUP_LABELS[g]}
                    </div>
                  )
                )}
                {showRows && items.map((it) => renderNavLink(it))}
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
