import { describe, expect, it } from 'vitest';
import { markGeometry, variantForSize, visibleGaps, SATELLITE_ANGLE } from '@/lib/clarionMark';

describe('Clarion mark geometry', () => {
  for (const variant of ['master', 'small'] as const) {
    it(`${variant}: every gap is open once round caps are counted`, () => {
      // The construction spec's own numbers failed exactly this: 16° gaps
      // minus two 11.5° caps rendered the three segments as one fused ring.
      const g = markGeometry(variant);
      const gaps = visibleGaps(g);
      expect(gaps).toHaveLength(4);
      for (const gap of gaps) expect(gap).toBeGreaterThan(10);
    });

    it(`${variant}: the satellite sits in its own gap, between ring-c and ring-a`, () => {
      const g = markGeometry(variant);
      const a = g.segments[0];
      const cEnd = g.segments[2].end + g.capDeg - 360;
      expect(a.start - g.capDeg).toBeGreaterThan(SATELLITE_ANGLE + g.satHalfDeg);
      expect(cEnd).toBeLessThan(SATELLITE_ANGLE - g.satHalfDeg);
    });

    it(`${variant}: the satellite is at least as thick as the ring`, () => {
      // A dot thinner than the stroke reads as a bump on a segment.
      const g = markGeometry(variant);
      expect(g.satR * 2).toBeGreaterThanOrEqual(g.stroke);
    });

    it(`${variant}: segments are equal and the amber overlay fits ring-a`, () => {
      const g = markGeometry(variant);
      const spans = g.segments.map((s) => s.span);
      expect(Math.max(...spans) - Math.min(...spans)).toBeLessThan(0.01);
      // The Uncertain overlay grows to 42° along ring-a.
      expect(g.segments[0].span).toBeGreaterThanOrEqual(42);
    });
  }

  it('uses the small construction below 20px', () => {
    expect(variantForSize(16)).toBe('small');
    expect(variantForSize(19)).toBe('small');
    expect(variantForSize(20)).toBe('master');
    expect(variantForSize(48)).toBe('master');
  });
});
