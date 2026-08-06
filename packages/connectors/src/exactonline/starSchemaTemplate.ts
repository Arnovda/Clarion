/**
 * ExactOnline deterministic star-schema template (version 1).
 *
 * Hand-written Kimball design for the EO entity catalog
 * (docs/SOURCE_ONBOARDING.md Phase F). Every column referenced below was
 * verified against the vendor's REST reference via the deterministic
 * transcription in `docs.ts` — no guessed field names.
 *
 * EO-specific design notes:
 *   • Keys are OData GUIDs (VARCHAR in the warehouse); dims key on the
 *     entity's GUID id, facts carry the raw GUID FK columns (marked
 *     technical). Journals and PaymentConditions are CODE-keyed — EO facts
 *     reference them by code string, not GUID.
 *   • CREDIT NOTES ARE NATIVELY NEGATIVE in EO (credit-note lines carry
 *     negative quantities/amounts), so unlike the Odoo template no sign-flip
 *     measure is needed — SUM(amount_dc) is already net.
 *   • `*DC` amounts are in the division's default currency (cross-currency
 *     additive); `*FC` amounts are in the document currency.
 *   • Dates arrive as ISO strings (the connector converts OData `/Date()/`
 *     epochs at sync time) — TRY_CAST(... AS DATE) normalises them.
 *   • Facts never JOIN dims (only their own header entity), so a dropped
 *     dim can't break a surviving fact.
 *   • Every dim carries an UNKNOWN MEMBER keyed '-1', and every fact FK is
 *     COALESCE'd onto it. EO leaves optional references as empty GUIDs, so
 *     without this a transaction line with no account vanishes from any
 *     inner join — silently, and only for some rows.
 *   • Every date on a fact also emits a `<role>_date_key` (YYYYMMDD) into the
 *     platform's `dim_date`. The raw DATE column stays for exact-date
 *     filtering; the key is what the star joins on, and it is what makes a
 *     role-playing date ("invoiced in March" vs "due in March") expressible.
 *
 * Doctrine: docs/DIMENSIONAL_MODEL.md.
 */

import {
  dateKeyColumn,
  dateKeyExpr,
  withUnknownMember,
  UNKNOWN_KEY_TEXT,
  type StarSchemaTemplate,
  type TemplateColumn,
  type TemplateDimension,
  type TemplateFact,
  type UnknownMemberSpec,
} from '../starSchema';

// ─── Column helpers ─────────────────────────────────────────────────────────

const col = (
  name: string,
  dataType: string,
  displayName: string,
  description: string,
  extra: Partial<TemplateColumn> = {},
): TemplateColumn => ({ name, dataType, displayName, description, role: 'attribute', ...extra });

/** GUID natural key of a dim. */
const guidKey = (name: string, displayName: string, description: string, sourceEntity: string): TemplateColumn =>
  col(name, 'VARCHAR', displayName, description, {
    role: 'natural_key', isTechnical: true, sourceEntity, sourceColumn: 'ID',
  });

const fk = (
  name: string, displayName: string, description: string,
  fkTargetTable: string, fkTargetColumn: string,
  extra: Partial<TemplateColumn> = {},
): TemplateColumn =>
  col(name, 'VARCHAR', displayName, description, {
    role: 'foreign_key', fkTargetTable, fkTargetColumn, isTechnical: true, ...extra,
  });

const measure = (
  name: string, displayName: string, description: string,
  additivity: 'additive' | 'semi_additive' | 'non_additive' = 'additive',
  extra: Partial<TemplateColumn> = {},
): TemplateColumn =>
  col(name, 'DOUBLE', displayName, description, { role: 'measure', additivity, ...extra });

/** Every EO dim keys on a VARCHAR (GUID or code), so one sentinel shape fits all. */
const unknown = (keyColumn: string, labelColumn: string): UnknownMemberSpec => ({
  keyColumn, keyLiteral: `'${UNKNOWN_KEY_TEXT}'`, labelColumn, label: 'Unknown',
});

// ─── Conformed dimensions ───────────────────────────────────────────────────

const BASE_DIMENSIONS: TemplateDimension[] = [
  {
    tableName: 'dim_account',
    displayName: 'Accounts',
    description: 'Customers, suppliers and prospects — one row per ExactOnline account.',
    sourceEntities: ['Accounts'],
    sql: `SELECT
  ID          AS account_id,
  Code        AS account_code,
  Name        AS account_name,
  City        AS city,
  CountryName AS country,
  Email       AS email,
  Phone       AS phone,
  VATNumber   AS vat_number,
  Status      AS status,
  IsSales     AS is_customer,
  IsSupplier  AS is_supplier,
  Parent      AS parent_id
FROM Accounts`,
    columns: [
      guidKey('account_id', 'Account ID', 'ExactOnline account GUID (primary key).', 'Accounts'),
      col('account_code', 'VARCHAR', 'Account code', 'Human-readable account code.', { sourceEntity: 'Accounts', sourceColumn: 'Code' }),
      col('account_name', 'VARCHAR', 'Account name', 'Name of the customer / supplier.', { sourceEntity: 'Accounts', sourceColumn: 'Name' }),
      col('city', 'VARCHAR', 'City', 'City of the visit address.', { sourceEntity: 'Accounts', sourceColumn: 'City' }),
      col('country', 'VARCHAR', 'Country', 'Country name of the account.', { sourceEntity: 'Accounts', sourceColumn: 'CountryName' }),
      col('email', 'VARCHAR', 'Email', 'Primary email address.', { sourceEntity: 'Accounts', sourceColumn: 'Email' }),
      col('phone', 'VARCHAR', 'Phone', 'Primary phone number.', { sourceEntity: 'Accounts', sourceColumn: 'Phone' }),
      col('vat_number', 'VARCHAR', 'VAT number', 'Tax / VAT identification number.', { sourceEntity: 'Accounts', sourceColumn: 'VATNumber' }),
      col('status', 'VARCHAR', 'Status', 'Account lifecycle status (C = customer, S = supplier, P = prospect, …).', { sourceEntity: 'Accounts', sourceColumn: 'Status' }),
      col('is_customer', 'BOOLEAN', 'Is customer', 'True when the account buys from you.', { sourceEntity: 'Accounts', sourceColumn: 'IsSales' }),
      col('is_supplier', 'BOOLEAN', 'Is supplier', 'True when the account supplies to you.', { sourceEntity: 'Accounts', sourceColumn: 'IsSupplier' }),
      fk('parent_id', 'Parent account', 'Parent account (e.g. holding company).', 'dim_account', 'account_id', { sourceEntity: 'Accounts', sourceColumn: 'Parent' }),
    ],
  },
  {
    tableName: 'dim_item',
    displayName: 'Items',
    description: 'Article master data — what is sold, purchased or stocked.',
    sourceEntities: ['Items'],
    sql: `SELECT
  ID                 AS item_id,
  Code               AS item_code,
  Description        AS item_description,
  ItemGroup          AS item_group_id,
  Unit               AS unit_code,
  IsSalesItem        AS is_sales_item,
  IsStockItem        AS is_stock_item,
  StandardSalesPrice AS standard_sales_price,
  CostPriceStandard  AS cost_price_standard
FROM Items`,
    columns: [
      guidKey('item_id', 'Item ID', 'ExactOnline item GUID (primary key).', 'Items'),
      col('item_code', 'VARCHAR', 'Item code', 'Article code / SKU.', { sourceEntity: 'Items', sourceColumn: 'Code' }),
      col('item_description', 'VARCHAR', 'Item description', 'Description of the article.', { sourceEntity: 'Items', sourceColumn: 'Description' }),
      fk('item_group_id', 'Item group', 'Reporting group of the item.', 'dim_item_group', 'item_group_id', { sourceEntity: 'Items', sourceColumn: 'ItemGroup' }),
      col('unit_code', 'VARCHAR', 'Unit', 'Default unit of measure code.', { sourceEntity: 'Items', sourceColumn: 'Unit' }),
      col('is_sales_item', 'BOOLEAN', 'Is sales item', 'True when the item can be sold.', { sourceEntity: 'Items', sourceColumn: 'IsSalesItem' }),
      col('is_stock_item', 'BOOLEAN', 'Is stock item', 'True when stock is tracked for the item.', { sourceEntity: 'Items', sourceColumn: 'IsStockItem' }),
      col('standard_sales_price', 'DOUBLE', 'Standard sales price', 'Default sales price.', { sourceEntity: 'Items', sourceColumn: 'StandardSalesPrice' }),
      col('cost_price_standard', 'DOUBLE', 'Standard cost price', 'Standard cost price.', { sourceEntity: 'Items', sourceColumn: 'CostPriceStandard' }),
    ],
  },
  {
    tableName: 'dim_item_group',
    displayName: 'Item groups',
    description: 'Item categorisation used for reporting groupings.',
    sourceEntities: ['ItemGroups'],
    sql: `SELECT
  ID          AS item_group_id,
  Code        AS item_group_code,
  Description AS item_group_description
FROM ItemGroups`,
    columns: [
      guidKey('item_group_id', 'Item group ID', 'ExactOnline item group GUID (primary key).', 'ItemGroups'),
      col('item_group_code', 'VARCHAR', 'Item group code', 'Code of the group.', { sourceEntity: 'ItemGroups', sourceColumn: 'Code' }),
      col('item_group_description', 'VARCHAR', 'Item group', 'Description of the group.', { sourceEntity: 'ItemGroups', sourceColumn: 'Description' }),
    ],
  },
  {
    tableName: 'dim_gl_account',
    displayName: 'GL accounts',
    description: 'The chart of accounts — one row per general-ledger account.',
    sourceEntities: ['GLAccounts'],
    sql: `SELECT
  ID              AS gl_account_id,
  Code            AS gl_account_code,
  Description     AS gl_account_name,
  TypeDescription AS gl_account_type,
  BalanceSide     AS balance_side
FROM GLAccounts`,
    columns: [
      guidKey('gl_account_id', 'GL account ID', 'ExactOnline GL account GUID (primary key).', 'GLAccounts'),
      col('gl_account_code', 'VARCHAR', 'GL account code', 'Chart-of-accounts code.', { sourceEntity: 'GLAccounts', sourceColumn: 'Code' }),
      col('gl_account_name', 'VARCHAR', 'GL account name', 'Name of the GL account.', { sourceEntity: 'GLAccounts', sourceColumn: 'Description' }),
      col('gl_account_type', 'VARCHAR', 'GL account type', 'Account classification (revenue, cost, debtors, …).', { sourceEntity: 'GLAccounts', sourceColumn: 'TypeDescription' }),
      col('balance_side', 'VARCHAR', 'Balance side', 'D (debit) or C (credit).', { sourceEntity: 'GLAccounts', sourceColumn: 'BalanceSide' }),
    ],
  },
  {
    tableName: 'dim_journal',
    displayName: 'Journals',
    description: 'Journal definitions (sales, purchases, bank, memo). Code-keyed — facts reference journals by code.',
    sourceEntities: ['Journals'],
    sql: `SELECT
  Code        AS journal_code,
  Description AS journal_name,
  Type        AS journal_type
FROM Journals`,
    columns: [
      col('journal_code', 'VARCHAR', 'Journal code', 'Journal code (natural key — facts reference this).', { role: 'natural_key', sourceEntity: 'Journals', sourceColumn: 'Code' }),
      col('journal_name', 'VARCHAR', 'Journal name', 'Description of the journal.', { sourceEntity: 'Journals', sourceColumn: 'Description' }),
      col('journal_type', 'BIGINT', 'Journal type', 'Numeric journal type (10 = sales, 20 = purchase, 12 = bank, …).', { isTechnical: true, sourceEntity: 'Journals', sourceColumn: 'Type' }),
    ],
  },
  {
    tableName: 'dim_payment_condition',
    displayName: 'Payment conditions',
    description: 'Payment terms (net 30, end-of-month, …). Code-keyed — documents reference them by code.',
    sourceEntities: ['PaymentConditions'],
    sql: `SELECT
  Code        AS payment_condition_code,
  Description AS payment_condition_name,
  PaymentDays AS payment_days
FROM PaymentConditions`,
    columns: [
      col('payment_condition_code', 'VARCHAR', 'Payment condition code', 'Payment condition code (natural key).', { role: 'natural_key', sourceEntity: 'PaymentConditions', sourceColumn: 'Code' }),
      col('payment_condition_name', 'VARCHAR', 'Payment condition', 'Description of the payment term.', { sourceEntity: 'PaymentConditions', sourceColumn: 'Description' }),
      col('payment_days', 'BIGINT', 'Payment days', 'Number of days before payment is due.', { sourceEntity: 'PaymentConditions', sourceColumn: 'PaymentDays' }),
    ],
  },
];

/**
 * Apply the unknown member to every dimension.
 *
 * Keyed by table name and throwing on a miss, so a dimension added later
 * cannot ship without one — the check is construction, not a review habit.
 */
const UNKNOWN_MEMBERS: Record<string, UnknownMemberSpec> = {
  dim_account:           unknown('account_id', 'account_name'),
  dim_item:              unknown('item_id', 'item_description'),
  dim_item_group:        unknown('item_group_id', 'item_group_description'),
  dim_gl_account:        unknown('gl_account_id', 'gl_account_name'),
  dim_journal:           unknown('journal_code', 'journal_name'),
  dim_payment_condition: unknown('payment_condition_code', 'payment_condition_name'),
};

const DIMENSIONS: TemplateDimension[] = BASE_DIMENSIONS.map((d) => {
  const spec = UNKNOWN_MEMBERS[d.tableName];
  if (!spec) throw new Error(`ExactOnline template: dim '${d.tableName}' has no unknown-member spec`);
  return { ...d, sql: withUnknownMember(d.sql, d.columns, spec) };
});

// ─── Facts ──────────────────────────────────────────────────────────────────

const FACTS: TemplateFact[] = [
  {
    tableName: 'fact_sales_invoice_lines',
    displayName: 'Sales invoice lines',
    description: 'One row per line on sales invoices and credit notes (credit-note amounts are natively negative).',
    grain: 'One row per sales invoice line',
    factTableType: 'transaction',
    sourceEntities: ['SalesInvoiceLines', 'SalesInvoices'],
    dimensionsUsed: ['dim_account', 'dim_item', 'dim_gl_account', 'dim_journal', 'dim_payment_condition', 'dim_date'],
    sql: `SELECT
  sil.ID                              AS invoice_line_id,
  sil.InvoiceID                       AS invoice_id,
  si.InvoiceNumber                    AS invoice_number,
  TRY_CAST(si.InvoiceDate AS DATE)    AS invoice_date,
  ${dateKeyExpr('si.InvoiceDate')} AS invoice_date_key,
  TRY_CAST(si.DueDate AS DATE)        AS due_date,
  ${dateKeyExpr('si.DueDate')} AS due_date_key,
  si.StatusDescription                AS status,
  si.TypeDescription                  AS document_type,
  COALESCE(si.InvoiceTo, '-1')        AS invoice_to_id,
  COALESCE(si.OrderedBy, '-1')        AS ordered_by_id,
  COALESCE(sil.Item, '-1')            AS item_id,
  COALESCE(sil.GLAccount, '-1')       AS gl_account_id,
  COALESCE(si.Journal, '-1')          AS journal_code,
  COALESCE(si.PaymentCondition, '-1') AS payment_condition_code,
  si.Currency                         AS currency,
  sil.Description                     AS line_description,
  sil.Quantity                        AS quantity,
  sil.NetPrice                        AS net_price,
  sil.AmountDC                        AS amount_dc,
  sil.AmountFC                        AS amount_fc,
  sil.VATAmountDC                     AS vat_amount_dc
FROM SalesInvoiceLines sil
JOIN SalesInvoices si ON sil.InvoiceID = si.InvoiceID`,
    columns: [
      guidKey('invoice_line_id', 'Invoice line ID', 'ExactOnline invoice line GUID (primary key).', 'SalesInvoiceLines'),
      col('invoice_id', 'VARCHAR', 'Invoice ID', 'GUID of the invoice header.', { isTechnical: true, sourceEntity: 'SalesInvoiceLines', sourceColumn: 'InvoiceID' }),
      col('invoice_number', 'BIGINT', 'Invoice number', 'Human-readable invoice number.', { role: 'degenerate_dimension', sourceEntity: 'SalesInvoices', sourceColumn: 'InvoiceNumber' }),
      col('invoice_date', 'DATE', 'Invoice date', 'Date of the invoice.', { sourceEntity: 'SalesInvoices', sourceColumn: 'InvoiceDate' }),
      dateKeyColumn('invoice_date_key', 'Invoice date key', 'Calendar key of the invoice date.', { sourceEntity: 'SalesInvoices', sourceColumn: 'InvoiceDate' }),
      col('due_date', 'DATE', 'Due date', 'Payment due date.', { sourceEntity: 'SalesInvoices', sourceColumn: 'DueDate' }),
      dateKeyColumn('due_date_key', 'Due date key', 'Calendar key of the due date.', { sourceEntity: 'SalesInvoices', sourceColumn: 'DueDate' }),
      col('status', 'VARCHAR', 'Status', 'Invoice status (open, processed, …).', { sourceEntity: 'SalesInvoices', sourceColumn: 'StatusDescription' }),
      col('document_type', 'VARCHAR', 'Document type', 'Sales invoice or credit note.', { sourceEntity: 'SalesInvoices', sourceColumn: 'TypeDescription' }),
      fk('invoice_to_id', 'Invoiced customer', 'Customer being billed.', 'dim_account', 'account_id', { sourceEntity: 'SalesInvoices', sourceColumn: 'InvoiceTo' }),
      fk('ordered_by_id', 'Ordering customer', 'Customer who placed the order.', 'dim_account', 'account_id', { sourceEntity: 'SalesInvoices', sourceColumn: 'OrderedBy' }),
      fk('item_id', 'Item', 'Item on the line (when set).', 'dim_item', 'item_id', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'Item' }),
      fk('gl_account_id', 'GL account', 'Revenue GL account of the line.', 'dim_gl_account', 'gl_account_id', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'GLAccount' }),
      fk('journal_code', 'Journal', 'Sales journal the invoice is booked in.', 'dim_journal', 'journal_code', { sourceEntity: 'SalesInvoices', sourceColumn: 'Journal' }),
      fk('payment_condition_code', 'Payment condition', 'Payment term of the invoice.', 'dim_payment_condition', 'payment_condition_code', { sourceEntity: 'SalesInvoices', sourceColumn: 'PaymentCondition' }),
      col('currency', 'VARCHAR', 'Currency', 'Document currency code.', { sourceEntity: 'SalesInvoices', sourceColumn: 'Currency' }),
      col('line_description', 'VARCHAR', 'Line description', 'Description of the invoiced line.', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'Description' }),
      measure('quantity', 'Quantity', 'Quantity invoiced (negative on credit notes).', 'additive', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'Quantity' }),
      measure('net_price', 'Net price', 'Net price per unit after discount.', 'non_additive', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'NetPrice' }),
      measure('amount_dc', 'Amount (default currency)', 'Line amount excl. VAT in the division currency — sums to net revenue.', 'additive', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'AmountDC' }),
      measure('amount_fc', 'Amount (document currency)', 'Line amount excl. VAT in the document currency.', 'additive', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'AmountFC' }),
      measure('vat_amount_dc', 'VAT amount', 'VAT amount in the division currency.', 'additive', { sourceEntity: 'SalesInvoiceLines', sourceColumn: 'VATAmountDC' }),
    ],
  },
  {
    tableName: 'fact_transaction_lines',
    displayName: 'Transaction lines',
    description: 'One row per booked general-ledger line — the complete accounting detail.',
    grain: 'One row per GL transaction line',
    factTableType: 'transaction',
    sourceEntities: ['TransactionLines'],
    dimensionsUsed: ['dim_gl_account', 'dim_account', 'dim_item', 'dim_journal', 'dim_date'],
    sql: `SELECT
  ID                            AS transaction_line_id,
  EntryNumber                   AS entry_number,
  TRY_CAST(Date AS DATE)        AS entry_date,
  ${dateKeyExpr('Date')} AS entry_date_key,
  FinancialYear                 AS financial_year,
  FinancialPeriod               AS financial_period,
  COALESCE(JournalCode, '-1')   AS journal_code,
  COALESCE(GLAccount, '-1')     AS gl_account_id,
  COALESCE(Account, '-1')       AS account_id,
  COALESCE(Item, '-1')          AS item_id,
  InvoiceNumber                 AS invoice_number,
  Description                   AS description,
  Currency                      AS currency,
  Quantity                      AS quantity,
  AmountDC                      AS amount_dc,
  AmountFC                      AS amount_fc,
  AmountVATFC                   AS vat_amount_fc
FROM TransactionLines`,
    columns: [
      guidKey('transaction_line_id', 'Transaction line ID', 'ExactOnline transaction line GUID (primary key).', 'TransactionLines'),
      col('entry_number', 'BIGINT', 'Entry number', 'Journal entry number.', { role: 'degenerate_dimension', sourceEntity: 'TransactionLines', sourceColumn: 'EntryNumber' }),
      col('entry_date', 'DATE', 'Entry date', 'Accounting date of the line.', { sourceEntity: 'TransactionLines', sourceColumn: 'Date' }),
      dateKeyColumn('entry_date_key', 'Entry date key', 'Calendar key of the accounting date.', { sourceEntity: 'TransactionLines', sourceColumn: 'Date' }),
      col('financial_year', 'BIGINT', 'Financial year', 'Fiscal year the line posts to.', { sourceEntity: 'TransactionLines', sourceColumn: 'FinancialYear' }),
      col('financial_period', 'BIGINT', 'Financial period', 'Fiscal period the line posts to.', { sourceEntity: 'TransactionLines', sourceColumn: 'FinancialPeriod' }),
      fk('journal_code', 'Journal', 'Journal the line is booked in.', 'dim_journal', 'journal_code', { sourceEntity: 'TransactionLines', sourceColumn: 'JournalCode' }),
      fk('gl_account_id', 'GL account', 'GL account the line posts to.', 'dim_gl_account', 'gl_account_id', { sourceEntity: 'TransactionLines', sourceColumn: 'GLAccount' }),
      fk('account_id', 'Account', 'Customer / supplier on the line (when set).', 'dim_account', 'account_id', { sourceEntity: 'TransactionLines', sourceColumn: 'Account' }),
      fk('item_id', 'Item', 'Item on the line (when set).', 'dim_item', 'item_id', { sourceEntity: 'TransactionLines', sourceColumn: 'Item' }),
      col('invoice_number', 'BIGINT', 'Invoice number', 'Invoice number the line belongs to (when applicable).', { sourceEntity: 'TransactionLines', sourceColumn: 'InvoiceNumber' }),
      col('description', 'VARCHAR', 'Description', 'Description of the booking.', { sourceEntity: 'TransactionLines', sourceColumn: 'Description' }),
      col('currency', 'VARCHAR', 'Currency', 'Currency of the line.', { sourceEntity: 'TransactionLines', sourceColumn: 'Currency' }),
      measure('quantity', 'Quantity', 'Quantity on the line (when applicable).', 'additive', { sourceEntity: 'TransactionLines', sourceColumn: 'Quantity' }),
      measure('amount_dc', 'Amount (default currency)', 'Signed amount in the division currency (debit positive, credit negative).', 'additive', { sourceEntity: 'TransactionLines', sourceColumn: 'AmountDC' }),
      measure('amount_fc', 'Amount (document currency)', 'Signed amount in the transaction currency.', 'additive', { sourceEntity: 'TransactionLines', sourceColumn: 'AmountFC' }),
      measure('vat_amount_fc', 'VAT amount', 'VAT amount in the transaction currency.', 'additive', { sourceEntity: 'TransactionLines', sourceColumn: 'AmountVATFC' }),
    ],
  },
  {
    tableName: 'fact_sales_order_lines',
    displayName: 'Sales order lines',
    description: 'One row per line on sales orders.',
    grain: 'One row per sales order line',
    factTableType: 'transaction',
    sourceEntities: ['SalesOrderLines', 'SalesOrders'],
    dimensionsUsed: ['dim_account', 'dim_item', 'dim_date'],
    sql: `SELECT
  sol.ID                            AS order_line_id,
  sol.OrderID                       AS order_id,
  so.OrderNumber                    AS order_number,
  TRY_CAST(so.OrderDate AS DATE)    AS order_date,
  ${dateKeyExpr('so.OrderDate')} AS order_date_key,
  so.StatusDescription              AS status,
  COALESCE(so.OrderedBy, '-1')      AS ordered_by_id,
  COALESCE(so.InvoiceTo, '-1')      AS invoice_to_id,
  COALESCE(sol.Item, '-1')          AS item_id,
  so.Currency                       AS currency,
  sol.Description                   AS line_description,
  sol.Quantity                      AS quantity,
  sol.QuantityDelivered             AS quantity_delivered,
  sol.QuantityInvoiced              AS quantity_invoiced,
  sol.NetPrice                      AS net_price,
  sol.Discount                      AS discount,
  sol.AmountDC                      AS amount_dc
FROM SalesOrderLines sol
JOIN SalesOrders so ON sol.OrderID = so.OrderID`,
    columns: [
      guidKey('order_line_id', 'Order line ID', 'ExactOnline order line GUID (primary key).', 'SalesOrderLines'),
      col('order_id', 'VARCHAR', 'Order ID', 'GUID of the order header.', { isTechnical: true, sourceEntity: 'SalesOrderLines', sourceColumn: 'OrderID' }),
      col('order_number', 'BIGINT', 'Order number', 'Human-readable order number.', { role: 'degenerate_dimension', sourceEntity: 'SalesOrders', sourceColumn: 'OrderNumber' }),
      col('order_date', 'DATE', 'Order date', 'Date the order was placed.', { sourceEntity: 'SalesOrders', sourceColumn: 'OrderDate' }),
      dateKeyColumn('order_date_key', 'Order date key', 'Calendar key of the order date.', { sourceEntity: 'SalesOrders', sourceColumn: 'OrderDate' }),
      col('status', 'VARCHAR', 'Status', 'Order status (open, partial, complete, cancelled).', { sourceEntity: 'SalesOrders', sourceColumn: 'StatusDescription' }),
      fk('ordered_by_id', 'Ordering customer', 'Customer who placed the order.', 'dim_account', 'account_id', { sourceEntity: 'SalesOrders', sourceColumn: 'OrderedBy' }),
      fk('invoice_to_id', 'Invoiced customer', 'Customer who will be billed.', 'dim_account', 'account_id', { sourceEntity: 'SalesOrders', sourceColumn: 'InvoiceTo' }),
      fk('item_id', 'Item', 'Item on the line.', 'dim_item', 'item_id', { sourceEntity: 'SalesOrderLines', sourceColumn: 'Item' }),
      col('currency', 'VARCHAR', 'Currency', 'Document currency code.', { sourceEntity: 'SalesOrders', sourceColumn: 'Currency' }),
      col('line_description', 'VARCHAR', 'Line description', 'Description of the ordered line.', { sourceEntity: 'SalesOrderLines', sourceColumn: 'Description' }),
      measure('quantity', 'Quantity ordered', 'Ordered quantity.', 'additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'Quantity' }),
      measure('quantity_delivered', 'Quantity delivered', 'Delivered quantity.', 'additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'QuantityDelivered' }),
      measure('quantity_invoiced', 'Quantity invoiced', 'Invoiced quantity.', 'additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'QuantityInvoiced' }),
      measure('net_price', 'Net price', 'Net price per unit.', 'non_additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'NetPrice' }),
      measure('discount', 'Discount', 'Line discount fraction.', 'non_additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'Discount' }),
      measure('amount_dc', 'Amount (default currency)', 'Line amount excl. VAT in the division currency.', 'additive', { sourceEntity: 'SalesOrderLines', sourceColumn: 'AmountDC' }),
    ],
  },
  {
    tableName: 'fact_purchase_order_lines',
    displayName: 'Purchase order lines',
    description: 'One row per line on purchase orders.',
    grain: 'One row per purchase order line',
    factTableType: 'transaction',
    sourceEntities: ['PurchaseOrderLines', 'PurchaseOrders'],
    dimensionsUsed: ['dim_account', 'dim_item', 'dim_date'],
    sql: `SELECT
  pol.ID                            AS order_line_id,
  pol.PurchaseOrderID               AS order_id,
  po.OrderNumber                    AS order_number,
  TRY_CAST(po.OrderDate AS DATE)    AS order_date,
  ${dateKeyExpr('po.OrderDate')} AS order_date_key,
  COALESCE(po.Supplier, '-1')       AS supplier_id,
  COALESCE(pol.Item, '-1')          AS item_id,
  po.Currency                       AS currency,
  pol.Description                   AS line_description,
  pol.Quantity                      AS quantity,
  pol.ReceivedQuantity              AS quantity_received,
  pol.InvoicedQuantity              AS quantity_invoiced,
  pol.NetPrice                      AS net_price,
  pol.AmountDC                      AS amount_dc
FROM PurchaseOrderLines pol
JOIN PurchaseOrders po ON pol.PurchaseOrderID = po.PurchaseOrderID`,
    columns: [
      guidKey('order_line_id', 'Order line ID', 'ExactOnline purchase order line GUID (primary key).', 'PurchaseOrderLines'),
      col('order_id', 'VARCHAR', 'Order ID', 'GUID of the purchase order header.', { isTechnical: true, sourceEntity: 'PurchaseOrderLines', sourceColumn: 'PurchaseOrderID' }),
      col('order_number', 'BIGINT', 'Order number', 'Human-readable purchase order number.', { role: 'degenerate_dimension', sourceEntity: 'PurchaseOrders', sourceColumn: 'OrderNumber' }),
      col('order_date', 'DATE', 'Order date', 'Date of the purchase order.', { sourceEntity: 'PurchaseOrders', sourceColumn: 'OrderDate' }),
      dateKeyColumn('order_date_key', 'Order date key', 'Calendar key of the order date.', { sourceEntity: 'PurchaseOrders', sourceColumn: 'OrderDate' }),
      fk('supplier_id', 'Supplier', 'Supplier the order was placed with.', 'dim_account', 'account_id', { sourceEntity: 'PurchaseOrders', sourceColumn: 'Supplier' }),
      fk('item_id', 'Item', 'Item on the line.', 'dim_item', 'item_id', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'Item' }),
      col('currency', 'VARCHAR', 'Currency', 'Document currency code.', { sourceEntity: 'PurchaseOrders', sourceColumn: 'Currency' }),
      col('line_description', 'VARCHAR', 'Line description', 'Description of the ordered line.', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'Description' }),
      measure('quantity', 'Quantity ordered', 'Ordered quantity.', 'additive', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'Quantity' }),
      measure('quantity_received', 'Quantity received', 'Received quantity.', 'additive', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'ReceivedQuantity' }),
      measure('quantity_invoiced', 'Quantity invoiced', 'Invoiced quantity.', 'additive', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'InvoicedQuantity' }),
      measure('net_price', 'Net price', 'Net price per unit.', 'non_additive', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'NetPrice' }),
      measure('amount_dc', 'Amount (default currency)', 'Line amount excl. VAT in the division currency.', 'additive', { sourceEntity: 'PurchaseOrderLines', sourceColumn: 'AmountDC' }),
    ],
  },
  {
    tableName: 'fact_receivables',
    displayName: 'Receivables',
    description: 'One row per open receivable item — what customers still owe.',
    grain: 'One row per receivable item',
    factTableType: 'accumulating_snapshot',
    sourceEntities: ['Receivables'],
    dimensionsUsed: ['dim_account', 'dim_gl_account', 'dim_journal', 'dim_payment_condition', 'dim_date'],
    sql: `SELECT
  ID                                  AS receivable_id,
  TRY_CAST(InvoiceDate AS DATE)       AS invoice_date,
  ${dateKeyExpr('InvoiceDate')} AS invoice_date_key,
  TRY_CAST(DueDate AS DATE)           AS due_date,
  ${dateKeyExpr('DueDate')} AS due_date_key,
  TRY_CAST(LastPaymentDate AS DATE)   AS last_payment_date,
  ${dateKeyExpr('LastPaymentDate')} AS last_payment_date_key,
  InvoiceNumber                       AS invoice_number,
  COALESCE(Account, '-1')             AS account_id,
  COALESCE(GLAccount, '-1')           AS gl_account_id,
  COALESCE(Journal, '-1')             AS journal_code,
  COALESCE(PaymentCondition, '-1')    AS payment_condition_code,
  Currency                            AS currency,
  Description                         AS description,
  IsFullyPaid                         AS is_fully_paid,
  AmountDC                            AS amount_dc,
  AmountFC                            AS amount_fc
FROM Receivables`,
    columns: [
      guidKey('receivable_id', 'Receivable ID', 'ExactOnline receivable GUID (primary key).', 'Receivables'),
      col('invoice_date', 'DATE', 'Invoice date', 'Date of the underlying invoice.', { sourceEntity: 'Receivables', sourceColumn: 'InvoiceDate' }),
      dateKeyColumn('invoice_date_key', 'Invoice date key', 'Calendar key of the invoice date.', { sourceEntity: 'Receivables', sourceColumn: 'InvoiceDate' }),
      col('due_date', 'DATE', 'Due date', 'Payment due date.', { sourceEntity: 'Receivables', sourceColumn: 'DueDate' }),
      dateKeyColumn('due_date_key', 'Due date key', 'Calendar key of the due date.', { sourceEntity: 'Receivables', sourceColumn: 'DueDate' }),
      col('last_payment_date', 'DATE', 'Last payment date', 'Date of the most recent payment against this item.', { sourceEntity: 'Receivables', sourceColumn: 'LastPaymentDate' }),
      dateKeyColumn('last_payment_date_key', 'Last payment date key', 'Calendar key of the most recent payment.', { sourceEntity: 'Receivables', sourceColumn: 'LastPaymentDate' }),
      col('invoice_number', 'BIGINT', 'Invoice number', 'Invoice number of the receivable.', { role: 'degenerate_dimension', sourceEntity: 'Receivables', sourceColumn: 'InvoiceNumber' }),
      fk('account_id', 'Customer', 'Customer who owes the amount.', 'dim_account', 'account_id', { sourceEntity: 'Receivables', sourceColumn: 'Account' }),
      fk('gl_account_id', 'GL account', 'Receivable GL account.', 'dim_gl_account', 'gl_account_id', { sourceEntity: 'Receivables', sourceColumn: 'GLAccount' }),
      fk('journal_code', 'Journal', 'Journal the receivable is booked in.', 'dim_journal', 'journal_code', { sourceEntity: 'Receivables', sourceColumn: 'Journal' }),
      fk('payment_condition_code', 'Payment condition', 'Payment term of the receivable.', 'dim_payment_condition', 'payment_condition_code', { sourceEntity: 'Receivables', sourceColumn: 'PaymentCondition' }),
      col('currency', 'VARCHAR', 'Currency', 'Currency of the receivable.', { sourceEntity: 'Receivables', sourceColumn: 'Currency' }),
      col('description', 'VARCHAR', 'Description', 'Description of the receivable.', { sourceEntity: 'Receivables', sourceColumn: 'Description' }),
      col('is_fully_paid', 'BOOLEAN', 'Fully paid', 'True when the item has been settled in full.', { sourceEntity: 'Receivables', sourceColumn: 'IsFullyPaid' }),
      measure('amount_dc', 'Amount (default currency)', 'Receivable amount in the division currency.', 'additive', { sourceEntity: 'Receivables', sourceColumn: 'AmountDC' }),
      measure('amount_fc', 'Amount (document currency)', 'Receivable amount in the document currency.', 'additive', { sourceEntity: 'Receivables', sourceColumn: 'AmountFC' }),
    ],
  },
  {
    tableName: 'fact_payables',
    displayName: 'Payables',
    description: 'One row per outgoing payment obligation — what you owe suppliers.',
    grain: 'One row per payable item',
    factTableType: 'accumulating_snapshot',
    sourceEntities: ['Payments'],
    dimensionsUsed: ['dim_account', 'dim_gl_account', 'dim_journal', 'dim_date'],
    sql: `SELECT
  ID                                  AS payable_id,
  TRY_CAST(InvoiceDate AS DATE)       AS invoice_date,
  ${dateKeyExpr('InvoiceDate')} AS invoice_date_key,
  TRY_CAST(DueDate AS DATE)           AS due_date,
  ${dateKeyExpr('DueDate')} AS due_date_key,
  InvoiceNumber                       AS invoice_number,
  COALESCE(Account, '-1')             AS account_id,
  COALESCE(GLAccount, '-1')           AS gl_account_id,
  COALESCE(Journal, '-1')             AS journal_code,
  Currency                            AS currency,
  Description                         AS description,
  AmountDC                            AS amount_dc,
  AmountFC                            AS amount_fc
FROM Payments`,
    columns: [
      guidKey('payable_id', 'Payable ID', 'ExactOnline payment obligation GUID (primary key).', 'Payments'),
      col('invoice_date', 'DATE', 'Invoice date', 'Date of the underlying supplier invoice.', { sourceEntity: 'Payments', sourceColumn: 'InvoiceDate' }),
      dateKeyColumn('invoice_date_key', 'Invoice date key', 'Calendar key of the invoice date.', { sourceEntity: 'Payments', sourceColumn: 'InvoiceDate' }),
      col('due_date', 'DATE', 'Due date', 'Payment due date.', { sourceEntity: 'Payments', sourceColumn: 'DueDate' }),
      dateKeyColumn('due_date_key', 'Due date key', 'Calendar key of the due date.', { sourceEntity: 'Payments', sourceColumn: 'DueDate' }),
      col('invoice_number', 'BIGINT', 'Invoice number', 'Invoice number of the payable.', { role: 'degenerate_dimension', sourceEntity: 'Payments', sourceColumn: 'InvoiceNumber' }),
      fk('account_id', 'Supplier', 'Supplier the amount is owed to.', 'dim_account', 'account_id', { sourceEntity: 'Payments', sourceColumn: 'Account' }),
      fk('gl_account_id', 'GL account', 'Payable GL account.', 'dim_gl_account', 'gl_account_id', { sourceEntity: 'Payments', sourceColumn: 'GLAccount' }),
      fk('journal_code', 'Journal', 'Journal the payable is booked in.', 'dim_journal', 'journal_code', { sourceEntity: 'Payments', sourceColumn: 'Journal' }),
      col('currency', 'VARCHAR', 'Currency', 'Currency of the payable.', { sourceEntity: 'Payments', sourceColumn: 'Currency' }),
      col('description', 'VARCHAR', 'Description', 'Description of the payable.', { sourceEntity: 'Payments', sourceColumn: 'Description' }),
      measure('amount_dc', 'Amount (default currency)', 'Payable amount in the division currency.', 'additive', { sourceEntity: 'Payments', sourceColumn: 'AmountDC' }),
      measure('amount_fc', 'Amount (document currency)', 'Payable amount in the document currency.', 'additive', { sourceEntity: 'Payments', sourceColumn: 'AmountFC' }),
    ],
  },
];

// ─── The template ───────────────────────────────────────────────────────────

export const EXACT_ONLINE_STAR_SCHEMA_TEMPLATE: StarSchemaTemplate = {
  version: 2,
  dimensions: DIMENSIONS,
  facts: FACTS,
  products: [
    {
      name: 'Core dimensions',
      description: 'Conformed dimensions shared by every ExactOnline data product: accounts, items, GL accounts, journals, payment conditions.',
      buildOrder: 1,
      factTables: [],
      ownedDimensions: DIMENSIONS.map((d) => d.tableName),
    },
    {
      name: 'Finance',
      description: 'Accounting analytics: general-ledger detail, open receivables and payables.',
      buildOrder: 2,
      factTables: ['fact_transaction_lines', 'fact_receivables', 'fact_payables'],
      ownedDimensions: [],
    },
    {
      name: 'Sales',
      description: 'Sales analytics: invoiced revenue and order intake.',
      buildOrder: 3,
      factTables: ['fact_sales_invoice_lines', 'fact_sales_order_lines'],
      ownedDimensions: [],
    },
    {
      name: 'Purchasing',
      description: 'Purchasing analytics: orders placed with suppliers, receipt and billing progress.',
      buildOrder: 4,
      factTables: ['fact_purchase_order_lines'],
      ownedDimensions: [],
    },
  ],
  relationships: [
    // fact_sales_invoice_lines
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'invoice_to_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'ordered_by_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'item_id', toTable: 'dim_item', toColumn: 'item_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'gl_account_id', toTable: 'dim_gl_account', toColumn: 'gl_account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'journal_code', toTable: 'dim_journal', toColumn: 'journal_code', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'payment_condition_code', toTable: 'dim_payment_condition', toColumn: 'payment_condition_code', type: 'fact_to_dim' },
    // fact_transaction_lines
    { fromTable: 'fact_transaction_lines', fromColumn: 'gl_account_id', toTable: 'dim_gl_account', toColumn: 'gl_account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_transaction_lines', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_transaction_lines', fromColumn: 'item_id', toTable: 'dim_item', toColumn: 'item_id', type: 'fact_to_dim' },
    { fromTable: 'fact_transaction_lines', fromColumn: 'journal_code', toTable: 'dim_journal', toColumn: 'journal_code', type: 'fact_to_dim' },
    // fact_sales_order_lines
    { fromTable: 'fact_sales_order_lines', fromColumn: 'ordered_by_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'invoice_to_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'item_id', toTable: 'dim_item', toColumn: 'item_id', type: 'fact_to_dim' },
    // fact_purchase_order_lines
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'supplier_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'item_id', toTable: 'dim_item', toColumn: 'item_id', type: 'fact_to_dim' },
    // fact_receivables
    { fromTable: 'fact_receivables', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'gl_account_id', toTable: 'dim_gl_account', toColumn: 'gl_account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'journal_code', toTable: 'dim_journal', toColumn: 'journal_code', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'payment_condition_code', toTable: 'dim_payment_condition', toColumn: 'payment_condition_code', type: 'fact_to_dim' },
    // fact_payables
    { fromTable: 'fact_payables', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_payables', fromColumn: 'gl_account_id', toTable: 'dim_gl_account', toColumn: 'gl_account_id', type: 'fact_to_dim' },
    { fromTable: 'fact_payables', fromColumn: 'journal_code', toTable: 'dim_journal', toColumn: 'journal_code', type: 'fact_to_dim' },
    // fact → dim_date. One relationship per DATE ROLE, all pointing at the same
    // calendar: that is what makes "invoiced in March" and "due in March"
    // different questions rather than one ambiguous one.
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'invoice_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_invoice_lines', fromColumn: 'due_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_transaction_lines', fromColumn: 'entry_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_sales_order_lines', fromColumn: 'order_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_purchase_order_lines', fromColumn: 'order_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'invoice_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'due_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_receivables', fromColumn: 'last_payment_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_payables', fromColumn: 'invoice_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },
    { fromTable: 'fact_payables', fromColumn: 'due_date_key', toTable: 'dim_date', toColumn: 'date_key', type: 'fact_to_dim' },

    // dim_to_dim
    { fromTable: 'dim_account', fromColumn: 'parent_id', toTable: 'dim_account', toColumn: 'account_id', type: 'dim_to_dim' },
    { fromTable: 'dim_item', fromColumn: 'item_group_id', toTable: 'dim_item_group', toColumn: 'item_group_id', type: 'dim_to_dim' },
  ],
  kpis: [
    {
      name: 'Invoiced sales revenue',
      description: 'Net invoiced revenue excl. VAT (credit notes are natively negative in ExactOnline).',
      formulaPlainText: 'Sum of invoice line amounts in the division currency',
      formulaSql: 'SELECT SUM(amount_dc) FROM fact_sales_invoice_lines',
      additivity: 'additive',
      productName: 'Sales',
      requiresTables: ['fact_sales_invoice_lines'],
    },
    {
      name: 'Sales order intake',
      description: 'Untaxed value of sales order lines.',
      formulaPlainText: 'Sum of order line amounts in the division currency',
      formulaSql: 'SELECT SUM(amount_dc) FROM fact_sales_order_lines',
      additivity: 'additive',
      productName: 'Sales',
      requiresTables: ['fact_sales_order_lines'],
    },
    {
      name: 'Outstanding receivables',
      description: 'Open amounts customers still owe.',
      formulaPlainText: 'Sum of receivable amounts not yet fully paid',
      formulaSql: 'SELECT SUM(amount_dc) FROM fact_receivables WHERE is_fully_paid = false',
      additivity: 'additive',
      productName: 'Finance',
      requiresTables: ['fact_receivables'],
    },
    {
      name: 'Purchase order value',
      description: 'Untaxed value of purchase order lines.',
      formulaPlainText: 'Sum of purchase order line amounts in the division currency',
      formulaSql: 'SELECT SUM(amount_dc) FROM fact_purchase_order_lines',
      additivity: 'additive',
      productName: 'Purchasing',
      requiresTables: ['fact_purchase_order_lines'],
    },
  ],
};
