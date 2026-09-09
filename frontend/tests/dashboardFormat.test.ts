import { describe, it, expect } from 'vitest';
import { yAxisFormatter, looksLikeYearColumn, formatIsoTimestamp, formatValue } from '../app/dashboards/utils/format';

describe('yAxisFormatter honours the widget format', () => {
  it('a count axis never says €', () => {
    const f = yAxisFormatter(4500, 'number');
    expect(f(1500)).toBe('1.5k');
    expect(f(1500)).not.toContain('€');
  });
  it('a percentage axis says %', () => {
    expect(yAxisFormatter(100, 'percentage')(43)).toBe('43%');
  });
  it('a currency axis says € at every magnitude', () => {
    expect(yAxisFormatter(800, 'currency')(500)).toBe('€500');
    expect(yAxisFormatter(4500, 'currency')(1500)).toBe('€1.5k');
    expect(yAxisFormatter(45000, 'currency')(15000)).toBe('€15k');
  });
  it('without a format the historical heuristic stands: big numbers are money', () => {
    expect(yAxisFormatter(4500)(1500)).toBe('€1.5k');
    expect(yAxisFormatter(800)(500)).toBe('500');
  });
});

describe('looksLikeYearColumn', () => {
  it('whole numbers in 1900..2100 are years', () => {
    expect(looksLikeYearColumn([2023, 2024, 2025, null])).toBe(true);
    expect(looksLikeYearColumn(['2024', '2025'])).toBe(true);
  });
  it('anything else is not', () => {
    expect(looksLikeYearColumn([2023, 2024, 12500])).toBe(false);
    expect(looksLikeYearColumn([2024.5])).toBe(false);
    expect(looksLikeYearColumn([null, undefined, ''])).toBe(false);
    expect(looksLikeYearColumn([])).toBe(false);
  });
  it('is the reason a year cell no longer reads as money', () => {
    expect(formatValue(2025)).toBe('€2.025,00');        // the bug, kept for numbers that really are money
    expect(formatValue(2025, 'id')).toBe('2025');       // what a year column now gets
  });
});

describe('formatIsoTimestamp', () => {
  it('a DATE that crossed the wire as a midnight stamp becomes the date', () => {
    expect(formatIsoTimestamp('2025-01-31T00:00:00.000Z')).toBe('2025-01-31');
  });
  it('a real timestamp keeps HH:MM', () => {
    expect(formatIsoTimestamp('2025-01-31T14:05:09.000Z')).toBe('2025-01-31 14:05');
    expect(formatIsoTimestamp('2025-01-31T14:05:09+02:00')).toBe('2025-01-31 14:05');
  });
  it('leaves every other string alone', () => {
    for (const s of ['2025-01-31', 'Van Damme BVBA', '', '2025-01-31T', 'T00:00']) expect(formatIsoTimestamp(s)).toBe(s);
  });
});
