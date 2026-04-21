'use client';

/**
 * Tiny leaf components: status dots, role badges, spinner.
 * No state, no hooks.
 */

import { Loader2 } from 'lucide-react';

export function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    draft:     'bg-line-strong',
    designing: 'bg-ocean animate-pulse',
    approved:  'bg-ok',
    running:   'bg-warn animate-pulse',
    success:   'bg-ok',
    error:     'bg-err',
    pending:   'bg-line-strong',
  };
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full ${color[status] ?? 'bg-line-strong'}`}
      title={status}
    />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft:     'bg-softer text-muted',
    designing: 'bg-ocean-softer text-ocean',
    approved:  'bg-ok-soft text-ok',
    running:   'bg-warn-soft text-warn',
    success:   'bg-ok-soft text-ok',
    error:     'bg-err-soft text-err',
  };
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${colors[status] ?? 'bg-softer text-muted'}`}>
      {status}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const config: Record<string, { bg: string; label: string }> = {
    fact:      { bg: 'bg-ai-soft text-ai',           label: 'Measures' },
    dimension: { bg: 'bg-ocean-softer text-ocean',   label: 'Lookup' },
    bridge:    { bg: 'bg-warn-soft text-warn',       label: 'Bridge' },
    junk:      { bg: 'bg-softer text-muted',         label: 'Flags' },
  };
  const c = config[role] ?? { bg: 'bg-softer text-muted', label: role };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${c.bg}`}>{c.label}</span>;
}

export function ColumnRoleBadge({ role }: { role: string | null }) {
  if (!role) return null;
  const colors: Record<string, string> = {
    surrogate_key:        'bg-warn-soft text-warn',
    natural_key:          'bg-warn-soft text-warn',
    foreign_key:          'bg-ai-soft text-ai',
    measure:              'bg-ok-soft text-ok',
    attribute:            'bg-ocean-softer text-ocean',
    degenerate_dimension: 'bg-softer text-muted',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-semibold ${colors[role] ?? 'bg-softer text-muted'}`}>
      {role.replace(/_/g, ' ')}
    </span>
  );
}

export function Spinner({ className = 'w-4 h-4 text-ocean' }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} strokeWidth={2} />;
}
