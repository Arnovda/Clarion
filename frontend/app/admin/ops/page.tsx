'use client';

/**
 * /admin/ops — the operator's operations console (wave B item 3).
 *
 * Three things an operator used to need a database session or a Log
 * Analytics login for:
 *
 *   ERRORS        every customer's recent failures — syncs, transformations,
 *                 pipelines, failing tables, failed AI calls — with the
 *                 CORRELATION id that finds the log lines (6-1, 6-2);
 *   QUEUES        what is running, waiting, delayed and FAILED (the
 *                 dead-letter set) across every queue, with retry and
 *                 cancel (6-6);
 *   ANNOUNCEMENTS what every customer is being told right now, and the
 *                 form that tells them (6-4).
 *
 * Same two-component shape as /admin/features and /admin/tenants: the chrome
 * is the default export, every hook lives one level inside <AppShell>.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw, XCircle, Megaphone, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import { useIsOperator, useFeaturesFailed, useFeaturesLoaded } from '@/lib/features';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';

type Tab = 'errors' | 'queues' | 'announcements';

interface ErrorRow {
  kind: string; tenantId: number; tenantName: string | null; at: string; summary: string;
  detail: string | null; requestId: string | null; ref: Record<string, unknown>;
}
interface QueueJob {
  queue: string; state: string; id: string; name: string; tenantId: number | null; requestId: string | null;
  attemptsMade: number; attempts: number; failedReason: string | null; createdAt: string | null; finishedAt: string | null;
  about: Record<string, unknown>;
}
interface QueueInfo { name: string; counts: Record<string, number>; jobs: QueueJob[] }
interface Announcement { id: number; message: string; level: 'info' | 'warning' | 'critical'; startsAt: string; endsAt: string | null; createdBy: string }
interface TenantOpt { id: number; name: string }

const errMsg = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error;

function OpsConsole() {
  const isOperator = useIsOperator();
  const featuresFailed = useFeaturesFailed();
  const featuresLoaded = useFeaturesLoaded();

  const [tab, setTab] = useState<Tab>('errors');
  const [denied, setDenied] = useState(false);
  const [fault, setFault] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [tenants, setTenants] = useState<TenantOpt[]>([]);
  const [tenantFilter, setTenantFilter] = useState<string>('');
  const [errors, setErrors] = useState<ErrorRow[] | null>(null);
  const [unreadable, setUnreadable] = useState<number[]>([]);

  const [queues, setQueues] = useState<QueueInfo[] | null>(null);
  const [queuesAvailable, setQueuesAvailable] = useState(true);

  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [draft, setDraft] = useState<{ message: string; level: Announcement['level'] }>({ message: '', level: 'warning' });

  const handle = useCallback((e: unknown) => {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) setDenied(true);
    else setFault(`The request failed${status ? ` (server said ${status})` : ''}. This is a fault, not a permission problem.`);
  }, []);

  const loadErrors = useCallback(async () => {
    try {
      const res = await api.get('/admin/ops/errors', { params: { limit: 100, ...(tenantFilter ? { tenantId: Number(tenantFilter) } : {}) } });
      setErrors(res.data?.data?.errors ?? []);
      setUnreadable(res.data?.data?.unreadableTenants ?? []);
      setDenied(false); setFault(null);
    } catch (e) { handle(e); }
  }, [tenantFilter, handle]);

  const loadQueues = useCallback(async () => {
    try {
      const res = await api.get('/admin/ops/queues');
      setQueuesAvailable(res.data?.data?.available !== false);
      setQueues(res.data?.data?.queues ?? []);
    } catch (e) { handle(e); }
  }, [handle]);

  const loadAnnouncements = useCallback(async () => {
    try {
      const res = await api.get('/admin/ops/announcements');
      setAnnouncements(res.data?.data?.announcements ?? []);
    } catch (e) { handle(e); }
  }, [handle]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get('/admin/tenants');
        setTenants((res.data?.data?.tenants ?? []).map((t: TenantOpt) => ({ id: t.id, name: t.name })));
      } catch { /* the filter is a nicety */ }
    })();
  }, []);
  useEffect(() => { void loadErrors(); }, [loadErrors]);
  useEffect(() => { if (tab === 'queues') void loadQueues(); }, [tab, loadQueues]);
  useEffect(() => { if (tab === 'announcements') void loadAnnouncements(); }, [tab, loadAnnouncements]);

  async function act(label: string, fn: () => Promise<void>, reload: () => Promise<void>) {
    setBusy(label); setActionError(null);
    try { await fn(); await reload(); }
    catch (e) { setActionError(errMsg(e) ?? 'That could not be done. Nothing was changed.'); }
    finally { setBusy(null); }
  }

  const checking = !featuresLoaded;
  const faulted = Boolean(fault) || featuresFailed;
  const refused = !faulted && (denied || !isOperator);

  if (checking) return <div className="flex items-center gap-2 text-muted text-sm py-10"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>;
  if (refused) {
    return (
      <>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Page not found</h1>
        <p className="text-[14.5px] text-ink-3 max-w-[62ch]">That page does not exist. Check the address, or head back to <a href="/home" className="text-ocean hover:underline">your home page</a>.</p>
      </>
    );
  }
  if (faulted) {
    return (
      <>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Something went wrong</h1>
        <div className="rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err max-w-[62ch]">{fault ?? 'Could not check your access — the request failed.'}</div>
      </>
    );
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      key={t}
      onClick={() => setTab(t)}
      className={cn('px-3 py-1.5 text-[13px] rounded-md border', tab === t ? 'border-ocean bg-ocean-softer text-ink' : 'border-line text-ink-3 hover:bg-soft')}
    >
      {label}
    </button>
  );

  return (
    <>
      <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Operations</h1>
      <p className="text-[14.5px] text-ink-3 max-w-[70ch] mb-6">
        What is failing for whom, what the queues are doing, and what every customer is being told.
        An error&apos;s request id is the thread: put it on a <code className="font-mono text-[12px]">request</code> line in <code className="font-mono text-[12px]">.ops/prod-logs</code> to read every log line it touched.
      </p>

      <div className="flex gap-2 mb-5">{tabBtn('errors', 'Errors')}{tabBtn('queues', 'Queues')}{tabBtn('announcements', 'Announcements')}</div>

      {actionError && <div className="mb-4 rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err">{actionError}</div>}

      {tab === 'errors' && (
        <section>
          <div className="flex items-center gap-2 mb-3 text-[12.5px]">
            <label className="text-muted-2">Workspace</label>
            <select value={tenantFilter} onChange={(e) => setTenantFilter(e.target.value)} className="rounded-md border border-line bg-raised px-2 py-1 text-[12.5px] text-ink">
              <option value="">every workspace</option>
              {tenants.map((t) => <option key={t.id} value={String(t.id)}>{t.name} (#{t.id})</option>)}
            </select>
            <button onClick={() => void loadErrors()} className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-soft">Refresh</button>
            {unreadable.length > 0 && <span className="text-err">could not read {unreadable.length} workspace(s): #{unreadable.join(', #')}</span>}
          </div>
          {errors == null && <div className="text-muted text-[12.5px]"><Loader2 className="inline w-3.5 h-3.5 animate-spin" /> Loading…</div>}
          {errors && errors.length === 0 && <div className="text-[13px] text-muted-2">No failures in the last 14 days{tenantFilter ? ' for this workspace' : ''}.</div>}
          {errors && errors.length > 0 && (
            <div className="rounded-lg border border-line bg-raised overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 text-left">
                    <th className="px-3 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Workspace</th><th className="px-3 py-2 font-medium">Kind</th>
                    <th className="px-3 py-2 font-medium">What</th><th className="px-3 py-2 font-medium">Request id</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, i) => (
                    <tr key={i} className="border-b border-softer align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-muted">{formatRelative(e.at)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{e.tenantName ?? `#${e.tenantId}`}</td>
                      <td className="px-3 py-2"><span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">{e.kind}</span></td>
                      <td className="px-3 py-2">
                        <div className="text-ink">{e.summary}</div>
                        {e.detail && <div className="text-muted-2 font-mono text-[11px] whitespace-pre-wrap break-words max-w-[60ch]">{e.detail}</div>}
                        <div className="text-muted-2 text-[11px]">{Object.entries(e.ref).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-ink-3 whitespace-nowrap">{e.requestId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === 'queues' && (
        <section>
          {queues == null && <div className="text-muted text-[12.5px]"><Loader2 className="inline w-3.5 h-3.5 animate-spin" /> Loading…</div>}
          {queues && !queuesAvailable && <div className="text-[13px] text-muted-2">Job queues are not available on this deployment (no Redis) — work runs inline.</div>}
          {queues && queuesAvailable && queues.map((q) => (
            <div key={q.name} className="mb-5">
              <div className="flex items-baseline gap-3 mb-1.5">
                <span className="font-mono text-[12px] text-ink">{q.name}</span>
                <span className="text-[11.5px] text-muted-2">
                  {q.counts.active ?? 0} active · {q.counts.waiting ?? 0} waiting · {q.counts.delayed ?? 0} delayed ·{' '}
                  <span className={cn((q.counts.failed ?? 0) > 0 && 'text-err')}>{q.counts.failed ?? 0} failed</span> · {q.counts.completed ?? 0} completed
                </span>
                <button onClick={() => void loadQueues()} className="ml-auto rounded-md border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-soft">Refresh</button>
              </div>
              {q.jobs.length === 0 ? (
                <div className="text-[12px] text-muted-2">Nothing running, waiting or failed.</div>
              ) : (
                <ul className="rounded-lg border border-line bg-raised divide-y divide-softer">
                  {q.jobs.map((j) => (
                    <li key={j.id} className="px-3 py-2 text-[12px] flex items-start gap-3">
                      <span className={cn('font-mono text-[10px] uppercase tracking-[0.06em] w-14 shrink-0 pt-0.5', j.state === 'failed' ? 'text-err' : j.state === 'active' ? 'text-ok' : 'text-muted')}>{j.state}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-ink">
                          <span className="font-mono">{j.name}</span> #{j.id}
                          {j.tenantId != null && <span className="text-muted-2 ml-2">workspace #{j.tenantId}</span>}
                          <span className="text-muted-2 ml-2">attempt {j.attemptsMade}/{j.attempts}</span>
                          {j.createdAt && <span className="text-muted-2 ml-2">{formatRelative(j.createdAt)}</span>}
                        </div>
                        {j.failedReason && <div className="text-err font-mono text-[11px] whitespace-pre-wrap break-words">{j.failedReason}</div>}
                        <div className="text-muted-2 text-[11px] font-mono">
                          {Object.entries(j.about).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}
                          {j.requestId && <> · request {j.requestId}</>}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {j.state === 'failed' && (
                          <button
                            onClick={() => void act(`retry-${j.id}`, async () => { await api.post(`/admin/ops/queues/${q.name}/jobs/${j.id}/retry`); }, loadQueues)}
                            disabled={busy === `retry-${j.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-soft disabled:opacity-50"
                          ><RotateCcw className="w-3 h-3" /> Retry</button>
                        )}
                        {j.state !== 'completed' && (
                          <button
                            onClick={() => {
                              const what = j.state === 'active' ? 'Ask this running job to stop at its next checkpoint?' : j.state === 'failed' ? 'Remove this failed job from the queue for good?' : 'Remove this job before it runs?';
                              if (!window.confirm(what)) return;
                              void act(`cancel-${j.id}`, async () => { await api.post(`/admin/ops/queues/${q.name}/jobs/${j.id}/cancel`); }, loadQueues);
                            }}
                            disabled={busy === `cancel-${j.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-err px-2 py-0.5 text-[11px] text-err hover:bg-err-soft disabled:opacity-50"
                          ><XCircle className="w-3 h-3" /> {j.state === 'active' ? 'Stop' : 'Remove'}</button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      {tab === 'announcements' && (
        <section>
          <div className="rounded-lg border border-line bg-raised p-4 mb-5 max-w-[640px]">
            <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mb-2 flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5" /> Tell every customer</div>
            <textarea
              value={draft.message}
              onChange={(e) => setDraft({ ...draft, message: e.target.value })}
              rows={2}
              placeholder="We are investigating slow dashboards. Data is safe; syncs will catch up. Next update in 30 minutes."
              className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-ink"
            />
            <div className="flex items-center gap-2 mt-2">
              <select value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value as Announcement['level'] })} className="rounded-md border border-line bg-raised px-2 py-1 text-[12.5px] text-ink">
                <option value="info">Info</option><option value="warning">Notice</option><option value="critical">Incident</option>
              </select>
              <button
                onClick={() => {
                  if (draft.message.trim().length < 3) { setActionError('Write the announcement first.'); return; }
                  if (!window.confirm('Publish this to every signed-in user of every workspace, on every screen, now?')) return;
                  void act('publish', async () => { await api.post('/admin/ops/announcements', { message: draft.message.trim(), level: draft.level }); setDraft({ message: '', level: 'warning' }); }, loadAnnouncements);
                }}
                disabled={busy === 'publish'}
                className="rounded-md border border-ocean bg-ocean-softer px-3 py-1 text-[12.5px] text-ink hover:bg-soft disabled:opacity-50"
              >
                Publish
              </button>
              <span className="text-[11.5px] text-muted-2">shows within a minute on every screen until you end it</span>
            </div>
          </div>
          {announcements == null && <div className="text-muted text-[12.5px]"><Loader2 className="inline w-3.5 h-3.5 animate-spin" /> Loading…</div>}
          {announcements && announcements.length === 0 && <div className="text-[13px] text-muted-2">Nothing has been announced yet.</div>}
          {announcements && announcements.length > 0 && (
            <ul className="rounded-lg border border-line bg-raised divide-y divide-softer max-w-[760px]">
              {announcements.map((a) => {
                const live = !a.endsAt || new Date(a.endsAt).getTime() > Date.now();
                return (
                  <li key={a.id} className="px-3 py-2.5 text-[12.5px] flex items-start gap-3">
                    <span className={cn('font-mono text-[10px] uppercase tracking-[0.06em] w-16 shrink-0 pt-0.5', live ? (a.level === 'critical' ? 'text-err' : a.level === 'warning' ? 'text-warn' : 'text-ocean') : 'text-muted-2')}>
                      {live ? a.level : 'ended'}
                    </span>
                    <div className="flex-1">
                      <div className={cn(live ? 'text-ink' : 'text-muted-2')}>{a.message}</div>
                      <div className="text-[11px] text-muted-2">by {a.createdBy} · {formatRelative(a.startsAt)}{a.endsAt ? ` · ends ${formatRelative(a.endsAt)}` : ''}</div>
                    </div>
                    {live ? (
                      <button onClick={() => void act(`end-${a.id}`, async () => { await api.patch(`/admin/ops/announcements/${a.id}`, { end: true }); }, loadAnnouncements)} disabled={busy === `end-${a.id}`} className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink hover:bg-soft disabled:opacity-50 shrink-0">End now</button>
                    ) : (
                      <button onClick={() => void act(`delete-${a.id}`, async () => { await api.delete(`/admin/ops/announcements/${a.id}`); }, loadAnnouncements)} disabled={busy === `delete-${a.id}`} className="rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-soft disabled:opacity-50 shrink-0">Delete</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-4 text-[12px] text-muted-2 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> An announcement is a system banner, not an email. Customers who are not signed in will not see it.</p>
        </section>
      )}
    </>
  );
}

export default function AdminOpsPage() {
  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <OpsConsole />
        </div>
      </div>
    </AppShell>
  );
}
