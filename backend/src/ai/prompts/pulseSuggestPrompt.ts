/**
 * Pulse Suggest Prompt — given a user's products and their KPIs,
 * propose 5-7 pulse entries the user might want to track.
 *
 * Output is structured JSON: each suggestion has a kind, a reference
 * to an existing KPI, an optional dimension to slice by, a sensitivity,
 * and a one-line rationale ("why we're suggesting this").
 *
 * We DON'T invent KPIs — only reference ones that already exist on
 * the user's products. If the user has no KPIs yet, we return an
 * empty list and surface a clear hint that they should define KPIs
 * first.
 */

export interface PulseSuggestContext {
  userDisplayName: string | null;
  /** Each product the user has access to, with its KPIs and a few key
   *  dimension columns (any column with role="dimension" on a fact or
   *  dim table). Used to propose slice-style entries. */
  products: Array<{
    productId: number;
    productName: string;
    productDescription: string | null;
    kpis: Array<{
      kpiId: number;
      name: string;
      description: string | null;
    }>;
    dimensionColumns: Array<{
      tableName: string;
      columnName: string;
      description: string | null;
    }>;
  }>;
}

export interface PulseSuggestion {
  kind: 'metric' | 'slice';
  product_kpi_id: number;
  data_product_id: number;
  dimension_table: string | null;     // null for 'metric'
  dimension_column: string | null;    // null for 'metric'
  sensitivity: 'low' | 'medium' | 'high';
  frequency: 'daily' | 'weekly';
  label: string;                       // human-readable, business voice
  rationale: string;                   // one sentence — why we suggest it
}

export interface PulseSuggestResult {
  suggestions: PulseSuggestion[];
  hint: string | null;   // e.g. "Define some KPIs first to populate this list."
}

export const PULSE_SUGGEST_SYSTEM = `You propose a starter "pulse" — a curated set of metrics and slices a single user should ask Clarion to watch on their behalf. Output ONLY valid JSON matching this shape:

{
  "suggestions": [
    {
      "kind": "metric" | "slice",
      "product_kpi_id": <int>,
      "data_product_id": <int>,
      "dimension_table": "<table>" | null,
      "dimension_column": "<column>" | null,
      "sensitivity": "low" | "medium" | "high",
      "frequency": "daily" | "weekly",
      "label": "<short business-voice label>",
      "rationale": "<one sentence — why this is worth watching>"
    }
  ],
  "hint": "<one short sentence shown above the suggestions, or empty string>"
}

Hard rules:
- Reference ONLY KPIs that appear in PRODUCTS. Never invent a KPI.
- For 'slice' kind: dimension_table + dimension_column must come from
  the dimensionColumns list on the same product as the KPI.
- For 'metric' kind: dimension_table and dimension_column must be null.
- Aim for 5-7 suggestions total. Mix metric + slice. Don't return
  duplicates of the same metric × dimension.
- Default sensitivity to medium. Use high for headline metrics
  (revenue, gross margin); use low for operational stats unlikely to
  swing dramatically.
- Default frequency to daily for headline financials, weekly for
  operational metrics that don't move overnight.
- label is for the user — short, business-voice, no SQL terms.
  Good: "Gross margin", "Revenue by salesperson"
  Bad:  "SUM(revenue) GROUP BY salesperson"
- rationale should explain in business terms ("This is how the team
  measures health. Worth a daily glance."), not SQL terms.

If the user has no products with KPIs, return suggestions=[] and a
clear hint telling them to define KPIs first.

If the user has products but no obvious headline KPIs (e.g. only
operational stats), still suggest 3-4 reasonable ones — they can
delete what they don't want.`;

export function buildPulseSuggestUser(context: PulseSuggestContext): string {
  if (context.products.length === 0) {
    return 'PRODUCTS: (none yet)\n\nReturn an empty suggestions array with a hint telling the user to design a data product first.';
  }

  const productLines = context.products.map((p) => {
    const kpiBlock = p.kpis.length > 0
      ? p.kpis.map((k) => `      kpi_id=${k.kpiId} ${k.name}${k.description ? ` — ${k.description}` : ''}`).join('\n')
      : '      (no KPIs defined)';
    const dimBlock = p.dimensionColumns.length > 0
      ? p.dimensionColumns.map((d) => `      ${d.tableName}.${d.columnName}${d.description ? ` — ${d.description}` : ''}`).join('\n')
      : '      (no dimension columns identified)';
    return [
      `  product_id=${p.productId} ${p.productName}`,
      p.productDescription ? `    description: ${p.productDescription}` : '',
      `    kpis:`,
      kpiBlock,
      `    dimensions:`,
      dimBlock,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    `USER: ${context.userDisplayName ?? 'a business user'}`,
    '',
    'PRODUCTS:',
    productLines,
    '',
    'Propose 5-7 pulse suggestions. Return JSON only.',
  ].join('\n');
}
