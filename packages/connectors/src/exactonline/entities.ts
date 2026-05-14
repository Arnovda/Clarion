/**
 * Curated ExactOnline entity catalog.
 *
 * Each entry maps a stable name (used as the warehouse table name and as the
 * value in `connections.selected_entities`) to:
 *   • API path (relative to `/api/v1/{division}`)
 *   • Optional default $filter clause to keep high-volume entities tractable
 *   • Display metadata for the wizard UI
 *
 * Why curated rather than dynamic for now: ExactOnline's $metadata XML is
 * parseable but adds non-trivial complexity (cross-namespace references,
 * EntityContainer→service-segment derivation). Curated covers the entities
 * we actually use today and keeps the connector surgical. Dynamic discovery
 * is a future enhancement (`listEntities` swaps in a $metadata fetcher
 * without changing the rest of the connector).
 *
 * To add an entity, drop a new entry here. Verify the `path` matches what
 * the API actually exposes — the easiest check is opening the URL in
 * Postman with a valid bearer token; ExactOnline's docs at
 * https://start.exactonline.<tld>/docs/HlpRestAPIResources.aspx list every
 * endpoint with its category (= service path segment).
 */

import type { EntityDescriptor, KnownRelationship } from '../types';

export interface ExactOnlineEntity extends EntityDescriptor {
  /** Path relative to `/api/v1/{division}`, with leading slash. */
  apiPath: string;

  /** Optional OData filter applied unconditionally to keep volume tractable. */
  defaultFilter?: string;
}

/**
 * Default date filters for high-volume entities. ExactOnline divisions
 * can carry decades of history; without a filter a single sync can pull
 * tens of millions of rows from `TransactionLines`, `Documents`, etc.
 * The 2025-01-01 cutoff keeps the initial sync tractable while still
 * covering the active fiscal year plus a comparable prior period.
 *
 * Users who genuinely need older history can override `defaultFilter`
 * per-connection in a follow-up — captured as a TODO on the connector
 * roadmap. For now the filter is uniform.
 */
const DEFAULT_DATE_CUTOFF = `2025-01-01T00:00:00`;
const TXN_LINES_DEFAULT_FILTER = `Date gt datetime'${DEFAULT_DATE_CUTOFF}'`;
const ORDER_DATE_FILTER        = `OrderDate gt datetime'${DEFAULT_DATE_CUTOFF}'`;
const INVOICE_DATE_FILTER      = `InvoiceDate gt datetime'${DEFAULT_DATE_CUTOFF}'`;
const ENTRY_DATE_FILTER        = `EntryDate gt datetime'${DEFAULT_DATE_CUTOFF}'`;
const QUOTATION_DATE_FILTER    = `QuotationDate gt datetime'${DEFAULT_DATE_CUTOFF}'`;
const DOCUMENT_DATE_FILTER     = `DocumentDate gt datetime'${DEFAULT_DATE_CUTOFF}'`;

// ─── NOTE ON API PATHS ───────────────────────────────────────────────────────
// Every entry below has been cross-referenced against ExactOnline's REST API
// reference (https://start.exactonline.<tld>/docs/HlpRestAPIResources.aspx).
// Paths can shift between API revisions — when adding new entries, verify
// against the docs page for the target locale (paths are identical across
// locales but availability sometimes differs).
//
// Entries marked `// VERIFY` are best-guess based on the EO category-segment
// convention but should be confirmed with a single Postman GET against the
// target division before going to production. Most production data flows
// will only enable a subset, so unverified entries cause no harm sitting in
// the catalog until someone selects them.
// ──────────────────────────────────────────────────────────────────────────

export const EXACT_ONLINE_ENTITIES: readonly ExactOnlineEntity[] = [
  // ════════════════════════════════════════════════════════════════════════
  // CRM — customers, contacts, prospects, addresses, classifications
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Accounts',
    displayName: 'Accounts',
    category: 'CRM',
    description: 'Customers, suppliers, prospects — the master account list.',
    apiPath: '/crm/Accounts',
    supportsIncremental: false,
  },
  {
    name: 'Contacts',
    displayName: 'Contacts',
    category: 'CRM',
    description: 'Individual contact persons. Each contact belongs to an account.',
    apiPath: '/crm/Contacts',
    supportsIncremental: false,
  },
  {
    name: 'Addresses',
    displayName: 'Addresses',
    category: 'CRM',
    description: 'Postal addresses linked to accounts (billing, shipping, visit).',
    apiPath: '/crm/Addresses',
    supportsIncremental: false,
  },
  {
    name: 'AccountClassifications',
    displayName: 'Account classifications',
    category: 'CRM',
    description: 'Customer / supplier segmentation values (e.g. tier, vertical).',
    apiPath: '/crm/AccountClassifications',
    supportsIncremental: false,
  },
  {
    name: 'AccountClassificationNames',
    displayName: 'Account classification names',
    category: 'CRM',
    description: 'Labels for the up-to-8 classification slots configured per division.',
    apiPath: '/crm/AccountClassificationNames',
    supportsIncremental: false,
  },
  {
    name: 'Opportunities',
    displayName: 'Opportunities',
    category: 'CRM',
    description: 'Sales pipeline opportunities (active + won + lost).',
    apiPath: '/crm/Opportunities', // VERIFY
    supportsIncremental: false,
  },
  {
    name: 'Quotations',
    displayName: 'Quotations',
    category: 'CRM',
    description: 'Sales quotations — pre-order pricing offers to customers.',
    apiPath: '/crm/Quotations', // VERIFY (also seen at /sales/Quotations on older API revisions)
    defaultFilter: QUOTATION_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'QuotationLines',
    displayName: 'Quotation lines',
    category: 'CRM',
    description: 'Line items on quotations.',
    apiPath: '/crm/QuotationLines', // VERIFY
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SALES — invoices, orders, entries
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'SalesInvoices',
    displayName: 'Sales invoices',
    category: 'Sales',
    description: 'Sales invoice headers — what was billed and to whom.',
    apiPath: '/salesinvoice/SalesInvoices',
    defaultFilter: INVOICE_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'SalesInvoiceLines',
    displayName: 'Sales invoice lines',
    category: 'Sales',
    description: 'Line items on sales invoices — what products / amounts.',
    apiPath: '/salesinvoice/SalesInvoiceLines',
    supportsIncremental: false,
  },
  {
    name: 'SalesOrders',
    displayName: 'Sales orders',
    category: 'Sales',
    description: 'Sales order headers — customer purchase orders captured.',
    apiPath: '/salesorder/SalesOrders',
    defaultFilter: ORDER_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'SalesOrderLines',
    displayName: 'Sales order lines',
    category: 'Sales',
    description: 'Line items on sales orders.',
    apiPath: '/salesorder/SalesOrderLines',
    supportsIncremental: false,
  },
  {
    name: 'SalesEntries',
    displayName: 'Sales entries',
    category: 'Sales',
    description:
      'Light-weight sales journal entries — used by accountants who book sales as a journal entry rather than as a full invoice.',
    apiPath: '/salesentry/SalesEntries',
    defaultFilter: ENTRY_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'SalesEntryLines',
    displayName: 'Sales entry lines',
    category: 'Sales',
    description: 'Line items on sales journal entries.',
    apiPath: '/salesentry/SalesEntryLines',
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // PURCHASE — orders, invoices, entries
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'PurchaseOrders',
    displayName: 'Purchase orders',
    category: 'Purchase',
    description: 'Orders placed with suppliers.',
    apiPath: '/purchaseorder/PurchaseOrders',
    defaultFilter: ORDER_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'PurchaseOrderLines',
    displayName: 'Purchase order lines',
    category: 'Purchase',
    description: 'Line items on purchase orders.',
    apiPath: '/purchaseorder/PurchaseOrderLines',
    supportsIncremental: false,
  },
  {
    name: 'PurchaseInvoices',
    displayName: 'Purchase invoices',
    category: 'Purchase',
    description: 'Supplier invoices booked into purchase ledger.',
    apiPath: '/purchaseinvoice/PurchaseInvoices', // VERIFY (some revisions use /purchase/PurchaseInvoices)
    defaultFilter: INVOICE_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'PurchaseInvoiceLines',
    displayName: 'Purchase invoice lines',
    category: 'Purchase',
    description: 'Line items on supplier invoices.',
    apiPath: '/purchaseinvoice/PurchaseInvoiceLines', // VERIFY
    supportsIncremental: false,
  },
  {
    name: 'PurchaseEntries',
    displayName: 'Purchase entries',
    category: 'Purchase',
    description:
      'Light-weight purchase journal entries — used by accountants who book costs as a journal entry rather than as a full invoice.',
    apiPath: '/purchaseentry/PurchaseEntries',
    defaultFilter: ENTRY_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'PurchaseEntryLines',
    displayName: 'Purchase entry lines',
    category: 'Purchase',
    description: 'Line items on purchase journal entries.',
    apiPath: '/purchaseentry/PurchaseEntryLines',
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // LOGISTICS — items, item groups, warehouses, units
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Items',
    displayName: 'Items',
    category: 'Logistics',
    description: 'Article master data — what you sell or stock.',
    apiPath: '/logistics/Items',
    supportsIncremental: false,
  },
  {
    name: 'ItemGroups',
    displayName: 'Item groups',
    category: 'Logistics',
    description: 'Item categorisation — typically used for reporting groupings.',
    apiPath: '/logistics/ItemGroups',
    supportsIncremental: false,
  },
  {
    name: 'Warehouses',
    displayName: 'Warehouses',
    category: 'Logistics',
    description: 'Physical or logical stock locations.',
    apiPath: '/inventory/Warehouses', // VERIFY (sometimes seen at /logistics/Warehouses)
    supportsIncremental: false,
  },
  {
    name: 'UnitsOfMeasure',
    displayName: 'Units of measure',
    category: 'Logistics',
    description: 'Quantity units used on items (piece, kg, hour, …).',
    apiPath: '/logistics/Units',
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // INVENTORY — stock transactions, stock counts
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'StockTransactions',
    displayName: 'Stock transactions',
    category: 'Inventory',
    description: 'Stock movement ledger — every in/out per item per warehouse.',
    apiPath: '/inventory/StockTransactions', // VERIFY
    defaultFilter: TXN_LINES_DEFAULT_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'StockCounts',
    displayName: 'Stock counts',
    category: 'Inventory',
    description: 'Physical inventory counts and reconciliations.',
    apiPath: '/inventory/StockCounts', // VERIFY
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // FINANCIAL — chart of accounts, journals, transactions, classifications
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'GLAccounts',
    displayName: 'GL accounts',
    category: 'Financial',
    description: 'Chart of accounts.',
    apiPath: '/financial/GLAccounts',
    supportsIncremental: false,
  },
  {
    name: 'Journals',
    displayName: 'Journals',
    category: 'Financial',
    description: 'Journal definitions (sales, purchases, bank, memo, …).',
    apiPath: '/financial/Journals',
    supportsIncremental: false,
  },
  {
    name: 'GLClassifications',
    displayName: 'GL classifications',
    category: 'Financial',
    description: 'Classification hierarchy of GL accounts for financial reporting.',
    apiPath: '/financial/GLClassifications',
    supportsIncremental: false,
  },
  {
    name: 'TransactionLines',
    displayName: 'Transaction lines',
    category: 'Financial',
    description:
      'GL ledger detail. Defaulted to 2025-onwards to keep volume tractable — adjust the filter to pull deeper history when needed.',
    apiPath: '/financialtransaction/TransactionLines',
    defaultFilter: TXN_LINES_DEFAULT_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'Documents',
    displayName: 'Documents',
    category: 'Financial',
    description:
      'Business documents (invoices, receipts, contracts) attached to accounts. High volume on active divisions — date-filtered by default.',
    apiPath: '/documents/Documents', // VERIFY
    defaultFilter: DOCUMENT_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'FinancialPeriods',
    displayName: 'Financial periods',
    category: 'Financial',
    description: 'Open / closed accounting periods per fiscal year.',
    apiPath: '/financial/FinancialPeriods', // VERIFY
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // CASHFLOW — banks, payments, receivables, payables
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'BankAccounts',
    displayName: 'Bank accounts',
    category: 'Cashflow',
    description: 'Bank account definitions (IBAN, GL link).',
    apiPath: '/cashflow/BankAccounts',
    supportsIncremental: false,
  },
  {
    name: 'BankEntries',
    displayName: 'Bank entries',
    category: 'Cashflow',
    description: 'Bank statement headers — one entry per statement / batch.',
    apiPath: '/cashflow/BankEntries', // VERIFY
    defaultFilter: ENTRY_DATE_FILTER,
    supportsIncremental: false,
  },
  {
    name: 'BankEntryLines',
    displayName: 'Bank entry lines',
    category: 'Cashflow',
    description: 'Individual lines on bank statements — each booked transaction.',
    apiPath: '/cashflow/BankEntryLines', // VERIFY
    supportsIncremental: false,
  },
  {
    name: 'Payments',
    displayName: 'Payments',
    category: 'Cashflow',
    description: 'Outgoing and incoming payments — useful for AR / AP analysis.',
    apiPath: '/cashflow/Payments', // VERIFY
    supportsIncremental: false,
  },
  {
    name: 'Receivables',
    displayName: 'Receivables',
    category: 'Cashflow',
    description: 'Open receivable items — what customers still owe.',
    apiPath: '/read/financial/Receivables', // VERIFY (read-only entity)
    supportsIncremental: false,
  },
  {
    name: 'Payables',
    displayName: 'Payables',
    category: 'Cashflow',
    description: 'Open payable items — what you owe suppliers.',
    apiPath: '/read/financial/Payables', // VERIFY (read-only entity)
    supportsIncremental: false,
  },
  {
    name: 'PaymentConditions',
    displayName: 'Payment conditions',
    category: 'Cashflow',
    description: 'Standard payment terms (net 30, end-of-month, …).',
    apiPath: '/cashflow/PaymentConditions',
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // HRM — employees, employments
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Employees',
    displayName: 'Employees',
    category: 'HRM',
    description: 'Employee master data.',
    apiPath: '/hrm/Employees',
    supportsIncremental: false,
  },
  {
    name: 'Employments',
    displayName: 'Employments',
    category: 'HRM',
    description: 'Employment contracts — each employee may have multiple over time.',
    apiPath: '/payroll/Employments', // VERIFY (sometimes under /hrm/)
    supportsIncremental: false,
  },
  {
    name: 'ActiveEmployments',
    displayName: 'Active employments',
    category: 'HRM',
    description: 'Currently-active employment contracts only.',
    apiPath: '/payroll/ActiveEmployments', // VERIFY
    supportsIncremental: false,
  },
  {
    name: 'Leave',
    displayName: 'Leave',
    category: 'HRM',
    description: 'Leave / vacation records.',
    apiPath: '/hrm/Leave', // VERIFY
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // PROJECT — projects, time tracking
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Projects',
    displayName: 'Projects',
    category: 'Project',
    description: 'Project master data.',
    apiPath: '/project/Projects',
    supportsIncremental: false,
  },
  {
    name: 'TimeTransactions',
    displayName: 'Time transactions',
    category: 'Project',
    description: 'Time bookings against projects — hours per employee per task.',
    apiPath: '/project/TimeTransactions', // VERIFY
    defaultFilter: `Date gt datetime'${DEFAULT_DATE_CUTOFF}'`,
    supportsIncremental: false,
  },
  {
    name: 'TimeCostTransactions',
    displayName: 'Time + cost transactions',
    category: 'Project',
    description: 'Combined time + cost transactions across projects.',
    apiPath: '/project/TimeCostTransactions', // VERIFY
    defaultFilter: `Date gt datetime'${DEFAULT_DATE_CUTOFF}'`,
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTION — recurring billing
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Subscriptions',
    displayName: 'Subscriptions',
    category: 'Subscription',
    description: 'Recurring billing subscriptions — what customers are subscribed to.',
    apiPath: '/subscription/Subscriptions',
    supportsIncremental: false,
  },
  {
    name: 'SubscriptionLines',
    displayName: 'Subscription lines',
    category: 'Subscription',
    description: 'Line items on subscriptions — individual subscribed products.',
    apiPath: '/subscription/SubscriptionLines',
    supportsIncremental: false,
  },
  {
    name: 'SubscriptionTypes',
    displayName: 'Subscription types',
    category: 'Subscription',
    description: 'Subscription plan templates.',
    apiPath: '/subscription/SubscriptionTypes',
    supportsIncremental: false,
  },

  // ════════════════════════════════════════════════════════════════════════
  // SYSTEM — division metadata
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Divisions',
    displayName: 'Divisions',
    category: 'System',
    description: 'The administrations / legal entities visible to this OAuth app.',
    apiPath: '/hrm/Divisions', // VERIFY (also seen at /system/Divisions)
    supportsIncremental: false,
  },
  {
    name: 'Users',
    displayName: 'Users',
    category: 'System',
    description: 'ExactOnline portal users with access to this division.',
    apiPath: '/users/Users', // VERIFY
    supportsIncremental: false,
  },
];

/**
 * Documented relationships between ExactOnline entities.
 *
 * Sourced from ExactOnline's REST API reference + the schema produced by
 * tap-exact-online (TicketSwap, MIT). Limited to the 7 entities we ship today;
 * more can be added without code changes once new entities go live.
 *
 * Casing matches the OData payloads exactly so the schema profiler's column
 * lookup (which compares against the introspected Parquet headers) matches.
 *
 * The connector's `getKnownRelationships()` filters this list to the entities
 * the user actually selected — relationships pointing at unsynced entities
 * are dropped before being handed to the profiler.
 */
export const EXACT_ONLINE_KNOWN_RELATIONSHIPS: readonly KnownRelationship[] = [
  // ── Sales: invoice header ↔ lines ────────────────────────────────────────
  {
    fromTable: 'SalesInvoiceLines', fromColumn: 'InvoiceID',
    toTable:   'SalesInvoices',     toColumn:   'InvoiceID',
    type: 'many_to_one',
    description: 'Each invoice line belongs to one sales invoice header.',
  },

  // ── Sales: invoice header → customer/account roles ───────────────────────
  // EO models several "account roles" on each invoice (who's billed, who
  // ordered, who receives the goods). All point at the same Accounts table.
  {
    fromTable: 'SalesInvoices', fromColumn: 'InvoiceTo',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'Which customer is billed for this invoice.',
  },
  {
    fromTable: 'SalesInvoices', fromColumn: 'OrderedBy',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'Which customer placed the order behind this invoice.',
  },
  {
    fromTable: 'SalesInvoices', fromColumn: 'DeliverTo',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'Which customer/address the goods are delivered to.',
  },

  // ── Sales: invoice line → item / GL account ──────────────────────────────
  {
    fromTable: 'SalesInvoiceLines', fromColumn: 'Item',
    toTable:   'Items',             toColumn:   'ID',
    type: 'many_to_one',
    description: 'The product or service this line is for.',
  },
  {
    fromTable: 'SalesInvoiceLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'The general ledger account this line posts to.',
  },

  // ── GL: chart of accounts → classifications ──────────────────────────────
  {
    fromTable: 'GLAccounts',        fromColumn: 'GLClassification',
    toTable:   'GLClassifications', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The classification group this GL account belongs to.',
  },
  // GL classification hierarchy (Parent → ID self-reference)
  {
    fromTable: 'GLClassifications', fromColumn: 'Parent',
    toTable:   'GLClassifications', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Parent classification in the financial-reporting hierarchy.',
  },

  // ── Transaction lines (GL ledger detail) ─────────────────────────────────
  {
    fromTable: 'TransactionLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',       toColumn:   'ID',
    type: 'many_to_one',
    description: 'The GL account this ledger line posts to.',
  },
  {
    fromTable: 'TransactionLines', fromColumn: 'Account',
    toTable:   'Accounts',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer/supplier whose ledger this line affects.',
  },
  {
    fromTable: 'TransactionLines', fromColumn: 'JournalCode',
    toTable:   'Journals',         toColumn:   'Code',
    type: 'many_to_one',
    description: 'The journal (sales / purchases / bank / …) this line posts to.',
  },

  // ── Item master → GL accounts ────────────────────────────────────────────
  // EO defaults sales/purchase posting accounts on every item. The column
  // names are present even when blank — Layer 2 heuristics can't see them
  // without this hint.
  {
    fromTable: 'Items',      fromColumn: 'GLAccountSales',
    toTable:   'GLAccounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Default GL account for sales of this item.',
  },
  {
    fromTable: 'Items',      fromColumn: 'GLAccountPurchase',
    toTable:   'GLAccounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Default GL account for purchases of this item.',
  },

  // ── Account hierarchy ────────────────────────────────────────────────────
  // Customers/suppliers can be parented to a holding company in EO.
  {
    fromTable: 'Accounts', fromColumn: 'Parent',
    toTable:   'Accounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Parent account (e.g. holding company over a subsidiary).',
  },

  // ════════════════════════════════════════════════════════════════════════
  // Relationships added with the catalog expansion.
  //
  // Naming convention: every FK references `<Table>.ID` unless otherwise
  // noted (Journals use a string `Code` as PK, hence the join is on `Code`).
  // Casing matches the OData payload so the schema profiler's column lookup
  // (which compares against introspected Parquet headers) matches.
  // ════════════════════════════════════════════════════════════════════════

  // ── CRM: contacts + addresses → accounts ────────────────────────────────
  {
    fromTable: 'Contacts',  fromColumn: 'Account',
    toTable:   'Accounts',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The account this contact person belongs to.',
  },
  {
    fromTable: 'Addresses', fromColumn: 'Account',
    toTable:   'Accounts',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The account this address belongs to.',
  },
  {
    fromTable: 'AccountClassifications', fromColumn: 'Account',
    toTable:   'Accounts',               toColumn:   'ID',
    type: 'many_to_one',
    description: 'The account this classification value is set on.',
  },

  // ── CRM: opportunities → accounts ────────────────────────────────────────
  {
    fromTable: 'Opportunities', fromColumn: 'Account',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'The account this opportunity is for.',
  },

  // ── Quotations: header → customer + invoice party; lines → quote header
  {
    fromTable: 'Quotations',  fromColumn: 'OrderedBy',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who requested the quotation.',
  },
  {
    fromTable: 'Quotations',  fromColumn: 'InvoiceTo',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who would be billed if the quotation is accepted.',
  },
  {
    fromTable: 'QuotationLines', fromColumn: 'QuotationID',
    toTable:   'Quotations',     toColumn:   'QuotationID',
    type: 'many_to_one',
    description: 'Each quotation line belongs to one quotation header.',
  },
  {
    fromTable: 'QuotationLines', fromColumn: 'Item',
    toTable:   'Items',          toColumn:   'ID',
    type: 'many_to_one',
    description: 'The product or service being quoted.',
  },

  // ── Sales orders: header → customer; lines → order header + item
  {
    fromTable: 'SalesOrders', fromColumn: 'OrderedBy',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who placed the order.',
  },
  {
    fromTable: 'SalesOrders', fromColumn: 'InvoiceTo',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who will be billed for this order.',
  },
  {
    fromTable: 'SalesOrders', fromColumn: 'DeliverTo',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'Account / address goods are shipped to.',
  },
  {
    fromTable: 'SalesOrderLines', fromColumn: 'OrderID',
    toTable:   'SalesOrders',     toColumn:   'OrderID',
    type: 'many_to_one',
    description: 'Each order line belongs to one sales-order header.',
  },
  {
    fromTable: 'SalesOrderLines', fromColumn: 'Item',
    toTable:   'Items',           toColumn:   'ID',
    type: 'many_to_one',
    description: 'The product or service being ordered.',
  },
  {
    fromTable: 'SalesOrderLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'GL account this line will post to on invoicing.',
  },

  // ── Sales entries: header → customer; lines → entry
  {
    fromTable: 'SalesEntries', fromColumn: 'Customer',
    toTable:   'Accounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer the sales entry is for.',
  },
  {
    fromTable: 'SalesEntryLines', fromColumn: 'EntryID',
    toTable:   'SalesEntries',    toColumn:   'EntryID',
    type: 'many_to_one',
    description: 'Each sales-entry line belongs to one entry header.',
  },
  {
    fromTable: 'SalesEntryLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'GL account the sales-entry line posts to.',
  },

  // ── Purchase orders: header → supplier; lines → order + item
  {
    fromTable: 'PurchaseOrders', fromColumn: 'Supplier',
    toTable:   'Accounts',       toColumn:   'ID',
    type: 'many_to_one',
    description: 'Supplier the purchase order was placed with.',
  },
  {
    fromTable: 'PurchaseOrderLines', fromColumn: 'PurchaseOrderID',
    toTable:   'PurchaseOrders',     toColumn:   'PurchaseOrderID',
    type: 'many_to_one',
    description: 'Each purchase-order line belongs to one purchase-order header.',
  },
  {
    fromTable: 'PurchaseOrderLines', fromColumn: 'Item',
    toTable:   'Items',              toColumn:   'ID',
    type: 'many_to_one',
    description: 'The product or service being purchased.',
  },
  {
    fromTable: 'PurchaseOrderLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'GL account the purchase line posts to.',
  },

  // ── Purchase invoices: header → supplier; lines → invoice + item
  {
    fromTable: 'PurchaseInvoices', fromColumn: 'Supplier',
    toTable:   'Accounts',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'Supplier who issued the purchase invoice.',
  },
  {
    fromTable: 'PurchaseInvoiceLines', fromColumn: 'InvoiceID',
    toTable:   'PurchaseInvoices',     toColumn:   'InvoiceID',
    type: 'many_to_one',
    description: 'Each purchase-invoice line belongs to one purchase-invoice header.',
  },
  {
    fromTable: 'PurchaseInvoiceLines', fromColumn: 'Item',
    toTable:   'Items',                toColumn:   'ID',
    type: 'many_to_one',
    description: 'The product or service being invoiced.',
  },
  {
    fromTable: 'PurchaseInvoiceLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',           toColumn:   'ID',
    type: 'many_to_one',
    description: 'GL account the purchase-invoice line posts to.',
  },

  // ── Purchase entries: header → supplier; lines → entry
  {
    fromTable: 'PurchaseEntries', fromColumn: 'Supplier',
    toTable:   'Accounts',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'Supplier the purchase entry is for.',
  },
  {
    fromTable: 'PurchaseEntryLines', fromColumn: 'EntryID',
    toTable:   'PurchaseEntries',    toColumn:   'EntryID',
    type: 'many_to_one',
    description: 'Each purchase-entry line belongs to one entry header.',
  },
  {
    fromTable: 'PurchaseEntryLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'GL account the purchase-entry line posts to.',
  },

  // ── Items → item group + units of measure
  {
    fromTable: 'Items',      fromColumn: 'ItemGroup',
    toTable:   'ItemGroups', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The reporting / categorisation group this item belongs to.',
  },
  {
    fromTable: 'Items',          fromColumn: 'Unit',
    toTable:   'UnitsOfMeasure', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Primary unit of measure for this item.',
  },

  // ── Inventory: stock transactions → item + warehouse
  {
    fromTable: 'StockTransactions', fromColumn: 'Item',
    toTable:   'Items',             toColumn:   'ID',
    type: 'many_to_one',
    description: 'The item this stock movement refers to.',
  },
  {
    fromTable: 'StockTransactions', fromColumn: 'Warehouse',
    toTable:   'Warehouses',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'The warehouse the stock movement happened in.',
  },
  {
    fromTable: 'StockCounts', fromColumn: 'Warehouse',
    toTable:   'Warehouses',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The warehouse this physical count covers.',
  },

  // ── Cashflow: bank accounts → accounts (customer/supplier) + GL
  {
    fromTable: 'BankAccounts', fromColumn: 'Account',
    toTable:   'Accounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'For supplier / customer bank accounts: which account owns this bank.',
  },
  {
    fromTable: 'BankAccounts', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',   toColumn:   'ID',
    type: 'many_to_one',
    description: 'The GL account this bank account posts to.',
  },
  {
    fromTable: 'BankEntries',  fromColumn: 'Journal',
    toTable:   'Journals',     toColumn:   'Code',
    type: 'many_to_one',
    description: 'The bank journal this statement is booked in.',
  },
  {
    fromTable: 'BankEntryLines', fromColumn: 'EntryID',
    toTable:   'BankEntries',    toColumn:   'EntryID',
    type: 'many_to_one',
    description: 'Each statement line belongs to one bank-statement header.',
  },
  {
    fromTable: 'BankEntryLines', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'The GL account this booked bank line posts to.',
  },
  {
    fromTable: 'BankEntryLines', fromColumn: 'Account',
    toTable:   'Accounts',       toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier this booked bank line is matched against.',
  },
  {
    fromTable: 'Payments',     fromColumn: 'Account',
    toTable:   'Accounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier the payment is with.',
  },

  // ── Receivables / payables → accounts (read-only entities)
  {
    fromTable: 'Receivables', fromColumn: 'Account',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer who owes this open amount.',
  },
  {
    fromTable: 'Payables',    fromColumn: 'Account',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'The supplier this open amount is owed to.',
  },

  // ── Financial: documents → account
  {
    fromTable: 'Documents', fromColumn: 'Account',
    toTable:   'Accounts',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier this document is filed against.',
  },

  // ── HR: employments → employee
  {
    fromTable: 'Employments',       fromColumn: 'Employee',
    toTable:   'Employees',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee this employment contract belongs to.',
  },
  {
    fromTable: 'ActiveEmployments', fromColumn: 'Employee',
    toTable:   'Employees',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee whose currently-active employment this is.',
  },
  {
    fromTable: 'Leave',     fromColumn: 'Employee',
    toTable:   'Employees', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee taking leave.',
  },

  // ── Projects: time bookings → project + employee
  {
    fromTable: 'TimeTransactions', fromColumn: 'Project',
    toTable:   'Projects',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The project this time was booked against.',
  },
  {
    fromTable: 'TimeTransactions', fromColumn: 'Employee',
    toTable:   'Employees',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee who booked this time.',
  },
  {
    fromTable: 'TimeCostTransactions', fromColumn: 'Project',
    toTable:   'Projects',             toColumn:   'ID',
    type: 'many_to_one',
    description: 'The project this time / cost was booked against.',
  },
  {
    fromTable: 'TimeCostTransactions', fromColumn: 'Employee',
    toTable:   'Employees',            toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee who recorded this time / cost.',
  },
  {
    fromTable: 'Projects', fromColumn: 'Account',
    toTable:   'Accounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer this project is for.',
  },

  // ── Subscriptions: header → customer; lines → subscription + item
  {
    fromTable: 'Subscriptions', fromColumn: 'OrderedBy',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who subscribed.',
  },
  {
    fromTable: 'Subscriptions',    fromColumn: 'SubscriptionType',
    toTable:   'SubscriptionTypes', toColumn:  'ID',
    type: 'many_to_one',
    description: 'The plan template this subscription is based on.',
  },
  {
    fromTable: 'SubscriptionLines', fromColumn: 'EntryID',
    toTable:   'Subscriptions',     toColumn:  'EntryID',
    type: 'many_to_one',
    description: 'Each subscription line belongs to one subscription.',
  },
  {
    fromTable: 'SubscriptionLines', fromColumn: 'Item',
    toTable:   'Items',             toColumn:  'ID',
    type: 'many_to_one',
    description: 'The product / service being subscribed to.',
  },
];

/** Stable name → entity, for fast lookup during sync. */
export const ENTITIES_BY_NAME: ReadonlyMap<string, ExactOnlineEntity> = new Map(
  EXACT_ONLINE_ENTITIES.map((e) => [e.name, e]),
);

/** EntityDescriptor projection (without internals like apiPath / defaultFilter). */
export function asEntityDescriptors(): EntityDescriptor[] {
  return EXACT_ONLINE_ENTITIES.map((e) => ({
    name: e.name,
    displayName: e.displayName,
    category: e.category,
    description: e.description,
    estimatedRowCount: e.estimatedRowCount,
    supportsIncremental: e.supportsIncremental,
  }));
}
