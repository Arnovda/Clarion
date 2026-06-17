/**
 * Source-color palette — connector_type → tasteful color set.
 *
 * Same source is always tinted the same way across the app: ProductCardGrid
 * uses these for the card edge + section header, ProductPreviewPanel uses
 * them for the eyebrow + section icons. Single import, single source of
 * truth — visual continuity across surfaces.
 *
 * Each entry is a self-contained set of Tailwind classes. We use fixed
 * Tailwind palettes (emerald, amber, indigo, etc.) instead of Observatory
 * tokens because Tailwind 3's opacity modifier (/N) doesn't work with hex
 * CSS variables — and Observatory tokens are all hex variables.
 */

export interface SourcePalette {
  edge:       string;   // solid bar — card accent rail + band top edge
  dot:        string;   // small dot in section header
  eyebrow:    string;   // tint for the colored eyebrow + connector type label
  tintBg:     string;   // very faint background tint (section bands, reference wash)
  tintStrong: string;   // stronger tint for filled icon tiles
  ring:       string;   // border tone that matches the tint (tile + tinted card)
}

export const PALETTE_EMERALD: SourcePalette = { edge: 'bg-emerald-500',  dot: 'bg-emerald-500',  eyebrow: 'text-emerald-700',  tintBg: 'bg-emerald-50/60',  tintStrong: 'bg-emerald-100/80',  ring: 'border-emerald-200'  };
export const PALETTE_AMBER:   SourcePalette = { edge: 'bg-amber-500',    dot: 'bg-amber-500',    eyebrow: 'text-amber-700',    tintBg: 'bg-amber-50/60',    tintStrong: 'bg-amber-100/80',    ring: 'border-amber-200'    };
export const PALETTE_INDIGO:  SourcePalette = { edge: 'bg-indigo-500',   dot: 'bg-indigo-500',   eyebrow: 'text-indigo-700',   tintBg: 'bg-indigo-50/60',   tintStrong: 'bg-indigo-100/80',   ring: 'border-indigo-200'   };
export const PALETTE_ROSE:    SourcePalette = { edge: 'bg-rose-500',     dot: 'bg-rose-500',     eyebrow: 'text-rose-700',     tintBg: 'bg-rose-50/60',     tintStrong: 'bg-rose-100/80',     ring: 'border-rose-200'     };
export const PALETTE_TEAL:    SourcePalette = { edge: 'bg-teal-500',     dot: 'bg-teal-500',     eyebrow: 'text-teal-700',     tintBg: 'bg-teal-50/60',     tintStrong: 'bg-teal-100/80',     ring: 'border-teal-200'     };
export const PALETTE_VIOLET:  SourcePalette = { edge: 'bg-violet-500',   dot: 'bg-violet-500',   eyebrow: 'text-violet-700',   tintBg: 'bg-violet-50/60',   tintStrong: 'bg-violet-100/80',   ring: 'border-violet-200'   };
export const PALETTE_SLATE:   SourcePalette = { edge: 'bg-slate-400',    dot: 'bg-slate-400',    eyebrow: 'text-slate-600',    tintBg: 'bg-slate-50/80',    tintStrong: 'bg-slate-100/80',    ring: 'border-slate-200'    };
export const PALETTE_NEUTRAL: SourcePalette = { edge: 'bg-neutral-300',  dot: 'bg-neutral-300',  eyebrow: 'text-neutral-600',  tintBg: 'bg-neutral-50/80',  tintStrong: 'bg-neutral-100/80',  ring: 'border-neutral-200'  };

/**
 * Deterministic palette assignment — connector_type wins, then connection
 * name as fallback. Keeps the same source tinted the same way across
 * sessions and across tenants (every ExactOnline customer sees emerald).
 */
export function paletteForSource(connectorType: string | null, sourceName: string | null, sourceDeleted: boolean): SourcePalette {
  if (sourceDeleted) return PALETTE_NEUTRAL;

  // Known connectors get a fixed brand color. Picked to evoke the
  // connector's own brand where it's well-known, otherwise to avoid
  // collisions inside one deployment.
  if (connectorType) {
    const ct = connectorType.toLowerCase();
    if (ct === 'exactonline')   return PALETTE_EMERALD;
    if (ct === 'netsuite')      return PALETTE_INDIGO;
    if (ct === 'salesforce')    return PALETTE_TEAL;
    if (ct === 'hubspot')       return PALETTE_AMBER;
    if (ct === 'postgres')      return PALETTE_INDIGO;
    if (ct === 'mysql')         return PALETTE_AMBER;
    if (ct === 'sqlserver')     return PALETTE_ROSE;
    if (ct === 'sqlite')        return PALETTE_SLATE;
  }

  // Fallback for unknown connectors / custom names — hash the source name
  // into one of the remaining palettes so different sources within a
  // tenant don't all collide on the same color.
  const FALLBACK_PALETTES = [PALETTE_VIOLET, PALETTE_TEAL, PALETTE_AMBER, PALETTE_ROSE, PALETTE_INDIGO, PALETTE_EMERALD];
  if (!sourceName) return PALETTE_SLATE;
  const hash = Array.from(sourceName).reduce((a, c) => a + c.charCodeAt(0), 0);
  return FALLBACK_PALETTES[hash % FALLBACK_PALETTES.length];
}
