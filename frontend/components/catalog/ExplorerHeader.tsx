'use client';

/**
 * <ExplorerHeader> — the one header every catalog view wears.
 *
 * The shape is the Databricks Catalog Explorer's, which the owner asked for
 * (2026-09-23): a breadcrumb that walks back up the tree, the thing's own
 * icon beside its name, the technical name with a copy button for the
 * people who write SQL, the actions on the right, and a horizontal tab
 * strip underneath. What differs is the content: the icon is the source's
 * own mark or the subject's glyph, the actions are Clarion's verbs (Ask AI,
 * Change with AI), and the technical name is a curator-only affordance —
 * a viewer reads the display name and nothing else.
 *
 * Purely presentational: the panels decide the crumbs, tabs and actions;
 * the page decides what a crumb click does (it owns the selection).
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, MoreHorizontal, X } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface Crumb {
  label: string;
  /** Absent = the current node (rendered, not clickable). */
  onClick?: () => void;
}

export interface ExplorerTab<T extends string> {
  id: T;
  label: string;
  count?: number;
}

interface Props<T extends string> {
  crumbs: Crumb[];
  /** The node's icon tile — a connector mark, a subject glyph, a table glyph. */
  icon: React.ReactNode;
  title: string;
  /** The identifier the SQL uses; shown in mono with a copy button. */
  technicalName?: string | null;
  /** Small chips beside the title (role, status). */
  badges?: React.ReactNode;
  /** One line under the title: what it is, in words. */
  subtitle?: React.ReactNode;
  /** Buttons on the right. */
  actions?: React.ReactNode;
  tabs: ExplorerTab<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  onClose?: () => void;
}

export default function ExplorerHeader<T extends string>({
  crumbs, icon, title, technicalName, badges, subtitle, actions, tabs, activeTab, onTabChange, onClose,
}: Props<T>) {
  return (
    <div className="bg-raised border-b border-line px-6 pt-3 pb-0 flex-shrink-0">
      {/* Breadcrumb — every ancestor is a door back up the tree. */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12px] text-muted mb-2.5 min-w-0">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} className="flex items-center gap-1 min-w-0">
              {c.onClick && !last ? (
                <button
                  type="button"
                  onClick={c.onClick}
                  className="truncate hover:text-ocean transition-colors max-w-[220px]"
                >
                  {c.label}
                </button>
              ) : (
                <span className={cn('truncate max-w-[280px]', last ? 'text-ink-2' : '')} aria-current={last ? 'page' : undefined}>
                  {c.label}
                </span>
              )}
              {!last && <ChevronRight className="w-3 h-3 shrink-0 text-muted-2" strokeWidth={2} aria-hidden />}
            </span>
          );
        })}
      </nav>

      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <span className="shrink-0 mt-0.5">{icon}</span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] truncate">{title}</h1>
              {technicalName && technicalName !== title && <CopyName name={technicalName} />}
              {badges}
            </div>
            {subtitle && <div className="text-[12.5px] text-muted mt-0.5">{subtitle}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {actions}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-soft text-muted hover:text-ink transition-colors"
              title="Close"
              aria-label="Close"
            >
              <X className="w-4 h-4" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Tab strip — underline on the active one, counts in mono. */}
      <div className="flex items-center gap-0 -mb-px overflow-x-auto" role="tablist">
        {tabs.map((t) => {
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              className={cn(
                'px-3.5 py-2.5 text-[13px] transition-colors whitespace-nowrap relative',
                active ? 'text-ink font-medium' : 'text-muted hover:text-ink-2',
              )}
            >
              {t.label}
              {typeof t.count === 'number' && (
                <span className="ml-1.5 text-[11px] font-mono text-muted-2 tabular-nums">{t.count}</span>
              )}
              {active && <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-ocean rounded-full" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The technical name in mono, and one click to copy it — for the SQL. */
function CopyName({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(name).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => { /* the name is on screen — nothing to recover */ },
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 text-[11.5px] font-mono text-muted-2 hover:text-ink-2 transition-colors max-w-[320px]"
      title={`Copy ${name}`}
    >
      <span className="truncate">{name}</span>
      {copied
        ? <Check className="w-3 h-3 shrink-0 text-ok" strokeWidth={2.5} aria-hidden />
        : <Copy className="w-3 h-3 shrink-0" strokeWidth={1.75} aria-hidden />}
      <span className="sr-only">{copied ? 'Copied' : 'Copy the technical name'}</span>
    </button>
  );
}

/** A header action: the primary one is filled, the rest are outlined. */
export function HeaderAction({
  onClick, href, primary, icon, children, title,
}: {
  onClick?: () => void;
  href?: string;
  primary?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
}) {
  const cls = cn(
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium rounded-md border transition-colors whitespace-nowrap',
    primary
      ? 'bg-ocean text-white border-ocean hover:bg-ocean-hover'
      : 'bg-raised text-ink-2 border-line hover:border-line-strong hover:bg-soft',
  );
  if (href) {
    return <a href={href} className={cls} title={title}>{icon}{children}</a>;
  }
  return <button type="button" onClick={onClick} className={cls} title={title}>{icon}{children}</button>;
}

/** The overflow: the doors that are real but not the thing you came for. */
export function MoreMenu({ items, label = 'More' }: {
  items: Array<{ label: string; href?: string; onClick?: () => void; icon?: React.ReactNode }>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="p-1.5 rounded-md border border-line bg-raised text-muted hover:text-ink hover:border-line-strong transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 min-w-[200px] bg-raised border border-line rounded-md shadow-2 py-1 z-20">
          {items.map((it) => {
            const cls = 'w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-soft hover:text-ink text-left';
            return it.href ? (
              <a key={it.label} role="menuitem" href={it.href} className={cls} onClick={() => setOpen(false)}>{it.icon}{it.label}</a>
            ) : (
              <button key={it.label} role="menuitem" type="button" className={cls} onClick={() => { setOpen(false); it.onClick?.(); }}>{it.icon}{it.label}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}
