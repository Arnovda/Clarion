'use client';

/**
 * One proposal from the coworker, and the only place it becomes real.
 *
 * Every card leads with the EVIDENCE a person needs to decide — the diff and
 * whether it compiles, the measurement on the data, the links checked, what
 * would notice — and ends in Keep / Discard. Keep calls the same route the
 * screens call; after it, Undo where an inverse exists (a new subject is a
 * build, and is said to be one).
 *
 * ONE visual language for every change to something that exists: the old
 * text on a red line, struck through, the new text on a green line below it —
 * the same marks as the SQL diff. Until the person decides, the header says
 * "Waiting for you" and the footer says nothing is saved yet.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, CornerUpLeft, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import type { CoworkerFieldChange, CoworkerGridRow, CoworkerProposal } from '@/lib/contract';
import type { ProposalState } from '@/lib/coworker/CoworkerProvider';
import { collapseUnchanged, diffLines, diffStats } from '@/app/notebooks/[id]/diff';

const KIND_LABEL: Record<CoworkerProposal['kind'], string> = {
  sql: 'SQL change',
  relationship: 'New relationship',
  'relationship-review': 'Relationship',
  glossary: 'New definition',
  'glossary-edit': 'Definition',
  descriptions: 'Descriptions',
  metric: 'Metric',
  table: 'New table',
  subject: 'New subject',
  'first-build': 'First subjects',
  rebuild: 'Rebuild',
  'grid-new': 'New table of yours',
  'grid-rows': 'Your table',
};

/** What the Kept line says, where "Kept" is not the right word. */
const KEPT_WORD: Partial<Record<CoworkerProposal['kind'], string>> = {
  subject: 'Building now', 'first-build': 'Building now', rebuild: 'Rebuilt',
};

const CARDINALITY: Record<string, string> = {
  one_to_one: 'one to one',
  one_to_many: 'one to many',
  many_to_one: 'many to one',
  many_to_many: 'many to many',
};

const ROLE_WORD: Record<string, string> = { fact: 'Measures table', dimension: 'Lookup table', bridge: 'Bridge table' };

interface Props {
  state: ProposalState;
  onKeep: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  onRebuild?: () => void;
  onOpen?: () => void;
}

export default function ProposalCard({ state, onKeep, onDiscard, onUndo, onRebuild, onOpen }: Props) {
  const p = state.proposal;
  const decided = state.status === 'kept' || state.status === 'discarded' || state.status === 'undone' || state.status === 'expired';
  const waiting = state.status === 'pending' || state.status === 'failed';
  const keepBlocked = (p.kind === 'sql' && !p.compiled) || (p.kind === 'metric' && p.check.ran && !p.check.ok);
  const blockedWhy = p.kind === 'metric' ? 'The formula does not run yet — ask for a fix first' : 'It does not compile yet — ask for a fix first';
  const weak = (p.kind === 'relationship' && p.measurement.verdict !== 'strong')
    || (p.kind === 'relationship-review' && p.action === 'confirm' && !!p.measurement && p.measurement.verdict !== 'strong');

  return (
    <div className={`rounded-lg border bg-raised overflow-hidden transition-colors shadow-[0_1px_2px_rgba(15,32,45,0.06)] ${
      state.status === 'kept' ? 'border-ok' : state.status === 'pending' || state.status === 'failed' ? 'border-line-strong' : 'border-line'
    }`}>
      <div className={`px-3 py-2 flex items-center gap-2 border-b ${state.status === 'kept' ? 'bg-ok-soft border-line' : 'bg-ocean-softer border-line'}`}>
        <span className={`text-[10px] font-mono tracking-[0.1em] uppercase ${state.status === 'kept' ? 'text-ok' : 'text-ocean'}`}>
          {KIND_LABEL[p.kind]}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink-2 font-medium" title={titleOf(p)}>{titleOf(p)}</span>
        {waiting && (
          <span className="shrink-0 px-1.5 py-px rounded-full border border-ocean bg-raised text-[10px] text-ocean font-medium">Waiting for you</span>
        )}
        {onOpen && (
          <button type="button" onClick={onOpen} className="p-0.5 rounded text-muted-2 hover:text-ocean transition-colors" title="Show it in the catalog" aria-label="Show it in the catalog">
            <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className={`px-3 py-2.5 space-y-2 text-[12.5px] text-ink-2 ${decided && state.status !== 'kept' ? 'opacity-60' : ''}`}>
        {p.kind === 'sql' && <SqlBody p={p} />}
        {p.kind === 'relationship' && <RelationshipBody p={p} />}
        {p.kind === 'glossary' && <GlossaryBody p={p} />}
        {p.kind === 'table' && <TableBody p={p} />}
        {p.kind === 'subject' && <SubjectBody p={p} />}
        {p.kind === 'descriptions' && <DescriptionsBody p={p} />}
        {p.kind === 'metric' && <MetricBody p={p} />}
        {p.kind === 'glossary-edit' && <GlossaryEditBody p={p} />}
        {p.kind === 'relationship-review' && <RelationshipReviewBody p={p} />}
        {p.kind === 'rebuild' && <RebuildBody p={p} />}
        {p.kind === 'first-build' && <FirstBuildBody p={p} />}
        {p.kind === 'grid-new' && <GridNewBody p={p} />}
        {p.kind === 'grid-rows' && <GridRowsBody p={p} />}
      </div>

      {p.kind === 'sql' && state.status === 'kept' && onRebuild && <RebuildStrip state={state} onRebuild={onRebuild} />}

      <div className="px-3 py-2 border-t border-line bg-softer flex items-center gap-2 min-h-[40px]">
        {state.status === 'pending' || state.status === 'failed' ? (
          <>
            <button
              type="button"
              onClick={onKeep}
              disabled={keepBlocked}
              title={keepBlocked ? blockedWhy : 'Save it, through the same route the screen uses'}
              className="px-3 py-1 text-[12.5px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2.25} />
              {weak ? 'Keep anyway' : 'Keep'}
            </button>
            <button type="button" onClick={onDiscard} className="px-3 py-1 text-[12.5px] rounded-md border border-line text-muted hover:text-ink-2 hover:border-line-strong transition-colors">
              Discard
            </button>
            {state.error
              ? <span className="flex-1 min-w-0 text-[11.5px] text-err truncate" title={state.error}>{state.error}</span>
              : <span className="flex-1 min-w-0 text-right text-[11px] text-muted-2 truncate">Nothing is saved until you keep it</span>}
          </>
        ) : state.status === 'keeping' || state.status === 'undoing' ? (
          <span className="text-[12px] text-muted inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {state.status === 'undoing' ? 'Undoing…' : p.kind === 'rebuild' ? 'Building…' : 'Saving…'}
          </span>
        ) : state.status === 'kept' ? (
          <>
            <span className="text-[12px] text-ok font-medium inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} /> {KEPT_WORD[p.kind] ?? 'Kept'}
            </span>
            {state.followHref && (
              <a href={state.followHref} className="text-[12px] text-ocean hover:underline inline-flex items-center gap-1">
                {state.followLabel ?? 'Follow'} <ArrowRight className="w-3 h-3" />
              </a>
            )}
            <span className="flex-1" />
            {state.error && <span className="text-[11.5px] text-err truncate" title={state.error}>{state.error}</span>}
            {state.undo && (
              <button type="button" onClick={onUndo} className="text-[12px] text-muted hover:text-ink-2 inline-flex items-center gap-1 transition-colors">
                <CornerUpLeft className="w-3.5 h-3.5" /> Undo
              </button>
            )}
          </>
        ) : (
          <span className="text-[12px] text-muted">
            {state.status === 'undone' ? 'Undone — back as it was'
              : state.status === 'expired' ? 'Not decided — no longer open. Ask again for a fresh proposal.'
                : 'Discarded — nothing changed'}
          </span>
        )}
      </div>
    </div>
  );
}

function titleOf(p: CoworkerProposal): string {
  switch (p.kind) {
    case 'sql': return p.label;
    case 'relationship': return `${p.fromLabel} → ${p.toLabel}`;
    case 'relationship-review': return p.label;
    case 'glossary': return p.term;
    case 'glossary-edit': return p.term;
    case 'descriptions': return p.items.length === 1 ? p.items[0].label : `${p.items.length} tables and columns`;
    case 'metric': return p.name;
    case 'table': return p.tableName;
    case 'subject': return p.name;
    case 'first-build': return p.connectionName;
    case 'rebuild': return p.label;
    case 'grid-new': return p.name;
    case 'grid-rows': return p.gridName;
  }
}

function SqlBody({ p }: { p: Extract<CoworkerProposal, { kind: 'sql' }> }) {
  const [all, setAll] = useState(false);
  const lines = useMemo(() => diffLines(p.before, p.after), [p.before, p.after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const rows = useMemo(() => (all ? lines.map((line) => ({ line })) : collapseUnchanged(lines, 2)), [lines, all]);
  const users = [...p.impact.dashboards.map((d) => d.name), ...p.impact.savedQuestions.map((q) => q.question)];
  return (
    <>
      {p.summary && <p className="leading-relaxed">{p.summary}</p>}
      <div className="rounded-md border border-line overflow-hidden">
        <div className="px-2 py-1 flex items-center gap-2 bg-soft border-b border-line text-[10.5px] font-mono">
          <span className="text-ok">+{stats.added}</span>
          <span className="text-err">−{stats.removed}</span>
          <span className="flex-1" />
          {p.compiled
            ? <span className="text-ok inline-flex items-center gap-1"><Check className="w-3 h-3" strokeWidth={2.5} />compiles</span>
            : <span className="text-warn inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" />does not compile</span>}
        </div>
        <div className="max-h-56 overflow-auto font-mono text-[11px] leading-[1.55]">
          {rows.map((r, i) => ('gap' in r ? (
            <button key={`g${i}`} type="button" onClick={() => setAll(true)} className="block w-full text-left px-2 py-0.5 text-muted-2 bg-softer hover:text-ink-2">
              ⋯ {r.gap} unchanged line{r.gap === 1 ? '' : 's'}
            </button>
          ) : (
            <div
              key={i}
              className={`px-2 whitespace-pre ${r.line.kind === 'added' ? 'bg-ok-soft text-ink' : r.line.kind === 'removed' ? 'bg-err-soft text-ink-2 line-through decoration-err' : 'text-muted'}`}
            >
              <span className="select-none inline-block w-3 text-muted-2">{r.line.kind === 'added' ? '+' : r.line.kind === 'removed' ? '−' : ' '}</span>
              {r.line.text}
            </div>
          )))}
        </div>
      </div>
      {!p.compiled && p.error && <p className="text-[11.5px] font-mono text-warn break-words">{p.error}</p>}
      <p className="text-[11.5px] text-muted">
        {users.length
          ? <>Used by {users.slice(0, 3).map((u, i) => <span key={i}>{i ? ', ' : ''}<span className="text-ink-2">{u}</span></span>)}{users.length > 3 ? ` and ${users.length - 3} more` : ''} — check them after the rebuild.</>
          : 'Nothing else uses this table yet.'}
        {' '}Keeping saves it; the table then offers a rebuild to make it live.
      </p>
    </>
  );
}

type Measurement = Extract<CoworkerProposal, { kind: 'relationship' }>['measurement'];

function MeasurementBlock({ m }: { m: Measurement }) {
  const ratio = m.containment?.ratio;
  const pct = typeof ratio === 'number' ? Math.round(ratio * 100) : null;
  const tone = m.verdict === 'strong' ? 'ok' : m.verdict === 'weak' ? 'warn' : m.verdict === 'broken' ? 'err' : 'muted';
  const headline = m.verdict === 'strong' ? 'Holds in your data'
    : m.verdict === 'weak' ? 'Partly holds — worth a look'
      : m.verdict === 'broken' ? 'Does not hold in your data'
        : 'Could not be checked';
  return (
    <div className="rounded-md border border-line p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className={`text-[12px] font-medium ${tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'err' ? 'text-err' : 'text-muted'}`}>{headline}</span>
        <span className="flex-1" />
        {pct !== null && <span className="text-[11px] font-mono text-muted tabular-nums">{pct}% found</span>}
      </div>
      {pct !== null && (
        <div className="h-1.5 rounded-full bg-soft overflow-hidden">
          <div className={`h-full rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : 'bg-err'}`} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      )}
      <p className="text-[11.5px] text-muted">
        {m.containment ? `${m.containment.matchedDistinct.toLocaleString()} of ${m.containment.sampledDistinct.toLocaleString()} values found` : 'Measured on the synced data.'}
        {m.cardinality ? ` · ${CARDINALITY[m.cardinality.type] ?? m.cardinality.type}` : ''}
        {m.orphans && m.orphans.rows > 0 ? ` · ${m.orphans.rows.toLocaleString()} rows without a partner` : ''}
      </p>
    </div>
  );
}

function RelationshipBody({ p }: { p: Extract<CoworkerProposal, { kind: 'relationship' }> }) {
  return (
    <>
      <p className="leading-relaxed">{p.reason}</p>
      <MeasurementBlock m={p.measurement} />
    </>
  );
}

function GlossaryBody({ p }: { p: Extract<CoworkerProposal, { kind: 'glossary' }> }) {
  return (
    <>
      <p className="font-display text-[15px] text-ink leading-snug">{p.term}</p>
      <p className="leading-relaxed">{p.meaning}</p>
      {p.links.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.links.map((l, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full border border-line bg-soft text-[11px] font-mono text-ink-2">
              {l.kind === 'kpi' ? `metric: ${l.kpi}` : l.kind === 'table' ? l.table : `${l.table}.${l.column}`}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function TableBody({ p }: { p: Extract<CoworkerProposal, { kind: 'table' }> }) {
  return (
    <>
      <p className="text-[11.5px] text-muted">{ROLE_WORD[p.tableRole] ?? 'Table'} in <span className="text-ink-2">{p.productName}</span></p>
      <p className="leading-relaxed">{p.description}</p>
      <p className="text-[11.5px] text-muted">After Keep I draft its SQL — “{p.sqlInstruction}” — as a next proposal you review.</p>
    </>
  );
}

function SubjectBody({ p }: { p: Extract<CoworkerProposal, { kind: 'subject' }> }) {
  return (
    <>
      <p className="leading-relaxed">{p.description}</p>
      <p className="text-[11.5px] text-muted">From <span className="text-ink-2">{p.connectionName}</span>:</p>
      <div className="flex flex-wrap gap-1.5">
        {p.entities.map((e) => (
          <span key={e} className="px-2 py-0.5 rounded-full border border-line bg-soft text-[11px] font-mono text-ink-2">{e}</span>
        ))}
      </div>
      <p className="text-[11.5px] text-muted">Built next to your subjects — none of them change. Designing and building takes a few minutes.</p>
    </>
  );
}

// ─── the shared before → after ──────────────────────────────────────────────

/**
 * One changed thing: the old value on a red, struck-through line, the new one
 * on a green line — the SQL diff's marks, so every card reads the same way.
 * A value that did not exist yet shows only its green line; one that goes
 * away, only its red one.
 */
function Change({ label, before, after, mono }: { label?: string; before: string | null; after: string | null; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      {label && <p className="text-[10px] font-mono tracking-[0.08em] uppercase text-muted-2">{label}</p>}
      <div className={`rounded-md border border-line overflow-hidden leading-relaxed ${mono ? 'font-mono text-[11px]' : 'text-[12px]'}`}>
        {before !== null && before !== '' && (
          <div className="flex gap-1.5 px-2 py-1 bg-err-soft text-ink-2">
            <span className="select-none text-muted-2 font-mono" aria-hidden>−</span>
            <span className="sr-only">Now: </span>
            <span className="line-through decoration-err whitespace-pre-wrap break-words min-w-0">{before}</span>
          </div>
        )}
        {after !== null && after !== '' ? (
          <div className="flex gap-1.5 px-2 py-1 bg-ok-soft text-ink">
            <span className="select-none text-muted-2 font-mono" aria-hidden>+</span>
            <span className="sr-only">Becomes: </span>
            <span className="whitespace-pre-wrap break-words min-w-0">{after}</span>
          </div>
        ) : (
          <div className="px-2 py-1 text-[11.5px] text-muted italic">removed</div>
        )}
      </div>
    </div>
  );
}

function Changes({ changes }: { changes: CoworkerFieldChange[] }) {
  return <div className="space-y-2">{changes.map((c) => <Change key={c.field} label={c.field} before={c.before} after={c.after} mono={c.field === 'Formula'} />)}</div>;
}

const SHOW_FIRST = 6;

function DescriptionsBody({ p }: { p: Extract<CoworkerProposal, { kind: 'descriptions' }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? p.items : p.items.slice(0, SHOW_FIRST);
  const names = p.items.filter((i) => i.field === 'display_name').length;
  const descs = p.items.length - names;
  return (
    <>
      <p className="text-[11.5px] text-muted">
        {[descs && `${descs} description${descs === 1 ? '' : 's'}`, names && `${names} display name${names === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
      </p>
      <div className="space-y-2">
        {shown.map((it) => (
          <Change
            key={`${it.target}:${it.id}:${it.field}`}
            label={`${it.label}${it.field === 'display_name' ? ' · display name' : ''}`}
            before={it.before}
            after={it.after}
          />
        ))}
      </div>
      {p.items.length > SHOW_FIRST && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-[11.5px] text-ocean hover:underline">
          {all ? 'Show fewer' : `Show all ${p.items.length}`}
        </button>
      )}
    </>
  );
}

function MetricBody({ p }: { p: Extract<CoworkerProposal, { kind: 'metric' }> }) {
  return (
    <>
      <p className="text-[11.5px] text-muted">
        {p.kpiId === null ? 'A new metric in ' : 'A change to a metric in '}<span className="text-ink-2">{p.productName}</span>
      </p>
      <Changes changes={p.changes} />
      {p.check.ran ? (
        p.check.ok ? (
          <p className="text-[11.5px] text-ok inline-flex items-center gap-1.5">
            <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
            {p.check.value != null
              ? <span>The formula runs on your data — it gives <span className="font-mono tabular-nums text-ink">{p.check.value}</span></span>
              : 'The formula runs on your data.'}
          </p>
        ) : (
          <p className="text-[11.5px] text-warn flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>The formula does not run yet{p.check.error ? <>: <span className="font-mono break-words">{p.check.error}</span></> : '.'}</span>
          </p>
        )
      ) : (
        <p className="text-[11.5px] text-muted">No formula to run — it is described in words only.</p>
      )}
    </>
  );
}

function GlossaryEditBody({ p }: { p: Extract<CoworkerProposal, { kind: 'glossary-edit' }> }) {
  return <Changes changes={p.changes} />;
}

const REVIEW_WORD = { confirm: 'Confirm this relationship', flag: 'Flag it as not holding', unflag: 'Take the flag off' } as const;

function RelationshipReviewBody({ p }: { p: Extract<CoworkerProposal, { kind: 'relationship-review' }> }) {
  return (
    <>
      <p className="text-ink font-medium">{REVIEW_WORD[p.action]}</p>
      <p className="leading-relaxed">{p.reason}</p>
      <Changes changes={p.changes} />
      {p.measurement && <MeasurementBlock m={p.measurement} />}
      {p.action === 'confirm' && (
        <p className="text-[11.5px] text-muted">A confirmation cannot be undone here — if it turns out wrong, flag it.</p>
      )}
    </>
  );
}

function RebuildBody({ p }: { p: Extract<CoworkerProposal, { kind: 'rebuild' }> }) {
  return (
    <>
      <p className="leading-relaxed">{p.why}</p>
      <p className="text-[11.5px] text-muted">
        Builds <span className="text-ink-2">{p.label}</span> from its saved SQL. Afterwards its data — and Ask AI&apos;s answers — show the change. Usually takes under a minute.
      </p>
    </>
  );
}

function FirstBuildBody({ p }: { p: Extract<CoworkerProposal, { kind: 'first-build' }> }) {
  return (
    <>
      <p className="leading-relaxed">Creates the first subjects from <span className="text-ink-2">{p.connectionName}</span>{p.topics.length ? ':' : '.'}</p>
      {p.topics.length > 0 && (
        <ul className="space-y-1">
          {p.topics.map((t) => (
            <li key={t.name} className="flex gap-2">
              <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-ok shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="text-ink">{t.name}</span>
                {t.shared && <span className="ml-1.5 text-[10.5px] text-muted">shared lookups</span>}
                {t.description && <span className="block text-[11.5px] text-muted">{t.description}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11.5px] text-muted">
        {p.fromTemplate ? '' : 'Clarion designs them from what was synced. '}Designing and building takes a few minutes; you can follow it at the top of the Catalog.
      </p>
    </>
  );
}

const TYPE_WORD = { text: 'text', number: 'number', date: 'date', boolean: 'yes / no' } as const;
const GRID_KIND_WORD = { mapping: 'A mapping', budget: 'A budget', list: 'A list' } as const;

function GridNewBody({ p }: { p: Extract<CoworkerProposal, { kind: 'grid-new' }> }) {
  const linked = p.columns.find((c) => c.link);
  return (
    <>
      <p className="text-[11.5px] text-muted">{GRID_KIND_WORD[p.gridKind]} in Your tables</p>
      <p className="leading-relaxed">{p.description}</p>
      <div className="rounded-md border border-line divide-y divide-line">
        {p.columns.map((c) => (
          <div key={c.name} className="px-2 py-1 flex items-baseline gap-2 bg-softer">
            <span className="text-ink">{c.name}</span>
            <span className="text-[11px] text-muted">{TYPE_WORD[c.type]}</span>
            <span className="flex-1" />
            {c.link && <span className="text-[11px] font-mono text-ink-2 truncate">values of {c.link.table}.{c.link.column}</span>}
          </div>
        ))}
      </div>
      {p.seedFromLink && linked?.link && (
        <p className="text-[11.5px] text-muted">It starts with one row per {linked.link.column} value, ready to fill in.</p>
      )}
    </>
  );
}

const ROW_CAP = 20;

function cell(v: CoworkerGridRow[string] | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function GridRowsBody({ p }: { p: Extract<CoworkerProposal, { kind: 'grid-rows' }> }) {
  const [all, setAll] = useState(false);
  const count = (s: string) => p.diff.filter((d) => d.status === s).length;
  const rows = all ? p.diff : p.diff.slice(0, ROW_CAP);
  return (
    <>
      <p className="text-[11.5px] font-mono">
        {count('added') > 0 && <span className="text-ok mr-2">+{count('added')} added</span>}
        {count('changed') > 0 && <span className="text-ocean mr-2">{count('changed')} changed</span>}
        {count('removed') > 0 && <span className="text-err">−{count('removed')} removed</span>}
      </p>
      <div className="rounded-md border border-line overflow-auto max-h-64">
        <table className="w-full text-[11.5px]">
          <thead className="bg-soft text-muted sticky top-0">
            <tr>
              <th className="w-4" />
              {p.columns.map((c) => <th key={c.key} className="px-2 py-1 text-left font-medium whitespace-nowrap">{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((d, i) => (
              <tr key={i} className={`border-t border-line ${d.status === 'added' ? 'bg-ok-soft' : d.status === 'removed' ? 'bg-err-soft' : ''}`}>
                <td className="pl-2 text-muted-2 font-mono select-none" aria-label={d.status}>{d.status === 'added' ? '+' : d.status === 'removed' ? '−' : '~'}</td>
                {p.columns.map((c) => {
                  const b = d.before?.[c.key];
                  const a = d.after?.[c.key];
                  if (d.status === 'changed' && cell(b) !== cell(a)) {
                    return (
                      <td key={c.key} className="px-2 py-1 align-top">
                        <span className="block line-through decoration-err text-muted bg-err-soft rounded px-1">{cell(b)}</span>
                        <span className="block text-ink bg-ok-soft rounded px-1 mt-0.5">{cell(a)}</span>
                      </td>
                    );
                  }
                  return (
                    <td key={c.key} className={`px-2 py-1 align-top whitespace-nowrap ${d.status === 'removed' ? 'line-through decoration-err text-muted' : 'text-ink-2'}`}>
                      {cell(d.status === 'removed' ? b : a ?? b)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {p.diff.length > ROW_CAP && (
        <button type="button" onClick={() => setAll((v) => !v)} className="text-[11.5px] text-ocean hover:underline">
          {all ? 'Show fewer' : `Show all ${p.diff.length} changed rows`}
        </button>
      )}
    </>
  );
}

/**
 * After a SQL change is kept: it is saved, but the table still serves its old
 * result until it is rebuilt. Say so, and offer the rebuild right here.
 */
function RebuildStrip({ state, onRebuild }: { state: ProposalState; onRebuild: () => void }) {
  const r = state.rebuild;
  return (
    <div className={`px-3 py-2 border-t border-line flex items-center gap-2 text-[12px] ${r?.status === 'done' ? 'bg-ok-soft' : 'bg-ocean-softer'}`}>
      {r?.status === 'done' ? (
        <span className="text-ok inline-flex items-center gap-1.5"><Check className="w-3.5 h-3.5" strokeWidth={2.5} />Rebuilt — the change is live.</span>
      ) : r?.status === 'running' ? (
        <span className="text-muted inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Rebuilding the table…</span>
      ) : (
        <>
          <span className="flex-1 min-w-0 text-ink-2">
            {r?.status === 'failed'
              ? <span className="text-err" title={r.error}>The rebuild failed{r.error ? `: ${r.error}` : '.'}</span>
              : 'Saved. Your data shows the old result until the table is rebuilt.'}
          </span>
          <button type="button" onClick={onRebuild} className="shrink-0 px-2.5 py-1 rounded-md border border-ocean text-ocean hover:bg-raised inline-flex items-center gap-1.5 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" /> {r?.status === 'failed' ? 'Try again' : 'Rebuild now'}
          </button>
        </>
      )}
    </div>
  );
}
