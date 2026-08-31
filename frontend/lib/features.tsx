'use client';

/**
 * Feature flags on the client.
 *
 * `GET /api/features` answers what is switched on for the signed-in user's
 * tenant. It is fetched ONCE per app shell mount and shared through context,
 * so a page asks `useFeature('x')` without a request of its own.
 *
 * WHILE THE ANSWER IS IN FLIGHT, EVERY FLAG READS FALSE. That is the safe
 * direction and it is a deliberate choice: a feature that flickers into view
 * and disappears is worse than one that appears a beat late, and a preview
 * feature must never be briefly visible to a tenant that is not on the ring.
 * Use `featuresLoaded` when a page needs to tell "off" from "not known yet"
 * — for example to hold a skeleton rather than render the old layout first.
 *
 * A FAILED FETCH IS NOT AN ANSWER, and this file has to say which it got.
 * Everything reading false because the request errored looks identical to
 * everything being switched off — and for `isOperator` that difference is the
 * whole story: it is the difference between "you may not open this" and "we
 * could not ask". That conflation cost an afternoon once already, one layer
 * up, and the fix there does not help while this layer still swallows it. So
 * `failed` is carried alongside, and a screen whose refusal would be a lie
 * checks it.
 *
 * There is no client-side cache on purpose. The response is a few dozen bytes,
 * the shell mounts once per navigation session, and caching it in
 * sessionStorage would mean a rollout change needs the tab closed to take
 * effect — which is exactly the property flags exist to avoid.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import api from '@/lib/api';
import type { FeatureKey } from '@/lib/contract';

interface FeaturesState {
  features: Record<string, boolean>;
  isOperator: boolean;
  loaded: boolean;
  /** The request errored. Flags read false, but nothing here was answered. */
  failed: boolean;
}

/**
 * NO DEFAULT VALUE, AND THAT IS THE POINT.
 *
 * This context used to default to `{isOperator: false, loaded: false}`, which
 * is a perfectly plausible-looking answer — and a component rendered OUTSIDE
 * the provider got it silently. It cost the operator console: the page read
 * `useIsOperator()` in its own body, above the `<AppShell>` that owns the
 * provider, so it read the default and refused its own operator while the nav
 * entry beside it (inside the shell) rendered correctly. An afternoon went into
 * the email allowlist, the deploy pipeline and the production logs before the
 * scope was the answer.
 *
 * So there is no default. Reading a flag outside the provider throws, loudly,
 * at first render — including during `next build`'s prerender, which makes it
 * a merge gate rather than a thing to remember. Every one of these hooks
 * answers a visibility question; a wrong answer hides a feature forever or
 * locks someone out of their own console, and neither announces itself.
 */
const FeaturesContext = createContext<FeaturesState | null>(null);

function useFeaturesState(): FeaturesState {
  const state = useContext(FeaturesContext);
  if (!state) {
    throw new Error(
      'Feature flags were read outside <FeaturesProvider>. The provider lives in '
      + 'AppShell, so a page cannot read a flag in its own body — it renders above '
      + 'the shell. Move the read into a child component rendered inside <AppShell>.',
    );
  }
  return state;
}

/**
 * Mount the provider. Nesting is a no-op ON PURPOSE: the chrome is mounted by
 * two components (AppShell and ShellLayout) and a page under one of them may
 * later render the other, at which point a second provider would fire a second
 * request and — far worse — hand its subtree a different answer than the rail
 * above it is reading. The outermost provider wins; an inner one passes
 * through.
 */
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const outer = useContext(FeaturesContext);
  if (outer) return <>{children}</>;
  return <FetchingFeaturesProvider>{children}</FetchingFeaturesProvider>;
}

function FetchingFeaturesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeaturesState>({
    features: {}, isOperator: false, loaded: false, failed: false,
  });

  useEffect(() => {
    let cancelled = false;
    api
      .get('/features')
      .then((res) => {
        if (cancelled) return;
        const data = res.data?.data as { features?: Record<string, boolean>; isOperator?: boolean } | undefined;
        setState({
          features: data?.features ?? {},
          isOperator: !!data?.isOperator,
          loaded: true,
          failed: false,
        });
      })
      .catch(() => {
        // Signed out, offline, or the endpoint is unavailable. Everything stays
        // off and the app renders as it did before flags existed — but `failed`
        // records that this is silence, not an answer, so a screen that would
        // otherwise tell someone they are not allowed in can say the truth
        // instead.
        if (!cancelled) setState({ features: {}, isOperator: false, loaded: true, failed: true });
      });
    return () => { cancelled = true; };
  }, []);

  return <FeaturesContext.Provider value={state}>{children}</FeaturesContext.Provider>;
}

/** Is this feature on for the signed-in tenant? False until the answer arrives. */
export function useFeature(key: FeatureKey): boolean {
  return useFeaturesState().features[key] === true;
}

/** True once the answer has arrived — lets a page distinguish "off" from "unknown". */
export function useFeaturesLoaded(): boolean {
  return useFeaturesState().loaded;
}

/** True when this user may change rollouts. Gates the operator console only. */
export function useIsOperator(): boolean {
  return useFeaturesState().isOperator;
}

/**
 * True when the flags request ERRORED, so `isOperator` and every flag are
 * defaults rather than answers. Only screens whose behaviour would be a
 * false statement need this — chiefly the operator console, which must not
 * tell someone they lack access when the truth is that nothing was asked.
 */
export function useFeaturesFailed(): boolean {
  return useFeaturesState().failed;
}
