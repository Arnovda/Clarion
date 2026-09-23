'use client';

/**
 * <ColumnsTable> — THE columns list, on the Overview of every table.
 *
 * One table, one grammar, whichever layer the table lives on: a filter box
 * above (the Databricks "Filter columns…"), then Column · Type · Description
 * · Term, with a key glyph on the columns that identify or join (the way
 * Databricks marks its partition columns), and — for curators — the
 * description edited IN the cell, saved when they leave it. No Save button
 * per row, no cards / grid toggle, no second list on another tab: the
 * Columns tab that used to duplicate this is gone.
 *
 * Anything richer than a description (a display name, a foreign-key target,
 * the expression that computes the column, its history) opens under the
 * row, so the table stays a table.
 */
import { useMemo, useState } from 'react';
import { BookOpen, Check, ChevronRight, KeyRound, Link2, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { classifyType } from '@/components/semantic/shared';

export interface ColumnRow {
  id: number;
  /** The technical column name. */
  name: string;
  displayName?: string | null;
  type?: string | null;
  description?: string | null;
  /** `key` = identifies a row; `fk` = points at another table's key. */
  keyKind?: 'key' | 'fk' | null;
  /** Tooltip on the key glyph ("Foreign key → dim_customer.customer_key"). */
  keyTitle?: string;
  /** A small chip after the name: Measure, Attribute, Dimension… */
  roleLabel?: string | null;
  roleTone?: 'ocean' | 'ok' | 'warn' | 'ai' | 'neutral';
  /** Glossary terms linked to this column — "your team calls this …". */
  terms?: string[];
  /** Scroll-to + ring when the panel was opened on this column. */
  focused?: boolean;
  /** A status node on the right (the approval badge) — curators only. */
  status?: React.ReactNode;
  /** Extra cells between Description and Term (a source column's Dim/Mea). */
  extra?: React.ReactNode;
  /** The row's details, opened with the chevron — curators only. */
  details?: React.ReactNode;
}

interface Props {
  rows: ColumnRow[];
  /** Inline description editing; the save is the caller's PATCH. */
  onSaveDescription?: (id: number, text: string) => Promise<void>;
  /** Header of the extra cell column, when rows carry `extra`. */
  extraHeader?: React.ReactNode;
  /** Header of the status column; absent = no status column. */
  statusHeader?: React.ReactNode;
  emptyText?: string;
}

const ROLE_TONE: Record<NonNullable<ColumnRow['roleTone']>, string> = {
  ocean: 'bg-ocean-softer text-ocean',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  ai: 'bg-ai-soft text-ai',
  neutral: 'bg-softer text-muted',
};

export default function ColumnsTable({ rows, onSaveDescription, extraHeader, statusHeader, emptyText }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const hasExtra = rows.some((r) => r.extra != null);
  const hasStatus = statusHeader != null;
  const hasDetails = rows.some((r) => r.details != null);
  const editable = !!onSaveDescription;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q)
      || (r.displayName ?? '').toLowerCase().includes(q)
      || (r.description ?? '').toLowerCase().includes(q)
      || (r.terms ?? []).some((t) => t.toLowerCase().includes(q)));
  }, [rows, filter]);

  const toggle = (id: number) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const colSpan = 4 + (hasExtra ? 1 : 0) + (hasStatus ? 1 : 0) + (hasDetails ? 1 : 0);

  return (
    <div>
      <div className="relative mb-3 max-w-xs">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-2 pointer-events-none" strokeWidth={1.75} aria-hidden />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setFilter(''); }}
          placeholder="Filter columns…"
          aria-label="Filter columns"
          className="w-full pl-8 pr-3 py-1.5 text-[12.5px] bg-raised border border-line rounded-md text-ink-2 placeholder:text-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30"
        />
      </div>

      <div className="bg-raised border border-line rounded-lg overflow-hidden">
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="bg-softer/60 border-b border-line text-left">
              {hasDetails && <th className="w-7" aria-label="Details" />}
              <Th>Column</Th>
              <Th className="w-[120px]">Type</Th>
              <Th>Description</Th>
              {hasExtra && <Th className="whitespace-nowrap">{extraHeader}</Th>}
              <Th className="w-[150px]">Term</Th>
              {hasStatus && <Th className="w-[96px] text-center">{statusHeader}</Th>}
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="px-4 py-6 text-center text-[12.5px] text-muted">
                  {filter ? `No column matches “${filter}”.` : (emptyText ?? 'No columns.')}
                </td>
              </tr>
            )}
            {shown.map((r) => {
              const isOpen = open.has(r.id);
              const typeInfo = r.type ? classifyType(r.type) : null;
              return (
                <RowGroup key={r.id} colSpan={colSpan} details={isOpen ? r.details : undefined}>
                  <tr
                    id={`col-${r.id}`}
                    className={cn(
                      'border-b border-line/60 last:border-0 align-top transition-colors hover:bg-softer/40',
                      r.focused && 'ring-1 ring-inset ring-ocean/30',
                    )}
                  >
                    {hasDetails && (
                      <td className="pl-2 pr-0 py-2.5">
                        {r.details != null && (
                          <button
                            type="button"
                            onClick={() => toggle(r.id)}
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Hide details' : 'Show details'}
                            className="p-0.5 rounded hover:bg-soft text-muted-2 hover:text-ink"
                          >
                            <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-90')} strokeWidth={2} />
                          </button>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-2.5 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {r.keyKind === 'key' && (
                          <KeyRound className="w-3.5 h-3.5 shrink-0 text-warn" strokeWidth={2} aria-label={r.keyTitle ?? 'Key'} />
                        )}
                        {r.keyKind === 'fk' && (
                          <Link2 className="w-3.5 h-3.5 shrink-0 text-ocean" strokeWidth={2} aria-label={r.keyTitle ?? 'Foreign key'} />
                        )}
                        <span className="font-mono text-[12px] text-ink truncate" title={r.keyTitle}>{r.name}</span>
                        {r.roleLabel && (
                          <span className={cn('shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium', ROLE_TONE[r.roleTone ?? 'neutral'])}>
                            {r.roleLabel}
                          </span>
                        )}
                      </div>
                      {r.displayName && r.displayName !== r.name && (
                        <span className="block text-[11px] text-muted-2 truncate">{r.displayName}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {typeInfo && r.type && (
                        <span className={cn('inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded font-medium font-mono', typeInfo.cls)}>
                          <span dangerouslySetInnerHTML={{ __html: typeInfo.icon }} />
                          {r.type}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-[200px]">
                      {editable
                        ? <InlineDescription id={r.id} value={r.description ?? ''} onSave={onSaveDescription!} />
                        : (r.description
                          ? <span className="text-ink-2 leading-snug">{r.description}</span>
                          : <span className="text-muted-2 italic">No description yet</span>)}
                    </td>
                    {hasExtra && <td className="px-3 py-2.5 whitespace-nowrap">{r.extra}</td>}
                    <td className="px-3 py-2.5">
                      {r.terms && r.terms.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {r.terms.map((t) => (
                            <span
                              key={t}
                              title="Your team's word for this column (Definitions)"
                              className="inline-flex items-center gap-1 rounded bg-ocean-softer px-1.5 py-0.5 text-[10.5px] text-ocean"
                            >
                              <BookOpen className="w-3 h-3" strokeWidth={2} aria-hidden />
                              <span className="italic">{t}</span>
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </td>
                    {hasStatus && <td className="px-3 py-2.5 text-center">{r.status}</td>}
                  </tr>
                </RowGroup>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn('px-3 py-2.5 text-[11px] font-medium text-muted', className)}>{children}</th>
  );
}

/** A row plus, when open, its details row — kept together so keys stay stable. */
function RowGroup({ children, details, colSpan }: { children: React.ReactNode; details?: React.ReactNode; colSpan: number }) {
  return (
    <>
      {children}
      {details != null && (
        <tr className="bg-softer/40 border-b border-line/60">
          <td colSpan={colSpan} className="px-5 py-4">{details}</td>
        </tr>
      )}
    </>
  );
}

/**
 * The description, edited in place: type, leave the cell (or press Enter),
 * and it is saved. Escape puts the stored text back. A tick confirms the
 * save; a failure keeps the text and says so in the cell.
 */
function InlineDescription({ id, value, onSave }: { id: number; value: string; onSave: (id: number, text: string) => Promise<void> }) {
  const [text, setText] = useState(value);
  const [base, setBase] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // A new stored value from outside (a reload) replaces an untouched draft.
  if (value !== base) { setBase(value); if (text === base) setText(value); }

  const commit = async () => {
    if (text.trim() === base.trim()) return;
    setState('saving');
    try {
      await onSave(id, text.trim());
      setBase(text.trim());
      setState('saved');
      setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 1500);
    } catch {
      setState('error');
    }
  };

  return (
    <div className="relative">
      <input
        value={text}
        onChange={(e) => { setText(e.target.value); if (state === 'error') setState('idle'); }}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setText(base); (e.target as HTMLInputElement).blur(); }
        }}
        placeholder="Add a description…"
        aria-label="Description"
        className={cn(
          'w-full bg-transparent text-ink-2 placeholder:text-muted-2 rounded px-2 py-1 -ml-2 text-[12.5px] leading-snug transition-colors text-ellipsis',
          'focus:outline-none focus:bg-raised focus:ring-1 focus:ring-ocean/40',
          state === 'error' && 'ring-1 ring-err/50',
        )}
      />
      {state !== 'idle' && (
        <span className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none">
          {state === 'saving' && <Loader2 className="w-3 h-3 animate-spin text-muted-2" aria-label="Saving" />}
          {state === 'saved' && <Check className="w-3.5 h-3.5 text-ok" strokeWidth={2.5} aria-label="Saved" />}
          {state === 'error' && <span className="text-[10px] text-err">not saved</span>}
        </span>
      )}
    </div>
  );
}
