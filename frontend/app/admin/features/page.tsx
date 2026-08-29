'use client';

/**
 * /admin/features — the operator console: which tenants can see what.
 *
 * This is the screen that makes "deploy" and "release" different events. Code
 * reaches production on a deploy; a feature reaches a customer here.
 *
 * NOT gated by RequireRole. Every other admin page keys off the tenant role,
 * and that is exactly wrong for this one — a tenant admin administers their
 * own company and must not be able to grant themselves unreleased features.
 * Visibility keys off `useIsOperator()` (an environment allowlist, answered by
 * the server), and the API refuses non-operators with a 404 regardless of what
 * the client renders. The client check is courtesy; the server check is the
 * control.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, AlertTriangle, Users, Globe, EyeOff, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import AppShell from '@/components/layout/AppShell';
import { useIsOperator } from '@/lib/features';
import { formatRelative } from '@/lib/dates';
import { cn } from '@/lib/cn';
import type { FeatureRollout } from '@/lib/contract';

interface FlagRow {
  key: string;
  description: string;
  known: boolean;
  rollout: FeatureRollout;
  tenants: Array<{ id: number; name: string }>;
  updated_at: string | null;
  updated_by: string | null;
}

interface TenantRow { id: number; name: string }

const RINGS: Array<{ value: FeatureRollout; label: string; hint: string; icon: typeof Globe }> = [
  { value: 'off',     label: 'Nobody',        hint: 'Not visible to anyone, including you.',      icon: EyeOff },
  { value: 'tenants', label: 'Chosen tenants', hint: 'Only the tenants you pick below.',           icon: Users },
  { value: 'all',     label: 'Everyone',       hint: 'Every customer. Time to delete the flag.',   icon: Globe },
];

export default function FeatureFlagsPage() {
  const isOperator = useIsOperator();
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [operatorsConfigured, setOperatorsConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/feature-flags');
      const d = res.data?.data;
      setFlags(d?.flags ?? []);
      setTenants(d?.tenants ?? []);
      setOperatorsConfigured(d?.operatorsConfigured !== false);
      setDenied(false);
    } catch {
      // The server answers 404 rather than 403 for a non-operator, so there is
      // nothing here to distinguish "no such page" from "not for you" — which
      // is the point. Render the same explanation either way.
      setDenied(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(key: string, rollout: FeatureRollout, tenantIds: number[]) {
    setSaving(key);
    setError(null);
    // Optimistic: the switch must feel instant, and a failure restores state
    // from the server rather than guessing at what it was.
    setFlags((prev) => prev.map((f) => (
      f.key === key
        ? { ...f, rollout, tenants: tenantIds.map((id) => ({ id, name: tenants.find((t) => t.id === id)?.name ?? `Tenant ${id}` })) }
        : f
    )));
    try {
      await api.put(`/admin/feature-flags/${key}`, { rollout, tenantIds });
      setSavedKey(key);
      window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1800);
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? 'Could not save that change.');
      await load();
    } finally {
      setSaving(null);
    }
  }

  async function removeOrphan(key: string) {
    try {
      await api.delete(`/admin/feature-flags/${key}`);
      await load();
    } catch {
      setError('Could not remove that leftover flag.');
    }
  }

  function toggleTenant(flag: FlagRow, tenantId: number) {
    const has = flag.tenants.some((t) => t.id === tenantId);
    const next = has
      ? flag.tenants.filter((t) => t.id !== tenantId).map((t) => t.id)
      : [...flag.tenants.map((t) => t.id), tenantId];
    // Picking a tenant while the flag is off is what the operator means by
    // "release it to them" — promote the ring rather than making them do it
    // in two steps and wonder why nothing happened.
    void save(flag.key, next.length > 0 ? 'tenants' : flag.rollout === 'tenants' ? 'off' : flag.rollout, next);
  }

  return (
    <AppShell>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">

          <p className="font-mono text-[11px] tracking-[0.14em] uppercase text-muted-2 mb-2">Platform operator</p>
          <h1 className="font-display text-[28px] leading-tight text-ink mb-2">Who sees what</h1>
          <p className="text-[14.5px] text-ink-3 max-w-[62ch] mb-8">
            Code reaches production when you promote a deploy. A feature reaches a customer here.
            Move a feature outward one ring at a time — yourself, then a tenant you trust, then everyone —
            and pull it back the moment it misbehaves. Changes take effect within about 20 seconds; no deploy.
          </p>

          {loading && (
            <div className="flex items-center gap-2 text-muted text-sm py-10">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading…
            </div>
          )}

          {!loading && (denied || !isOperator) && (
            <div className="rounded-md border border-line bg-raised p-5">
              <h2 className="font-display text-[17px] text-ink mb-1.5">This console is not open to you</h2>
              <p className="text-[14px] text-ink-3 max-w-[60ch]">
                Feature rollouts are changed by platform operators, not by account admins — otherwise any
                customer could switch on work that has not been released to them.
              </p>
              <p className="text-[14px] text-ink-3 max-w-[60ch] mt-2.5">
                Operators are listed in the deployment&rsquo;s <code className="font-mono text-[12.5px] bg-softer px-1 py-0.5 rounded-sm">PLATFORM_OPERATOR_EMAILS</code>{' '}
                setting. Add your email there and redeploy to open it.
              </p>
            </div>
          )}

          {!loading && !denied && isOperator && (
            <>
              {!operatorsConfigured && (
                <div className="mb-5 rounded-md border border-warn bg-warn-soft px-4 py-3 text-[13.5px] text-ink flex gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-warn shrink-0 mt-0.5" aria-hidden="true" />
                  <span>No operators are configured, so nobody can change a rollout. Set <code className="font-mono text-[12.5px]">PLATFORM_OPERATOR_EMAILS</code> and redeploy.</span>
                </div>
              )}

              {error && (
                <div className="mb-5 rounded-md border border-err bg-err-soft px-4 py-3 text-[13.5px] text-err">{error}</div>
              )}

              <div className="flex flex-col gap-4">
                {flags.map((flag) => {
                  const busy = saving === flag.key;
                  return (
                    <section
                      key={flag.key}
                      className={cn(
                        'rounded-md border bg-raised p-5',
                        flag.known ? 'border-line' : 'border-warn',
                      )}
                    >
                      <div className="flex items-start justify-between gap-4 mb-1">
                        <h2 className="font-mono text-[13.5px] text-ink">{flag.key}</h2>
                        <div className="flex items-center gap-2 shrink-0">
                          {savedKey === flag.key && (
                            <span className="flex items-center gap-1 text-ok text-[12px]">
                              <Check className="w-3.5 h-3.5" aria-hidden="true" /> Saved
                            </span>
                          )}
                          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted" aria-hidden="true" />}
                          {!flag.known && (
                            <button
                              type="button"
                              onClick={() => void removeOrphan(flag.key)}
                              className="flex items-center gap-1 text-[12px] text-muted hover:text-err transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Remove
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="text-[13.5px] text-ink-3 max-w-[64ch] mb-4">{flag.description}</p>

                      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label={`Audience for ${flag.key}`}>
                        {RINGS.map((ring) => {
                          const active = flag.rollout === ring.value;
                          const Icon = ring.icon;
                          return (
                            <button
                              key={ring.value}
                              type="button"
                              disabled={busy || !flag.known}
                              aria-pressed={active}
                              title={ring.hint}
                              onClick={() => void save(flag.key, ring.value, flag.tenants.map((t) => t.id))}
                              className={cn(
                                'flex items-center gap-1.5 h-8 px-3 rounded-sm border text-[13px] transition-colors',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                                'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
                                active
                                  ? 'border-ocean bg-ocean-softer text-ink font-medium'
                                  : 'border-line bg-surface text-ink-3 hover:border-line-strong',
                              )}
                            >
                              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                              {ring.label}
                            </button>
                          );
                        })}
                      </div>

                      {flag.rollout === 'tenants' && (
                        <div className="border-t border-line pt-3.5">
                          <p className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-muted-2 mb-2.5">
                            Tenants on this ring
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {tenants.map((t) => {
                              const on = flag.tenants.some((x) => x.id === t.id);
                              return (
                                <button
                                  key={t.id}
                                  type="button"
                                  disabled={busy}
                                  aria-pressed={on}
                                  onClick={() => toggleTenant(flag, t.id)}
                                  className={cn(
                                    'h-7 px-2.5 rounded-full border text-[12.5px] transition-colors',
                                    'disabled:opacity-50',
                                    'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
                                    on
                                      ? 'border-ocean bg-ocean-softer text-ink'
                                      : 'border-line bg-surface text-muted hover:text-ink-3 hover:border-line-strong',
                                  )}
                                >
                                  {t.name}
                                </button>
                              );
                            })}
                            {tenants.length === 0 && (
                              <span className="text-[13px] text-muted">No tenants yet.</span>
                            )}
                          </div>
                          {/* A tenant that was deleted after joining the ring still counts
                              toward the audience; show it so the numbers add up. */}
                          {flag.tenants.some((t) => !tenants.find((x) => x.id === t.id)) && (
                            <p className="text-[12.5px] text-muted mt-2.5">
                              Also listed: {flag.tenants.filter((t) => !tenants.find((x) => x.id === t.id)).map((t) => t.name).join(', ')}
                            </p>
                          )}
                        </div>
                      )}

                      {flag.updated_at && (
                        <p className="text-[12px] text-muted-2 mt-3.5">
                          Last changed {formatRelative(flag.updated_at)}
                          {flag.updated_by ? ` by ${flag.updated_by}` : ''}
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>

              <p className="text-[13px] text-muted mt-7 max-w-[62ch]">
                Flags are declared in the code, not created here — that way a typo cannot invent a flag that
                is off forever. Once a feature has been on <strong className="text-ink-3 font-medium">Everyone</strong> for a
                while, delete the flag and its checks: a switch nobody will ever flip is just a branch in the code.
              </p>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
