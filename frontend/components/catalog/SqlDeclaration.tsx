'use client';

/**
 * <SqlDeclaration> — a product table's SQL, edited where it lives.
 *
 * ONE editor for the SELECT that builds a table, and ONE verb: Save. Save
 * validates (the guard, then a real compile in the warehouse) and stores the
 * SQL once, and keeps the notebook's deploy cell in step so nothing reverts
 * it later — the contract in docs/backlog/declarative-data-engineering.md
 * §3.4, served by PUT /products/tables/:id/sql. Preview runs the draft for a
 * few rows without storing anything. The columns under the editor are
 * DERIVED by the compile, never typed in.
 *
 * The assistant's proposals land here too, as a diff with Keep / Discard
 * (context: catalogAssistantContext). Keep is this component's own save.
 *
 * Mechanics that used to be buttons (Deploy, Run, Deploy-all) are gone: the
 * state is shown — "built 2 h ago · changed since, by Ines" — and the one
 * thing left to operate is "Rebuild now", offered only once a saved change is
 * waiting.
 *
 * The SQL is FORMATTED when it loads (owner, 2026-09-23: "format the SQL by
 * default"). The formatted text is the baseline, so opening a table never
 * reads as an unsaved change, and a proposal is formatted the same way before
 * it is diffed — otherwise every line would differ for whitespace alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { AlertTriangle, Check, Loader2, Play, RefreshCw, Sparkles, WandSparkles, X } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatSql } from '@/lib/formatSql';
import { formatRelative } from '@/lib/dates';
import { useToast } from '@/components/ui/Toast';
import { collapseUnchanged, diffLines, diffStats } from '@/app/notebooks/[id]/diff';
import { useSqlProposal, type DeclaredColumn } from './catalogAssistantContext';

const CellEditor = dynamic(() => import('@/components/notebooks/CellEditor'), { ssr: false });

interface Declaration {
  id: number;
  table_name: string;
  display_name: string | null;
  table_role: string | null;
  transformation_sql: string | null;
  transformation_status: string | null;
  last_run_at: string | null;
  last_run_error: string | null;
  row_count: number | null;
  degraded_reason: string | null;
  declared_by: string | null;
  declared_at: string | null;
  pending_rebuild: boolean;
  product: { id: number; name: string; connection_id: number | null };
  shared_from: { tableId: number; productId: number; productName: string } | null;
  columns: Array<{ id: number; column_name: string; display_name: string | null; data_type: string | null; column_role: string | null; description: string | null }>;
}

interface Preview { columns: string[]; rows: Record<string, unknown>[] }

function errorText(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error ?? e.message ?? fallback;
}

export default function SqlDeclaration({
  tableId, canRebuild,
}: {
  /** Postgres product_tables id. */
  tableId: number;
  /** Rebuild is offered to admins and analysts; the route allows both. */
  canRebuild: boolean;
}) {
  const toast = useToast();
  const { proposal, reportDraft, decide } = useSqlProposal(tableId);
  // Formatted like the editor's text, or the diff marks every line changed.
  const prettyProposal = useMemo(
    () => (proposal ? { ...proposal, sql: formatSql(proposal.sql) } : null),
    [proposal],
  );

  const [decl, setDecl] = useState<Declaration | null | undefined>(undefined);
  const [sql, setSql] = useState('');
  const [saved, setSaved] = useState('');
  const [columns, setColumns] = useState<DeclaredColumn[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Remount the editor when the text is replaced from OUTSIDE (a Keep, a
  // Format) — CellEditor owns its document after mount.
  const [editorKey, setEditorKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await api.get(`/products/tables/${tableId}/declaration`);
      const d = r.data?.data as Declaration;
      setDecl(d);
      // What is stored is often one long line, or the model's own layout.
      // Save stores what is in the editor; the formatter touches whitespace
      // and keyword case only, and unparseable SQL comes back verbatim.
      const pretty = formatSql(d.transformation_sql ?? '');
      setSql(pretty);
      setSaved(pretty);
      setColumns(d.columns.map((c) => ({ name: c.column_name, type: c.data_type ?? '' })));
      setEditorKey((k) => k + 1);
    } catch {
      setDecl(null);
    }
  }, [tableId]);

  useEffect(() => { void load(); }, [load]);

  // The assistant proposes against what is on screen, not what is stored.
  const draftRef = useRef(sql);
  draftRef.current = sql;
  useEffect(() => { reportDraft(tableId, sql); }, [tableId, sql, reportDraft]);

  const dirty = sql.trim() !== saved.trim();

  async function save(text: string): Promise<boolean> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.put(`/products/tables/${tableId}/sql`, { sql: text });
      const data = r.data?.data as { columns: DeclaredColumn[]; keeps_serving: boolean };
      setSaved(text);
      setSql(text);
      setColumns(data.columns);
      setDecl((d) => d ? { ...d, transformation_sql: text, pending_rebuild: true, declared_at: new Date().toISOString() } : d);
      setNotice(data.keeps_serving
        ? 'Saved. The table keeps serving its last build until you rebuild it.'
        : 'Saved. Rebuild to materialise it.');
      toast.success('Declaration saved');
      return true;
    } catch (err) {
      setError(errorText(err, 'Could not save'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    setPreview(null);
    try {
      const r = await api.post(`/products/tables/${tableId}/sql/preview`, { sql });
      setPreview(r.data?.data as Preview);
    } catch (err) {
      setError(errorText(err, 'Preview failed'));
    } finally {
      setPreviewing(false);
    }
  }

  async function rebuild() {
    setRebuilding(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post(`/products/tables/${tableId}/run`);
      const result = r.data?.data as { status?: string; error?: string; row_count?: number } | null;
      if (result?.status === 'success') {
        setNotice(`Rebuilt${typeof result.row_count === 'number' ? ` — ${result.row_count.toLocaleString('en-GB')} rows` : ''}.`);
        toast.success('Table rebuilt');
      } else {
        setError(result?.error ?? 'The rebuild did not succeed.');
      }
      await load();
    } catch (err) {
      setError(errorText(err, 'The rebuild failed'));
    } finally {
      setRebuilding(false);
    }
  }

  function format() {
    const pretty = formatSql(sql);
    if (pretty !== sql) { setSql(pretty); setEditorKey((k) => k + 1); }
  }

  async function keepProposal() {
    if (!prettyProposal) return;
    const ok = await save(prettyProposal.sql);
    if (ok) { setEditorKey((k) => k + 1); decide(prettyProposal.id, 'kept'); }
  }

  function discardProposal() {
    if (!proposal) return;
    decide(proposal.id, 'discarded');
  }

  if (decl === undefined) {
    return (
      <div className="flex items-center gap-2 px-6 py-6 text-[13px] text-muted">
        <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} aria-hidden /> Loading the declaration…
      </div>
    );
  }
  if (decl === null) {
    return <p className="px-6 py-6 text-[13px] text-err">Could not load this table&apos;s SQL.</p>;
  }

  if (decl.shared_from) {
    return (
      <div className="px-6 py-6">
        <div className="bg-raised border border-line rounded-lg p-5 text-[13px] text-ink-2 leading-relaxed">
          <p>
            <span className="font-medium text-ink">{decl.display_name || decl.table_name}</span> is shared data,
            built once in <span className="font-medium text-ink">{decl.shared_from.productName}</span> and used here.
            Change it there and every subject that uses it follows.
          </p>
          <Link
            href={`/catalog?tableId=${decl.shared_from.tableId}`}
            className="inline-flex items-center gap-1 mt-3 text-[12.5px] font-medium text-ocean hover:text-ocean-hover transition-colors"
          >
            Open it in {decl.shared_from.productName} →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-4">
      {/* State line + the one verb. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-[12px] text-muted flex-1 min-w-[200px]">
          <StateLine decl={decl} />
        </p>
        <div className="flex items-center gap-2">
          <ToolbarButton onClick={format} disabled={!sql.trim()} title="Tidy the SQL again after editing (it is formatted when it loads)">
            <WandSparkles className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden /> Format
          </ToolbarButton>
          <ToolbarButton onClick={runPreview} disabled={!sql.trim() || previewing} title="Run the draft for a few rows — nothing is stored">
            {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden /> : <Play className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />}
            Preview
          </ToolbarButton>
          {canRebuild && decl.pending_rebuild && !dirty && (
            <ToolbarButton onClick={rebuild} disabled={rebuilding} title="Build the table from the saved SQL now">
              {rebuilding ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden /> : <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} aria-hidden />}
              Rebuild now
            </ToolbarButton>
          )}
          <button
            type="button"
            onClick={() => void save(sql)}
            disabled={!dirty || saving || !sql.trim()}
            title="Checks that the SQL is read-only and compiles against your data, then stores it. Nothing is rebuilt until you say so."
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-medium bg-ocean text-white rounded-md hover:bg-ocean-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} aria-hidden /> : <Check className="w-3.5 h-3.5" strokeWidth={2.5} aria-hidden />}
            Save
          </button>
        </div>
      </div>

      {decl.degraded_reason && (
        <p className="flex items-start gap-2 text-[12.5px] text-warn bg-warn-soft border border-line rounded-md px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden />
          <span>{decl.degraded_reason}</span>
        </p>
      )}

      {/* The assistant's proposal — ON the declaration, decided here. */}
      {prettyProposal && (
        <ProposalDiff
          previous={sql}
          proposal={prettyProposal}
          saving={saving}
          onKeep={() => void keepProposal()}
          onDiscard={discardProposal}
        />
      )}

      {/* The editor. */}
      <div className={cn('rounded-md border bg-raised overflow-hidden', proposal ? 'border-line opacity-60 pointer-events-none' : 'border-line focus-within:border-ocean')}>
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-line bg-softer">
          <span className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">
            {decl.table_role === 'fact' ? 'Measures' : 'Lookup'} · {decl.table_name}
          </span>
          {dirty && !proposal && <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-warn">unsaved</span>}
        </div>
        <div className="min-h-[220px]">
          <CellEditor
            key={editorKey}
            value={sql}
            onChange={setSql}
            language="sql"
            placeholder="SELECT … — the query that builds this table"
            readOnly={!!proposal}
          />
        </div>
      </div>

      {error && (
        <p className="flex items-start gap-2 text-[12.5px] text-err bg-err-soft border border-line rounded-md px-3 py-2">
          <X className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden />
          <span className="font-mono text-[12px] break-words">{error}</span>
        </p>
      )}
      {notice && !error && (
        <p className="flex items-start gap-2 text-[12.5px] text-ok">
          <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2.5} aria-hidden />
          <span>{notice}</span>
        </p>
      )}

      {/* Preview rows. */}
      {preview && (
        <section className="bg-raised border border-line rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-softer">
            <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted">
              Preview · first {preview.rows.length} {preview.rows.length === 1 ? 'row' : 'rows'}
            </p>
            <button type="button" onClick={() => setPreview(null)} className="text-[10px] font-mono uppercase tracking-[0.08em] text-muted-2 hover:text-ink-2">
              Hide
            </button>
          </div>
          {preview.rows.length === 0 ? (
            <p className="px-4 py-3 text-[12.5px] text-muted">The query ran and returned no rows.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr className="border-b border-line">
                    {preview.columns.map((c) => (
                      <th key={c} className="text-left px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted whitespace-nowrap">{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      {preview.columns.map((c) => (
                        <td key={c} className="px-3 py-1.5 text-ink-2 whitespace-nowrap max-w-[240px] truncate">{cellText(row[c])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Derived columns — what the compile says the table will have. */}
      {columns && columns.length > 0 && (
        <section>
          <p className="text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-2">
            Columns · derived from the SQL
          </p>
          <div className="flex flex-wrap gap-1.5">
            {columns.map((c) => (
              <span key={c.name} className="inline-flex items-baseline gap-1.5 rounded-md border border-line bg-raised px-2 py-1 text-[12px]">
                <span className="font-mono text-ink-2">{c.name}</span>
                {c.type && <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-2">{c.type}</span>}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function StateLine({ decl }: { decl: Declaration }) {
  const built = decl.last_run_at ? `built ${formatRelative(decl.last_run_at)}` : 'not built yet';
  const rows = decl.row_count != null ? ` · ${decl.row_count.toLocaleString('en-GB')} rows` : '';
  const by = decl.declared_by ? ` by ${decl.declared_by}` : '';
  if (decl.transformation_status === 'error' || decl.transformation_status === 'failed') {
    return <><span className="text-err">last build failed</span>{decl.last_run_error ? ` — ${decl.last_run_error.slice(0, 160)}` : ''}</>;
  }
  if (decl.pending_rebuild) {
    return <>{built}{rows} · <span className="text-warn">changed since{by ? `,${by}` : ''}{decl.declared_at ? ` · ${formatRelative(decl.declared_at)}` : ''}</span></>;
  }
  return <>{built}{rows}{decl.declared_at ? ` · declared${by} ${formatRelative(decl.declared_at)}` : ''}</>;
}

function ToolbarButton({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium text-ink-2 border border-line rounded-md bg-raised hover:bg-softer hover:border-line-strong disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

function cellText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The proposed change, where it would land: what goes, what comes, two buttons. */
function ProposalDiff({
  previous, proposal, saving, onKeep, onDiscard,
}: {
  previous: string;
  proposal: { sql: string; summary: string; compiled: boolean; error?: string | null };
  saving: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => diffLines(previous, proposal.sql), [previous, proposal.sql]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const rows = useMemo(() => (showAll ? lines.map((line) => ({ line })) : collapseUnchanged(lines, 3)), [lines, showAll]);

  return (
    <section className="rounded-md border border-ocean/40 bg-raised overflow-hidden" aria-label="Suggested change">
      <div className="flex items-center gap-2 px-3 py-2 bg-ocean-softer border-b border-line">
        <Sparkles className="w-3.5 h-3.5 text-ocean shrink-0" strokeWidth={2} aria-hidden />
        <span className="text-[11px] font-mono uppercase tracking-[0.08em] text-ocean">Suggested change</span>
        <span className="text-[11px] font-mono text-muted-2 tabular-nums">
          {stats.unchanged ? 'identical to your SQL' : `+${stats.added} −${stats.removed}`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-ink-2 border border-line bg-raised hover:border-err hover:text-err disabled:opacity-50 transition-colors"
        >
          <X className="w-3 h-3" strokeWidth={2.5} aria-hidden /> Discard
        </button>
        <button
          type="button"
          onClick={onKeep}
          disabled={saving || stats.unchanged}
          title={proposal.compiled ? 'Keep — this saves the SQL' : 'The proposal did not compile; keeping it stores it anyway'}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium text-white bg-ocean hover:bg-ocean-hover disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} aria-hidden /> : <Check className="w-3 h-3" strokeWidth={3} aria-hidden />}
          Keep
        </button>
      </div>
      {proposal.summary && (
        <p className="px-3 py-2 text-[12.5px] text-ink-2 border-b border-line">{proposal.summary}</p>
      )}
      {!proposal.compiled && (
        <p className="flex items-start gap-2 px-3 py-2 text-[12px] text-warn border-b border-line bg-warn-soft">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" strokeWidth={2} aria-hidden />
          <span>This does not compile{proposal.error ? `: ${proposal.error}` : ''} — read it before you keep it.</span>
        </p>
      )}
      {stats.unchanged ? (
        <p className="px-4 py-3 text-[12px] text-muted">The assistant came back with the SQL you already have — nothing to change.</p>
      ) : (
        <div className="max-h-[420px] overflow-auto font-mono text-[12px] leading-[1.55]">
          {rows.map((row, i) => {
            if ('gap' in row) {
              return (
                <button
                  key={`gap-${i}`}
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="w-full text-left px-3 py-1 text-[11px] text-muted-2 bg-softer hover:bg-soft border-y border-line transition-colors"
                >
                  ⋯ {row.gap} unchanged {row.gap === 1 ? 'line' : 'lines'}
                </button>
              );
            }
            const { kind, text, oldNumber, newNumber } = row.line;
            const tone = kind === 'added' ? 'bg-ok-soft text-ink' : kind === 'removed' ? 'bg-err-soft text-ink' : 'text-ink-2';
            return (
              <div key={`l-${i}`} className={`flex ${tone}`}>
                <span className="w-9 shrink-0 px-1 text-right text-muted-2 select-none tabular-nums">{oldNumber ?? ''}</span>
                <span className="w-9 shrink-0 px-1 text-right text-muted-2 select-none tabular-nums border-r border-line">{newNumber ?? ''}</span>
                <span className={`w-4 shrink-0 text-center select-none ${kind === 'added' ? 'text-ok' : kind === 'removed' ? 'text-err' : 'text-transparent'}`}>
                  {kind === 'added' ? '+' : kind === 'removed' ? '−' : ' '}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words pr-3">{text || ' '}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
