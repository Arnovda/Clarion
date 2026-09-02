'use client';

/**
 * /admin/tenants — "Customers". The operator console (P1-5): every workspace
 * with its health and usage, suspend/resume, the AI budget, sync inspection,
 * and an audited 15-minute support session (impersonation).
 *
 * Follows /admin/features' structure to the letter, for the reasons written
 * there at length: NOT RequireRole (a tenant admin must not administer other
 * tenants; visibility keys off `useIsOperator()` and the API refuses with
 * 404 regardless of what the client renders); the chrome is the default
 * export and every hook lives one level INSIDE <AppShell> (the
 * FeaturesProvider lesson); three outcomes, never two — allowed, not-found,
 * and a fault that says so — because a fault wearing a refusal's clothes
 * once cost an afternoon.
 *
 * Suspension takes effect within ~30 seconds on every request the suspended
 * workspace makes (P1-3's requireAuth re-validation) — this page is just the
 * switch, and says so. A support session REPLACES the operator's own
 * session: the token is hard-boxed at 15 minutes with no refresh, so it
 * ends by itself and the operator signs back in.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ChevronDown, ChevronRight, ShieldAlert, UserCheck } from 'lucide-react';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import { useIsOperator, useFeaturesFailed, useFeaturesLoaded } from '@/lib/features';
import { clearToken, setToken } from '@/lib/auth';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  status: string;
  monthlyTokenBudget: number | null;
  createdAt: string;
  users?: number;
  activeUsers?: number;
  connections?: number;
  failedConnections?: number;
  lastSyncAt?: string | null;
  aiTokensThisMonth?: number;
  aiCallsThisMonth?: number;
  healthError?: boolean;
  // P1-6 — last-24h request window (null = no data measured, which the
  // console must show differently from "0 errors over N requests").
  requests24h?: number | null;
  errors24h?: number | null;
  avgMs24h?: number | null;
  p95Ms24h?: number | null;
}

interface TenantDetail {
  users: Array<{ id: number; email: string; display_name: string | null; role: string; is_active: boolean }>;
  connections: Array<{ id: number; name: string; type: string; connector_type: string | null; last_sync_status: string | null; last_synced_at: string | null }>;
  syncRuns: Array<{ id: number; connection_id: number; status: string; queued_at: string; completed_at: string | null }>;
  usage: Array<{ period_start: string; total_tokens: number; call_count: number }>;
}

const num = (n: number | undefined) => (n ?? 0).toLocaleString('en-GB');

/**
 * The p95 the server reports is the UPPER BOUND of a coarse histogram bucket
 * (see services/tenantRequestStats.ts) — render it as such. 30000 is the
 * last bound and doubles as the overflow report, so it reads "at least".
 */
function p95Label(p95Ms: number | null | undefined): string {
  if (p95Ms == null) return '';
  if (p95Ms >= 30000) return 'p95 ≥ 30 s';
  return p95Ms >= 1000 ? `p95 ≤ ${p95Ms / 1000} s` : `p95 ≤ ${p95Ms} ms`;
}

function StatusPill({ status }: { status: string }) {
  const suspended = status !== 'active';
  return (
    <span className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] uppercase',
      suspended ? 'bg-err-soft text-err' : 'bg-ok-soft text-ok',
    )}>
      {suspended ? status : 'active'}
    </span>
  );
}

function TenantConsole() {
  const isOperator = useIsOperator();
  const featuresFailed = useFeaturesFailed();
  const featuresLoaded = useFeaturesLoaded();

  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [callerTenantId, setCallerTenantId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/tenants');
      setTenants(res.data?.data?.tenants ?? []);
      setCallerTenantId(res.data?.data?.callerTenantId ?? null);
      setDenied(false);
      setLoadError(null);
    } catch (e) {
      // Same split as /admin/features: 404 is the deliberate refusal;
      // anything else is a FAULT and must not wear the refusal's clothes.
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) setDenied(true);
      else {
        setLoadError(`Could not load the customer list${status ? ` (server said ${status})` : ''}. This is a fault, not a permission problem.`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: number) => {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    setActionError(null);
    const t = tenants.find((x) => x.id === id);
    setBudgetDraft(t?.monthlyTokenBudget == null ? '' : String(t.monthlyTokenBudget));
    try {
      const res = await api.get(`/admin/tenants/${id}`);
      setDetail(res.data?.data ?? null);
    } catch {
      setActionError('Could not load this workspace in depth. The list above is unaffected.');
    } finally {
      setDetailLoading(false);
    }
  }, [openId, tenants]);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setActionError(msg ?? 'That change could not be made. Nothing was altered.');
    } finally {
      setBusy(null);
    }
  }

  function suspend(t: TenantRow) {
    // The consequence is stated before the click lands anywhere: every user
    // of the workspace is refused within about 30 seconds.
    if (!window.confirm(`Suspend ${t.name}? Every user of this workspace will be refused within about 30 seconds. You can resume at any time.`)) return;
    void act(`suspend-${t.id}`, async () => { await api.post(`/admin/tenants/${t.id}/suspend`); });
  }

  function resume(t: TenantRow) {
    void act(`resume-${t.id}`, async () => { await api.post(`/admin/tenants/${t.id}/resume`); });
  }

  function saveBudget(t: TenantRow) {
    const raw = budgetDraft.trim();
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      setActionError('The budget must be a whole number of tokens, or empty for unlimited.');
      return;
    }
    void act(`budget-${t.id}`, async () => {
      await api.patch(`/admin/tenants/${t.id}/budget`, { monthlyTokenBudget: value });
    });
  }

  function impersonate(t: TenantRow, user: TenantDetail['users'][number]) {
    // The reason is required — it lands verbatim in the CUSTOMER's audit
    // trail next to the operator's email, which is the whole control.
    const reason = window.prompt(
      `Start a 15-minute support session as ${user.email}?\n\n`
      + 'This replaces YOUR session — you will need to sign in again afterwards. '
      + `The session is recorded in ${t.name}'s audit trail with the reason you give here.\n\nReason:`,
    );
    if (reason == null) return;
    if (reason.trim().length < 3) {
      setActionError('A support session needs a stated reason (at least a few words).');
      return;
    }
    void act(`impersonate-${user.id}`, async () => {
      const res = await api.post(`/admin/tenants/${t.id}/impersonate`, { userId: user.id, reason: reason.trim() });
      const token = res.data?.data?.token as string | undefined;
      if (!token) throw new Error('No token returned');
      // Replace the session: clear BOTH tokens first (no refresh token may
      // survive — the support window must close itself), then the boxed one.
      clearToken();
      setToken(token);
      window.location.href = '/home';
    });
  }

  const faulted = Boolean(loadError) || featuresFailed;
  const refused = !faulted && (denied || !isOperator);
  const checking = loading || !featuresLoaded;

  if (checking) {
    return (
      <div className="flex items-center gap-2 text-muted text-sm py-10">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
      </div>
    );
  }

  if (refused) {
    return (
      <>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Page not found</h1>
        <p className="text-[14.5px] text-ink-3 max-w-[62ch]">
          That page does not exist. Check the address, or head back to{' '}
          <a href="/home" className="text-ocean hover:underline">your home page</a>.
        </p>
      </>
    );
  }

  if (faulted) {
    return (
      <>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Something went wrong</h1>
        <div className="rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err max-w-[62ch]">
          {loadError ?? 'Could not check your access — the request failed. This is a fault, not a permission problem.'}
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Customers</h1>
      <p className="text-[14.5px] text-ink-3 max-w-[70ch] mb-8">
        Every workspace, its health and this month&apos;s AI usage. Suspending a workspace refuses
        every one of its users within about 30 seconds; resuming restores them just as fast. A
        support session signs you in as one of their users for 15 minutes, is recorded in their
        audit trail, and ends by itself.
      </p>

      {actionError && (
        <div className="mb-5 rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err">{actionError}</div>
      )}

      <div className="rounded-lg border border-line bg-raised overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 text-left">
              <th className="px-4 py-2.5 font-medium">Workspace</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium text-right">Users</th>
              <th className="px-3 py-2.5 font-medium text-right">Sources</th>
              <th className="px-3 py-2.5 font-medium">Last sync</th>
              <th className="px-3 py-2.5 font-medium text-right">Traffic (24h)</th>
              <th className="px-3 py-2.5 font-medium text-right">AI this month</th>
              <th className="px-3 py-2.5 font-medium text-right">Budget</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <TenantRows
                key={t.id}
                tenant={t}
                isOpen={openId === t.id}
                isSelf={t.id === callerTenantId}
                detail={openId === t.id ? detail : null}
                detailLoading={openId === t.id && detailLoading}
                busy={busy}
                budgetDraft={budgetDraft}
                onBudgetDraft={setBudgetDraft}
                onOpen={() => void openDetail(t.id)}
                onSuspend={() => suspend(t)}
                onResume={() => resume(t)}
                onSaveBudget={() => saveBudget(t)}
                onImpersonate={(u) => impersonate(t, u)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TenantRows(props: {
  tenant: TenantRow;
  isOpen: boolean;
  isSelf: boolean;
  detail: TenantDetail | null;
  detailLoading: boolean;
  busy: string | null;
  budgetDraft: string;
  onBudgetDraft: (v: string) => void;
  onOpen: () => void;
  onSuspend: () => void;
  onResume: () => void;
  onSaveBudget: () => void;
  onImpersonate: (u: TenantDetail['users'][number]) => void;
}) {
  const { tenant: t, isOpen, isSelf, detail, detailLoading, busy } = props;
  const suspended = t.status !== 'active';
  return (
    <>
      <tr
        className={cn('border-b border-softer cursor-pointer hover:bg-soft', isOpen && 'bg-soft')}
        onClick={props.onOpen}
      >
        <td className="px-4 py-3">
          <span className="inline-flex items-center gap-1.5 text-ink font-medium">
            {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-muted" /> : <ChevronRight className="w-3.5 h-3.5 text-muted" />}
            {t.name}
            {isSelf && <span className="font-mono text-[9.5px] tracking-[0.08em] uppercase text-muted-2 ml-1">you</span>}
          </span>
          <div className="text-[11px] text-muted-2 ml-5">{t.slug} · since {formatRelative(t.createdAt)}</div>
        </td>
        <td className="px-3 py-3"><StatusPill status={t.status} /></td>
        <td className="px-3 py-3 text-right tabular-nums">
          {t.healthError ? '—' : <>{num(t.activeUsers)}<span className="text-muted-2"> / {num(t.users)}</span></>}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">
          {t.healthError ? '—' : num(t.connections)}
          {!t.healthError && (t.failedConnections ?? 0) > 0 && (
            <span className="text-err ml-1.5" title="sources whose last sync failed">({t.failedConnections} failing)</span>
          )}
        </td>
        <td className="px-3 py-3 text-muted">{t.lastSyncAt ? formatRelative(t.lastSyncAt) : 'never'}</td>
        <td className="px-3 py-3 text-right tabular-nums">
          {t.requests24h == null ? (
            <span className="text-muted-2" title="No request data measured in the last 24 hours (no traffic, or the stats window is unavailable)">—</span>
          ) : (
            <span title={`${num(t.requests24h)} requests · ${num(t.errors24h ?? 0)} server errors · avg ${t.avgMs24h ?? 0} ms · p95 ${p95Label(t.p95Ms24h)}`}>
              {num(t.requests24h)}
              <span className={cn('ml-1.5', (t.errors24h ?? 0) > 0 ? 'text-err' : 'text-muted-2')}>
                {num(t.errors24h ?? 0)} err
              </span>
              <span className="text-muted-2 ml-1.5">{p95Label(t.p95Ms24h)}</span>
            </span>
          )}
        </td>
        <td className="px-3 py-3 text-right tabular-nums">{t.healthError ? '—' : `${num(t.aiTokensThisMonth)} tok`}</td>
        <td className="px-3 py-3 text-right tabular-nums text-muted">
          {t.monthlyTokenBudget == null ? 'unlimited' : num(t.monthlyTokenBudget)}
        </td>
        <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
          {suspended ? (
            <button
              onClick={props.onResume}
              disabled={busy === `resume-${t.id}`}
              className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink hover:bg-soft disabled:opacity-50"
            >
              Resume
            </button>
          ) : (
            <button
              onClick={props.onSuspend}
              disabled={isSelf || busy === `suspend-${t.id}`}
              title={isSelf ? 'You are signed in under this workspace' : undefined}
              className="rounded-md border border-err px-2.5 py-1 text-[12px] text-err hover:bg-err-soft disabled:opacity-40"
            >
              Suspend
            </button>
          )}
        </td>
      </tr>

      {isOpen && (
        <tr className="border-b border-softer bg-soft">
          <td colSpan={9} className="px-6 py-4">
            {detailLoading && (
              <div className="flex items-center gap-2 text-muted text-[12.5px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
              </div>
            )}
            {detail && (
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mb-2">People</div>
                  <ul className="space-y-1.5">
                    {detail.users.map((u) => (
                      <li key={u.id} className="flex items-center justify-between gap-3 text-[12.5px]">
                        <span className={cn(!u.is_active && 'line-through text-muted-2')}>
                          {u.display_name ?? u.email}
                          <span className="text-muted-2 ml-1.5">{u.email} · {u.role}</span>
                        </span>
                        {u.is_active && !suspended && (
                          <button
                            onClick={() => props.onImpersonate(u)}
                            disabled={busy === `impersonate-${u.id}`}
                            className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-soft disabled:opacity-50 shrink-0"
                            title="Sign in as this user for 15 minutes — recorded in their audit trail"
                          >
                            <UserCheck className="w-3 h-3" /> Support session
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>

                  <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mt-5 mb-2">AI budget</div>
                  <div className="flex items-center gap-2">
                    <input
                      value={props.budgetDraft}
                      onChange={(e) => props.onBudgetDraft(e.target.value)}
                      placeholder="unlimited"
                      inputMode="numeric"
                      className="w-40 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] text-ink"
                    />
                    <button
                      onClick={props.onSaveBudget}
                      disabled={busy === `budget-${t.id}`}
                      className="rounded-md border border-line px-2.5 py-1.5 text-[12px] text-ink hover:bg-soft disabled:opacity-50"
                    >
                      Save
                    </button>
                    <span className="text-[11.5px] text-muted-2">tokens per month · empty = unlimited</span>
                  </div>
                </div>

                <div>
                  <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mb-2">Sources</div>
                  {detail.connections.length === 0 && <div className="text-[12.5px] text-muted-2">None connected yet.</div>}
                  <ul className="space-y-1.5">
                    {detail.connections.map((c) => (
                      <li key={c.id} className="text-[12.5px] flex items-center gap-2">
                        <span className="text-ink">{c.name}</span>
                        <span className="text-muted-2">{c.connector_type ?? c.type}</span>
                        {c.last_sync_status && (
                          <span className={cn(
                            'font-mono text-[10px] uppercase tracking-[0.06em]',
                            c.last_sync_status === 'success' ? 'text-ok' : 'text-err',
                          )}>
                            {c.last_sync_status}
                          </span>
                        )}
                        {c.last_synced_at && <span className="text-muted-2">{formatRelative(c.last_synced_at)}</span>}
                      </li>
                    ))}
                  </ul>

                  <div className="font-mono text-[10px] tracking-[0.1em] uppercase text-muted-2 mt-5 mb-2">Recent syncs</div>
                  {detail.syncRuns.length === 0 && <div className="text-[12.5px] text-muted-2">No sync has run yet.</div>}
                  <ul className="space-y-1">
                    {detail.syncRuns.slice(0, 8).map((r) => (
                      <li key={r.id} className="text-[12px] flex items-center gap-2 tabular-nums">
                        <span className={cn(
                          'font-mono text-[10px] uppercase tracking-[0.06em] w-16',
                          r.status === 'success' ? 'text-ok' : r.status === 'failed' ? 'text-err' : 'text-muted',
                        )}>
                          {r.status}
                        </span>
                        <span className="text-muted-2">{formatRelative(r.queued_at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {suspended && detail && (
              <div className="mt-4 flex items-center gap-2 text-[12px] text-err">
                <ShieldAlert className="w-3.5 h-3.5" />
                Suspended — every request from this workspace is being refused. Support sessions are unavailable while suspended.
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The chrome only — nothing here reads a flag or decides anything; the
 * console one level in does all of it, inside the provider (the
 * FeaturesProvider lesson, see /admin/features).
 */
export default function AdminTenantsPage() {
  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <TenantConsole />
        </div>
      </div>
    </AppShell>
  );
}
