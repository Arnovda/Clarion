'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  MessageSquare, LayoutGrid, Code2, BookOpen, Star, Heart,
  Plug, Inbox, Users, Shield,
} from 'lucide-react';
import { getTokenPayload, TokenPayload } from '@/lib/auth';
import { cn } from '@/lib/cn';

type Role = 'admin' | 'analyst' | 'viewer';
type Group = 'workspace' | 'model' | 'admin';

const ICON_CLASS = 'w-[14px] h-[14px] shrink-0';

const ICONS = {
  chat:   <MessageSquare className={ICON_CLASS} strokeWidth={1.5} />,
  grid:   <LayoutGrid    className={ICON_CLASS} strokeWidth={1.5} />,
  code:   <Code2         className={ICON_CLASS} strokeWidth={1.5} />,
  book:   <BookOpen      className={ICON_CLASS} strokeWidth={1.5} />,
  star:   <Star          className={ICON_CLASS} strokeWidth={1.5} />,
  heart:  <Heart         className={ICON_CLASS} strokeWidth={1.5} />,
  plug:   <Plug          className={ICON_CLASS} strokeWidth={1.5} />,
  inbox:  <Inbox         className={ICON_CLASS} strokeWidth={1.5} />,
  users:  <Users         className={ICON_CLASS} strokeWidth={1.5} />,
  shield: <Shield        className={ICON_CLASS} strokeWidth={1.5} />,
};

/* ── Nav model ──────────────────────────────────────────────────────── */

interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: React.ReactNode;
  roles: Role[];
  group: Group;
}

const NAV_ITEMS: NavItem[] = [
  // Workspace
  { key: 'ask',        href: '/query',      label: 'Ask',        icon: ICONS.chat,  roles: ['admin', 'analyst', 'viewer'], group: 'workspace' },
  { key: 'dashboards', href: '/dashboards', label: 'Dashboards', icon: ICONS.grid,  roles: ['admin', 'analyst', 'viewer'], group: 'workspace' },
  { key: 'notebooks',  href: '/notebooks',  label: 'Notebooks',  icon: ICONS.code,  roles: ['admin', 'analyst'],            group: 'workspace' },

  // Model
  { key: 'semantic',   href: '/semantic',   label: 'Catalog',    icon: ICONS.book,  roles: ['admin', 'analyst'],            group: 'model' },
  { key: 'products',   href: '/products',   label: 'Products',   icon: ICONS.star,  roles: ['admin'],                       group: 'model' },
  { key: 'quality',    href: '/health',     label: 'Quality',    icon: ICONS.heart, roles: ['admin', 'analyst'],            group: 'model' },

  // Admin
  { key: 'sources',    href: '/setup',      label: 'Sources',     icon: ICONS.plug,   roles: ['admin'], group: 'admin' },
  { key: 'suggestions',href: '/gaps',       label: 'Suggestions', icon: ICONS.inbox,  roles: ['admin'], group: 'admin' },
  { key: 'team',       href: '/users',      label: 'Team',        icon: ICONS.users,  roles: ['admin'], group: 'admin' },
  { key: 'policies',   href: '/policies',   label: 'Policies',    icon: ICONS.shield, roles: ['admin'], group: 'admin' },
];

const ROUTE_ALIASES: Record<string, string[]> = {
  '/query':      ['/query', '/ask'],
  '/dashboards': ['/dashboards'],
  '/notebooks':  ['/notebooks'],
  '/semantic':   ['/semantic'],
  '/products':   ['/products'],
  '/health':     ['/health'],
  '/setup':      ['/setup', '/sources'],
  '/gaps':       ['/gaps', '/suggestions'],
  '/users':      ['/users'],
  '/policies':   ['/policies'],
};

const GROUP_LABELS: Record<Group, string> = {
  workspace: 'Workspace',
  model:     'Model',
  admin:     'Admin',
};

export default function IconRail() {
  const pathname = usePathname();
  const [payload, setPayload] = useState<TokenPayload | null>(null);

  useEffect(() => {
    setPayload(getTokenPayload());
  }, []);

  const role: Role = payload?.role ?? 'viewer';
  const visible = NAV_ITEMS.filter((i) => i.roles.includes(role));

  function isActive(href: string) {
    const aliases = ROUTE_ALIASES[href] ?? [href];
    return aliases.some((a) => pathname === a || pathname.startsWith(a + '/'));
  }

  const groups: Group[] = ['workspace', 'model', 'admin'];

  return (
    <aside
      aria-label="Primary navigation"
      className="w-[220px] min-w-[220px] h-screen flex flex-col bg-raised border-r border-line shrink-0 overflow-y-auto"
    >
      <nav className="flex-1 flex flex-col gap-0.5 px-2.5 py-3.5">
        {groups.map((g) => {
          const items = visible.filter((i) => i.group === g);
          if (items.length === 0) return null;
          return (
            <div key={g} className="contents">
              <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted px-2.5 pt-3 pb-1.5 font-medium">
                {GROUP_LABELS[g]}
              </div>
              {items.map((it) => {
                const active = isActive(it.href);
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
                    <span className="truncate">{it.label}</span>
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
