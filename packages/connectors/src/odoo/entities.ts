/**
 * Curated Odoo entity catalog.
 *
 * Odoo models are addressed by dotted names (`account.move.line`). Warehouse /
 * DuckDB identifiers can't contain dots (the writer's `isSafeTableName` rejects
 * them), so every entity is exposed under the underscore form
 * (`account_move_line`) — which also matches Odoo's own PostgreSQL table
 * naming. The dotted MODEL name is kept for the RPC calls; the mapping lives in
 * `ODOO_ALLOWLIST` (single source of truth).
 *
 * Discovery is dynamic: `probeEntities` calls `fields_get` + `search_count` per
 * model and only surfaces the ones that actually exist + are readable on the
 * connected instance. So version differences are handled automatically —
 * `stock.valuation.layer`, removed in Odoo 19, simply won't appear on a v19
 * instance without any code change.
 *
 * To add a model: add one line to `ODOO_ALLOWLIST` (and, optionally, known FKs
 * to `ODOO_KNOWN_RELATIONSHIPS`). Everything else is derived.
 */

import type { EntityDescriptor, EntityCursorSpec, KnownRelationship } from '../types';

/**
 * model → warehouse table_name. Finance / operations focused; deliberately not
 * the thousands of technical models Odoo ships. Order here is the order the
 * wizard shows.
 */
export const ODOO_ALLOWLIST: ReadonlyArray<{ model: string; table: string; category: string; displayName: string; description: string }> = [
  { model: 'res.partner',           table: 'res_partner',           category: 'Contacts',   displayName: 'Contacts / partners',       description: 'Customers, vendors and contacts — one row per person or organisation Odoo interacts with.' },
  { model: 'res.company',           table: 'res_company',           category: 'Contacts',   displayName: 'Companies',                 description: 'Legal entities configured in this Odoo instance (multi-company setups have several).' },
  { model: 'res.currency',          table: 'res_currency',          category: 'Accounting', displayName: 'Currencies',                description: 'Currencies with their rounding precision; referenced by journals, orders and invoices.' },
  { model: 'account.account',       table: 'account_account',       category: 'Accounting', displayName: 'Chart of accounts',         description: 'The chart of accounts — one row per general-ledger account.' },
  { model: 'account.journal',       table: 'account_journal',       category: 'Accounting', displayName: 'Journals',                  description: 'Accounting journals (sales, purchases, bank, cash, miscellaneous) that entries are posted in.' },
  { model: 'account.move',          table: 'account_move',          category: 'Accounting', displayName: 'Journal entries / invoices', description: 'Journal entries, including customer invoices, vendor bills and credit notes (move_type distinguishes them). One row per document, header level.' },
  { model: 'account.move.line',     table: 'account_move_line',     category: 'Accounting', displayName: 'Journal items',             description: 'Individual debit/credit lines of journal entries — the finest-grained accounting record.' },
  { model: 'account.payment',       table: 'account_payment',       category: 'Accounting', displayName: 'Payments',                  description: 'Customer and vendor payments registered against bank or cash journals.' },
  { model: 'account.payment.term',  table: 'account_payment_term',  category: 'Accounting', displayName: 'Payment terms',             description: 'Payment terms (e.g. 30 days net) applied to invoices and orders.' },
  { model: 'account.tax',           table: 'account_tax',           category: 'Accounting', displayName: 'Taxes',                     description: 'Tax definitions (VAT rates etc.) applied on invoice and order lines.' },
  { model: 'product.template',      table: 'product_template',      category: 'Products',   displayName: 'Product templates',         description: 'Products as defined in the catalog; variants of one product share a template.' },
  { model: 'product.product',       table: 'product_product',       category: 'Products',   displayName: 'Product variants',          description: 'Sellable / purchasable product variants — the row that order lines and stock moves reference.' },
  { model: 'product.category',      table: 'product_category',      category: 'Products',   displayName: 'Product categories',        description: 'Hierarchical product categories used for grouping and accounting defaults.' },
  { model: 'uom.uom',               table: 'uom_uom',               category: 'Products',   displayName: 'Units of measure',          description: 'Units of measure (each in a UoM category) used on order and stock lines.' },
  { model: 'sale.order',            table: 'sale_order',            category: 'Sales',      displayName: 'Sales orders',              description: 'Sales orders and quotations — one row per order, header level (state distinguishes quotation vs confirmed).' },
  { model: 'sale.order.line',       table: 'sale_order_line',       category: 'Sales',      displayName: 'Sales order lines',         description: 'Sales order lines: product, quantity and price per line — the sales fact grain.' },
  { model: 'purchase.order',        table: 'purchase_order',        category: 'Purchasing', displayName: 'Purchase orders',           description: 'Purchase orders sent to vendors — one row per order, header level.' },
  { model: 'purchase.order.line',   table: 'purchase_order_line',   category: 'Purchasing', displayName: 'Purchase order lines',      description: 'Purchase order lines: product, quantity and cost per line — the purchasing fact grain.' },
  { model: 'stock.move',            table: 'stock_move',            category: 'Inventory',  displayName: 'Stock moves',               description: 'Individual product movements between locations (receipts, deliveries, internal transfers).' },
  { model: 'stock.quant',           table: 'stock_quant',           category: 'Inventory',  displayName: 'Stock quants (on-hand)',    description: 'Current on-hand quantity per product per location — the inventory snapshot.' },
  { model: 'stock.valuation.layer', table: 'stock_valuation_layer', category: 'Inventory',  displayName: 'Stock valuation layers',    description: 'Inventory valuation entries — the monetary value of stock moves (absent on some Odoo versions).' },
];

/** Dotted model name → warehouse table name, for resolving many2one `relation`
 * targets from `fields_get` into relationship endpoints. */
export const MODEL_TO_TABLE: ReadonlyMap<string, string> = new Map(
  ODOO_ALLOWLIST.map((e) => [e.model, e.table]),
);

/**
 * Odoo stamps `write_date` on every modification, so it's the canonical
 * incremental cursor. The connector filters `write_date >= cursor` (NOT `>`):
 * `write_date` is second-precision and non-unique, so a strictly-greater
 * filter can skip rows that share the boundary second. `>=` re-pulls the
 * boundary instant, and the merge-by-`id` writer makes that idempotent — a
 * tiny duplicate-fetch in exchange for never losing a row.
 */
const WRITE_DATE_CURSOR: EntityCursorSpec = { field: 'write_date', type: 'timestamp' };

/** Odoo's primary key is always the integer `id` column. */
const BUSINESS_KEY = 'id';

export interface OdooEntity extends EntityDescriptor {
  /** Dotted Odoo model name used for RPC calls (e.g. `account.move.line`). */
  model: string;
}

export const ODOO_ENTITIES: readonly OdooEntity[] = ODOO_ALLOWLIST.map((e) => ({
  name: e.table,
  displayName: e.displayName,
  category: e.category,
  description: e.description,
  model: e.model,
  supportsIncremental: true,
  incrementalCursor: WRITE_DATE_CURSOR,
  businessKey: BUSINESS_KEY,
}));

export const ENTITIES_BY_NAME: ReadonlyMap<string, OdooEntity> = new Map(
  ODOO_ENTITIES.map((e) => [e.name, e]),
);

/** EntityDescriptor projection for the wizard (keeps cursor/businessKey — Odoo
 * is transparent about incrementality, unlike the EO catalog which strips it). */
export function asEntityDescriptors(): EntityDescriptor[] {
  return ODOO_ENTITIES.map((e) => ({
    name: e.name,
    displayName: e.displayName,
    category: e.category,
    description: e.description,
    supportsIncremental: e.supportsIncremental,
    incrementalCursor: e.incrementalCursor,
    businessKey: e.businessKey,
  }));
}

// ─── Field selection rules ────────────────────────────────────────────────
/**
 * Field types we never ingest:
 *   • binary       — attachments / images, huge, not analytics-relevant
 *   • one2many / many2many — variable-length relations; would bloat parquet.
 *     Model these via the relationship/graph layer, not raw columns.
 */
export const EXCLUDE_FIELD_TYPES: ReadonlySet<string> = new Set(['binary', 'one2many', 'many2many']);

/**
 * Noisy technical field name prefixes. Odoo decorates every model with chatter
 * (`message_*`), activities (`activity_*`), images (`image_*`), and dunder
 * internals (`__last_update`). None are useful for analytics.
 */
export const EXCLUDE_FIELD_PREFIXES: readonly string[] = ['message_', 'activity_', 'image_', '__'];

/** Always keep these even if a rule above would drop them. `id` is the PK,
 * `write_date` is the incremental cursor. */
export const ALWAYS_KEEP_FIELDS: readonly string[] = ['id', 'write_date'];

/** Page size for `search_read`. Odoo Online throttles ~1 req/sec, so larger
 * pages mean fewer requests; 2000 is comfortably under Odoo's response limits. */
export const PAGE_SIZE = 2000;

/**
 * Map an Odoo field type to a DuckDB SQL type, used to build the writer's
 * explicit `columns` schema (stable types, no per-sync inference drift).
 *
 *   • many2one — we flatten `[id, name]` to the integer id, so it's BIGINT.
 *   • monetary — keep 4dp; Odoo rounds to currency precision server-side.
 *   • integer  — BIGINT (Odoo ids and counters can exceed INT32).
 *
 * Anything unmapped falls back to VARCHAR (lossy but safe). The writer
 * re-validates types against its own allow-list before they reach SQL.
 */
export function odooTypeToDuckDb(odooType: string): string {
  switch (odooType) {
    case 'integer':
    case 'many2one':       return 'BIGINT';
    case 'float':          return 'DOUBLE';
    case 'monetary':       return 'DECIMAL(18,4)';
    case 'boolean':        return 'BOOLEAN';
    case 'date':           return 'DATE';
    case 'datetime':       return 'TIMESTAMP';
    case 'char':
    case 'text':
    case 'html':
    case 'selection':
    default:               return 'VARCHAR';
  }
}

/**
 * Analytics-role hint from Odoo's field type system, used for documented
 * columns that skip the AI classification pass:
 *
 *   • monetary / float — quantities and amounts → measure
 *   • many2one / selection / char / boolean / date / datetime — attributes
 *     you group or filter by → dimension
 *   • integer / text / html — ambiguous (an integer can be a count OR a
 *     sequence/colour index) → no hint, flags default to false
 */
export function odooFieldRole(name: string, odooType: string): 'measure' | 'dimension' | undefined {
  if (name === 'id') return undefined;
  switch (odooType) {
    case 'monetary':
    case 'float':      return 'measure';
    case 'many2one':
    case 'selection':
    case 'char':
    case 'boolean':
    case 'date':
    case 'datetime':   return 'dimension';
    default:           return undefined;
  }
}

// ─── Known relationships (documented Odoo many2one FKs) ────────────────────
/**
 * Documented FKs among the allowlisted models. Column names are Odoo's
 * snake_case many2one field names (which we flatten to the integer id), target
 * is always the `id` column. `getKnownRelationships` filters these to the
 * entities the user actually selected; the schema profiler value-verifies the
 * rest, so a column that doesn't exist on a given Odoo version is simply
 * dropped (no harm).
 */
export const ODOO_KNOWN_RELATIONSHIPS: readonly KnownRelationship[] = [
  // res.partner
  { fromTable: 'res_partner', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this contact belongs to.' },
  { fromTable: 'res_partner', fromColumn: 'parent_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Parent contact (company a person works at).' },
  { fromTable: 'res_partner', fromColumn: 'commercial_partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Commercial entity this contact rolls up to.' },

  // account.account / journal
  { fromTable: 'account_account', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company that owns this GL account.' },
  { fromTable: 'account_journal', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company that owns this journal.' },
  { fromTable: 'account_journal', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this journal (when set).' },

  // account.move
  { fromTable: 'account_move', fromColumn: 'partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Customer / vendor on this entry.' },
  { fromTable: 'account_move', fromColumn: 'journal_id', toTable: 'account_journal', toColumn: 'id', type: 'many_to_one', description: 'Journal this entry is posted in.' },
  { fromTable: 'account_move', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this entry belongs to.' },
  { fromTable: 'account_move', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this entry.' },
  { fromTable: 'account_move', fromColumn: 'invoice_payment_term_id', toTable: 'account_payment_term', toColumn: 'id', type: 'many_to_one', description: 'Payment term on this invoice.' },

  // account.move.line
  { fromTable: 'account_move_line', fromColumn: 'move_id', toTable: 'account_move', toColumn: 'id', type: 'many_to_one', description: 'Journal entry this line belongs to.' },
  { fromTable: 'account_move_line', fromColumn: 'account_id', toTable: 'account_account', toColumn: 'id', type: 'many_to_one', description: 'GL account this line posts to.' },
  { fromTable: 'account_move_line', fromColumn: 'partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Customer / vendor on this line.' },
  { fromTable: 'account_move_line', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product on this line (when set).' },
  { fromTable: 'account_move_line', fromColumn: 'journal_id', toTable: 'account_journal', toColumn: 'id', type: 'many_to_one', description: 'Journal of this line.' },
  { fromTable: 'account_move_line', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this line.' },
  { fromTable: 'account_move_line', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this line.' },

  // account.payment
  { fromTable: 'account_payment', fromColumn: 'partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Customer / vendor this payment is with.' },
  { fromTable: 'account_payment', fromColumn: 'journal_id', toTable: 'account_journal', toColumn: 'id', type: 'many_to_one', description: 'Bank / cash journal of this payment.' },
  { fromTable: 'account_payment', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this payment belongs to.' },
  { fromTable: 'account_payment', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this payment.' },

  // account.tax
  { fromTable: 'account_tax', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this tax is defined for.' },

  // product.* / uom
  { fromTable: 'product_product', fromColumn: 'product_tmpl_id', toTable: 'product_template', toColumn: 'id', type: 'many_to_one', description: 'Template this variant belongs to.' },
  { fromTable: 'product_template', fromColumn: 'categ_id', toTable: 'product_category', toColumn: 'id', type: 'many_to_one', description: 'Category of this product.' },
  { fromTable: 'product_template', fromColumn: 'uom_id', toTable: 'uom_uom', toColumn: 'id', type: 'many_to_one', description: 'Default unit of measure.' },
  { fromTable: 'product_template', fromColumn: 'uom_po_id', toTable: 'uom_uom', toColumn: 'id', type: 'many_to_one', description: 'Purchase unit of measure.' },
  { fromTable: 'product_template', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this product belongs to (when set).' },
  { fromTable: 'product_category', fromColumn: 'parent_id', toTable: 'product_category', toColumn: 'id', type: 'many_to_one', description: 'Parent product category.' },

  // sale.order(.line)
  { fromTable: 'sale_order', fromColumn: 'partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Customer on this sales order.' },
  { fromTable: 'sale_order', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this order belongs to.' },
  { fromTable: 'sale_order', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this order.' },
  { fromTable: 'sale_order_line', fromColumn: 'order_id', toTable: 'sale_order', toColumn: 'id', type: 'many_to_one', description: 'Order this line belongs to.' },
  { fromTable: 'sale_order_line', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product on this line.' },
  { fromTable: 'sale_order_line', fromColumn: 'product_uom', toTable: 'uom_uom', toColumn: 'id', type: 'many_to_one', description: 'Unit of measure on this line.' },
  { fromTable: 'sale_order_line', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this line.' },

  // purchase.order(.line)
  { fromTable: 'purchase_order', fromColumn: 'partner_id', toTable: 'res_partner', toColumn: 'id', type: 'many_to_one', description: 'Vendor on this purchase order.' },
  { fromTable: 'purchase_order', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company this order belongs to.' },
  { fromTable: 'purchase_order', fromColumn: 'currency_id', toTable: 'res_currency', toColumn: 'id', type: 'many_to_one', description: 'Currency of this order.' },
  { fromTable: 'purchase_order_line', fromColumn: 'order_id', toTable: 'purchase_order', toColumn: 'id', type: 'many_to_one', description: 'Order this line belongs to.' },
  { fromTable: 'purchase_order_line', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product on this line.' },
  { fromTable: 'purchase_order_line', fromColumn: 'product_uom', toTable: 'uom_uom', toColumn: 'id', type: 'many_to_one', description: 'Unit of measure on this line.' },
  { fromTable: 'purchase_order_line', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this line.' },

  // stock.*
  { fromTable: 'stock_move', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product being moved.' },
  { fromTable: 'stock_move', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this move.' },
  { fromTable: 'stock_quant', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product this on-hand quantity is for.' },
  { fromTable: 'stock_quant', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this quant.' },
  { fromTable: 'stock_valuation_layer', fromColumn: 'product_id', toTable: 'product_product', toColumn: 'id', type: 'many_to_one', description: 'Product this valuation layer is for.' },
  { fromTable: 'stock_valuation_layer', fromColumn: 'stock_move_id', toTable: 'stock_move', toColumn: 'id', type: 'many_to_one', description: 'Stock move that produced this valuation.' },
  { fromTable: 'stock_valuation_layer', fromColumn: 'company_id', toTable: 'res_company', toColumn: 'id', type: 'many_to_one', description: 'Company of this valuation layer.' },
];
