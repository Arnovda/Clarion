/**
 * P2-1 — the i18n mechanism. The COMPLETENESS of a translation is enforced
 * by the type system (nl.ts is typed `Dictionary`, and the P1-7 gate runs
 * tsc), so these tests pin the parts types cannot: the runtime SHAPE parity
 * (a key whose VALUE kind drifts — string vs function — would type-check in
 * isolation but break a caller), the browser-language guess, and the two
 * provider contracts (outside-provider throws; nesting is a no-op).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '../lib/i18n/en';
import nl from '../lib/i18n/nl';
import { I18nProvider, browserLocaleGuess, useT } from '../lib/i18n';

function shapeOf(obj: unknown, path = ''): string[] {
  if (typeof obj === 'function') return [`${path}:fn`];
  if (typeof obj === 'string') return [`${path}:str`];
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>)
      .flatMap(([k, v]) => shapeOf(v, path ? `${path}.${k}` : k))
      .sort();
  }
  return [`${path}:${typeof obj}`];
}

describe('dictionaries', () => {
  it('nl has exactly the shape of en — every key, same kind', () => {
    expect(shapeOf(nl)).toEqual(shapeOf(en));
  });

  it('locale names are written in their own language, never translated', () => {
    expect(en.langName).toBe('English');
    expect(nl.langName).toBe('Nederlands');
  });
});

describe('browserLocaleGuess', () => {
  it('any nl-* browser guesses Dutch; everything else English', () => {
    expect(browserLocaleGuess('nl-BE')).toBe('nl');
    expect(browserLocaleGuess('nl')).toBe('nl');
    expect(browserLocaleGuess('NL-NL')).toBe('nl');
    expect(browserLocaleGuess('fr-BE')).toBe('en'); // no fr dictionary yet
    expect(browserLocaleGuess('en-GB')).toBe('en');
    expect(browserLocaleGuess(undefined)).toBe('en');
  });
});

function Probe() {
  const t = useT();
  return <span>{t.nav.items.subjects}</span>;
}

describe('I18nProvider', () => {
  it('serves the dictionary to consumers', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    // jsdom's navigator.language is en-US → English dictionary.
    expect(screen.getByText(en.nav.items.subjects)).toBeTruthy();
  });

  it('nesting is a no-op — the outermost provider wins (the two-chromes rule)', () => {
    render(
      <I18nProvider>
        <I18nProvider>
          <Probe />
        </I18nProvider>
      </I18nProvider>,
    );
    expect(screen.getAllByText(en.nav.items.subjects)).toHaveLength(1);
  });

  it('useT outside the provider THROWS — never silently renders the wrong language', () => {
    // A default here would be the features-context bug again: a component
    // reading from the wrong tree position cannot report it.
    expect(() => render(<Probe />)).toThrow(/I18nProvider/);
  });
});
