'use client';

/**
 * i18n provider (P2-1) — the interface language, resolved once per app
 * mount and offered as `useT()` / `useI18n()`.
 *
 * RESOLUTION ORDER, and why:
 *  1. The signed-in user's stored preference (`users.locale`, fetched from
 *     /users/profile) — a deliberate choice beats any guess.
 *  2. The browser's language (`navigator.language` starts with 'nl') — so a
 *     Dutch machine gets a Dutch SIGN-IN SCREEN before any account exists,
 *     and a user who never touches the switcher still lands right.
 *  3. English.
 *
 * Language is a USER preference, not a URL: this is a logged-in B2B tool,
 * so /nl/… route prefixes would churn every deep link and bookmark for
 * nothing. `setLocale` applies immediately and persists via
 * PATCH /users/profile when signed in (best-effort — the screen must flip
 * even if the save blips).
 *
 * PLACEMENT: mounted ONCE in the root layout, above every page and both
 * copies of the app chrome — the FeaturesProvider lesson (two chromes must
 * provide the same context) solved by construction. Nesting is a no-op:
 * the outermost provider wins, a nested one renders children untouched.
 * The hooks THROW outside the provider so a misplaced call fails
 * `next build`'s prerender (a merge gate), never silently renders the
 * wrong language — the exact failure mode the features context had.
 *
 * The switcher (TopBar avatar menu) offers ONLY locales listed in
 * AVAILABLE_LOCALES — a language appears when its dictionary is COMPLETE
 * (typed against en.ts), never as a half-translated pretence. French joins
 * by adding fr.ts + one entry here + the backend enum.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import en, { type Dictionary } from './en';
import nl from './nl';
import api from '../api';
import { getTokenPayload } from '../auth';
import { setDatesLocale } from '../dates';

export type Locale = 'en' | 'nl';

export const AVAILABLE_LOCALES: ReadonlyArray<{ code: Locale; name: string }> = [
  { code: 'en', name: en.langName },
  { code: 'nl', name: nl.langName },
];

const DICTS: Record<Locale, Dictionary> = { en, nl };

export function browserLocaleGuess(lang?: string): Locale {
  const l = (lang ?? (typeof navigator !== 'undefined' ? navigator.language : '') ?? '').toLowerCase();
  return l.startsWith('nl') ? 'nl' : 'en';
}

interface I18nValue {
  locale: Locale;
  t: Dictionary;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const parent = useContext(I18nContext);
  // Initial state is 'en' on server AND first client render — identical
  // markup, no hydration mismatch; the guess/preference lands in effects.
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    if (parent) return; // nested provider: inert by design
    setLocaleState(browserLocaleGuess());
    if (!getTokenPayload()) return;
    let cancelled = false;
    api
      .get('/users/profile')
      .then((res) => {
        const stored = res.data?.data?.locale;
        if (!cancelled && (stored === 'en' || stored === 'nl')) setLocaleState(stored);
      })
      .catch(() => { /* guess stands */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The <html lang> attribute and the date formatter follow the active
  // locale — the root layout's server-rendered lang="en" is just the shell.
  useEffect(() => {
    if (parent) return;
    document.documentElement.lang = locale;
    setDatesLocale(locale);
  }, [locale, parent]);

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: DICTS[locale],
      setLocale: (l: Locale) => {
        setLocaleState(l);
        // Persist only a signed-in user's deliberate choice; pre-login the
        // guess simply re-runs next visit, which is the honest behaviour.
        if (getTokenPayload()) {
          api.patch('/users/profile', { locale: l }).catch(() => { /* screen already flipped */ });
        }
      },
    }),
    [locale],
  );

  if (parent) return <>{children}</>;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(I18nContext);
  if (!v) {
    // Thrown, not defaulted: a default would silently render English from
    // the wrong tree position — the features-context bug all over again.
    throw new Error('useI18n/useT called outside I18nProvider — it mounts once in app/layout.tsx');
  }
  return v;
}

export function useT(): Dictionary {
  return useI18n().t;
}
