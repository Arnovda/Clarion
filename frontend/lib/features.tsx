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
}

const FeaturesContext = createContext<FeaturesState>({
  features: {},
  isOperator: false,
  loaded: false,
});

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeaturesState>({ features: {}, isOperator: false, loaded: false });

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
        });
      })
      .catch(() => {
        // Signed out, offline, or the endpoint is unavailable. Everything stays
        // off and the app renders as it did before flags existed. `loaded` is
        // set so pages waiting on it are released rather than stuck.
        if (!cancelled) setState({ features: {}, isOperator: false, loaded: true });
      });
    return () => { cancelled = true; };
  }, []);

  return <FeaturesContext.Provider value={state}>{children}</FeaturesContext.Provider>;
}

/** Is this feature on for the signed-in tenant? False until the answer arrives. */
export function useFeature(key: FeatureKey): boolean {
  return useContext(FeaturesContext).features[key] === true;
}

/** True once the answer has arrived — lets a page distinguish "off" from "unknown". */
export function useFeaturesLoaded(): boolean {
  return useContext(FeaturesContext).loaded;
}

/** True when this user may change rollouts. Gates the operator console only. */
export function useIsOperator(): boolean {
  return useContext(FeaturesContext).isOperator;
}
