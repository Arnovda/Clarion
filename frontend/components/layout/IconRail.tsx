'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star,
  Plug, Inbox, Users, Shield, Library, Package, Workflow, Search,
  Home as HomeIcon, DollarSign, ChevronLeft, ChevronDown, Share2,
  Blocks, Sparkles,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';
import api from '@/lib/api';
import { getItem, setItem, storageKeys } from '@/lib/storage';
import { iconForAnalytics } from '@/components/catalog/entityIcons';
import { cleanTopicName } from '@/app/products/helpers';
import { TOPICS_CHANGED_EVENT } from '@/lib/topicsChanged';

type Role = 'admin' | 'analyst' | 'viewer';
// IA model (2026-08-18, the owner's sketch): the rail is business-first.
//   • workspace — Home, unlabelled: the landing surface, above everything.
//   • uncover   — the ways you interrogate the data: Ask AI, Dashboards,
//     Notebooks (Notebooks analyst+ — viewers simply don't see the row).
//   • subjects  — the business user's world. One row per analytics data
//     product, fetched at runtime, plus Shared data: the lookups every
//     subject slices by read as CONTENT, not tooling, so they live here
//     (read-only for viewers) rather than in Studio.
//   • studio    — the builder's pipeline, in pipeline order: Sources →
//     Build → Relations → Data Catalog → Refresh → Suggestions. analyst+.
//   • settings  — admin-only org config.
//
// `Data Catalog` returned to the rail on 2026-08-18: the 2026-08-06 removal
// was about the FRONT DOOR (topics replace it for business users), but it
// also took away the curator's working surface — definitions, columns, data
// preview — which is Studio work and needs a direct door.
type Group = 'workspace' | 'uncover' | 'topics' | 'studio' | 'settings';

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
  relations: <Share2        className={ICON_CLASS} strokeWidth={1.5} />,
  blocks:   <Blocks         className={ICON_CLASS} strokeWidth={1.5} />,
  sparkles: <Sparkles       className={ICON_CLASS} strokeWidth={1.5} />,
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
  // ── Workspace — Home alone, unlabelled, above everything ─────────────────
  { key: 'home',       href: '/home',       label: 'Home',            icon: ICONS.home,    roles: ['admin', 'analyst', 'viewer'],  group: 'workspace' },
  // ── Uncover — the ways you interrogate the data ──────────────────────────
  { key: 'ask',        href: '/query',      label: 'Ask AI',          icon: ICONS.chat,    roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',      icon: ICONS.grid,    roles: ['admin', 'analyst', 'viewer'],  group: 'uncover' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',       icon: ICONS.code,    roles: ['admin', 'analyst'],            group: 'uncover' },
  // ── Studio — the builder's pipeline, in pipeline order ───────────────────
  { key: 'sources',    href: '/sources',    label: 'Sources',         icon: ICONS.plug,    roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'sources' },
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
  { key: 'catalog',    href: '/catalog',    label: 'Data Catalog',    icon: ICONS.book,    roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'pipelines',  href: '/pipelines',  label: 'Refresh',         icon: ICONS.workflow,roles: ['admin', 'analyst'],            group: 'studio' },
  { key: 'review',     href: '/review',     label: 'Suggestions',     icon: ICONS.inbox,   roles: ['admin', 'analyst'],            group: 'studio', badgeKey: 'review' },
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
  '/shared-data': ['/shared-data'],
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
  topics:    'Subjects',
  studio:    'Studio',
  settings:  'Settings',
};

const GROUP_ORDER: Group[] = ['workspace', 'uncover', 'topics', 'studio', 'settings'];

// Groups that render as collapsible disclosures (collapsed by default) so the
// business owner's rail is just the calm Workspace items until they choose to
// open the builder/admin tools. `workspace` and `topics` are never collapsible
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
  // "Your data" — one row per analytics data product. Fetched for EVERY role:
  // the topics are the viewer's entire world, so an empty list here means a
  // viewer has no navigation at all.
  const [topics, setTopics] = useState<Array<{ id: number; name: string }>>([]);

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

  // Topic rows. Reference-kind products are deliberately excluded — they are
  // lookups, not subject areas, and they live under Studio → Shared data.
  // Hidden products are excluded too: the Build page's show/hide toggle IS
  // the topic selection, and this filter is what makes it mean something.
  // Re-fetched on TOPICS_CHANGED_EVENT because the shell (and this rail)
  // persists across client-side navigations — a build finishing or a toggle
  // on /build must reach the rail without a full reload.
  useEffect(() => {
    if (!payload) return;
    let cancelled = false;
    const fetchTopics = () => {
      api.get('/products')
        .then((res) => {
          if (cancelled) return;
          const rows = (res.data.data ?? []) as Array<{ id: number; name: string; kind?: string; hidden?: boolean }>;
          setTopics(
            rows
              .filter((p) => (p.kind ?? 'analytics') === 'analytics' && p.hidden !== true)
              .map((p) => ({ id: p.id, name: p.name }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
        })
        .catch(() => { /* rail degrades to Workspace + Studio */ });
    };
    fetchTopics();
    window.addEventListener(TOPICS_CHANGED_EVENT, fetchTopics);
    return () => {
      cancelled = true;
      window.removeEventListener(TOPICS_CHANGED_EVENT, fetchTopics);
    };
  }, [payload]);

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
  // Topic rows are built here rather than being part of NAV_ITEMS because
  // they are tenant data, not app structure. They wear the same curated
  // glyph the rest of the app resolves from a product name, so a topic looks
  // identical in the rail, in the catalog and on its own page.
  const topicItems: NavItem[] = topics.map((t) => {
    const Glyph = iconForAnalytics(t.name);
    return {
      key: `topic-${t.id}`,
      href: `/topics/${t.id}`,
      label: cleanTopicName(t.name),
      icon: <Glyph className={ICON_CLASS} strokeWidth={1.5} />,
      roles: ['admin', 'analyst', 'viewer'],
      group: 'topics',
    };
  });
  // Empty YOUR DATA is a builder's call to action, not a blank: the group
  // used to render nothing at zero topics, which left the one job this rail
  // exists for — get your topics up — behind an unlinked URL. Viewers keep
  // the quiet rail (there is nothing they could do about it).
  if (topicItems.length === 0 && (role === 'admin' || role === 'analyst')) {
    topicItems.push({
      key: 'topics-empty',
      href: '/build',
      label: 'Create your topics →',
      icon: ICONS.sparkles,
      roles: ['admin', 'analyst'],
      group: 'topics',
    });
  }
  // Shared data closes the Subjects group: the lookups every subject slices
  // by are CONTENT (your customers, your products), not tooling — so they
  // sit with the subjects, for every role. The page is read-only for
  // viewers; editing stays a curator affordance on the page itself.
  topicItems.push({
    key: 'shared',
    href: '/shared-data',
    label: 'Shared data',
    icon: ICONS.library,
    roles: ['admin', 'analyst', 'viewer'],
    group: 'topics',
  });
  const visible = [...NAV_ITEMS, ...topicItems].filter((i) => i.roles.includes(role));

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
