/**
 * Odoo deterministic star-schema template (version 1).
 *
 * Hand-written Kimball design for the Odoo entity catalog — every Odoo
 * customer gets the SAME facts and dimensions, instantly and token-free
 * (docs/SOURCE_ONBOARDING.md Phase F). The platform filters this template to
 * the entities the customer actually synced via
 * `instantiateStarSchemaTemplate`; the AI designer remains the fallback when
 * no fact survives the filter.
 *
 * Design notes:
 *   • Facts carry NATURAL FK id columns (partner_id, product_id, …) and never
 *     JOIN dimension tables — a dropped dim can't break a surviving fact.
 *     Dims key on the source `id` (aliased `<entity>_id`); no surrogate keys
 *     (SCD1 platform — natural keys are stable and join-friendly for NL→SQL).
 *   • Column names/filters target MODERN Odoo (16+ — the versions the JSON-2
 *     transport serves; the platform's transformation error surface catches
 *     the rare older-instance mismatch and the AI repair pass takes over).
 *   • Raw FK id columns are `isTechnical` (hidden from end-user output,
 *     available for joins); business identifiers, dates and measures are not.
 *   • Every table's SQL reads ONLY the entities in its `sourceEntities`
 *     (validated by the template test suite, executed against synthetic
 *     tables in DuckDB).
 *
 * Versioning: bump `version` on any shape change; already-materialised
 * customers stay on their version until an explicit re-design.
 */

import type {
  StarSchemaTemplate,
  TemplateColumn,
  TemplateDimension,
  TemplateFact,
} from '../starSchema';

// ─── Column helpers (concise builders — this file is 90% data) ─────────────

const col = (
  name: string,
  dataType: string,
  displayName: string,
  description: string,
  extra: Partial<TemplateColumn> = {},
): TemplateColumn => ({ name, dataType, displayName, description, role: 'attribute', ...extra });

const key = (name: string, displayName: string, description: string, sourceEntity: string): TemplateColumn =>
  col(name, 'BIGINT', displayName, description, {
    role: 'natural_key', isTechnical: true, sourceEntity, sourceColumn: 'id',
  });

const fk = (
  name: string, displayName: string, description: string,
  fkTargetTable: string, fkTargetColumn: string,
  extra: Partial<TemplateColumn> = {},
): TemplateColumn =>
  col(name, 'BIGINT', displayName, description, {
    role: 'foreign_key', fkTargetTable, fkTargetColumn, isTechnical: true, ...extra,
  });

const measure = (
  name: string, dataType: string, displayName: string, description: string,
  additivity: 'additive' | 'semi_additive' | 'non_additive' = 'additive',
  extra: Partial<TemplateColumn> = {},
): TemplateColumn =>
  col(name, dataType, displayName, description, { role: 'measure', additivity, ...extra });

const MONEY = 'DECIMAL(18,4)';

// ─── Conformed dimensions ───────────────────────────────────────────────────

const DIMENSIONS: TemplateDimension[] = [
  {
    tableName: 'dim_partner',
    displayName: 'Partners',
    description: 'Customers, vendors and contacts — one row per Odoo partner.',
    sourceEntities: ['res_partner'],
    sql: `SELECT
  id         AS partner_id,
  name       AS partner_name,
  email,
  phone,
  city,
  zip,
  vat        AS vat_number,
  is_company,
  active,
  parent_id,
  company_id
FROM res_partner`,
    columns: [
      key('partner_id', 'Partner ID', 'Odoo partner id (primary key).', 'res_partner'),
      col('partner_name', 'VARCHAR', 'Partner name', 'Name of the person or organisation.', { sourceEntity: 'res_partner', sourceColumn: 'name' }),
      col('email', 'VARCHAR', 'Email', 'Primary email address.', { sourceEntity: 'res_partner', sourceColumn: 'email' }),
      col('phone', 'VARCHAR', 'Phone', 'Primary phone number.', { sourceEntity: 'res_partner', sourceColumn: 'phone' }),
      col('city', 'VARCHAR', 'City', 'City of the main address.', { sourceEntity: 'res_partner', sourceColumn: 'city' }),
      col('zip', 'VARCHAR', 'Postal code', 'Postal code of the main address.', { sourceEntity: 'res_partner', sourceColumn: 'zip' }),
      col('vat_number', 'VARCHAR', 'VAT number', 'Tax / VAT identification number.', { sourceEntity: 'res_partner', sourceColumn: 'vat' }),
      col('is_company', 'BOOLEAN', 'Is company', 'True when the partner is an organisation rather than a person.', { sourceEntity: 'res_partner', sourceColumn: 'is_company' }),
      col('active', 'BOOLEAN', 'Active', 'False when the partner is archived.', { sourceEntity: 'res_partner', sourceColumn: 'active' }),
      fk('parent_id', 'Parent partner', 'Parent contact (e.g. the company a person works at).', 'dim_partner', 'partner_id', { sourceEntity: 'res_partner', sourceColumn: 'parent_id' }),
      fk('company_id', 'Company', 'Internal company this partner record belongs to.', 'dim_company', 'company_id', { sourceEntity: 'res_partner', sourceColumn: 'company_id' }),
    ],
  },
  {
    tableName: 'dim_product',
    displayName: 'Products',
    description: 'Sellable / purchasable product variants with their template attributes.',
    sourceEntities: ['product_product', 'product_template'],
    sql: `SELECT
  pp.id           AS product_id,
  pt.name         AS product_name,
  pp.default_code AS internal_reference,
  pt.type         AS product_type,
  pt.categ_id     AS category_id,
  pt.uom_id       AS uom_id,
  pt.list_price   AS list_price,
  pp.active       AS active
FROM product_product pp
JOIN product_template pt ON pp.product_tmpl_id = pt.id`,
    columns: [
      key('product_id', 'Product ID', 'Odoo product variant id (primary key).', 'product_product'),
      col('product_name', 'VARCHAR', 'Product name', 'Name of the product.', { sourceEntity: 'product_template', sourceColumn: 'name' }),
      col('internal_reference', 'VARCHAR', 'Internal reference', 'Internal product code / SKU.', { sourceEntity: 'product_product', sourceColumn: 'default_code' }),
      col('product_type', 'VARCHAR', 'Product type', 'Goods, service or consumable classification.', { sourceEntity: 'product_template', sourceColumn: 'type' }),
      fk('category_id', 'Category', 'Product category.', 'dim_product_category', 'category_id', { sourceEntity: 'product_template', sourceColumn: 'categ_id' }),
      fk('uom_id', 'Unit of measure', 'Default unit of measure.', 'dim_uom', 'uom_id', { sourceEntity: 'product_template', sourceColumn: 'uom_id' }),
      col('list_price', 'DOUBLE', 'List price', 'Default sales price of the product.', { sourceEntity: 'product_template', sourceColumn: 'list_price' }),
      col('active', 'BOOLEAN', 'Active', 'False when the product is archived.', { sourceEntity: 'product_product', sourceColumn: 'active' }),
    ],
  },
  {
    tableName: 'dim_product_category',
    displayName: 'Product categories',
    description: 'Hierarchical product categories.',
    sourceEntities: ['product_category'],
    sql: `SELECT
  id            AS category_id,
  name          AS category_name,
  complete_name AS category_path,
  parent_id
FROM product_category`,
    columns: [
      key('category_id', 'Category ID', 'Odoo product category id (primary key).', 'product_category'),
      col('category_name', 'VARCHAR', 'Category name', 'Name of the category.', { sourceEntity: 'product_category', sourceColumn: 'name' }),
      col('category_path', 'VARCHAR', 'Category path', 'Full hierarchical path (e.g. "All / Saleable / Office").', { sourceEntity: 'product_category', sourceColumn: 'complete_name' }),
      fk('parent_id', 'Parent category', 'Parent category in the hierarchy.', 'dim_product_category', 'category_id', { sourceEntity: 'product_category', sourceColumn: 'parent_id' }),
    ],
  },
  {
    tableName: 'dim_account',
    displayName: 'GL accounts',
    description: 'The chart of accounts — one row per general-ledger account.',
    sourceEntities: ['account_account'],
    sql: `SELECT
  id           AS account_id,
  code         AS account_code,
  name         AS account_name,
  account_type AS account_type
FROM account_account`,
    columns: [
      key('account_id', 'Account ID', 'Odoo GL account id (primary key).', 'account_account'),
      col('account_code', 'VARCHAR', 'Account code', 'Chart-of-accounts code.', { sourceEntity: 'account_account', sourceColumn: 'code' }),
      col('account_name', 'VARCHAR', 'Account name', 'Name of the GL account.', { sourceEntity: 'account_account', sourceColumn: 'name' }),
      col('account_type', 'VARCHAR', 'Account type', 'Account classification (receivable, payable, income, expense, …).', { sourceEntity: 'account_account', sourceColumn: 'account_type' }),
    ],
  },
  {
    tableName: 'dim_journal',
    displayName: 'Journals',
    description: 'Accounting journals (sales, purchases, bank, cash, miscellaneous).',
    sourceEntities: ['account_journal'],
    sql: `SELECT
  id          AS journal_id,
  name        AS journal_name,
  code        AS journal_code,
  type        AS journal_type,
  company_id,
  currency_id
FROM account_journal`,
    columns: [
      key('journal_id', 'Journal ID', 'Odoo journal id (primary key).', 'account_journal'),
      col('journal_name', 'VARCHAR', 'Journal name', 'Name of the journal.', { sourceEntity: 'account_journal', sourceColumn: 'name' }),
      col('journal_code', 'VARCHAR', 'Journal code', 'Short code of the journal.', { sourceEntity: 'account_journal', sourceColumn: 'code' }),
      col('journal_type', 'VARCHAR', 'Journal type', 'sale, purchase, bank, cash or general.', { sourceEntity: 'account_journal', sourceColumn: 'type' }),
      fk('company_id', 'Company', 'Company that owns this journal.', 'dim_company', 'company_id', { sourceEntity: 'account_journal', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the journal (when set).', 'dim_currency', 'currency_id', { sourceEntity: 'account_journal', sourceColumn: 'currency_id' }),
    ],
  },
  {
    tableName: 'dim_company',
    displayName: 'Companies',
    description: 'Internal legal entities configured in Odoo.',
    sourceEntities: ['res_company'],
    sql: `SELECT
  id   AS company_id,
  name AS company_name,
  currency_id
FROM res_company`,
    columns: [
      key('company_id', 'Company ID', 'Odoo company id (primary key).', 'res_company'),
      col('company_name', 'VARCHAR', 'Company name', 'Name of the legal entity.', { sourceEntity: 'res_company', sourceColumn: 'name' }),
      fk('currency_id', 'Currency', 'Main currency of the company.', 'dim_currency', 'currency_id', { sourceEntity: 'res_company', sourceColumn: 'currency_id' }),
    ],
  },
  {
    tableName: 'dim_currency',
    displayName: 'Currencies',
    description: 'Currencies referenced by journals, orders and invoices.',
    sourceEntities: ['res_currency'],
    sql: `SELECT
  id     AS currency_id,
  name   AS currency_code,
  symbol AS currency_symbol,
  active
FROM res_currency`,
    columns: [
      key('currency_id', 'Currency ID', 'Odoo currency id (primary key).', 'res_currency'),
      col('currency_code', 'VARCHAR', 'Currency code', 'ISO currency code (EUR, USD, …).', { sourceEntity: 'res_currency', sourceColumn: 'name' }),
      col('currency_symbol', 'VARCHAR', 'Symbol', 'Currency symbol.', { sourceEntity: 'res_currency', sourceColumn: 'symbol' }),
      col('active', 'BOOLEAN', 'Active', 'False when the currency is disabled.', { sourceEntity: 'res_currency', sourceColumn: 'active' }),
    ],
  },
  {
    tableName: 'dim_payment_term',
    displayName: 'Payment terms',
    description: 'Payment terms applied to invoices and orders (e.g. 30 days net).',
    sourceEntities: ['account_payment_term'],
    sql: `SELECT
  id   AS payment_term_id,
  name AS payment_term_name
FROM account_payment_term`,
    columns: [
      key('payment_term_id', 'Payment term ID', 'Odoo payment term id (primary key).', 'account_payment_term'),
      col('payment_term_name', 'VARCHAR', 'Payment term', 'Name of the payment term.', { sourceEntity: 'account_payment_term', sourceColumn: 'name' }),
    ],
  },
  {
    tableName: 'dim_uom',
    displayName: 'Units of measure',
    description: 'Quantity units used on order and stock lines.',
    sourceEntities: ['uom_uom'],
    sql: `SELECT
  id   AS uom_id,
  name AS uom_name
FROM uom_uom`,
    columns: [
      key('uom_id', 'UoM ID', 'Odoo unit-of-measure id (primary key).', 'uom_uom'),
      col('uom_name', 'VARCHAR', 'Unit of measure', 'Name of the unit (Units, kg, hour, …).', { sourceEntity: 'uom_uom', sourceColumn: 'name' }),
    ],
  },
];

// ─── Facts ──────────────────────────────────────────────────────────────────

const FACTS: TemplateFact[] = [
  {
    tableName: 'fact_invoice_lines',
    displayName: 'Invoice lines',
    description: 'One row per product line on customer invoices, vendor bills and their credit notes.',
    grain: 'One row per invoice line',
    factTableType: 'transaction',
    sourceEntities: ['account_move_line', 'account_move'],
    dimensionsUsed: ['dim_partner', 'dim_product', 'dim_account', 'dim_journal', 'dim_company', 'dim_currency', 'dim_payment_term', 'dim_date'],
    sql: `SELECT
  aml.id                                 AS invoice_line_id,
  aml.move_id                            AS invoice_id,
  am.name                                AS invoice_number,
  am.move_type                           AS move_type,
  am.state                               AS state,
  TRY_CAST(am.invoice_date AS DATE)      AS invoice_date,
  TRY_CAST(am.invoice_date_due AS DATE)  AS invoice_due_date,
  am.partner_id                          AS partner_id,
  aml.product_id                         AS product_id,
  aml.account_id                         AS account_id,
  am.journal_id                          AS journal_id,
  am.company_id                          AS company_id,
  am.currency_id                         AS currency_id,
  am.invoice_payment_term_id             AS payment_term_id,
  aml.quantity                           AS quantity,
  aml.price_unit                         AS price_unit,
  aml.price_subtotal                     AS amount_untaxed,
  aml.price_total                        AS amount_total,
  CASE WHEN am.move_type IN ('out_refund', 'in_refund') THEN -aml.price_subtotal ELSE aml.price_subtotal END AS amount_signed
FROM account_move_line aml
JOIN account_move am ON aml.move_id = am.id
WHERE am.move_type IN ('out_invoice', 'out_refund', 'in_invoice', 'in_refund')
  AND (aml.display_type IS NULL OR aml.display_type = 'product')`,
    columns: [
      key('invoice_line_id', 'Invoice line ID', 'Odoo journal item id (primary key).', 'account_move_line'),
      col('invoice_id', 'BIGINT', 'Invoice ID', 'Odoo id of the invoice header.', { isTechnical: true, sourceEntity: 'account_move_line', sourceColumn: 'move_id' }),
      col('invoice_number', 'VARCHAR', 'Invoice number', 'Invoice / bill number (e.g. INV/2026/0042).', { role: 'degenerate_dimension', sourceEntity: 'account_move', sourceColumn: 'name' }),
      col('move_type', 'VARCHAR', 'Document type', 'out_invoice, out_refund (customer side), in_invoice, in_refund (vendor side).', { sourceEntity: 'account_move', sourceColumn: 'move_type' }),
      col('state', 'VARCHAR', 'Status', 'draft, posted or cancel.', { sourceEntity: 'account_move', sourceColumn: 'state' }),
      col('invoice_date', 'DATE', 'Invoice date', 'Date of the invoice.', { sourceEntity: 'account_move', sourceColumn: 'invoice_date' }),
      col('invoice_due_date', 'DATE', 'Due date', 'Payment due date.', { sourceEntity: 'account_move', sourceColumn: 'invoice_date_due' }),
      fk('partner_id', 'Customer / vendor', 'Partner billed or billing.', 'dim_partner', 'partner_id', { sourceEntity: 'account_move', sourceColumn: 'partner_id' }),
      fk('product_id', 'Product', 'Product on the line (when set).', 'dim_product', 'product_id', { sourceEntity: 'account_move_line', sourceColumn: 'product_id' }),
      fk('account_id', 'GL account', 'GL account the line posts to.', 'dim_account', 'account_id', { sourceEntity: 'account_move_line', sourceColumn: 'account_id' }),
      fk('journal_id', 'Journal', 'Journal the invoice is booked in.', 'dim_journal', 'journal_id', { sourceEntity: 'account_move', sourceColumn: 'journal_id' }),
      fk('company_id', 'Company', 'Company the invoice belongs to.', 'dim_company', 'company_id', { sourceEntity: 'account_move', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the invoice.', 'dim_currency', 'currency_id', { sourceEntity: 'account_move', sourceColumn: 'currency_id' }),
      fk('payment_term_id', 'Payment term', 'Payment term on the invoice.', 'dim_payment_term', 'payment_term_id', { sourceEntity: 'account_move', sourceColumn: 'invoice_payment_term_id' }),
      measure('quantity', 'DOUBLE', 'Quantity', 'Quantity invoiced on the line.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'quantity' }),
      measure('price_unit', MONEY, 'Unit price', 'Price per unit.', 'non_additive', { sourceEntity: 'account_move_line', sourceColumn: 'price_unit' }),
      measure('amount_untaxed', MONEY, 'Amount (untaxed)', 'Line amount excluding tax.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'price_subtotal' }),
      measure('amount_total', MONEY, 'Amount (incl. tax)', 'Line amount including tax.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'price_total' }),
      measure('amount_signed', MONEY, 'Amount (signed)', 'Untaxed amount, negated for credit notes — sums to net revenue / net cost.', 'additive'),
    ],
  },
  {
    tableName: 'fact_journal_items',
    displayName: 'Journal items',
    description: 'One row per general-ledger line — the complete accounting detail.',
    grain: 'One row per journal item',
    factTableType: 'transaction',
    sourceEntities: ['account_move_line', 'account_move'],
    dimensionsUsed: ['dim_account', 'dim_partner', 'dim_journal', 'dim_company', 'dim_currency', 'dim_date'],
    sql: `SELECT
  aml.id                      AS journal_item_id,
  aml.move_id                 AS entry_id,
  am.name                     AS entry_number,
  TRY_CAST(aml.date AS DATE)  AS entry_date,
  am.state                    AS state,
  am.move_type                AS move_type,
  aml.account_id              AS account_id,
  aml.partner_id              AS partner_id,
  aml.journal_id              AS journal_id,
  aml.company_id              AS company_id,
  aml.currency_id             AS currency_id,
  aml.debit                   AS debit,
  aml.credit                  AS credit,
  aml.balance                 AS balance
FROM account_move_line aml
JOIN account_move am ON aml.move_id = am.id`,
    columns: [
      key('journal_item_id', 'Journal item ID', 'Odoo journal item id (primary key).', 'account_move_line'),
      col('entry_id', 'BIGINT', 'Entry ID', 'Odoo id of the journal entry header.', { isTechnical: true, sourceEntity: 'account_move_line', sourceColumn: 'move_id' }),
      col('entry_number', 'VARCHAR', 'Entry number', 'Journal entry number.', { role: 'degenerate_dimension', sourceEntity: 'account_move', sourceColumn: 'name' }),
      col('entry_date', 'DATE', 'Entry date', 'Accounting date of the line.', { sourceEntity: 'account_move_line', sourceColumn: 'date' }),
      col('state', 'VARCHAR', 'Status', 'draft, posted or cancel.', { sourceEntity: 'account_move', sourceColumn: 'state' }),
      col('move_type', 'VARCHAR', 'Document type', 'entry, out_invoice, in_invoice, … — what kind of document produced this line.', { sourceEntity: 'account_move', sourceColumn: 'move_type' }),
      fk('account_id', 'GL account', 'GL account the line posts to.', 'dim_account', 'account_id', { sourceEntity: 'account_move_line', sourceColumn: 'account_id' }),
      fk('partner_id', 'Partner', 'Customer / vendor on the line (when set).', 'dim_partner', 'partner_id', { sourceEntity: 'account_move_line', sourceColumn: 'partner_id' }),
      fk('journal_id', 'Journal', 'Journal the line is booked in.', 'dim_journal', 'journal_id', { sourceEntity: 'account_move_line', sourceColumn: 'journal_id' }),
      fk('company_id', 'Company', 'Company of the line.', 'dim_company', 'company_id', { sourceEntity: 'account_move_line', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the line.', 'dim_currency', 'currency_id', { sourceEntity: 'account_move_line', sourceColumn: 'currency_id' }),
      measure('debit', MONEY, 'Debit', 'Debit amount in company currency.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'debit' }),
      measure('credit', MONEY, 'Credit', 'Credit amount in company currency.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'credit' }),
      measure('balance', MONEY, 'Balance', 'Debit minus credit in company currency.', 'additive', { sourceEntity: 'account_move_line', sourceColumn: 'balance' }),
    ],
  },
  {
    tableName: 'fact_sales_order_lines',
    displayName: 'Sales order lines',
    description: 'One row per line on sales orders and quotations.',
    grain: 'One row per sales order line',
    factTableType: 'transaction',
    sourceEntities: ['sale_order_line', 'sale_order'],
    dimensionsUsed: ['dim_partner', 'dim_product', 'dim_company', 'dim_currency', 'dim_date'],
    sql: `SELECT
  sol.id                           AS order_line_id,
  sol.order_id                     AS order_id,
  so.name                          AS order_reference,
  TRY_CAST(so.date_order AS DATE)  AS order_date,
  so.state                         AS state,
  so.partner_id                    AS partner_id,
  sol.product_id                   AS product_id,
  so.company_id                    AS company_id,
  so.currency_id                   AS currency_id,
  sol.product_uom_qty              AS quantity_ordered,
  sol.qty_delivered                AS quantity_delivered,
  sol.qty_invoiced                 AS quantity_invoiced,
  sol.price_unit                   AS price_unit,
  sol.discount                     AS discount_pct,
  sol.price_subtotal               AS amount_untaxed,
  sol.price_total                  AS amount_total
FROM sale_order_line sol
JOIN sale_order so ON sol.order_id = so.id`,
    columns: [
      key('order_line_id', 'Order line ID', 'Odoo sales order line id (primary key).', 'sale_order_line'),
      col('order_id', 'BIGINT', 'Order ID', 'Odoo id of the sales order header.', { isTechnical: true, sourceEntity: 'sale_order_line', sourceColumn: 'order_id' }),
      col('order_reference', 'VARCHAR', 'Order reference', 'Sales order number (e.g. S00042).', { role: 'degenerate_dimension', sourceEntity: 'sale_order', sourceColumn: 'name' }),
      col('order_date', 'DATE', 'Order date', 'Date the order was placed.', { sourceEntity: 'sale_order', sourceColumn: 'date_order' }),
      col('state', 'VARCHAR', 'Status', 'draft (quotation), sent, sale (confirmed), done or cancel.', { sourceEntity: 'sale_order', sourceColumn: 'state' }),
      fk('partner_id', 'Customer', 'Customer on the order.', 'dim_partner', 'partner_id', { sourceEntity: 'sale_order', sourceColumn: 'partner_id' }),
      fk('product_id', 'Product', 'Product on the line.', 'dim_product', 'product_id', { sourceEntity: 'sale_order_line', sourceColumn: 'product_id' }),
      fk('company_id', 'Company', 'Company of the order.', 'dim_company', 'company_id', { sourceEntity: 'sale_order', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the order.', 'dim_currency', 'currency_id', { sourceEntity: 'sale_order', sourceColumn: 'currency_id' }),
      measure('quantity_ordered', 'DOUBLE', 'Quantity ordered', 'Ordered quantity.', 'additive', { sourceEntity: 'sale_order_line', sourceColumn: 'product_uom_qty' }),
      measure('quantity_delivered', 'DOUBLE', 'Quantity delivered', 'Delivered quantity.', 'additive', { sourceEntity: 'sale_order_line', sourceColumn: 'qty_delivered' }),
      measure('quantity_invoiced', 'DOUBLE', 'Quantity invoiced', 'Invoiced quantity.', 'additive', { sourceEntity: 'sale_order_line', sourceColumn: 'qty_invoiced' }),
      measure('price_unit', MONEY, 'Unit price', 'Price per unit.', 'non_additive', { sourceEntity: 'sale_order_line', sourceColumn: 'price_unit' }),
      measure('discount_pct', 'DOUBLE', 'Discount %', 'Line discount percentage.', 'non_additive', { sourceEntity: 'sale_order_line', sourceColumn: 'discount' }),
      measure('amount_untaxed', MONEY, 'Amount (untaxed)', 'Line amount excluding tax.', 'additive', { sourceEntity: 'sale_order_line', sourceColumn: 'price_subtotal' }),
      measure('amount_total', MONEY, 'Amount (incl. tax)', 'Line amount including tax.', 'additive', { sourceEntity: 'sale_order_line', sourceColumn: 'price_total' }),
    ],
  },
  {
    tableName: 'fact_purchase_order_lines',
    displayName: 'Purchase order lines',
    description: 'One row per line on purchase orders.',
    grain: 'One row per purchase order line',
    factTableType: 'transaction',
    sourceEntities: ['purchase_order_line', 'purchase_order'],
    dimensionsUsed: ['dim_partner', 'dim_product', 'dim_company', 'dim_currency', 'dim_date'],
    sql: `SELECT
  pol.id                           AS order_line_id,
  pol.order_id                     AS order_id,
  po.name                          AS order_reference,
  TRY_CAST(po.date_order AS DATE)  AS order_date,
  po.state                         AS state,
  po.partner_id                    AS vendor_id,
  pol.product_id                   AS product_id,
  po.company_id                    AS company_id,
  po.currency_id                   AS currency_id,
  pol.product_qty                  AS quantity_ordered,
  pol.qty_received                 AS quantity_received,
  pol.qty_invoiced                 AS quantity_invoiced,
  pol.price_unit                   AS price_unit,
  pol.price_subtotal               AS amount_untaxed,
  pol.price_total                  AS amount_total
FROM purchase_order_line pol
JOIN purchase_order po ON pol.order_id = po.id`,
    columns: [
      key('order_line_id', 'Order line ID', 'Odoo purchase order line id (primary key).', 'purchase_order_line'),
      col('order_id', 'BIGINT', 'Order ID', 'Odoo id of the purchase order header.', { isTechnical: true, sourceEntity: 'purchase_order_line', sourceColumn: 'order_id' }),
      col('order_reference', 'VARCHAR', 'Order reference', 'Purchase order number (e.g. P00042).', { role: 'degenerate_dimension', sourceEntity: 'purchase_order', sourceColumn: 'name' }),
      col('order_date', 'DATE', 'Order date', 'Date the order was confirmed / created.', { sourceEntity: 'purchase_order', sourceColumn: 'date_order' }),
      col('state', 'VARCHAR', 'Status', 'draft, sent, purchase (confirmed), done or cancel.', { sourceEntity: 'purchase_order', sourceColumn: 'state' }),
      fk('vendor_id', 'Vendor', 'Vendor the order was placed with.', 'dim_partner', 'partner_id', { sourceEntity: 'purchase_order', sourceColumn: 'partner_id' }),
      fk('product_id', 'Product', 'Product on the line.', 'dim_product', 'product_id', { sourceEntity: 'purchase_order_line', sourceColumn: 'product_id' }),
      fk('company_id', 'Company', 'Company of the order.', 'dim_company', 'company_id', { sourceEntity: 'purchase_order', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the order.', 'dim_currency', 'currency_id', { sourceEntity: 'purchase_order', sourceColumn: 'currency_id' }),
      measure('quantity_ordered', 'DOUBLE', 'Quantity ordered', 'Ordered quantity.', 'additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'product_qty' }),
      measure('quantity_received', 'DOUBLE', 'Quantity received', 'Received quantity.', 'additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'qty_received' }),
      measure('quantity_invoiced', 'DOUBLE', 'Quantity invoiced', 'Invoiced quantity.', 'additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'qty_invoiced' }),
      measure('price_unit', MONEY, 'Unit price', 'Price per unit.', 'non_additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'price_unit' }),
      measure('amount_untaxed', MONEY, 'Amount (untaxed)', 'Line amount excluding tax.', 'additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'price_subtotal' }),
      measure('amount_total', MONEY, 'Amount (incl. tax)', 'Line amount including tax.', 'additive', { sourceEntity: 'purchase_order_line', sourceColumn: 'price_total' }),
    ],
  },
  {
    tableName: 'fact_payments',
    displayName: 'Payments',
    description: 'One row per customer or vendor payment.',
    grain: 'One row per payment',
    factTableType: 'transaction',
    sourceEntities: ['account_payment'],
    dimensionsUsed: ['dim_partner', 'dim_journal', 'dim_company', 'dim_currency', 'dim_date'],
    sql: `SELECT
  ap.id                        AS payment_id,
  TRY_CAST(ap.date AS DATE)    AS payment_date,
  ap.payment_type              AS payment_type,
  ap.partner_type              AS partner_type,
  ap.state                     AS state,
  ap.partner_id                AS partner_id,
  ap.journal_id                AS journal_id,
  ap.company_id                AS company_id,
  ap.currency_id               AS currency_id,
  ap.amount                    AS amount,
  CASE WHEN ap.payment_type = 'inbound' THEN ap.amount ELSE -ap.amount END AS amount_signed
FROM account_payment ap`,
    columns: [
      key('payment_id', 'Payment ID', 'Odoo payment id (primary key).', 'account_payment'),
      col('payment_date', 'DATE', 'Payment date', 'Date of the payment.', { sourceEntity: 'account_payment', sourceColumn: 'date' }),
      col('payment_type', 'VARCHAR', 'Direction', 'inbound (money received) or outbound (money sent).', { sourceEntity: 'account_payment', sourceColumn: 'payment_type' }),
      col('partner_type', 'VARCHAR', 'Partner type', 'customer or supplier.', { sourceEntity: 'account_payment', sourceColumn: 'partner_type' }),
      col('state', 'VARCHAR', 'Status', 'Payment lifecycle state.', { sourceEntity: 'account_payment', sourceColumn: 'state' }),
      fk('partner_id', 'Partner', 'Customer / vendor the payment is with.', 'dim_partner', 'partner_id', { sourceEntity: 'account_payment', sourceColumn: 'partner_id' }),
      fk('journal_id', 'Journal', 'Bank / cash journal of the payment.', 'dim_journal', 'journal_id', { sourceEntity: 'account_payment', sourceColumn: 'journal_id' }),
      fk('company_id', 'Company', 'Company of the payment.', 'dim_company', 'company_id', { sourceEntity: 'account_payment', sourceColumn: 'company_id' }),
      fk('currency_id', 'Currency', 'Currency of the payment.', 'dim_currency', 'currency_id', { sourceEntity: 'account_payment', sourceColumn: 'currency_id' }),
      measure('amount', MONEY, 'Amount', 'Payment amount (always positive).', 'additive', { sourceEntity: 'account_payment', sourceColumn: 'amount' }),
      measure('amount_signed', MONEY, 'Amount (signed)', 'Positive for money received, negative for money sent.', 'additive'),
    ],
  },
  {
    tableName: 'fact_stock_moves',
    displayName: 'Stock moves',
    description: 'One row per product movement (receipt, delivery, internal transfer).',
    grain: 'One row per stock move',
    factTableType: 'transaction',
    sourceEntities: ['stock_move'],
    dimensionsUsed: ['dim_product', 'dim_company', 'dim_date'],
    sql: `SELECT
  sm.id                        AS stock_move_id,
  TRY_CAST(sm.date AS DATE)    AS move_date,
  sm.state                     AS state,
  sm.reference                 AS reference,
  sm.product_id                AS product_id,
  sm.company_id                AS company_id,
  sm.product_uom_qty           AS quantity
FROM stock_move sm`,
    columns: [
      key('stock_move_id', 'Stock move ID', 'Odoo stock move id (primary key).', 'stock_move'),
      col('move_date', 'DATE', 'Move date', 'Date the move was (or is scheduled to be) done.', { sourceEntity: 'stock_move', sourceColumn: 'date' }),
      col('state', 'VARCHAR', 'Status', 'draft, waiting, confirmed, assigned, done or cancel.', { sourceEntity: 'stock_move', sourceColumn: 'state' }),
      col('reference', 'VARCHAR', 'Reference', 'Picking / document reference of the move.', { role: 'degenerate_dimension', sourceEntity: 'stock_move', sourceColumn: 'reference' }),
      fk('product_id', 'Product', 'Product being moved.', 'dim_product', 'product_id', { sourceEntity: 'stock_move', sourceColumn: 'product_id' }),
      fk('company_id', 'Company', 'Company of the move.', 'dim_company', 'company_id', { sourceEntity: 'stock_move', sourceColumn: 'company_id' }),
      measure('quantity', 'DOUBLE', 'Quantity', 'Quantity moved (in the product’s unit of measure).', 'additive', { sourceEntity: 'stock_move', sourceColumn: 'product_uom_qty' }),
    ],
  },
];

// ─── The template ───────────────────────────────────────────────────────────

export const ODOO_STAR_SCHEMA_TEMPLATE: StarSchemaTemplate = {
  version: 1,
  dimensions: DIMENSIONS,
  facts: FACTS,
  products: [
    {
      name: 'Core dimensions',
      description: 'Conformed dimensions shared by every Odoo data product: partners, products, accounts, journals, companies, currencies.',
      buildOrder: 1,
      factTables: [],
      ownedDimensions: DIMENSIONS.map((d) => d.tableName),
    },
    {
      name: 'Finance',
      description: 'Accounting analytics: general ledger, invoices and bills, payments.',
      buildOrder: 2,
      factTables: ['fact_journal_items', 'fact_invoice_lines', 'fact_payments'],
      ownedDimensions: [],
    },
    {
      name: 'Sales',
      description: 'Sales analytics: orders, quantities, delivery and invoicing progress.',
      buildOrder: 3,
      factTables: ['fact_sales_order_lines'],
      ownedDimensions: [],
    },
    {
      name: 'Purchasing',
      description: 'Purchasing analytics: orders placed with vendors, receipts and billing progress.',
      buildOrder: 4,
      factTables: ['fact_purchase_order_lines'],
      ownedDimensions: [],
    },
    {
      name: 'Inventory',
      description: 'Inventory analytics: product movements over time.',
      buildOrder: 5,
      factTables: ['fact_stock_moves'],
      ownedDimensions: [],
    },
  ],
  relationships: [
    // fact_invoice_lines
    { fromTable: 'fact_invoice_lines', fromColumn: 'partner_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'product_id', toTable: 'dim_product', toColumn: 'product_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'journal_id', toTable: 'dim_journal', toColumn: 'journal_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'fact_to_dim' },
    { fromTable: 'fact_invoice_lines', fromColumn: 'payment_term_id', toTable: 'dim_payment_term', toColumn: 'payment_term_id', type: 'fact_to_dim' },
    // fact_journal_items
    { fromTable: 'fact_journal_items', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_journal_items', fromColumn: 'partner_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'fact_to_dim' },
    { fromTable: 'fact_journal_items', fromColumn: 'journal_id', toTable: 'dim_journal', toColumn: 'journal_id', type: 'fact_to_dim' },
    { fromTable: 'fact_journal_items', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    { fromTable: 'fact_journal_items', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'fact_to_dim' },
    // fact_sales_order_lines
    { fromTable: 'fact_sales_order_lines', fromColumn: 'partner_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'product_id', toTable: 'dim_product', toColumn: 'product_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'fact_to_dim' },
    // fact_purchase_order_lines
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'vendor_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'fact_to_dim' },
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'product_id', toTable: 'dim_product', toColumn: 'product_id', type: 'fact_to_dim' },
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'fact_to_dim' },
    // fact_payments
    { fromTable: 'fact_payments', fromColumn: 'partner_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'fact_to_dim' },
    { fromTable: 'fact_payments', fromColumn: 'journal_id', toTable: 'dim_journal', toColumn: 'journal_id', type: 'fact_to_dim' },
    { fromTable: 'fact_payments', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    { fromTable: 'fact_payments', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'fact_to_dim' },
    // fact_stock_moves
    { fromTable: 'fact_stock_moves', fromColumn: 'product_id', toTable: 'dim_product', toColumn: 'product_id', type: 'fact_to_dim' },
    { fromTable: 'fact_stock_moves', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'fact_to_dim' },
    // dim_to_dim
    { fromTable: 'dim_partner', fromColumn: 'parent_id', toTable: 'dim_partner', toColumn: 'partner_id', type: 'dim_to_dim' },
    { fromTable: 'dim_partner', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'dim_to_dim' },
    { fromTable: 'dim_product', fromColumn: 'category_id', toTable: 'dim_product_category', toColumn: 'category_id', type: 'dim_to_dim' },
    { fromTable: 'dim_product', fromColumn: 'uom_id', toTable: 'dim_uom', toColumn: 'uom_id', type: 'dim_to_dim' },
    { fromTable: 'dim_product_category', fromColumn: 'parent_id', toTable: 'dim_product_category', toColumn: 'category_id', type: 'dim_to_dim' },
    { fromTable: 'dim_journal', fromColumn: 'company_id', toTable: 'dim_company', toColumn: 'company_id', type: 'dim_to_dim' },
    { fromTable: 'dim_journal', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'dim_to_dim' },
    { fromTable: 'dim_company', fromColumn: 'currency_id', toTable: 'dim_currency', toColumn: 'currency_id', type: 'dim_to_dim' },
  ],
  kpis: [
    {
      name: 'Invoiced revenue',
      description: 'Net revenue from posted customer invoices (credit notes subtracted).',
      formulaPlainText: 'Sum of signed untaxed amounts on posted customer invoices and credit notes',
      formulaSql: "SELECT SUM(amount_signed) FROM fact_invoice_lines WHERE move_type IN ('out_invoice', 'out_refund') AND state = 'posted'",
      additivity: 'additive',
      productName: 'Finance',
      requiresTables: ['fact_invoice_lines'],
    },
    {
      name: 'Vendor bill spend',
      description: 'Net spend from posted vendor bills (refunds subtracted).',
      formulaPlainText: 'Sum of signed untaxed amounts on posted vendor bills and refunds',
      formulaSql: "SELECT SUM(amount_signed) FROM fact_invoice_lines WHERE move_type IN ('in_invoice', 'in_refund') AND state = 'posted'",
      additivity: 'additive',
      productName: 'Finance',
      requiresTables: ['fact_invoice_lines'],
    },
    {
      name: 'Payments received',
      description: 'Total inbound payments (excluding drafts and cancellations).',
      formulaPlainText: 'Sum of inbound payment amounts, excluding draft and cancelled payments',
      formulaSql: "SELECT SUM(amount) FROM fact_payments WHERE payment_type = 'inbound' AND state NOT IN ('draft', 'cancel', 'canceled', 'cancelled')",
      additivity: 'additive',
      productName: 'Finance',
      requiresTables: ['fact_payments'],
    },
    {
      name: 'Confirmed sales value',
      description: 'Untaxed value of confirmed sales orders.',
      formulaPlainText: 'Sum of untaxed line amounts on confirmed sales orders',
      formulaSql: "SELECT SUM(amount_untaxed) FROM fact_sales_order_lines WHERE state IN ('sale', 'done')",
      additivity: 'additive',
      productName: 'Sales',
      requiresTables: ['fact_sales_order_lines'],
    },
    {
      name: 'Confirmed purchase value',
      description: 'Untaxed value of confirmed purchase orders.',
      formulaPlainText: 'Sum of untaxed line amounts on confirmed purchase orders',
      formulaSql: "SELECT SUM(amount_untaxed) FROM fact_purchase_order_lines WHERE state IN ('purchase', 'done')",
      additivity: 'additive',
      productName: 'Purchasing',
      requiresTables: ['fact_purchase_order_lines'],
    },
  ],
};
