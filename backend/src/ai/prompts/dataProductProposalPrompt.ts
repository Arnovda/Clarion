/**
 * AI prompt for auto-proposing a full set of conformed data products
 * from a single source system schema.
 *
 * Phase 1 (this prompt): Returns STRUCTURE ONLY — product names, table names,
 * roles, dependencies, build order, and which source tables feed each product table.
 * No transformation SQL — that is generated per-product by the existing
 * star schema design flow once the user approves.
 */

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ProposedTable {
  table_name: string;
  display_name: string;
  description: string;
  table_role: 'fact' | 'dimension' | 'bridge' | 'junk';
  is_shared_dimension: boolean;  // true = owned by THIS product, reused by others
  dag_order: number;             // 0=dims first, 1=facts
  source_tables: string[];       // which source table names feed this table
}

export interface ProposedStarSchema {
  name: string;         // e.g. "Sales Order Lines"
  description: string;
  grain: string;        // e.g. "One row per order line"
  tables: ProposedTable[];
}

export interface ProposedDependency {
  source_product_name: string;
  shared_table_names: string[];
}

export interface ProposedDataProduct {
  name: string;
  description: string;
  build_order: number;
  star_schemas: ProposedStarSchema[];
  depends_on: ProposedDependency[];
}

export interface DataProductProposal {
  rationale: string;
  shared_dimensions: Array<{
    table_name: string;
    owner_product_name: string;
  }>;
  data_products: ProposedDataProduct[];
}

// ---------------------------------------------------------------------------
// Source context types (passed in)
// ---------------------------------------------------------------------------

export interface SourceTableContext {
  table_name: string;
  display_name: string;
  description: string;
  domain: string;
  columns: Array<{
    column_name: string;
    data_type: string;
    description: string;
    is_primary_key: boolean;
    is_foreign_key: boolean;
    fk_references?: string;
  }>;
  relationships: Array<{
    to_table: string;
    via_column: string;
    type: string;
  }>;
}

export interface ExistingDataProduct {
  name: string;
  shared_dimension_tables: string[];
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const DATA_PRODUCT_PROPOSAL_SYSTEM = `You are an expert data warehouse architect specializing in Kimball dimensional modelling.

Your task: analyse a source system schema and propose the ideal set of analytics topics.

## Naming rules — CRITICAL
- Use SHORT, plain business names that a non-technical manager would use: "Sales", "Customers", "Products", "Purchases", "HR", "Finance", "Inventory"
- NEVER use technical suffixes like "360", "Analytics", "Dimension", "Domain", "Data Product", "Kimball"
- Shared dimension products are also named plainly: "Customers" not "CustomerDimension", "Products" not "ProductMaster"
- The date calendar product (if any) should simply be named "Calendar"
- Table names still use snake_case with dim_/fact_ prefix (dim_customer, fact_sales) — this is internal only

## Architecture principles
- Conformed dimensions (dim_customer, dim_product, dim_date) are built ONCE and owned by one product
- The "Calendar" product (dim_date) is always build_order: 1 if included; it has no fact tables
- Identify the natural domain owner for each shared dimension
- Products that reference a shared dimension declare it in depends_on — they do NOT include it in their own tables
- Group related fact tables into one analytics topic (e.g. "Sales" contains sales orders + invoices)
- Keep the number of topics focused: 3-6 is ideal for most source systems

## Output rules
- Be concise: short descriptions (max 10 words), no verbose explanations
- 3–6 topics is ideal — don't over-split
- Return ONLY valid JSON — no markdown, no explanation, no code fences:
{
  "rationale": "2-3 sentence explanation of the design",
  "shared_dimensions": [
    { "table_name": "dim_customer", "owner_product_name": "Customers" }
  ],
  "data_products": [
    {
      "name": "Customers",
      "description": "Customer master data and segmentation",
      "build_order": 1,
      "depends_on": [],
      "star_schemas": [
        {
          "name": "Customer Master",
          "description": "One row per customer with enriched attributes",
          "grain": "One row per customer",
          "tables": [
            {
              "table_name": "dim_customer",
              "display_name": "Customer",
              "description": "Conformed customer dimension",
              "table_role": "dimension",
              "is_shared_dimension": true,
              "dag_order": 0,
              "source_tables": ["klanten"]
            }
          ]
        }
      ]
    },
    {
      "name": "Sales",
      "description": "Sales orders, lines and invoices",
      "build_order": 2,
      "depends_on": [
        { "source_product_name": "Customers", "shared_table_names": ["dim_customer"] }
      ],
      "star_schemas": [
        {
          "name": "Sales Order Lines",
          "description": "Transactional sales at line level",
          "grain": "One row per order line",
          "tables": [
            {
              "table_name": "fact_sales_order_lines",
              "display_name": "Sales Order Lines",
              "description": "Revenue and quantity by order line",
              "table_role": "fact",
              "is_shared_dimension": false,
              "dag_order": 1,
              "source_tables": ["verkooporders", "verkooporder_regels"]
            }
          ]
        }
      ]
    }
  ]
}`;

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildDataProductProposalUser(
  sourceTables: SourceTableContext[],
  existingProducts: ExistingDataProduct[],
  connectionName: string,
): string {
  // Compact representation — table names, domains, FK relationships only.
  // Column details are not needed to identify fact vs dimension or to group products.
  const tablesSummary = sourceTables.map((t) => {
    const fkCols = t.columns.filter((c) => c.is_foreign_key);
    const pkCols = t.columns.filter((c) => c.is_primary_key);
    const fkStr = fkCols.map((c) => `${c.column_name}→${c.fk_references ?? '?'}`).join(', ');
    const rels = t.relationships.map((r) => r.to_table).join(', ');
    const parts = [
      `${t.table_name}${t.domain ? ` [${t.domain}]` : ''}`,
      t.description ? `"${t.description}"` : '',
      pkCols.length ? `PK: ${pkCols.map((c) => c.column_name).join(', ')}` : '',
      fkStr ? `FK: ${fkStr}` : '',
      rels ? `links to: ${rels}` : '',
    ].filter(Boolean);
    return parts.join(' | ');
  }).join('\n');

  const existingSection = existingProducts.length > 0
    ? `Already existing (do not recreate):\n${existingProducts.map((p) =>
        `- ${p.name} (shared dims: ${p.shared_dimension_tables.join(', ') || 'none'})`,
      ).join('\n')}\n\n`
    : '';

  return `Design all analytics topics for source system: ${connectionName}

${existingSection}Source schema (${sourceTables.length} tables):

${tablesSummary}

Return only the JSON proposal.`;
}
