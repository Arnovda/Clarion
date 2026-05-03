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
 * A canonical default for `TransactionLines` — the GL ledger. Without a
 * filter this can be tens of millions of rows on a real division. Keep
 * the spike scope to recent activity.
 */
const TXN_LINES_DEFAULT_FILTER = `Date gt datetime'2025-01-01T00:00:00'`;

export const EXACT_ONLINE_ENTITIES: readonly ExactOnlineEntity[] = [
  // ── Master data / CRM ──────────────────────────────────────────────────
  {
    name: 'Accounts',
    displayName: 'Accounts',
    category: 'CRM',
    description: 'Customers, suppliers, prospects.',
    apiPath: '/crm/Accounts',
    supportsIncremental: false,
  },
  {
    name: 'Items',
    displayName: 'Items',
    category: 'Logistics',
    description: 'Article master data.',
    apiPath: '/logistics/Items',
    supportsIncremental: false,
  },

  // ── Sales ──────────────────────────────────────────────────────────────
  {
    name: 'SalesInvoices',
    displayName: 'Sales invoices',
    category: 'Sales',
    description: 'Sales invoice headers.',
    apiPath: '/salesinvoice/SalesInvoices',
    supportsIncremental: false,
  },
  {
    name: 'SalesInvoiceLines',
    displayName: 'Sales invoice lines',
    category: 'Sales',
    description: 'Line items for sales invoices.',
    apiPath: '/salesinvoice/SalesInvoiceLines',
    supportsIncremental: false,
  },

  // ── Financial / GL ─────────────────────────────────────────────────────
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
    description: 'Journal definitions (sales, purchases, bank, etc.).',
    apiPath: '/financial/Journals',
    supportsIncremental: false,
  },
  {
    name: 'GLClassifications',
    displayName: 'GL classifications',
    category: 'Financial',
    description: 'Classification of GL accounts for financial reporting.',
    apiPath: '/financial/GLClassifications',
    supportsIncremental: false,
  },
  {
    name: 'TransactionLines',
    displayName: 'Transaction lines',
    category: 'Financial',
    description:
      'GL ledger detail. Defaulted to FY2025-onwards to keep volume tractable for the spike — adjust when needed.',
    apiPath: '/financialtransaction/TransactionLines',
    defaultFilter: TXN_LINES_DEFAULT_FILTER,
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
