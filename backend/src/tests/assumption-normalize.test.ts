/**
 * Structured assumptions — worksheet phase 5 (§4.3 chips-as-controls).
 *
 * The assumptions field is MODEL OUTPUT whose contract changed from
 * string[] to objects; `defaultSubScores` must accept BOTH shapes and
 * anything in between (the defaultPreset lesson: any field the model
 * writes is parsed tolerantly at every consumer). These tests pin:
 *  - legacy strings still work and stay in the label list
 *  - structured entries round-trip with options/value/silent
 *  - silent entries are EXCLUDED from the legacy label list (chips) but
 *    present in assumption_details (the "+ add" source)
 *  - malformed garbage degrades or drops, never throws
 *  - caps hold (8 assumptions, 6 options)
 */

import { describe, it, expect } from 'vitest';
import { defaultSubScores } from '../ai/AIService';

const base = { intent: 'data', sql: 'SELECT 1', confidence: 0.9 };

describe('assumption normalization', () => {
  it('accepts legacy string assumptions', () => {
    const out = defaultSubScores({ ...base, assumptions: ['Revenue excl. VAT', '  ', 'Active only'] });
    expect(out.assumptions).toEqual(['Revenue excl. VAT', 'Active only']);
    expect(out.assumption_details).toHaveLength(2);
    expect(out.assumption_details![0]).toMatchObject({ label: 'Revenue excl. VAT', options: [], silent: false });
  });

  it('accepts a bare string (model forgot the array)', () => {
    const out = defaultSubScores({ ...base, assumptions: 'Drafts excluded' });
    expect(out.assumptions).toEqual(['Drafts excluded']);
  });

  it('round-trips structured entries; silent ones leave the chip labels', () => {
    const out = defaultSubScores({
      ...base,
      assumptions: [
        {
          label: 'Revenue excl. VAT', detail: 'Both columns exist',
          options: [{ value: 'excl_vat', label: 'excl. VAT' }, { value: 'incl_vat', label: 'incl. VAT' }],
          value: 'excl_vat', silent: false,
        },
        {
          label: 'Last 12 months', detail: 'Default window',
          options: [{ value: 'm12', label: 'last 12 months' }, { value: 'ytd', label: 'this year' }],
          value: 'm12', silent: true,
        },
      ],
    });
    expect(out.assumptions).toEqual(['Revenue excl. VAT']); // silent excluded
    expect(out.assumption_details).toHaveLength(2);
    expect(out.assumption_details![0].options).toHaveLength(2);
    expect(out.assumption_details![0].value).toBe('excl_vat');
    expect(out.assumption_details![1].silent).toBe(true);
  });

  it('degrades malformed entries instead of throwing', () => {
    const out = defaultSubScores({
      ...base,
      assumptions: [
        { label: 'Ok one', options: 'not-an-array', value: 42, silent: 'yes' }, // fields wrong types
        { detail: 'no label at all' },                                          // dropped
        null, 7,                                                               // dropped
        { label: 'Options mixed', options: ['plain string', { label: 'obj' }, { value: 'v' }, null] },
      ],
    });
    expect(out.assumptions).toEqual(['Ok one', 'Options mixed']);
    const mixed = out.assumption_details!.find((a) => a.label === 'Options mixed')!;
    // string option → {value,label}; label-only object keeps label as value;
    // value-only and null are dropped (no label to render).
    expect(mixed.options).toEqual([
      { value: 'plain string', label: 'plain string' },
      { value: 'obj', label: 'obj' },
    ]);
    const okOne = out.assumption_details!.find((a) => a.label === 'Ok one')!;
    expect(okOne.options).toEqual([]);
    expect(okOne.silent).toBe(false); // 'yes' is not true
  });

  it('caps at 8 assumptions and 6 options', () => {
    const out = defaultSubScores({
      ...base,
      assumptions: Array.from({ length: 12 }, (_, i) => ({
        label: `A${i}`,
        options: Array.from({ length: 10 }, (_, j) => ({ value: `v${j}`, label: `o${j}` })),
      })),
    });
    expect(out.assumption_details).toHaveLength(8);
    expect(out.assumption_details![0].options).toHaveLength(6);
  });
});
