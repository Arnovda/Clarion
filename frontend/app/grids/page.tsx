'use client';

/**
 * /grids — "Your tables": the list of managed grids (budgets, mappings,
 * lists a business user maintains inside Clarion) plus the create flow.
 *
 * A grid's truth lives in Postgres and is materialised into the tenant's
 * warehouse on every save, so from the moment a table exists here it can be
 * used in Ask AI and dashboards next to the connectors' data. This page is
 * the front door; the editor lives at /grids/[id].
 *
 * Vocabulary rule applies: business words only — a user makes "tables" with
 * "columns" and "rows"; the words parquet/warehouse/view never render.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeftRight, ArrowRight, ListChecks, Loader2, Plus, Table2, Target, X,
} from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import RequireRole from '@/components/RequireRole';
import { formatRelative } from '@/lib/dates';
import {
  GRID_TEMPLATES,
  type GridKind,
  type GridSummary,
  type GridTemplate,
} from './types';

const KIND_ICON: Record<GridKind, typeof Target> = {
  budget: Target,
  mapping: ArrowLeftRight,
  list: ListChecks,
};

function mapSummary(g: Record<string, unknown>): GridSummary {
  return g as unknown as GridSummary;
}

export default function GridsPage() {
  return (
    <RequireRole roles={['admin', 'analyst']}>
      <Grids />
    </RequireRole>
  );
}

function Grids() {
  const router = useRouter();
  const toast = useToast();
  const [grids, setGrids] = useState<GridSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState<GridTemplate | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/grids');
      setGrids(((res.data?.data ?? []) as Record<string, unknown>[]).map(mapSummary));
      setError('');
    } catch {
      setError('Could not load your tables.');
      setGrids([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openCreate(tpl: GridTemplate) {
    setCreating(tpl);
    setNewName(tpl.suggestedName);
  }

  async function create() {
    if (!creating || busy) return;
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const res = await api.post('/grids', {
        name,
        kind: creating.kind,
        columns: creating.columns,
      });
      const created = res.data?.data as GridSummary;
      router.push(`/grids/${created.id}`);
    } catch (e) {
      const ax = e as { response?: { data?: { error?: string } }; message?: string };
      toast.error('Could not create the table', {
        description: ax?.response?.data?.error ?? ax?.message ?? 'Unknown error',
      });
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-10 pb-10 pt-10">
      <div className="mx-auto max-w-[880px]">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-2">Studio</p>
            <h1 className="mt-1.5 font-display text-[30px] leading-[1.15] tracking-[-0.02em] text-ink">Your tables</h1>
            <p className="mt-1.5 max-w-[560px] text-[14px] leading-[1.6] text-ink-3 [text-wrap:pretty]">
              Budgets, mappings and lists you keep in Clarion itself — usable in answers and
              dashboards next to the data from your sources, without a spreadsheet in between.
            </p>
          </div>
          {grids !== null && grids.length > 0 && (
            <button
              type="button"
              onClick={() => openCreate(GRID_TEMPLATES[2])}
              className="mt-1 flex shrink-0 items-center gap-1.5 rounded-[8px] bg-ocean px-4 py-2 text-[13.5px] font-medium text-white hover:opacity-90"
            >
              <Plus className="h-4 w-4" strokeWidth={2} aria-hidden /> New table
            </button>
          )}
        </header>

        {error && <p className="mb-4 text-[13px] text-err">{error}</p>}

        {grids === null ? (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden /> Loading…
          </div>
        ) : grids.length === 0 ? (
          <section className="rounded-[12px] border border-line bg-raised px-6 py-6">
            <div className="flex items-center gap-2.5">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[8px] bg-ocean-softer text-ocean">
                <Table2 className="h-[17px] w-[17px]" strokeWidth={1.6} aria-hidden />
              </span>
              <h2 className="text-[15px] font-medium text-ink">Start your first table</h2>
            </div>
            <p className="mt-2 max-w-[560px] text-[13px] leading-[1.6] text-ink-3">
              The lists your business keeps in Excel — a budget, a mapping between two sets of
              names, any reference list — can live here instead. Type or paste the rows, and the
              table is immediately part of your data.
            </p>
            <div className="mt-4 grid gap-3.5 sm:grid-cols-3">
              {GRID_TEMPLATES.map((tpl) => (
                <TemplateCard key={tpl.kind} tpl={tpl} onPick={() => openCreate(tpl)} />
              ))}
            </div>
          </section>
        ) : (
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {grids.map((g) => {
              const Glyph = KIND_ICON[g.kind] ?? ListChecks;
              const status = g.materializeError
                ? { dot: 'bg-warn', text: 'Not available in answers yet' }
                : g.materializedAt
                  ? { dot: 'bg-ok', text: `Updated ${formatRelative(g.updatedAt)}` }
                  : { dot: 'bg-soft', text: 'Being prepared…' };
              return (
                <a
                  key={g.id}
                  href={`/grids/${g.id}`}
                  className="group flex flex-col gap-2.5 rounded-[10px] border border-line bg-raised p-4 shadow-1 transition-colors duration-1 ease-observatory hover:border-ocean"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[8px] bg-ocean-softer text-ocean">
                      <Glyph className="h-[17px] w-[17px]" strokeWidth={1.6} aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink group-hover:text-ocean">
                      {g.name}
                    </span>
                  </div>
                  <p className="line-clamp-2 min-h-[36px] text-[12px] leading-[1.55] text-ink-3">
                    {g.description || `${g.columns.map((c) => c.name).join(' · ')}`}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${status.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-2">
                      {g.rowCount.toLocaleString('en-GB')} {g.rowCount === 1 ? 'row' : 'rows'} · {status.text}
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-ocean">
                      Open <ArrowRight className="h-3 w-3" strokeWidth={2} aria-hidden />
                    </span>
                  </div>
                </a>
              );
            })}
          </div>
        )}

        {creating && (
          <>
            <div className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px]" onClick={() => !busy && setCreating(null)} />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div
                className="w-full max-w-lg overflow-y-auto rounded-lg border border-line bg-raised shadow-2"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">New table</p>
                      <h2 className="font-display text-[22px] leading-tight tracking-[-0.01em] text-ink">
                        {creating.title}
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => !busy && setCreating(null)}
                      className="rounded p-1 text-muted-2 hover:text-ink-3"
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" strokeWidth={2} />
                    </button>
                  </div>

                  <div className="mt-4 flex gap-2">
                    {GRID_TEMPLATES.map((tpl) => (
                      <button
                        key={tpl.kind}
                        type="button"
                        onClick={() => { setCreating(tpl); setNewName(tpl.suggestedName); }}
                        className={`rounded-[8px] border px-3 py-1.5 text-[12.5px] transition-colors ${
                          creating.kind === tpl.kind
                            ? 'border-ocean bg-ocean-softer text-ocean'
                            : 'border-line text-ink-3 hover:border-ink-3'
                        }`}
                      >
                        {tpl.title}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[12.5px] leading-[1.55] text-ink-3">{creating.description}</p>

                  <label className="mt-5 block font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                    Name
                  </label>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
                    autoFocus
                    className="mt-1.5 w-full rounded-[8px] border border-line bg-bg px-3 py-2 text-[13.5px] text-ink placeholder:text-muted-2 focus:border-ocean focus:outline-none"
                    placeholder="Budget 2026"
                  />
                  <p className="mt-2 text-[12px] text-muted-2">
                    Starts with: {creating.columns.map((c) => c.name).join(' · ')} — you can change
                    the columns afterwards.
                  </p>

                  <div className="mt-5 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setCreating(null)}
                      disabled={busy}
                      className="rounded-[8px] border border-line px-3.5 py-1.5 text-[12.5px] text-ink-3 hover:border-ink-3 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void create()}
                      disabled={busy || !newName.trim()}
                      className="flex items-center gap-1.5 rounded-[8px] bg-ocean px-4 py-2 text-[13.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} aria-hidden />}
                      Create table
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TemplateCard({ tpl, onPick }: { tpl: GridTemplate; onPick: () => void }) {
  const Glyph = KIND_ICON[tpl.kind] ?? ListChecks;
  return (
    <button
      type="button"
      onClick={onPick}
      className="group flex flex-col items-start gap-2 rounded-[10px] border border-line bg-bg p-4 text-left transition-colors duration-1 ease-observatory hover:border-ocean"
    >
      <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-ocean-softer text-ocean">
        <Glyph className="h-[15px] w-[15px]" strokeWidth={1.6} aria-hidden />
      </span>
      <span className="text-[13.5px] font-medium text-ink group-hover:text-ocean">{tpl.title}</span>
      <span className="text-[11.5px] leading-[1.5] text-muted-2">{tpl.description}</span>
    </button>
  );
}
