/**
 * Managed grids ("Your tables") — shared types for the list page and the
 * editor. Mirrors GET/POST/PUT /api/grids (camelCase mapping happens at the
 * fetch boundary, per house convention).
 */

export type GridColumnType = 'text' | 'number' | 'date' | 'boolean';
export type GridKind = 'budget' | 'mapping' | 'list';

export interface GridColumn {
  /** Stable identifier — becomes the column name in answers/dashboards. */
  key: string;
  /** Display label, renamed freely. */
  name: string;
  type: GridColumnType;
}

export interface GridSummary {
  id: number;
  name: string;
  slug: string;
  /** The name this table answers to in questions: `grid_<slug>`. */
  viewName: string;
  description: string | null;
  kind: GridKind;
  columns: GridColumn[];
  rowCount: number;
  materializedAt: string | null;
  materializeError: string | null;
  updatedAt: string;
  updatedBy: string | null;
  createdAt: string;
}

export interface GridDetail extends GridSummary {
  rows: Array<{ id: number; data: Record<string, unknown> }>;
}

/**
 * Client-side mirror of the server's column-key derivation, so a freshly
 * added column has a usable key before the first save. The server validates
 * (and would re-derive) either way — divergence is harmless, agreement is
 * nicer.
 */
export function deriveColumnKey(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/g, '');
  if (base === '' || !/^[a-z]/.test(base)) base = base === '' ? 'column' : `c_${base}`.slice(0, 60);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface GridTemplate {
  kind: GridKind;
  title: string;
  description: string;
  suggestedName: string;
  columns: Array<{ name: string; type: GridColumnType }>;
}

export const GRID_TEMPLATES: GridTemplate[] = [
  {
    kind: 'budget',
    title: 'Budget',
    description: 'Planned amounts per category and period — ask "how are we doing against budget?"',
    suggestedName: `Budget ${new Date().getFullYear()}`,
    columns: [
      { name: 'Category', type: 'text' },
      { name: 'Period', type: 'date' },
      { name: 'Amount', type: 'number' },
    ],
  },
  {
    kind: 'mapping',
    title: 'Mapping',
    description: 'Translate one set of names into another — regions, reporting lines, groupings.',
    suggestedName: 'Mapping',
    columns: [
      { name: 'From', type: 'text' },
      { name: 'To', type: 'text' },
    ],
  },
  {
    kind: 'list',
    title: 'Blank list',
    description: 'Start from scratch and shape the columns yourself.',
    suggestedName: 'New table',
    columns: [
      { name: 'Name', type: 'text' },
      { name: 'Value', type: 'number' },
    ],
  },
];

export const COLUMN_TYPE_LABEL: Record<GridColumnType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
};
