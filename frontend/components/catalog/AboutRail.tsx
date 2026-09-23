'use client';

/**
 * <AboutRail> — the "About this table" column on the right of an Overview.
 *
 * The Databricks explorer keeps a table's facts (owner, type, source,
 * tags, insights) in a narrow rail beside the columns, so the columns —
 * what people came for — take the width. Same here. A row is a label and
 * a value; a section is a heading and rows; anything richer (a lineage
 * line, a policy note) is passed in as a node. Empty values are skipped
 * so the rail never reads "Owner: —".
 */
import { cn } from '@/lib/cn';

export interface AboutRow {
  label: string;
  value: React.ReactNode;
}

export interface AboutSection {
  title: string;
  rows?: AboutRow[];
  /** Free content under the rows (chips, a sentence, a small list). */
  body?: React.ReactNode;
  /** A door: "Manage policies →". */
  link?: { label: string; href: string };
}

export default function AboutRail({ sections, className }: { sections: AboutSection[]; className?: string }) {
  const visible = sections.filter((s) => (s.rows && s.rows.some((r) => r.value != null && r.value !== '')) || s.body || s.link);
  if (visible.length === 0) return null;
  return (
    <aside className={cn('w-[264px] shrink-0 space-y-6', className)} aria-label="About">
      {visible.map((s) => (
        <section key={s.title}>
          <h3 className="text-[13px] font-medium text-ink mb-2.5">{s.title}</h3>
          {s.rows && (
            <dl className="space-y-2">
              {s.rows.filter((r) => r.value != null && r.value !== '').map((r) => (
                <div key={r.label} className="flex items-baseline gap-3 text-[12.5px]">
                  <dt className="w-[88px] shrink-0 text-muted">{r.label}</dt>
                  <dd className="min-w-0 flex-1 text-ink-2 break-words">{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {s.body && <div className={cn('text-[12.5px] text-ink-2', s.rows && 'mt-2.5')}>{s.body}</div>}
          {s.link && (
            <a href={s.link.href} className="inline-block mt-2 text-[12px] font-medium text-ocean hover:text-ocean-hover transition-colors">
              {s.link.label} →
            </a>
          )}
        </section>
      ))}
    </aside>
  );
}

/** A small neutral chip for a rail value (a status, a term, a domain). */
export function RailChip({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'err' | 'ocean'; title?: string }) {
  const cls = {
    neutral: 'bg-softer text-ink-3 border-line',
    ok: 'bg-ok-soft text-ok border-ok/20',
    warn: 'bg-warn-soft text-warn border-warn/20',
    err: 'bg-err-soft text-err border-err/20',
    ocean: 'bg-ocean-softer text-ocean border-ocean/20',
  }[tone];
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight', cls)}>
      {children}
    </span>
  );
}
