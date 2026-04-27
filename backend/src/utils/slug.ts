/**
 * Slug helpers for the catalog browser.
 *
 * Catalog URLs use slugs instead of raw integer IDs so the URLs read like a
 * Unity-Catalog-style three-level namespace (catalog/schema/table).
 *
 * Slugs are:
 *   - lowercased
 *   - non-alphanumeric chars (other than `_`) replaced with `_`
 *   - runs of `_` collapsed to a single `_`
 *   - leading/trailing `_` stripped
 *
 * Because two source connections (or two data products) can share the same
 * display name, `toSlugWithId` appends `_<id>` deterministically when needed
 * for stable, collision-free identifiers in URLs.
 */

export function toSlug(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function toSlugWithId(name: string, id: number): string {
  const base = toSlug(name) || 'unnamed';
  return `${base}_${id}`;
}

/**
 * Parse a `<base>_<id>` slug back into its trailing numeric id, or null if the
 * slug doesn't end in `_<digits>`. Used by the catalog router to resolve
 * `:schema` slugs back to a connection or data-product id.
 */
export function parseIdFromSlug(slug: string): number | null {
  const m = slug.match(/_(\d+)$/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}
