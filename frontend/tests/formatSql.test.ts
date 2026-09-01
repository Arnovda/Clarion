/**
 * P1-7 — the one SQL formatter (lib/formatSql.ts). Its two contract
 * points: keywords inside STRING LITERALS survive (the defect the naive
 * regex it replaced had), and unparseable input comes back verbatim
 * instead of throwing inside a render.
 */

import { describe, it, expect } from 'vitest';
import { formatSql } from '../lib/formatSql';

describe('formatSql', () => {
  it('formats a query with upper keywords', () => {
    const out = formatSql('select a, b from t where a = 1');
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('never mangles keywords inside string literals', () => {
    const out = formatSql("select * from t where note = 'please select from the list'");
    expect(out).toContain("'please select from the list'");
  });

  it('returns unparseable input verbatim instead of throwing', () => {
    const garbage = 'this is (( not sql @@';
    expect(formatSql(garbage)).toBe(garbage);
    expect(formatSql('')).toBe('');
  });

  it('keeps {{placeholder}} tokens intact', () => {
    const out = formatSql("select * from t where ('{{customer}}' = 'all' or c = '{{customer}}')");
    expect(out.match(/\{\{customer\}\}/g)).toHaveLength(2);
  });
});
