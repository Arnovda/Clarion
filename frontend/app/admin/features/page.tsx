'use client';

/**
 * /admin/features — "Who sees what". Choosing an audience, and nothing else.
 *
 * The first version of this screen had two controls per feature: a three-way
 * audience selector AND a separate list of tenant chips that only mattered in
 * one of those three states. That is two things to learn and one of them can
 * contradict the other. There is now ONE list per feature — Everyone at the
 * top, then a line per customer — and the state is derived from what is
 * ticked: nothing = nobody, some = those, Everyone = everyone including
 * customers who sign up later. The stored model still has three states,
 * because "everyone forever" genuinely differs from "these three accounts",
 * but the person choosing never has to name that distinction.
 *
 * NOT gated by RequireRole. Every other admin page keys off the tenant role,
 * and that is exactly wrong here — a customer's admin must not be able to
 * grant themselves unreleased features. Visibility keys off `useIsOperator()`;
 * the API refuses non-operators regardless of what the client renders.
 *
 * TO SOMEONE WHO IS NOT AN OPERATOR, THIS PAGE DOES NOT EXIST. It renders the
 * ordinary not-found screen — no title, no description, no explanation of what
 * the page decides or how access is granted. The API already answers 404
 * rather than 403 for exactly this reason, and the screen used to undo that
 * care by printing a card that told any signed-in customer the page was here
 * and how to get into it.
 *
 * The one thing that must NOT be hidden is a FAULT. A failed request is not a
 * refusal, and telling someone they lack access when the truth is that nothing
 * could be asked sends them to fix what was never broken — it cost an
 * afternoon once. So there are three outcomes here, never two: allowed,
 * not-found, and a fault that says so with its status.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, Users } from 'lucide-react';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import { useIsOperator, useFeaturesFailed, useFeaturesLoaded } from '@/lib/features';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { FeatureRollout } from '@/lib/contract';

interface FlagRow {
  key: string;
  /** 'release' = a batch of shipped work awaiting an audience; 'feature' = a standing capability. */
  kind: 'release' | 'feature';
  name: string;
  description: string;
  rollout: FeatureRollout;
  tenants: Array<{ id: number; name: string }>;
  updated_at: string | null;
  updated_by: string | null;
}

interface TenantRow { id: number; name: string }

/** What the row says about itself, in one line, without naming a state. */
function audienceSummary(flag: FlagRow, tenants: TenantRow[]): string {
  if (flag.rollout === 'all') return 'Everyone';
  const n = flag.tenants.length;
  if (flag.rollout !== 'tenants' || n === 0) return 'Nobody yet';
  if (n === 1) return flag.tenants[0].name;
  if (n === tenants.length) return `All ${n} customers (but not new ones)`;
  return `${n} customers`;
}

/**
 * Something nobody can see yet: shipped, deployed, audience still empty.
 *
 * This is the state every release is born in — a key with no row resolves to
 * off — so it is not an error, it is the queue. Derived rather than read from
 * a stored "released" marker, so pulling a release back to nobody puts it in
 * the queue again, which is exactly what it is.
 *
 * Scoped to RELEASES on purpose. A standing feature (the preview marker) is
 * switched on when someone wants it, not queued for a decision, and counting
 * it here would put a permanent number in a banner whose whole job is to mean
 * "there is something new to decide about".
 */
function isWaitingForAudience(flag: FlagRow): boolean {
  if (flag.kind !== 'release') return false;
  if (flag.rollout === 'all') return false;
  return flag.rollout !== 'tenants' || flag.tenants.length === 0;
}

/** The page's chrome, shared by all three outcomes so they cannot drift apart. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">{children}</div>
      </div>
    </AppShell>
  );
}

export default function FeatureFlagsPage() {
  const isOperator = useIsOperator();
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const waiting = flags.filter(isWaitingForAudience);
  // Releases first (that is the decision this page exists for, and a deploy
  // links straight here), unreleased ones at the very top; standing features
  // last. Stable within each group so the list does not reshuffle under the
  // operator as they tick boxes.
  const rank = (f: FlagRow) =>
    (isWaitingForAudience(f) ? 0 : 1) + (f.kind === 'release' ? 0 : 2);
  const ordered = [...flags].sort((a, b) => rank(a) - rank(b));
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Two different failures that must not share one variable. A LOAD fault
  // means the page cannot be shown at all; a SAVE failure happens with the
  // console already on screen and must leave it there — folding them together
  // would blank the whole page because one checkbox failed to save.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const featuresFailed = useFeaturesFailed();
  const featuresLoaded = useFeaturesLoaded();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/feature-flags');
      const d = res.data?.data;
      setFlags(d?.flags ?? []);
      setTenants(d?.tenants ?? []);
      setDenied(false);
      setLoadError(null);
    } catch (e) {
      // 404 is the deliberate refusal (the server answers 404 rather than 403
      // for a non-operator, so a probing tenant admin learns nothing). ANYTHING
      // ELSE is a fault, and must not wear the refusal's clothes: this page
      // spent an afternoon telling its own operator he was not allowed in while
      // the real answer was a server error, because every failure landed in one
      // blanket catch. A wrong explanation is worse than no explanation — it
      // sends you to fix the thing that was never broken.
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setDenied(true);
      } else {
        const msg = (e as { response?: { data?: { error?: string } }; message?: string })
          ?.response?.data?.error ?? (e as { message?: string })?.message;
        setLoadError(
          `Could not load the releases${status ? ` (server said ${status})` : ''}. `
          + `This is a fault, not a permission problem.${msg ? ` ${msg}` : ''}`,
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(key: string, rollout: FeatureRollout, tenantIds: number[]) {
    setSaving(key);
    setSaveError(null);
    // Optimistic: ticking a box must feel instant. A failure reloads from the
    // server rather than guessing at what the previous state was.
    setFlags((prev) => prev.map((f) => (
      f.key === key
        ? {
            ...f,
            rollout,
            tenants: tenantIds.map((id) => ({
              id,
              name: tenants.find((t) => t.id === id)?.name ?? `Account ${id}`,
            })),
          }
        : f
    )));
    try {
      await api.put(`/admin/feature-flags/${key}`, { rollout, tenantIds });
      setSavedKey(key);
      window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2000);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setSaveError(msg ?? 'That change could not be saved. Nothing was altered.');
      await load();
    } finally {
      setSaving(null);
    }
  }

  /** Everyone on ↔ off. Turning it off falls back to whoever was picked before. */
  function toggleEveryone(flag: FlagRow) {
    const ids = flag.tenants.map((t) => t.id);
    if (flag.rollout === 'all') void save(flag.key, ids.length > 0 ? 'tenants' : 'off', ids);
    else void save(flag.key, 'all', ids);
  }

  /** Tick or untick one customer. Untick the last one and nobody sees it. */
  function toggleCustomer(flag: FlagRow, tenantId: number) {
    const on = flag.tenants.some((t) => t.id === tenantId);
    const ids = on
      ? flag.tenants.filter((t) => t.id !== tenantId).map((t) => t.id)
      : [...flag.tenants.map((t) => t.id), tenantId];
    void save(flag.key, ids.length > 0 ? 'tenants' : 'off', ids);
  }

  // A fault must never wear a refusal's clothes. `error` is set only for a
  // non-404 answer from the console endpoint; `featuresFailed` covers the other
  // half — the /features request that decides `isOperator` erroring, which
  // would otherwise read as "not an operator" and be indistinguishable from it.
  const faulted = Boolean(loadError) || featuresFailed;
  const refused = !faulted && (denied || !isOperator);

  // `isOperator` is false until /api/features answers, so deciding anything
  // before `featuresLoaded` would flash "Page not found" at the very person
  // this console belongs to. Wait for BOTH requests.
  const checking = loading || !featuresLoaded;

  // Nothing describing the page renders while we are still deciding who is
  // reading it — otherwise a customer who guesses the URL sees what it is for
  // in the moment before being told it does not exist.
  if (checking) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-muted text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
        </div>
      </Shell>
    );
  }

  // Not an operator: the page is not here. Nothing about what it does, and
  // nothing about how to be let in — the API's 404 exists to keep exactly that
  // from a signed-in customer, and printing it on screen gave it back.
  if (refused) {
    return (
      <Shell>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Page not found</h1>
        <p className="text-[14.5px] text-ink-3 max-w-[62ch]">
          That page does not exist. Check the address, or head back to{' '}
          <a href="/home" className="text-ocean hover:underline">your home page</a>.
        </p>
      </Shell>
    );
  }

  // A fault gets its own screen too, and deliberately says nothing about what
  // this page is for: while the check itself is broken we do not know who is
  // reading it, and a description of the release console is exactly what the
  // 404 above exists to withhold from a customer.
  if (faulted) {
    return (
      <Shell>
        <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Something went wrong</h1>
        <div className="rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err max-w-[62ch]">
          {loadError ?? (
            'Could not check your access — the request for your release settings failed. '
            + 'This is a fault, not a permission problem. Reload; if it keeps happening, '
            + 'check the backend logs.'
          )}
        </div>
      </Shell>
    );
  }

  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">

          <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Who sees what</h1>
          <p className="text-[14.5px] text-ink-3 max-w-[62ch] mb-8">
            Each release arrives switched off. Tick the customers who should get it — start with your own
            test account — and untick to take it away again. One tick covers everything in that release,
            so there is nothing to decide feature by feature. Changes apply within about 20 seconds;
            nothing here needs a deploy or a restart.
          </p>

          {isOperator && (
            <>
              {saveError && (
                <div className="mb-5 rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err">{saveError}</div>
              )}

              {/* Features nobody has been given yet lead the page.
                  Promoting a build makes code reachable for EVERY tenant at
                  once — one revision serves them all — so the audience choice
                  is a separate act, and this screen is where it happens. The
                  failure that matters is a feature reaching production and
                  then sitting switched off because nothing said it was
                  waiting; a deploy links straight here, and this banner is
                  what it lands on. Counted from the same derived state the
                  rows use, so it can never disagree with them. */}
              {waiting.length > 0 && (
                <div className="mb-5 rounded-md border border-ocean-soft bg-ocean-softer px-4 py-3">
                  <p className="text-[13.5px] text-ink">
                    <span className="font-medium">
                      {waiting.length === 1
                        ? 'A new release is live but nobody can see it yet'
                        : `${waiting.length} releases are live but nobody can see them yet`}
                    </span>
                    {' — '}
                    {waiting.map((f) => f.name).join(', ')}. Tick the customers who should get each one.
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-4">
                {ordered.map((flag) => {
                  const busy = saving === flag.key;
                  const everyone = flag.rollout === 'all';
                  return (
                    <section key={flag.key} className="rounded-md border border-line bg-raised overflow-hidden">
                      <header className="px-5 pt-4 pb-3.5">
                        <div className="flex items-start justify-between gap-4">
                          <h2 className="font-display text-[17px] text-ink leading-snug">{flag.name}</h2>
                          <div className="flex items-center gap-2 shrink-0 pt-0.5">
                            {savedKey === flag.key && (
                              <span className="flex items-center gap-1 text-ok text-[12px]">
                                <Check className="w-3.5 h-3.5" aria-hidden="true" /> Saved
                              </span>
                            )}
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" aria-hidden="true" />}
                          </div>
                        </div>
                        <p className="text-[13.5px] text-ink-3 max-w-[60ch] mt-1">{flag.description}</p>
                        <p className="flex items-center gap-1.5 text-[12.5px] text-muted mt-2.5">
                          <Users className="w-3.5 h-3.5" aria-hidden="true" />
                          Currently seen by: <span className="text-ink-3">{audienceSummary(flag, tenants)}</span>
                        </p>
                      </header>

                      <div className="border-t border-line bg-surface px-5 py-3">
                        <ul className="flex flex-col">
                          <li>
                            <label
                              className={cn(
                                'flex items-center gap-3 py-2 cursor-pointer select-none',
                                busy && 'opacity-60 pointer-events-none',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={everyone}
                                disabled={busy}
                                onChange={() => toggleEveryone(flag)}
                                className="w-4 h-4 accent-[color:var(--ocean)] cursor-pointer"
                              />
                              <span className="text-[14px] text-ink">Everyone</span>
                              <span className="text-[12.5px] text-muted">including customers who join later</span>
                            </label>
                          </li>

                          {tenants.map((t) => {
                            const on = everyone || flag.tenants.some((x) => x.id === t.id);
                            return (
                              <li key={t.id} className="border-t border-line first:border-t-0">
                                <label
                                  className={cn(
                                    'flex items-center gap-3 py-2 cursor-pointer select-none',
                                    (busy || everyone) && 'opacity-60',
                                    busy && 'pointer-events-none',
                                    // While Everyone is on, the individual rows show as
                                    // ticked but are not the control — unticking one would
                                    // silently mean "everyone except". Turn Everyone off first.
                                    everyone && 'pointer-events-none',
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    disabled={busy || everyone}
                                    onChange={() => toggleCustomer(flag, t.id)}
                                    className="w-4 h-4 accent-[color:var(--ocean)] cursor-pointer"
                                  />
                                  <span className="text-[14px] text-ink">{t.name}</span>
                                </label>
                              </li>
                            );
                          })}

                          {tenants.length === 0 && (
                            <li className="py-2 text-[13.5px] text-muted">No customer accounts yet.</li>
                          )}
                        </ul>

                        {/* A customer removed after being picked still counts toward the
                            audience — show it so the summary line above adds up. */}
                        {flag.tenants.some((t) => !tenants.find((x) => x.id === t.id)) && (
                          <p className="text-[12.5px] text-muted pt-2 border-t border-line mt-1">
                            Also on: {flag.tenants.filter((t) => !tenants.find((x) => x.id === t.id)).map((t) => t.name).join(', ')}
                          </p>
                        )}
                      </div>

                      {flag.updated_at && (
                        <p className="px-5 py-2.5 border-t border-line text-[12px] text-muted-2">
                          Last changed {formatRelative(flag.updated_at)}
                          {flag.updated_by ? ` by ${flag.updated_by}` : ''}
                        </p>
                      )}
                    </section>
                  );
                })}

                {flags.length === 0 && (
                  <p className="text-[14px] text-muted">Nothing is waiting to be released right now.</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
