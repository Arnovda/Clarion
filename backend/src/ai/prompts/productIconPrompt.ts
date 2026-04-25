/**
 * AI prompt — generate a single, line-icon SVG for a data product.
 *
 * The icon must match the existing app aesthetic (lucide-react line icons
 * already used throughout the UI):
 *   • 24×24 viewBox
 *   • monochrome — strokes use `currentColor` so the surrounding text-color
 *     class (e.g. `text-ocean`) themes the icon
 *   • stroke-width 1.75, stroke-linecap "round", stroke-linejoin "round"
 *   • no fill, no gradients, no text, no images, no <defs>, no <style>
 *   • a single root <svg> element only
 */

export const PRODUCT_ICON_SYSTEM = `You design minimal line-style SVG icons that match the Lucide icon set used by an analytics app.

Output a SINGLE <svg> element representing the data product. Strict rules:
- Root element MUST be exactly: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
- Inside use ONLY these elements: <path>, <circle>, <line>, <rect>, <polyline>, <polygon>, <ellipse>, <g>
- NO <text>, NO <image>, NO <defs>, NO <style>, NO <filter>, NO <use>, NO gradients
- NO fill colors, NO stroke colors — leave stroke="currentColor" inherited from the root
- Keep it geometric and recognizable at 24×24 — about 4 to 12 simple shapes
- Use the full canvas: shapes should reach near x=2..22, y=2..22 (not crammed in a corner)
- Do not include "data:" URIs or external references
- Output ONLY the SVG markup, no markdown fences, no commentary, no XML declaration

Pick a metaphor that matches the product's BUSINESS DOMAIN, not its technical role. Examples:
- "Sales 360" → shopping bag, coin stack, or upward chart
- "Customer Insights" → person silhouette, contact card, heart
- "Inventory" → boxes, warehouse, layered crates
- "HR / People" → user group, ID badge
- "Finance" → bar chart with axis, ledger
- "Logistics / Delivery" → truck, package with route
- "Marketing" → megaphone, target
Always prefer a single clear metaphor over a busy collage.`;

export function buildProductIconUser(name: string, description?: string | null): string {
  const desc = (description ?? '').trim();
  return [
    `Product name: ${name}`,
    desc ? `Description: ${desc}` : null,
    '',
    'Return ONLY the <svg>…</svg> markup.',
  ].filter(Boolean).join('\n');
}
