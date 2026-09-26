'use client';

/**
 * One proposal from the coworker, and the only place it becomes real.
 *
 * Every card leads with the EVIDENCE a person needs to decide — the diff and
 * whether it compiles, the measurement on the data, the links checked, what
 * would notice — and ends in Keep / Discard. Keep calls the same route the
 * screens call; after it, Undo where an inverse exists (a new subject is a
 * build, and is said to be one).
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, CornerUpLeft, ExternalLink, Loader2 } from 'lucide-react';
import type { CoworkerProposal } from '@/lib/contract';
import type { ProposalState } from '@/lib/coworker/CoworkerProvider';
import { collapseUnchanged, diffLines, diffStats } from '@/app/notebooks/[id]/diff';

const KIND_LABEL: Record<CoworkerProposal['kind'], string> = {
  sql: 'SQL change',
  relationship: 'Relationship',
  glossary: 'Definition',
  table: 'New table',
  subject: 'New subject',
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
  onOpen?: () => void;
}

export default function ProposalCard({ state, onKeep, onDiscard, onUndo, onOpen }: Props) {
  const p = state.proposal;
  const decided = state.status === 'kept' || state.status === 'discarded' || state.status === 'undone' || state.status === 'expired';
  const keepBlocked = p.kind === 'sql' && !p.compiled;
  const weak = p.kind === 'relationship' && p.measurement.verdict !== 'strong';

  return (
    <div className={`rounded-lg border bg-raised overflow-hidden transition-colors shadow-[0_1px_2px_rgba(15,32,45,0.06)] ${
      state.status === 'kept' ? 'border-ok' : state.status === 'pending' || state.status === 'failed' ? 'border-line-strong' : 'border-line'
    }`}>
      <div className={`px-3 py-2 flex items-center gap-2 border-b ${state.status === 'kept' ? 'bg-ok-soft border-line' : 'bg-ocean-softer border-line'}`}>
        <span className={`text-[10px] font-mono tracking-[0.1em] uppercase ${state.status === 'kept' ? 'text-ok' : 'text-ocean'}`}>
          {KIND_LABEL[p.kind]}
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-ink-2 font-medium" title={titleOf(p)}>{titleOf(p)}</span>
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
      </div>

      <div className="px-3 py-2 border-t border-line bg-softer flex items-center gap-2 min-h-[40px]">
        {state.status === 'pending' || state.status === 'failed' ? (
          <>
            <button
              type="button"
              onClick={onKeep}
              disabled={keepBlocked}
              title={keepBlocked ? 'It does not compile yet — ask for a fix first' : 'Save it, through the same route the screen uses'}
              className="px-3 py-1 text-[12.5px] font-medium rounded-md text-white bg-ocean hover:bg-ocean-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2.25} />
              {weak ? 'Keep anyway' : 'Keep'}
            </button>
            <button type="button" onClick={onDiscard} className="px-3 py-1 text-[12.5px] rounded-md border border-line text-muted hover:text-ink-2 hover:border-line-strong transition-colors">
              Discard
            </button>
            {state.error && <span className="flex-1 min-w-0 text-[11.5px] text-err truncate" title={state.error}>{state.error}</span>}
          </>
        ) : state.status === 'keeping' || state.status === 'undoing' ? (
          <span className="text-[12px] text-muted inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {state.status === 'keeping' ? 'Saving…' : 'Undoing…'}
          </span>
        ) : state.status === 'kept' ? (
          <>
            <span className="text-[12px] text-ok font-medium inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} /> {p.kind === 'subject' ? 'Building now' : 'Kept'}
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
    case 'glossary': return p.term;
    case 'table': return p.tableName;
    case 'subject': return p.name;
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
          ? <>Used by {users.slice(0, 3).map((u, i) => <span key={i}>{i ? ', ' : ''}<span className="text-ink-2">{u}</span></span>)}{users.length > 3 ? ` and ${users.length - 3} more` : ''} — check them after the next rebuild.</>
          : 'Nothing else uses this table yet.'}
        {' '}Saving keeps the table serving; the change is built on the next rebuild.
      </p>
    </>
  );
}

function RelationshipBody({ p }: { p: Extract<CoworkerProposal, { kind: 'relationship' }> }) {
  const m = p.measurement;
  const ratio = m.containment?.ratio;
  const pct = typeof ratio === 'number' ? Math.round(ratio * 100) : null;
  const tone = m.verdict === 'strong' ? 'ok' : m.verdict === 'weak' ? 'warn' : m.verdict === 'broken' ? 'err' : 'muted';
  const headline = m.verdict === 'strong' ? 'Holds in your data'
    : m.verdict === 'weak' ? 'Partly holds — worth a look'
      : m.verdict === 'broken' ? 'Does not hold in your data'
        : 'Could not be checked';
  return (
    <>
      <p className="leading-relaxed">{p.reason}</p>
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
