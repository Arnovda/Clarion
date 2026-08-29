'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star,
  Plug, Inbox, Users, Shield, Library, Package, Workflow, Search,
  Home as HomeIcon, DollarSign, ChevronLeft, ChevronDown, Share2,
  Blocks, Sparkles, Layers, Table2, ToggleRight,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useIsOperator } from '@/lib/features';
import api from '@/lib/api';
import { getItem, setItem, storageKeys } from '@/lib/storage';

type Role = 'admin' | 'analyst' | 'viewer';
// IA model (2026-08-18, the owner's sketch; revised 2026-08-20 — Option A of
// three mocked directions, the owner's pick): the rail is business-first.
//   • workspace — Home, unlabelled: the landing surface, above everything.
//   • uncover   — the ways you interrogate the data: Ask AI, Dashboards,
//     SUBJECTS, Notebooks (Notebooks analyst+). Subjects is ONE entry — the
//     hub at /subjects — not a row per topic: per-topic rows were right at
//     two or three template topics, but the AI designer produces six-plus
//     and a rail that grows with the model's output always eventually
//     scrolls. The hub carries what a rail row never could (descriptions,
//     freshness), and Shared data lives there too.
//   • studio    — the builder's pipeline, in pipeline order: Sources →
//     Build → Relations → Data Catalog → Refresh → Suggestions. analyst+.
//   • settings  — admin-only org config.
//
// `Data Catalog` returned to the rail on 2026-08-18: the 2026-08-06 removal
// was about the FRONT DOOR (topics replace it for business users), but it
// also took away the curator's working surface — definitions, columns, data
// preview — which is Studio work and needs a direct door.
type Group = 'workspace' | 'uncover' | 'studio' | 'settings';

const ICON_CLASS = 'w-4 h-4 shrink-0';

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
  relations: <Share2        className={ICON_CLASS} strokeWidth={1.5} />,
  blocks:   <Blocks         className={ICON_CLASS} strokeWidth={1.5} />,
  sparkles: <Sparkles       className={ICON_CLASS} strokeWidth={1.5} />,
  layers:   <Layers         className={ICON_CLASS} strokeWidth={1.5} />,
  table:    <Table2         className={ICON_CLASS} strokeWidth={1.5} />,
  flag:     <ToggleRight    className={ICON_CLASS} strokeWidth={1.5} />,
};

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: React.ReactNode;
  roles: Role[];
  group: Group;
  badgeKey?: 'review' | 'sources';
  /**
   * Shown only to platform operators. Deliberately separate from `roles`:
   * operator is not a tenant role, and a tenant admin must never see the
   * feature-rollout console (see routes/featureFlags.ts).
   */
  operatorOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  // ── Workspace — Home alone, unlabelled, above everything ─────────────────
  { key: 'home',       href: '/home',       label: 'Home',            icon: ICONS.home,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  // ── Uncover — the ways you interrogate the data ──────────────────────────
  { key: 'ask',        href: '/query',      label: 'Ask',             icon: ICONS.chat,    roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',      icon: ICONS.grid,    roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  // The root-cause agent — fully built since months but had ZERO nav links
  // (gap analysis G10). Ask AI's "Why?" chips escalate here too.
  { key: 'investigate', href: '/investigate', label: 'Investigate',   icon: ICONS.search,  roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  // The Subjects hub — every topic plus Shared data, with the descriptions
  // and freshness a rail row could never show. Stays lit on /topics/* and
  // /shared-data via ROUTE_ALIASES so deep links don't orphan the state.
  { key: 'subjects',   href: '/subjects',   label: 'Subjects',        icon: ICONS.layers,  roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',       icon: ICONS.code,    roles: ['admin', 'analyst'],            group: 'uncover' },
  // ── Studio — the builder's pipeline, in pipeline order ───────────────────
  { key: 'sources',    href: '/sources',    label: 'Sources',         icon: ICONS.plug,    roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'sources' },
  // Managed grids — budgets, mappings and lists edited inside Clarion. Sits
  // with Sources because it IS a source of data (the manual one); the rows
  // live in Postgres and materialise into the warehouse on every save.
  { key: 'grids',      href: '/grids',      label: 'Your tables',     icon: ICONS.table,   roles: ['admin', 'analyst'],            group: 'studio' },
  // Where a source becomes topics — the tenant-level front door to the
  // bus-matrix flow (build, show/hide, guarded rebuild). Tenant-level on
  // purpose: preparing data spans sources (shared data is conformed across
  // them), so this is NOT a per-source action on the source card.
  { key: 'build',      href: '/build',      label: 'Build',           icon: ICONS.blocks,  roles: ['admin', 'analyst'],            group: 'studio' },
  // Where the relationship canvas lives. Studio on purpose — it is a repair and
  // escape-hatch tool for people who already know their data, not the front
  // door. A new customer must never meet 170 edges on day one.
  { key: 'relations',  href: '/relationships', label: 'Relations',    icon: ICONS.relations, roles: ['admin', 'analyst'],          group: 'studio' },
  // The curator's working surface: browse both layers, edit definitions,
  // preview data. The one relationship surface stays /relationships — the
  // catalog's own diagram tab was retired the day this entry returned.
  { key: 'catalog',    href: '/catalog',    label: 'Catalog',         icon: ICONS.book,    roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'pipelines',  href: '/pipelines',  label: 'Refresh',         icon: ICONS.workflow,roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'review',     href: '/review',     label: 'Suggestions',     icon: ICONS.inbox,   roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'review' },
  // ── Settings — admin-only org config ────────────────────────────────────
  { key: 'team',       href: '/users',      label: 'Team & roles',    icon: ICONS.users,   roles: ['admin'],                       group: 'settings' },
  { key: 'policies',   href: '/policies',   label: 'Policies',        icon: ICONS.shield,  roles: ['admin'],                       group: 'settings' },
  { key: 'ai-usage',   href: '/admin/ai-usage', label: 'AI usage',     icon: ICONS.dollar,  roles: ['admin'],                       group: 'settings' },
  { key: 'features',   href: '/admin/features', label: 'Who sees what', icon: ICONS.flag,  roles: ['admin', 'analyst', 'viewer'],  group: 'settings', operatorOnly: true },
];

const ROUTE_ALIASES: Record<string, string[]> = {
  '/home':       ['/home'],
  '/query':      ['/query', '/ask'],
  '/dashboards': ['/dashboards'],
  '/notebooks':  ['/notebooks'],
  // A topic page and Shared data are both "inside" the Subjects hub — keep
  // the hub entry lit there so the rail always answers "where am I?".
  '/subjects':   ['/subjects', '/topics', '/shared-data'],
  '/pipelines':  ['/pipelines'],
  '/sources':    ['/sources', '/setup'],
  '/build':      ['/build'],
  // Glossary + health are facets of the catalog surface; deep links there
  // keep the Data Catalog rail item lit instead of orphaning the active state.
  '/catalog':    ['/catalog', '/semantic', '/glossary', '/health'],
  '/review':     ['/review', '/gaps', '/suggestions'],
  '/users':      ['/users'],
  '/policies':   ['/policies'],
};

const GROUP_LABELS: Record<Group, string> = {
  // No eyebrow on the workspace group — it's the unlabelled default surface
  // (just Home), which keeps the top of the rail calm. The rest are labelled.
  workspace: '',
  uncover:   'Uncover',
  studio:    'Studio',
  settings:  'Settings',
};

const GROUP_ORDER: Group[] = ['workspace', 'uncover', 'studio', 'settings'];

// Groups that render as collapsible disclosures (collapsed by default) so the
// business owner's rail is just the calm Workspace items until they choose to
// open the builder/admin tools. `workspace` and `uncover` are never collapsible
// — between them they ARE the business user's app.
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
  // Per-topic rows are gone (Option A, 2026-08-20): the Subjects entry under
  // Uncover is the one door, and the hub at /subjects carries the topic list
  // with descriptions and freshness. Shared data lives on the hub too.
  const isOperator = useIsOperator();
  const visible = NAV_ITEMS.filter((i) => i.roles.includes(role) && (!i.operatorOnly || isOperator));

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
          // Full-bleed row with a left accent bar rather than an inset pill:
          // the bar reads as "you are here" from the rail's edge, and it is
          // the same vocabulary the thread list uses two panels over.
          'group relative flex items-center border-l-2 text-[14px]',
          'transition-colors duration-1 ease-observatory',
          'focus-visible:outline-none focus-visible:bg-raised',
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-2 pl-3.5 pr-3 py-[9px]',
          active
            ? 'border-ocean bg-raised text-ink font-medium'
            : 'border-transparent text-ink-2 hover:bg-softer hover:text-ink',
        )}
        aria-current={active ? 'page' : undefined}
      >
        <span className={cn(active ? 'text-ocean' : 'text-muted group-hover:text-ink-2')}>
          {it.icon}
        </span>
        {!collapsed && (
          <>
            <span className="truncate flex-1">{it.label}</span>
            {badge > 0 && (
              <span className={cn(
                'inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full text-[10px] font-mono font-medium tabular-nums',
                active ? 'bg-ocean text-white' : 'bg-raised text-ink-3',
              )}>
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </>
        )}
        {collapsed && badge > 0 && (
          <span
            className="absolute top-1.5 right-2 w-[7px] h-[7px] rounded-full bg-ocean ring-2 ring-[var(--soft)]"
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
          // Light chrome, one step DEEPER than the panels beside it. That
          // step is what lets the active row be the LIGHTER thing on the rail
          // (white fill + accent bar) instead of a tint — the mockup's move,
          // and the reason "you are here" reads at a glance.
          'bg-soft',
          'border-r border-line',
        )}
      >
        {/* No horizontal padding — rows are full-bleed so their accent bar
            can sit flush against the rail's own edge. */}
        <nav className="flex-1 flex flex-col gap-0.5 py-2 overflow-y-auto scrollbar-thin">
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
                    <div className="mx-3 my-2 border-t border-line" aria-hidden />
                  ) : isCollapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleGroup(g)}
                      aria-expanded={openGroups.includes(g)}
                      className="group/disc mt-3 flex w-full items-center gap-1.5 px-4 pt-1 pb-1.5 text-left"
                    >
                      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2 font-medium group-hover/disc:text-muted transition-colors">
                        {GROUP_LABELS[g]}
                      </span>
                      {/* The chevron is a hover affordance while the section is
                          open — an open group should read as a plain eyebrow,
                          not as a control. Closed, it stays visible: it is the
                          only sign that rows are hidden under it. */}
                      <ChevronDown
                        className={cn(
                          'w-3 h-3 text-muted-2 transition-[transform,opacity] duration-150',
                          openGroups.includes(g)
                            ? 'opacity-0 group-hover/disc:opacity-100'
                            : '-rotate-90 opacity-100',
                        )}
                        strokeWidth={2}
                      />
                      {/* Attention dot when the section is closed but something
                          inside needs the user (pending reviews / sources). */}
                      {!openGroups.includes(g) && pending > 0 && (
                        <span className="ml-1 w-[7px] h-[7px] rounded-full bg-ocean" aria-label={`${pending} pending`} />
                      )}
                    </button>
                  ) : (
                    <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2 px-4 pt-4 pb-1.5 font-medium">
                      {GROUP_LABELS[g]}
                    </div>
                  )
                )}
                {showRows && items.map((it) => renderNavLink(it))}
              </div>
            );
          })}
        </nav>

        {/* Collapse toggle pinned to the bottom, kept quiet: it is chrome for
            the chrome, and should never compete with a nav row. */}
        <div className="px-2 py-2 border-t border-line">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              'w-full flex items-center rounded-sm py-1.5 text-[12px]',
              'text-muted-2 hover:text-ink-2 hover:bg-softer transition-colors',
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
            'hover:bg-ocean/25 active:bg-ocean/40',
          )}
          title="Drag to resize"
          aria-hidden
        />
      )}
    </div>
  );
}
