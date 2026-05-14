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
 *
 * No date filters by design. Earlier revisions had a 2025-01-01 cutoff on
 * high-volume entities to keep the spike's first sync manageable. The
 * product decision (May 2026) is to ingest ALL history — customers asking
 * "what did we sell to X 4 years ago" should get an answer. The trade-off
 * is that first sync of a long-lived ExactOnline division can be lengthy
 * (TransactionLines on an active 10-year-old division can run tens of
 * millions of rows). Acceptable for the value of complete history.
 */

import type { EntityDescriptor, KnownRelationship } from '../types';

export interface ExactOnlineEntity extends EntityDescriptor {
  /** Path relative to `/api/v1/{division}`, with leading slash. */
  apiPath: string;

  /**
   * Optional OData filter applied unconditionally. Currently UNUSED — the
   * catalog ships no date-based default filters (product decision: ingest
   * all history). Kept on the type for future per-entity overrides
   * (e.g. `IsActive eq true` on master tables, or volume guards on
   * specific entities only).
   */
  defaultFilter?: string;
}

/**
 * Most ExactOnline OData entities carry a `Modified` field (Edm.DateTime)
 * that monotonically tracks the last time a row was edited. This is the
 * canonical cursor field for incremental sync: a query like
 *   $filter=Modified gt datetime'2026-05-14T10:00:00'
 * returns only rows changed since the last sync. Combined with the
 * warehouse-writer's merge-by-key behaviour, this gives a correct
 * upsert flow even when EO doesn't expose deletes.
 *
 * A handful of entities don't have Modified (e.g. AgingReceivablesList,
 * read-only aggregates, classification *Names* dictionaries). For those
 * we leave `incrementalCursor` undefined and the platform runs a full
 * pull every sync — fine because they're small.
 */
const MODIFIED_CURSOR = { field: 'Modified', type: 'timestamp' } as const;

// ─── NOTE ON API PATHS ───────────────────────────────────────────────────────
// Every entry below has been cross-referenced against ExactOnline's REST API
// reference at https://start.exactonline.nl/docs/HlpRestAPIResources.aspx.
// Paths are stable across .nl/.be/.com/.de/.fr/.es/.co.uk/.us regions.
//
// Verified May 2026 against the live docs index. Any future entries should
// be confirmed the same way — drop the URL in a browser, search for the
// entity name, and use the exact category-segment shown.
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Contacts',
    displayName: 'Contacts',
    category: 'CRM',
    description: 'Individual contact persons. Each contact belongs to an account.',
    apiPath: '/crm/Contacts',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Addresses',
    displayName: 'Addresses',
    category: 'CRM',
    description: 'Postal addresses linked to accounts (billing, shipping, visit).',
    apiPath: '/crm/Addresses',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'AccountClassifications',
    displayName: 'Account classifications',
    category: 'CRM',
    description: 'Customer / supplier segmentation values (e.g. tier, vertical).',
    apiPath: '/crm/AccountClassifications',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'AccountClassificationNames',
    displayName: 'Account classification names',
    category: 'CRM',
    description: 'Labels for the up-to-8 classification slots configured per division.',
    apiPath: '/crm/AccountClassificationNames',
    // Dictionary table — small, ambiguous per-row PK. Full sync each run.
    supportsIncremental: false,
  },
  {
    name: 'Opportunities',
    displayName: 'Opportunities',
    category: 'CRM',
    description: 'Sales pipeline opportunities (active + won + lost).',
    apiPath: '/crm/Opportunities',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Quotations',
    displayName: 'Quotations',
    category: 'CRM',
    description: 'Sales quotations — pre-order pricing offers to customers.',
    apiPath: '/crm/Quotations',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'QuotationLines',
    displayName: 'Quotation lines',
    category: 'CRM',
    description: 'Line items on quotations.',
    apiPath: '/crm/QuotationLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'BankAccounts',
    displayName: 'Bank accounts',
    category: 'CRM',
    description:
      'Bank account definitions per customer/supplier (IBAN, BIC, etc.). Lives under /crm/ in the EO API.',
    apiPath: '/crm/BankAccounts',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SalesInvoiceLines',
    displayName: 'Sales invoice lines',
    category: 'Sales',
    description: 'Line items on sales invoices — what products / amounts.',
    apiPath: '/salesinvoice/SalesInvoiceLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SalesOrders',
    displayName: 'Sales orders',
    category: 'Sales',
    description: 'Sales order headers — customer purchase orders captured.',
    apiPath: '/salesorder/SalesOrders',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SalesOrderLines',
    displayName: 'Sales order lines',
    category: 'Sales',
    description: 'Line items on sales orders.',
    apiPath: '/salesorder/SalesOrderLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SalesEntries',
    displayName: 'Sales entries',
    category: 'Sales',
    description:
      'Light-weight sales journal entries — used by accountants who book sales as a journal entry rather than as a full invoice.',
    apiPath: '/salesentry/SalesEntries',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SalesEntryLines',
    displayName: 'Sales entry lines',
    category: 'Sales',
    description: 'Line items on sales journal entries.',
    apiPath: '/salesentry/SalesEntryLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'PurchaseOrderLines',
    displayName: 'Purchase order lines',
    category: 'Purchase',
    description: 'Line items on purchase orders.',
    apiPath: '/purchaseorder/PurchaseOrderLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'PurchaseInvoices',
    displayName: 'Purchase invoices',
    category: 'Purchase',
    description: 'Supplier invoices booked into purchase ledger.',
    apiPath: '/purchase/PurchaseInvoices',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'PurchaseInvoiceLines',
    displayName: 'Purchase invoice lines',
    category: 'Purchase',
    description: 'Line items on supplier invoices.',
    apiPath: '/purchase/PurchaseInvoiceLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'PurchaseEntries',
    displayName: 'Purchase entries',
    category: 'Purchase',
    description:
      'Light-weight purchase journal entries — used by accountants who book costs as a journal entry rather than as a full invoice.',
    apiPath: '/purchaseentry/PurchaseEntries',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'PurchaseEntryLines',
    displayName: 'Purchase entry lines',
    category: 'Purchase',
    description: 'Line items on purchase journal entries.',
    apiPath: '/purchaseentry/PurchaseEntryLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },

  // ════════════════════════════════════════════════════════════════════════
  // LOGISTICS — items, item groups, units
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Items',
    displayName: 'Items',
    category: 'Logistics',
    description: 'Article master data — what you sell or stock.',
    apiPath: '/logistics/Items',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'ItemGroups',
    displayName: 'Item groups',
    category: 'Logistics',
    description: 'Item categorisation — typically used for reporting groupings.',
    apiPath: '/logistics/ItemGroups',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Units',
    displayName: 'Units of measure',
    category: 'Logistics',
    description: 'Quantity units used on items (piece, kg, hour, …).',
    apiPath: '/logistics/Units',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SupplierItems',
    displayName: 'Supplier items',
    category: 'Logistics',
    description: 'Supplier-specific article codes and prices per item.',
    apiPath: '/logistics/SupplierItems',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },

  // ════════════════════════════════════════════════════════════════════════
  // INVENTORY — warehouses, stock counts, current stock levels, transfers
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Warehouses',
    displayName: 'Warehouses',
    category: 'Inventory',
    description: 'Physical or logical stock locations.',
    apiPath: '/inventory/Warehouses',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'ItemWarehouses',
    displayName: 'Item × warehouse stock',
    category: 'Inventory',
    description:
      'Current stock levels per item per warehouse — the snapshot table for "how many do we have right now."',
    apiPath: '/inventory/ItemWarehouses',
    // Snapshot semantics — current stock per row. Full-sync each run to
    // ensure we never serve stale levels from a partial incremental.
    supportsIncremental: false,
  },
  {
    name: 'StockCounts',
    displayName: 'Stock counts',
    category: 'Inventory',
    description: 'Physical inventory counts and reconciliations.',
    apiPath: '/inventory/StockCounts',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'StockCountLines',
    displayName: 'Stock count lines',
    category: 'Inventory',
    description: 'Per-item count detail for each stock count run.',
    apiPath: '/inventory/StockCountLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'WarehouseTransfers',
    displayName: 'Warehouse transfers',
    category: 'Inventory',
    description: 'Stock movement headers between warehouses.',
    apiPath: '/inventory/WarehouseTransfers',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'WarehouseTransferLines',
    displayName: 'Warehouse transfer lines',
    category: 'Inventory',
    description: 'Per-item detail on warehouse transfers.',
    apiPath: '/inventory/WarehouseTransferLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Journals',
    displayName: 'Journals',
    category: 'Financial',
    description: 'Journal definitions (sales, purchases, bank, memo, …).',
    apiPath: '/financial/Journals',
    // Journals use string `Code` as the natural PK rather than `ID`.
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'Code',
  },
  {
    name: 'GLClassifications',
    displayName: 'GL classifications',
    category: 'Financial',
    description: 'Classification hierarchy of GL accounts for financial reporting.',
    apiPath: '/financial/GLClassifications',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'TransactionLines',
    displayName: 'Transaction lines',
    category: 'Financial',
    description:
      'GL ledger detail — every booked accounting line. The largest table in a typical ExactOnline division. First sync of a 10-year-old active division can run tens of millions of rows; subsequent re-syncs only see changes if the connector supports it (not today — runs are full-table).',
    apiPath: '/financialtransaction/TransactionLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'FinancialPeriods',
    displayName: 'Financial periods',
    category: 'Financial',
    description: 'Open / closed accounting periods per fiscal year.',
    apiPath: '/financial/FinancialPeriods',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Documents',
    displayName: 'Documents',
    category: 'Financial',
    description:
      'Business documents (invoices, receipts, contracts) attached to accounts. High volume on active divisions but no built-in filter — full history ingested.',
    apiPath: '/documents/Documents',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },

  // ════════════════════════════════════════════════════════════════════════
  // CASHFLOW — bank entries, payments, receivables, payables, conditions
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Banks',
    displayName: 'Banks',
    category: 'Cashflow',
    description: 'Master list of banks recognised by the division.',
    apiPath: '/cashflow/Banks',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'BankEntries',
    displayName: 'Bank entries',
    category: 'Cashflow',
    description: 'Bank statement headers — one entry per statement / batch. Listed under /financialtransaction/ in the EO API.',
    apiPath: '/financialtransaction/BankEntries',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'BankEntryLines',
    displayName: 'Bank entry lines',
    category: 'Cashflow',
    description: 'Individual lines on bank statements — each booked transaction.',
    apiPath: '/financialtransaction/BankEntryLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Payments',
    displayName: 'Payments',
    category: 'Cashflow',
    description: 'Outgoing and incoming payments — useful for AR / AP analysis.',
    apiPath: '/cashflow/Payments',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Receivables',
    displayName: 'Receivables',
    category: 'Cashflow',
    description: 'Open receivable items — what customers still owe.',
    apiPath: '/cashflow/Receivables',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'ReceivablesList',
    displayName: 'Receivables list (aging)',
    category: 'Cashflow',
    description:
      'Aging view of open receivables — read-only, denormalised for reporting. Pairs with Receivables for cash-flow dashboards.',
    apiPath: '/read/financial/ReceivablesList',
    // Read-only aggregate. No stable per-row Modified to filter on.
    supportsIncremental: false,
  },
  {
    name: 'PayablesList',
    displayName: 'Payables list (aging)',
    category: 'Cashflow',
    description:
      'Aging view of open payables — what you owe suppliers. Read-only endpoint; there is no direct /cashflow/Payables collection in the EO API.',
    apiPath: '/read/financial/PayablesList',
    // Read-only aggregate. Same rationale as ReceivablesList.
    supportsIncremental: false,
  },
  {
    name: 'AgingReceivablesList',
    displayName: 'Aging — receivables',
    category: 'Cashflow',
    description: 'Bucketed aging of open receivables (0-30 / 31-60 / …).',
    apiPath: '/read/financial/AgingReceivablesList',
    // Bucketed aggregate — recomputed every sync, no merge semantics.
    supportsIncremental: false,
  },
  {
    name: 'AgingPayablesList',
    displayName: 'Aging — payables',
    category: 'Cashflow',
    description: 'Bucketed aging of open payables.',
    apiPath: '/read/financial/AgingPayablesList',
    // Bucketed aggregate.
    supportsIncremental: false,
  },
  {
    name: 'PaymentConditions',
    displayName: 'Payment conditions',
    category: 'Cashflow',
    description: 'Standard payment terms (net 30, end-of-month, …).',
    apiPath: '/cashflow/PaymentConditions',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },

  // ════════════════════════════════════════════════════════════════════════
  // HRM / PAYROLL — employees, employments, leave
  //
  // Note: Employees + employment contracts all live under /payroll/ in EO's
  // API, not /hrm/. Leave registrations are under /hrm/.
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Employees',
    displayName: 'Employees',
    category: 'HRM',
    description: 'Employee master data.',
    apiPath: '/payroll/Employees',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'Employments',
    displayName: 'Employments',
    category: 'HRM',
    description: 'Employment contracts — each employee may have multiple over time.',
    apiPath: '/payroll/Employments',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'ActiveEmployments',
    displayName: 'Active employments',
    category: 'HRM',
    description: 'Currently-active employment contracts only.',
    apiPath: '/payroll/ActiveEmployments',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'EmploymentContracts',
    displayName: 'Employment contracts',
    category: 'HRM',
    description: 'Contract terms (FTE, contract type, start/end) per employment.',
    apiPath: '/payroll/EmploymentContracts',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'EmploymentSalaries',
    displayName: 'Employment salaries',
    category: 'HRM',
    description: 'Salary detail per employment.',
    apiPath: '/payroll/EmploymentSalaries',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'EmploymentOrganizations',
    displayName: 'Employment organizations',
    category: 'HRM',
    description: 'Org-unit assignment per employment.',
    apiPath: '/payroll/EmploymentOrganizations',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'LeaveRegistrations',
    displayName: 'Leave registrations',
    category: 'HRM',
    description: 'Leave / vacation records per employee.',
    apiPath: '/hrm/LeaveRegistrations',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'TimeTransactions',
    displayName: 'Time transactions',
    category: 'Project',
    description: 'Time bookings against projects — hours per employee per task.',
    apiPath: '/project/TimeTransactions',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'TimeCostTransactions',
    displayName: 'Time + cost transactions',
    category: 'Project',
    description: 'Combined time + cost transactions across projects.',
    apiPath: '/project/TimeCostTransactions',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
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
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SubscriptionLines',
    displayName: 'Subscription lines',
    category: 'Subscription',
    description: 'Line items on subscriptions — individual subscribed products.',
    apiPath: '/subscription/SubscriptionLines',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
  {
    name: 'SubscriptionTypes',
    displayName: 'Subscription types',
    category: 'Subscription',
    description: 'Subscription plan templates.',
    apiPath: '/subscription/SubscriptionTypes',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },

  // ════════════════════════════════════════════════════════════════════════
  // SYSTEM — division metadata
  // ════════════════════════════════════════════════════════════════════════
  {
    name: 'Divisions',
    displayName: 'Divisions',
    category: 'System',
    description: 'The administrations / legal entities visible to this OAuth app.',
    apiPath: '/system/Divisions',
    supportsIncremental: true,
    incrementalCursor: MODIFIED_CURSOR,
    businessKey: 'ID',
  },
];

/**
 * Documented relationships between ExactOnline entities.
 *
 * Sourced from ExactOnline's REST API reference + the schema produced by
 * tap-exact-online (TicketSwap, MIT). Limited to the entities we ship today;
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
  {
    fromTable: 'Accounts', fromColumn: 'Parent',
    toTable:   'Accounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Parent account (e.g. holding company over a subsidiary).',
  },

  // ════════════════════════════════════════════════════════════════════════
  // Relationships for the expanded catalog (May 2026).
  // Verified entity names match the apiPath above (Units, not UnitsOfMeasure;
  // LeaveRegistrations, not Leave; etc.).
  // ════════════════════════════════════════════════════════════════════════

  // ── CRM: contacts + addresses + classifications → accounts ──────────────
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
  {
    fromTable: 'BankAccounts', fromColumn: 'Account',
    toTable:   'Accounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier this bank account belongs to.',
  },
  {
    fromTable: 'BankAccounts', fromColumn: 'GLAccount',
    toTable:   'GLAccounts',   toColumn:   'ID',
    type: 'many_to_one',
    description: 'The GL account this bank account posts to.',
  },

  // ── Opportunities → account ─────────────────────────────────────────────
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

  // ── Items → item group + units + supplier items
  {
    fromTable: 'Items',      fromColumn: 'ItemGroup',
    toTable:   'ItemGroups', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The reporting / categorisation group this item belongs to.',
  },
  {
    fromTable: 'Items', fromColumn: 'Unit',
    toTable:   'Units', toColumn:   'ID',
    type: 'many_to_one',
    description: 'Primary unit of measure for this item.',
  },
  {
    fromTable: 'SupplierItems', fromColumn: 'Item',
    toTable:   'Items',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The item this supplier code refers to.',
  },
  {
    fromTable: 'SupplierItems', fromColumn: 'Supplier',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'The supplier whose code is being mapped.',
  },

  // ── Inventory: ItemWarehouses + stock counts + transfers
  {
    fromTable: 'ItemWarehouses', fromColumn: 'Item',
    toTable:   'Items',          toColumn:   'ID',
    type: 'many_to_one',
    description: 'The item this stock-level row is for.',
  },
  {
    fromTable: 'ItemWarehouses', fromColumn: 'Warehouse',
    toTable:   'Warehouses',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'The warehouse holding this stock.',
  },
  {
    fromTable: 'StockCounts', fromColumn: 'Warehouse',
    toTable:   'Warehouses',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The warehouse this physical count covers.',
  },
  {
    fromTable: 'StockCountLines', fromColumn: 'StockCountID',
    toTable:   'StockCounts',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'Each count line belongs to one stock-count header.',
  },
  {
    fromTable: 'StockCountLines', fromColumn: 'Item',
    toTable:   'Items',           toColumn:   'ID',
    type: 'many_to_one',
    description: 'The item being counted on this line.',
  },
  {
    fromTable: 'WarehouseTransferLines', fromColumn: 'WarehouseTransferID',
    toTable:   'WarehouseTransfers',     toColumn:   'ID',
    type: 'many_to_one',
    description: 'Each transfer line belongs to one transfer header.',
  },
  {
    fromTable: 'WarehouseTransferLines', fromColumn: 'Item',
    toTable:   'Items',                  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The item being moved on this transfer line.',
  },
  {
    fromTable: 'WarehouseTransfers', fromColumn: 'WarehouseFrom',
    toTable:   'Warehouses',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'Warehouse the stock is moving out of.',
  },
  {
    fromTable: 'WarehouseTransfers', fromColumn: 'WarehouseTo',
    toTable:   'Warehouses',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'Warehouse the stock is moving into.',
  },

  // ── Cashflow: bank entries / payments / receivables / payables
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
    fromTable: 'Payments', fromColumn: 'Account',
    toTable:   'Accounts', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier the payment is with.',
  },
  {
    fromTable: 'Receivables', fromColumn: 'Account',
    toTable:   'Accounts',    toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer who owes this open amount.',
  },
  {
    fromTable: 'ReceivablesList', fromColumn: 'AccountId',
    toTable:   'Accounts',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who owes this open amount (aging view).',
  },
  {
    fromTable: 'PayablesList',    fromColumn: 'AccountId',
    toTable:   'Accounts',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'Supplier this open amount is owed to (aging view).',
  },

  // ── Financial: documents → account
  {
    fromTable: 'Documents', fromColumn: 'Account',
    toTable:   'Accounts',  toColumn:   'ID',
    type: 'many_to_one',
    description: 'The customer / supplier this document is filed against.',
  },

  // ── HR / Payroll
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
    fromTable: 'EmploymentContracts', fromColumn: 'Employment',
    toTable:   'Employments',         toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employment this contract terms record is for.',
  },
  {
    fromTable: 'EmploymentSalaries', fromColumn: 'Employment',
    toTable:   'Employments',        toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employment this salary detail is for.',
  },
  {
    fromTable: 'EmploymentOrganizations', fromColumn: 'Employee',
    toTable:   'Employees',               toColumn:   'ID',
    type: 'many_to_one',
    description: 'The employee assigned to this organisation unit.',
  },
  {
    fromTable: 'LeaveRegistrations', fromColumn: 'Employee',
    toTable:   'Employees',          toColumn:   'ID',
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

  // ── Subscriptions: header → customer + plan; lines → subscription + item
  {
    fromTable: 'Subscriptions', fromColumn: 'OrderedBy',
    toTable:   'Accounts',      toColumn:   'ID',
    type: 'many_to_one',
    description: 'Customer who subscribed.',
  },
  {
    fromTable: 'Subscriptions',     fromColumn: 'SubscriptionType',
    toTable:   'SubscriptionTypes', toColumn:   'ID',
    type: 'many_to_one',
    description: 'The plan template this subscription is based on.',
  },
  {
    fromTable: 'SubscriptionLines', fromColumn: 'EntryID',
    toTable:   'Subscriptions',     toColumn:   'EntryID',
    type: 'many_to_one',
    description: 'Each subscription line belongs to one subscription.',
  },
  {
    fromTable: 'SubscriptionLines', fromColumn: 'Item',
    toTable:   'Items',             toColumn:   'ID',
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
