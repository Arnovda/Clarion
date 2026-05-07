'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star,
  Plug, Inbox, Users, Shield, Library, Package, Workflow, Search,
  Home as HomeIcon, DollarSign,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';
import api from '@/lib/api';

type Role = 'admin' | 'analyst' | 'viewer';
type Group = 'home' | 'discover' | 'work' | 'curate' | 'settings';

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
  // Home — daily driver, default landing
  { key: 'home',       href: '/home',       label: 'Home',            icon: ICONS.home,    roles: ['admin', 'analyst', 'viewer'],  group: 'home' },

  // Discover — find your data
  { key: 'catalog',    href: '/catalog',    label: 'Catalog',         icon: ICONS.book,    roles: ['admin', 'analyst', 'viewer'],  group: 'discover' },
  { key: 'glossary',   href: '/glossary',   label: 'Glossary',        icon: ICONS.library, roles: ['admin', 'analyst', 'viewer'],  group: 'discover' },

  // Work — daily use. Vocabulary lock:
  //   • /catalog → "Catalog" — the consumer discovery surface (cards UX)
  //   • /products → "Build" — the curator authoring surface where admins
  //     design star schemas, edit transformations, manage KPIs.
  // Earlier "Datasets" label was a soften-the-engineering-term attempt;
  // dropped because it collided semantically with "Catalog" and gave no
  // hint about what the user does there.
  // /query (Ask AI) auto-detects investigate questions ("Why did revenue
  // drop?") and renders the multi-step trail inline with a 🕵️ indicator.
  // /investigate is no longer in the rail — it stays as a deep-link alias
  // for morning-brief "Why?" buttons and replay URLs.
  { key: 'ask',        href: '/query',      label: 'Ask AI',          icon: ICONS.chat,    roles: ['admin', 'analyst', 'viewer'],  group: 'work' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards',      icon: ICONS.grid,    roles: ['admin', 'analyst', 'viewer'],  group: 'work' },
  { key: 'products',   href: '/products',   label: 'Build',           icon: ICONS.package, roles: ['admin', 'analyst'],            group: 'work' },
  { key: 'pipelines',  href: '/pipelines',  label: 'Refresh',         icon: ICONS.workflow,roles: ['admin', 'analyst'],            group: 'work' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',       icon: ICONS.code,    roles: ['admin', 'analyst'],            group: 'work' },

  // Curate — keep definitions correct (analyst+)
  { key: 'sources',    href: '/sources',    label: 'Sources',         icon: ICONS.plug,    roles: ['admin', 'analyst'],            group: 'curate', badgeKey: 'sources' },
  { key: 'review',     href: '/review',     label: 'AI review queue', icon: ICONS.inbox,   roles: ['admin', 'analyst'],            group: 'curate', badgeKey: 'review' },

  // Settings — admin only
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
  // Curator's workshop. /setup retained as a back-compat alias so any
  // bookmarked URLs from before the rename still light up the active
  // state. Phase 4 of the catalog redesign moved /setup → /sources to
  // give the curator surface an honest name.
  '/sources':    ['/sources', '/setup'],
  '/review':     ['/review', '/gaps', '/suggestions'],
  '/users':      ['/users'],
  '/policies':   ['/policies'],
};

const GROUP_LABELS: Record<Group, string> = {
  // Home is unlabelled — it's the only item in its group, a nameless
  // header would be visual noise. The rendering loop skips empty labels.
  home:     '',
  discover: 'Discover',
  work:     'Work',
  curate:   'Curate',
  settings: 'Settings',
};

const GROUP_ORDER: Group[] = ['home', 'discover', 'work', 'curate', 'settings'];

export default function IconRail() {
  const pathname = usePathname();
  const [payload, setPayload] = useState<TokenPayload | null>(null);
  const [reviewCount, setReviewCount] = useState<number>(0);
  const [sourcesCount, setSourcesCount] = useState<number>(0);

  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  // Load badge counts for analyst+
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
        // "pending" sources = those without a successful profiling run
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

  return (
    <aside
      aria-label="Primary navigation"
      className="w-[220px] min-w-[220px] h-full flex flex-col bg-raised border-r border-line shrink-0 overflow-y-auto"
    >
      <nav className="flex-1 flex flex-col gap-0.5 px-2.5 py-3.5">
        {GROUP_ORDER.map((g) => {
          const items = visible.filter((i) => i.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="contents">
              {GROUP_LABELS[g] && (
                <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted px-2.5 pt-3 pb-1.5 font-medium">
                  {GROUP_LABELS[g]}
                </div>
              )}
              {items.map((it) => {
                const active = isActive(it.href);
                const badge = badgeFor(it);
                return (
                  <Link
                    key={it.key}
                    href={it.href}
                    className={cn(
                      'flex items-center gap-2.5 px-2.5 py-2 rounded-sm text-[13.5px]',
                      'transition-colors duration-1 ease-observatory',
                      'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
                      active
                        ? 'bg-ocean-softer text-ocean font-medium'
                        : 'text-ink-2 hover:bg-soft hover:text-ink'
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <span className={cn('opacity-85', active && 'opacity-100')}>{it.icon}</span>
                    <span className="truncate flex-1">{it.label}</span>
                    {badge > 0 && (
                      <span className={cn(
                        'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-medium tabular-nums',
                        active ? 'bg-ocean text-white' : 'bg-ocean-softer text-ocean'
                      )}>
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
