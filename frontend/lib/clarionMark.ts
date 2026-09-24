/**
 * The Clarion mark's geometry: three ring segments, one satellite dot sitting
 * in its own gap at the top right, and a centre dot.
 *
 * Why the numbers are COMPUTED here, not copied from the spec (2026-09-24):
 * the construction spec gave nominal arc angles with 16° gaps, but a round
 * line cap extends every segment by half the stroke width — about 11.5° at
 * the 24-unit master. Two caps closed each 16° gap completely (the segments
 * rendered as one fused U) and the satellite overlapped ring-a. So the rule
 * below starts from what must be VISIBLE — a clear gap of `gap` degrees
 * between every pair of shapes, cap included — and derives the path angles
 * from it. `visibleGaps` exists so a test can hold that property.
 *
 * Angles: 0° = 12 o'clock, clockwise positive (the spec's convention).
 */

export type MarkVariant = 'master' | 'small';

interface VariantSpec {
  /** viewBox is `0 0 view view`. */
  view: number;
  /** Ring centreline radius. */
  r: number;
  stroke: number;
  satR: number;
  centreR: number;
  /** Clear angular gap between every pair of neighbouring shapes, in degrees. */
  gap: number;
}

// The master mark is drawn for 20px and up; the small one is a separate
// construction for 16–19px (thicker relative stroke, wider gaps), never a
// scaled copy — a scaled master closes its gaps at 16px.
const SPECS: Record<MarkVariant, VariantSpec> = {
  master: { view: 24, r: 7.5, stroke: 3, satR: 1.6, centreR: 2.75, gap: 18 },
  small: { view: 16, r: 5.1, stroke: 2.35, satR: 1.3, centreR: 2.1, gap: 20 },
};

export const SATELLITE_ANGLE = 45;

export type SegmentId = 'ring-a' | 'ring-b' | 'ring-c';

export interface MarkSegment {
  id: SegmentId;
  /** Path angles (the cap extends beyond these). */
  start: number;
  end: number;
  /** Angular span of the path itself, in degrees — used as pathLength. */
  span: number;
  d: string;
}

export interface MarkGeometry {
  variant: MarkVariant;
  view: number;
  c: number;
  r: number;
  stroke: number;
  centreR: number;
  satR: number;
  sat: { cx: number; cy: number };
  segments: MarkSegment[];
  /** Angular half-width a round cap adds to a segment end. */
  capDeg: number;
  /** Angular half-width of the satellite. */
  satHalfDeg: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function polar(c: number, r: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [round3(c + r * Math.sin(t)), round3(c - r * Math.cos(t))];
}

function arcPath(c: number, r: number, start: number, end: number): string {
  const [x0, y0] = polar(c, r, start);
  const [x1, y1] = polar(c, r, end);
  const large = end - start > 180 ? 1 : 0;
  return `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

const cache = new Map<MarkVariant, MarkGeometry>();

export function markGeometry(variant: MarkVariant): MarkGeometry {
  const hit = cache.get(variant);
  if (hit) return hit;

  const s = SPECS[variant];
  const c = s.view / 2;
  const toDeg = (len: number) => (len / s.r) * (180 / Math.PI);
  const capDeg = toDeg(s.stroke / 2);
  const satHalfDeg = toDeg(s.satR);

  // The satellite's zone: the dot plus a clear gap either side. The three
  // segments (visible length L each, caps included) and the two gaps between
  // them share whatever remains of the circle.
  const zoneEnd = SATELLITE_ANGLE + satHalfDeg + s.gap;
  const zoneStart = SATELLITE_ANGLE - satHalfDeg - s.gap + 360;
  const visible = (zoneStart - zoneEnd - 2 * s.gap) / 3;

  const ids: SegmentId[] = ['ring-a', 'ring-b', 'ring-c'];
  const segments = ids.map((id, i) => {
    const visStart = zoneEnd + i * (visible + s.gap);
    const start = round3(visStart + capDeg);
    const end = round3(visStart + visible - capDeg);
    return { id, start, end, span: round3(end - start), d: arcPath(c, s.r, start, end) };
  });

  const [cx, cy] = polar(c, s.r, SATELLITE_ANGLE);
  const geom: MarkGeometry = {
    variant,
    view: s.view,
    c,
    r: s.r,
    stroke: s.stroke,
    centreR: s.centreR,
    satR: s.satR,
    sat: { cx, cy },
    segments,
    capDeg,
    satHalfDeg,
  };
  cache.set(variant, geom);
  return geom;
}

/** The small construction below 20px, the master from 20px up. */
export function variantForSize(px: number): MarkVariant {
  return px < 20 ? 'small' : 'master';
}

/**
 * The clear angular gaps actually rendered, going clockwise from the
 * satellite: satellite→ring-a, ring-a→ring-b, ring-b→ring-c, ring-c→satellite.
 * Caps and the satellite's width are included — this is what the eye sees.
 */
export function visibleGaps(g: MarkGeometry): number[] {
  const satStart = SATELLITE_ANGLE - g.satHalfDeg;
  const satEnd = SATELLITE_ANGLE + g.satHalfDeg;
  const vis = g.segments.map((s) => [s.start - g.capDeg, s.end + g.capDeg]);
  return [
    vis[0][0] - satEnd,
    vis[1][0] - vis[0][1],
    vis[2][0] - vis[1][1],
    satStart + 360 - vis[2][1],
  ];
}
