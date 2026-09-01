/**
 * chooseBusinessKey — the fallback that runs when a source declares nothing.
 *
 * The bug it replaces: the old rule was "the column with the highest distinct
 * percentage, first one wins a tie". On ExactOnline's BankEntryLines that
 * chose `Created` — a timestamp, unique because rows arrive at different
 * instants — and the table then reported 100% BK completeness and 100% BK
 * uniqueness while identifying nothing. A wrong key is worse than none: an
 * empty score reads as "not measured", a wrong one reads as "perfect".
 */

import { describe, it, expect } from 'vitest';
import { chooseBusinessKey, type FieldStat } from '../quality/QualityProfiler';

/** A perfectly unique, never-null column of the given type. */
const unique = (name: string, type = 'VARCHAR'): FieldStat => ({
  field_name: name, data_type: type,
  null_count: 0, null_pct: 0,
  distinct_count: 100, distinct_pct: 1,
  min_value: null, max_value: null, mean_value: null, median_value: null,
  top_values: [], histogram: [],
});

const withStats = (f: FieldStat, patch: Partial<FieldStat>): FieldStat => ({ ...f, ...patch });

describe('chooseBusinessKey', () => {
  it('THE PRODUCTION CASE: prefers ID over a unique Created timestamp', () => {
    // Field order deliberately puts Created first — under the old rule that
    // alone decided it.
    const fields = [
      unique('Created', 'TIMESTAMP'),
      unique('Modified', 'TIMESTAMP'),
      unique('ID', 'VARCHAR'),
      withStats(unique('EntryNumber'), { distinct_pct: 0.4 }),
    ];
    expect(chooseBusinessKey(fields, 'BankEntryLines')).toBe('ID');
  });

  it('never proposes a timestamp, even when it is the ONLY unique column', () => {
    const fields = [
      unique('Created', 'TIMESTAMP'),
      withStats(unique('Description'), { distinct_pct: 0.2 }),
    ];
    expect(chooseBusinessKey(fields, 'BankEntryLines')).toBeNull();
  });

  it('returns null rather than naming a column that is merely unique', () => {
    // A free-text column can be unique by coincidence. Nothing here says
    // "identity", so the honest answer is that we do not know.
    const fields = [unique('Description'), unique('Notes')];
    expect(chooseBusinessKey(fields, 'Documents')).toBeNull();
  });

  it('rejects a column that is unique but has nulls — a key identifies every row', () => {
    const fields = [withStats(unique('ID'), { null_count: 3, null_pct: 0.03 })];
    expect(chooseBusinessKey(fields, 'Accounts')).toBeNull();
  });

  it('rejects a key-shaped column that is not unique', () => {
    const fields = [withStats(unique('EntryID'), { distinct_pct: 0.12 })];
    expect(chooseBusinessKey(fields, 'BankEntryLines')).toBeNull();
  });

  it('prefers the table-qualified key over an unrelated one', () => {
    const fields = [unique('ParentID'), unique('AccountID')];
    expect(chooseBusinessKey(fields, 'Accounts')).toBe('AccountID');
  });

  it('prefers bare ID over any qualified id', () => {
    const fields = [unique('ParentID'), unique('ID'), unique('AccountID')];
    expect(chooseBusinessKey(fields, 'Accounts')).toBe('ID');
  });

  it('accepts a natural code key — some sources key on Code, not a surrogate', () => {
    const fields = [unique('Code'), withStats(unique('Description'), { distinct_pct: 0.9 })];
    expect(chooseBusinessKey(fields, 'Journals')).toBe('Code');
  });

  it('accepts a suffix-shaped key (invoice_number)', () => {
    expect(chooseBusinessKey([unique('invoice_number')], 'invoices')).toBe('invoice_number');
  });

  it('is deterministic when two candidates rank equally', () => {
    const fields = [unique('b_id'), unique('a_id')];
    // Same rank, same length → alphabetical, so the same data always yields
    // the same answer rather than depending on column order.
    expect(chooseBusinessKey(fields, 'Things')).toBe('a_id');
    expect(chooseBusinessKey([...fields].reverse(), 'Things')).toBe('a_id');
  });

  it('identifies nothing in an empty table instead of scoring it 0%', () => {
    // rowCount 0 ⇒ every distinct_pct is 0. The old rule still named a column
    // and published a 0% uniqueness score for a table with no data to judge.
    const fields = [withStats(unique('ID'), { distinct_count: 0, distinct_pct: 0 })];
    expect(chooseBusinessKey(fields, 'Accounts')).toBeNull();
  });

  it('tolerates float division just under 1 on a large table', () => {
    const fields = [withStats(unique('ID'), { distinct_count: 999_999, distinct_pct: 0.9999 })];
    expect(chooseBusinessKey(fields, 'Accounts')).toBe('ID');
  });

  it('never proposes a boolean or a float', () => {
    const fields = [unique('IsActive', 'BOOLEAN'), unique('Amount', 'DOUBLE')];
    expect(chooseBusinessKey(fields, 'Accounts')).toBeNull();
  });

  it('handles a table with no columns at all', () => {
    expect(chooseBusinessKey([], 'Empty')).toBeNull();
  });
});
