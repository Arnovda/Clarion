'use client';

/**
 * <ManageTables> — the Tables tab inside Manage mode.
 *
 * Two panes. LEFT (320px): the topic's own measure tables, each with the
 * QUESTION IT ANSWERS as its second line, then the shared lookups as
 * read-only pills. Lookups are deliberately not editable here — they are
 * owned by Shared data, and letting one topic edit a dimension that four
 * other topics read is the exact confusion Shared data exists to remove.
 *
 * RIGHT: the selected table. Leads with a plain-language explanation of how
 * it is built; SQL is the appendix, collapsed by default.
 *
 * SQL VISIBILITY: everything in this file is behind Manage mode, which is
 * analyst+ only. Do not lift any of it — especially the SQL panel or the
 * provenance trail — onto a surface a viewer can reach.
 */

import { useEffect, useMemo, useState } from 'react';
import { Code2, Loader2, Sparkles } from 'lucide-react';
import { format as sqlFormatter } from 'sql-formatter';
import api from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/dates';
import { useToast } from '@/components/ui/Toast';
import { RoleBadge, ColumnRoleBadge } from '@/app/products/badges';
import { extractProvenance, englishList } from '@/lib/sqlProvenance';
import type {
  FullDataProduct, ProductColumn, ProductRelationship, ProductTable,
} from '@/app/products/types';
import type { TableSubTab, TopicQuestion } from '@/app/topics/types';

type TableWithColumns = ProductTable & { columns: ProductColumn[] };

interface Props {
  detail: FullDataProduct;
  questions: TopicQuestion[];
  /** admin — the SQL editor and Run are admin-gated on the API. */
  isAdmin: boolean;
  selectedTableId: number | null;
  onSelectTable: (id: number) => void;
  subTab: TableSubTab;
  onSubTab: (t: TableSubTab) => void;
  sqlOpen: boolean;
  onSqlOpen: (open: boolean) => void;
  onRefineTable: (table: TableWithColumns) => void;
  onChanged: () => void;
}

function allTables(detail: FullDataProduct): TableWithColumns[] {
  return detail.star_schemas
    .flatMap((s) => s.tables)
    .sort((a, b) => a.dag_order - b.dag_order || a.table_name.localeCompare(b.table_name));
}

function allRelationships(detail: FullDataProduct): ProductRelationship[] {
  return detail.star_schemas.flatMap((s) => s.relationships);
}

function label(t: ProductTable): string {
  return t.display_name ?? t.table_name;
}

/** Health dot for a table: last run status, then its quality checks. */
function dotClass(t: ProductTable): string {
  if (t.transformation_status === 'error') return 'bg-err';
  const failed = (t.quality_checks ?? []).some((c) => c.status === 'fail' || c.status === 'error');
  if (failed) return 'bg-warn';
  if (t.transformation_status === 'success') return 'bg-ok';
  return 'bg-line-strong';
}

/**
 * Pair each measure table with a question it answers, so the left pane says
 * what a table is FOR rather than what it is called. Matched by name
 * similarity against the topic's stored questions — nothing invented: a
 * table with no plausible question simply shows none.
 */
function questionFor(t: ProductTable, questions: TopicQuestion[]): string | null {
  const haystack = `${t.table_name} ${t.display_name ?? ''} ${t.description ?? ''}`.toLowerCase();
  const scored = questions
    .filter((q) => !q.derived)
    .map((q) => {
      const words = q.text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const hits = words.filter((w) => haystack.includes(w)).length;
      return { q, hits };
    })
    .sort((a, b) => b.hits - a.hits);
  return scored[0] && scored[0].hits > 0 ? scored[0].q.text : null;
}

export default function ManageTables({
  detail, questions, isAdmin,
  selectedTableId, onSelectTable,
  subTab, onSubTab,
  sqlOpen, onSqlOpen,
  onRefineTable, onChanged,
}: Props) {
  const toast = useToast();
  const tables = useMemo(() => allTables(detail), [detail]);
  const measures = tables.filter((t) => t.table_role !== 'dimension');
  const lookups = tables.filter((t) => t.table_role === 'dimension');
  const relationships = useMemo(() => allRelationships(detail), [detail]);

  const selected = tables.find((t) => t.id === selectedTableId) ?? measures[0] ?? tables[0] ?? null;

  // Auto-select the first measure so the right pane is never empty on entry.
  useEffect(() => {
    if (selectedTableId === null && selected) onSelectTable(selected.id);
  }, [selectedTableId, selected, onSelectTable]);

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── Left pane ─────────────────────────────────────────────────── */}
      <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface">
        <div className="border-b border-line px-[18px] py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
          Measures — {measures.length}
        </div>
        {measures.map((t) => {
          const q = questionFor(t, questions);
          const active = selected?.id === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelectTable(t.id)}
              className={cn(
                'flex items-start gap-2.5 border-b border-softer px-[18px] py-3 text-left transition-colors duration-1 ease-observatory',
                active ? 'border-l-2 border-l-ocean bg-raised' : 'hover:bg-softer',
              )}
            >
              <span className={cn('mt-[5px] h-2 w-2 shrink-0 rounded-full', dotClass(t))} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13.5px]', active ? 'font-medium text-ink' : 'text-ink-2')}>
                  {label(t)}
                </span>
                {q && (
                  <span className="mt-px block truncate text-[12px] text-muted">
                    Answers “{q}”
                  </span>
                )}
              </span>
              {t.row_count != null && (
                <span className="mt-0.5 shrink-0 font-mono text-[10.5px] tabular-nums text-muted-2">
                  {t.row_count.toLocaleString('en-GB')}
                </span>
              )}
            </button>
          );
        })}

        <div className="flex items-center gap-2 border-y border-line px-[18px] py-2.5">
          <span className="flex-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">
            Shared lookups — {lookups.length}
          </span>
          <a href="/shared-data" className="text-[11.5px] text-ocean hover:underline">
            Edit in Shared data
          </a>
        </div>
        <div className="flex flex-wrap gap-1.5 px-[18px] py-3.5">
          {lookups.length === 0 && (
            <span className="text-[12px] text-muted">No shared lookups yet.</span>
          )}
          {lookups.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-raised px-[9px] py-[5px] text-[12px] text-muted"
              title="Shared lookups are edited in Shared data"
            >
              {label(t)}
              {t.row_count != null && (
                <span className="font-mono text-[10.5px] tabular-nums text-muted-2">
                  {t.row_count.toLocaleString('en-GB')}
                </span>
              )}
            </span>
          ))}
        </div>
      </div>

      {/* ── Right pane ────────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-[26px] pt-5">
        {!selected ? (
          <p className="text-[13px] italic text-muted">Nothing has been built for this topic yet.</p>
        ) : (
          <TableDetail
            key={selected.id}
            table={selected}
            relationships={relationships}
            tables={tables}
            isAdmin={isAdmin}
            subTab={subTab}
            onSubTab={onSubTab}
            sqlOpen={sqlOpen}
            onSqlOpen={onSqlOpen}
            onRefine={() => onRefineTable(selected)}
            onChanged={onChanged}
            toastError={(title, description) => toast.error(title, { description })}
            toastSuccess={(title, description) => toast.success(title, { description })}
          />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function TableDetail({
  table, relationships, tables, isAdmin,
  subTab, onSubTab, sqlOpen, onSqlOpen, onRefine, onChanged,
  toastError, toastSuccess,
}: {
  table: TableWithColumns;
  relationships: ProductRelationship[];
  tables: TableWithColumns[];
  isAdmin: boolean;
  subTab: TableSubTab;
  onSubTab: (t: TableSubTab) => void;
  sqlOpen: boolean;
  onSqlOpen: (open: boolean) => void;
  onRefine: () => void;
  onChanged: () => void;
  toastError: (title: string, description?: string) => void;
  toastSuccess: (title: string, description?: string) => void;
}) {
  const rels = relationships.filter(
    (r) => r.from_table_name === table.table_name || r.to_table_name === table.table_name,
  );
  const checks = table.quality_checks ?? [];
  const passing = checks.filter((c) => c.status === 'pass').length;

  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [editingSql, setEditingSql] = useState<string | null>(null);
  const [savingSql, setSavingSql] = useState(false);
  const [editingSummary, setEditingSummary] = useState<string | null>(null);
  const [savingSummary, setSavingSummary] = useState(false);

  // Provenance is read off the SQL, and the joined relations are relabelled
  // with the display name of whichever product table they resolve to — so a
  // trail reads "Date, Accounts, GL accounts", not "dim_date, dim_accounts".
  const provenance = useMemo(() => extractProvenance(table.transformation_sql), [table.transformation_sql]);
  const joinLabels = useMemo(() => {
    const byName = new Map(tables.map((t) => [t.table_name.toLowerCase(), t]));
    return provenance.joins.map((j) => {
      const bare = j.includes('.') ? j.split('.').pop()! : j;
      const hit = byName.get(bare.toLowerCase());
      return hit ? label(hit) : bare;
    });
  }, [provenance.joins, tables]);

  /**
   * The plain-language explanation. A curator-written `plain_summary` wins;
   * otherwise a sentence derived from the provenance. The fallback is
   * deliberately a real sentence rather than a "not documented yet" stub —
   * the card's job is to explain the table, and the provenance genuinely
   * does explain it.
   */
  const summary = (table.plain_summary ?? '').trim() || (
    provenance.from
      ? joinLabels.length > 0
        ? `Built from ${provenance.from}, joined to ${englishList(joinLabels)} so you can slice by any of them.`
        : `Built from ${provenance.from}.`
      : 'How this table is built has not been described yet.'
  );

  async function handleRun() {
    setRunning(true);
    try {
      await api.post(`/products/tables/${table.id}/run`);
      toastSuccess('Rebuilt', label(table));
      onChanged();
    } catch (err) {
      toastError('Rebuild failed', apiError(err));
    } finally {
      setRunning(false);
    }
  }

  async function handlePreview() {
    setPreviewing(true);
    try {
      // Reads the BUILT table — materialises nothing and runs no user SQL.
      const res = await api.get('/semantic/product-preview', {
        params: { productTableId: table.id, limit: 20 },
      });
      const data = res.data?.data as { columns?: string[]; rows?: Record<string, unknown>[] } | undefined;
      setPreview({ columns: data?.columns ?? [], rows: data?.rows ?? [] });
    } catch (err) {
      toastError('Preview failed', apiError(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function saveSql() {
    if (editingSql === null) return;
    setSavingSql(true);
    try {
      await api.put(`/products/tables/${table.id}/sql`, { sql: editingSql });
      setEditingSql(null);
      toastSuccess('SQL saved', 'Deploy to rebuild the table from it.');
      onChanged();
    } catch (err) {
      toastError('Could not save SQL', apiError(err));
    } finally {
      setSavingSql(false);
    }
  }

  async function saveSummary() {
    if (editingSummary === null) return;
    setSavingSummary(true);
    try {
      await api.patch(`/products/tables/${table.id}`, { plain_summary: editingSummary.trim() || null });
      setEditingSummary(null);
      onChanged();
    } catch (err) {
      toastError('Could not save the description', apiError(err));
    } finally {
      setSavingSummary(false);
    }
  }

  const formattedSql = useMemo(() => {
    const raw = table.transformation_sql ?? '';
    try { return sqlFormatter(raw, { language: 'duckdb' }); } catch { return raw; }
  }, [table.transformation_sql]);

  return (
    <>
      {/* Header */}
      <div className="mb-3.5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className="font-display text-[20px] tracking-[-0.01em] text-ink">{label(table)}</span>
            <RoleBadge role={table.table_role} />
          </div>
          <div className="mt-[3px] text-[12.5px] text-muted">
            {[
              table.description,
              table.last_run_at ? `rebuilt ${formatRelative(table.last_run_at)}` : 'never rebuilt',
              checks.length > 0 ? `${passing} of ${checks.length} checks passing` : null,
            ].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={handlePreview}
            disabled={previewing || !isAdmin}
            title={isAdmin ? undefined : 'Reading warehouse rows is an admin action'}
            className="whitespace-nowrap rounded-sm border border-line bg-raised px-[11px] py-1.5 text-[12.5px] text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean disabled:opacity-50"
          >
            {previewing ? 'Loading…' : 'Preview rows'}
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={running || !isAdmin}
            title={isAdmin ? undefined : 'Rebuilding a table is an admin action'}
            className="whitespace-nowrap rounded-sm border border-line bg-raised px-[11px] py-1.5 text-[12.5px] text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : 'Run'}
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="mb-4 flex gap-0.5 border-b border-line">
        <SubTab active={subTab === 'built'} onClick={() => onSubTab('built')}>How it&apos;s built</SubTab>
        <SubTab active={subTab === 'columns'} onClick={() => onSubTab('columns')} count={table.columns.length}>Columns</SubTab>
        <SubTab active={subTab === 'relationships'} onClick={() => onSubTab('relationships')} count={rels.length}>Relationships</SubTab>
        <SubTab active={subTab === 'quality'} onClick={() => onSubTab('quality')}>Quality</SubTab>
      </div>

      {subTab === 'built' && (
        <div className="mb-6 flex flex-col gap-4 rounded-[10px] border border-line bg-raised px-[22px] py-5">
          {/* 1 — plain language first */}
          {editingSummary !== null ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={editingSummary}
                onChange={(e) => setEditingSummary(e.target.value)}
                rows={3}
                autoFocus
                className="w-full resize-y rounded-sm border border-line bg-surface px-3 py-2 text-[15px] leading-[1.6] text-ink focus:border-ocean focus:outline-none"
                placeholder="Explain in plain language what this table contains."
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveSummary}
                  disabled={savingSummary}
                  className="rounded-sm bg-ocean px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-ocean-hover disabled:opacity-50"
                >
                  {savingSummary ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingSummary(null)}
                  className="rounded-sm px-3 py-1.5 text-[12.5px] text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="group/summary flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[15px] leading-[1.6] text-ink [text-wrap:pretty]">{summary}</p>
              <button
                type="button"
                onClick={() => setEditingSummary((table.plain_summary ?? '').trim() || summary)}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-muted-2 opacity-0 transition-opacity duration-1 hover:text-ocean focus-visible:opacity-100 group-hover/summary:opacity-100"
              >
                Edit
              </button>
            </div>
          )}

          {/* 2 — provenance trail */}
          {provenance.from && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">From</span>
              <span className="rounded-[5px] bg-softer px-[9px] py-1 font-mono text-[11.5px] text-ink-2">
                {provenance.from}
              </span>
              {joinLabels.length > 0 && (
                <span className="text-line-strong" aria-hidden>→</span>
              )}
              {joinLabels.map((j) => (
                <span key={j} className="rounded-[5px] bg-ocean-softer px-[9px] py-1 text-[12px] text-ocean">
                  {j}
                </span>
              ))}
            </div>
          )}

          {/* 3 — actions */}
          <div className="flex flex-wrap items-center gap-2 border-t border-softer pt-1">
            <button
              type="button"
              onClick={() => onSqlOpen(!sqlOpen)}
              className="flex items-center gap-[7px] whitespace-nowrap rounded-sm border border-line bg-raised px-[11px] py-[7px] text-[12.5px] text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean"
            >
              <Code2 className="h-[13px] w-[13px]" strokeWidth={1.75} aria-hidden />
              {sqlOpen ? 'Hide SQL' : 'Show SQL'}
            </button>
            <button
              type="button"
              onClick={onRefine}
              className="flex items-center gap-[7px] whitespace-nowrap rounded-sm border border-line bg-raised px-[11px] py-[7px] text-[12.5px] text-ink-2 transition-colors duration-1 ease-observatory hover:border-ocean hover:text-ocean"
            >
              <Sparkles className="h-[13px] w-[13px] text-ocean" strokeWidth={1.75} aria-hidden />
              Ask AI to change it
            </button>
            <span className="ml-auto text-[11.5px] text-muted-2">Business users never see this tab.</span>
          </div>

          {/* 4 — SQL, collapsed by default */}
          {sqlOpen && (
            <div className="overflow-hidden rounded-lg bg-ink">
              <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/60">
                  {table.table_name}.sql
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/40">
                  {table.load_mode ?? 'full'} · {isAdmin ? 'edit to override' : 'read-only'}
                </span>
              </div>
              {editingSql !== null ? (
                <div className="flex flex-col gap-2 p-3.5">
                  <textarea
                    value={editingSql}
                    onChange={(e) => setEditingSql(e.target.value)}
                    rows={16}
                    spellCheck={false}
                    className="w-full resize-y rounded-sm border border-white/15 bg-transparent p-2 font-mono text-[11.5px] leading-[1.7] text-white/90 focus:border-white/40 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveSql}
                      disabled={savingSql}
                      className="rounded-sm bg-white px-3 py-1.5 text-[12.5px] font-medium text-ocean disabled:opacity-50"
                    >
                      {savingSql ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingSql(null)}
                      className="rounded-sm px-3 py-1.5 text-[12.5px] text-white/60 hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="relative">
                  <pre className="overflow-x-auto p-3.5 font-mono text-[11.5px] leading-[1.7] text-white/80">
                    {formattedSql || '— no transformation yet —'}
                  </pre>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setEditingSql(table.transformation_sql ?? '')}
                      className="absolute right-3 top-2.5 rounded-sm border border-white/20 px-2 py-1 text-[11px] text-white/70 hover:border-white/50 hover:text-white"
                    >
                      Edit
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {subTab === 'columns' && (
        <div className="mb-6 overflow-hidden rounded-[10px] border border-line bg-raised">
          {table.columns.length === 0 ? (
            <p className="px-5 py-4 text-[13px] italic text-muted">No columns yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line text-[10px] uppercase tracking-[0.12em] text-muted-2">
                  <th className="px-5 py-2.5 font-mono font-normal">Column</th>
                  <th className="px-5 py-2.5 font-mono font-normal">Type</th>
                  <th className="px-5 py-2.5 font-mono font-normal">Role</th>
                  <th className="px-5 py-2.5 font-mono font-normal">Description</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((c) => (
                  <tr key={c.id} className="border-b border-softer last:border-0">
                    <td className="px-5 py-2 text-[12.5px] text-ink">{c.display_name ?? c.column_name}</td>
                    <td className="px-5 py-2 font-mono text-[11.5px] text-muted-2">{c.data_type ?? '—'}</td>
                    <td className="px-5 py-2"><ColumnRoleBadge role={c.column_role} /></td>
                    <td className="px-5 py-2 text-[12.5px] text-muted">{c.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {subTab === 'relationships' && (
        <div className="mb-6 flex flex-col gap-2">
          {rels.length === 0 ? (
            <p className="text-[13px] italic text-muted">This table joins to nothing yet.</p>
          ) : rels.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised px-4 py-3 text-[12.5px]">
              <span className="font-mono text-[11.5px] text-ink-2">{r.from_table_name}.{r.from_column_name}</span>
              <span className="text-line-strong" aria-hidden>→</span>
              <span className="font-mono text-[11.5px] text-ink-2">{r.to_table_name}.{r.to_column_name}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2">
                {r.relationship_type}
              </span>
            </div>
          ))}
        </div>
      )}

      {subTab === 'quality' && (
        <div className="mb-6 flex flex-col gap-2">
          {checks.length === 0 ? (
            <p className="text-[13px] italic text-muted">No checks have run against this table yet.</p>
          ) : checks.map((c) => (
            <div key={c.id} className="flex items-start gap-3 rounded-lg border border-line bg-raised px-4 py-3">
              <span
                className={cn(
                  'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                  c.status === 'pass' ? 'bg-ok' : c.status === 'skip' ? 'bg-line-strong' : 'bg-err',
                )}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="text-[12.5px] text-ink">{c.check_type === 'bk_uniqueness' ? 'Every row is unique' : 'No unexpected row multiplication'}</div>
                <div className="mt-0.5 text-[12px] text-muted">{c.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview overlay — rows only, no SQL. */}
      {preview && (
        <div className="mb-6 overflow-hidden rounded-[10px] border border-line bg-raised">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-2">
              Preview — {preview.rows.length} rows
            </span>
            <button type="button" onClick={() => setPreview(null)} className="text-[11.5px] text-muted hover:text-ink">
              Close
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  {preview.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-b border-softer last:border-0">
                    {preview.columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-3 py-1.5 text-[12px] text-ink-2">
                        {row[c] === null || row[c] === undefined ? '—' : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function SubTab({
  active, onClick, count, children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative whitespace-nowrap px-3 py-2 text-[12.5px] transition-colors duration-1 ease-observatory',
        active ? 'font-medium text-ink' : 'text-muted hover:text-ink-2',
      )}
    >
      {children}
      {count !== undefined && (
        <span className="ml-1 font-mono text-[10.5px] tabular-nums text-muted-2">{count}</span>
      )}
      {active && <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded-sm bg-ocean" aria-hidden />}
    </button>
  );
}

function apiError(err: unknown): string {
  const ax = err as { response?: { data?: { error?: string } }; message?: string };
  return ax?.response?.data?.error ?? ax?.message ?? 'Unknown error';
}
