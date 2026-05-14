# ExactOnline entity catalog

Reference for the entities the Clarion connector exposes for ingestion.
Users pick a subset of these during the connection wizard
(`POST /api/source-types/exactonline/list-entities` returns the
filtered catalog; the user's choice is persisted in
`connections.selected_entities`).

The catalog is **curated**, not dynamic — every entry maps a stable
name to a specific REST API path. Adding entries is a one-file change
to `packages/connectors/src/exactonline/entities.ts`. Dynamic discovery
from `$metadata` is a future enhancement; the curated catalog gives
us coverage without the XML-parsing complexity.

## How to use this doc

- **Choosing entities during a demo / pilot:** start with the
  Tier-1 minimum below, add Tier-2 as the customer's domain calls
  for it.
- **Adding new entities:** drop a new entry in `entities.ts` following
  the same shape; the wizard renders it automatically via
  `listEntities()`. If the entity is high-volume (transactional, time-
  series), add a `defaultFilter` clause (see the existing
  `TXN_LINES_DEFAULT_FILTER` pattern).
- **API path verification:** entries marked **`// VERIFY`** in the
  source file are best-guess paths based on ExactOnline's category-
  segment convention. Before going to production on any of those,
  hit the URL once with Postman against a live division and a valid
  bearer token. If the path is wrong, EO returns 404 with a clear
  message; correct it in one place.

## Volume guidance

The `defaultFilter` column shows the OData filter applied automatically
to keep first-sync volumes tractable. For a typical Belgian SMB the
2025-01-01 cutoff captures the active fiscal year plus a comparable
prior period — enough for trend analysis without pulling millions of
historical rows. Customers needing deeper history can override the
filter per-connection in a follow-up enhancement.

## Catalog (Tier 1 — the SMB starter pack)

These are the entities most SMB demos use day one. They give you full
sales + purchase + financial + master-data coverage and are enough to
build the first dashboards.

| Name | Category | What it contains | Volume hint |
|---|---|---|---|
| `Accounts` | CRM | Customers, suppliers, prospects — the master account list | Low (hundreds to low thousands) |
| `Contacts` | CRM | Individual contact persons linked to accounts | Low to medium |
| `Items` | Logistics | Article master data | Low to medium |
| `SalesInvoices` | Sales | Sales invoice headers | Medium, date-filtered |
| `SalesInvoiceLines` | Sales | Line items on sales invoices | Medium-high, follows invoices |
| `SalesOrders` | Sales | Sales order headers (before invoicing) | Medium, date-filtered |
| `SalesOrderLines` | Sales | Line items on sales orders | Medium-high, follows orders |
| `PurchaseInvoices` | Purchase | Supplier invoices | Medium, date-filtered |
| `PurchaseInvoiceLines` | Purchase | Line items on supplier invoices | Medium-high |
| `GLAccounts` | Financial | Chart of accounts | Low (hundreds) |
| `Journals` | Financial | Journal definitions | Very low |
| `GLClassifications` | Financial | Classification hierarchy of GL accounts | Low |
| `TransactionLines` | Financial | GL ledger detail | **HIGH** — date-filtered to 2025+ |
| `BankAccounts` | Cashflow | Bank account definitions | Very low |
| `PaymentConditions` | Cashflow | Payment terms catalogue | Very low |

## Catalog (Tier 2 — domain-specific)

Add these when the customer's domain calls for them.

| Name | Category | When useful |
|---|---|---|
| `Addresses` | CRM | When shipping addresses matter (wholesale, logistics) |
| `AccountClassifications` / `AccountClassificationNames` | CRM | When customers segment by tier / vertical / industry |
| `Opportunities` | CRM | Sales pipeline reporting |
| `Quotations` / `QuotationLines` | CRM | When pre-order quoting is part of the sales flow |
| `SalesEntries` / `SalesEntryLines` | Sales | Accountancy firms — sales booked as journal entries instead of invoices |
| `PurchaseOrders` / `PurchaseOrderLines` | Purchase | Procurement workflow reporting |
| `PurchaseEntries` / `PurchaseEntryLines` | Purchase | Accountancy firms — costs booked as journal entries |
| `ItemGroups` | Logistics | Reporting grouped by product category |
| `Warehouses` / `UnitsOfMeasure` | Logistics | Multi-warehouse + multi-unit inventory |
| `StockTransactions` / `StockCounts` | Inventory | Inventory analytics (high volume — date-filtered) |
| `Documents` | Financial | Document tracking attached to accounts |
| `FinancialPeriods` | Financial | Period-aware reporting |
| `BankEntries` / `BankEntryLines` | Cashflow | Cash-flow / treasury analysis |
| `Payments` | Cashflow | AR / AP analytics |
| `Receivables` / `Payables` | Cashflow | Open-items aging |
| `Employees` / `Employments` / `ActiveEmployments` | HRM | Payroll-adjacent analytics, headcount, contracts |
| `Leave` | HRM | Absence reporting |
| `Projects` / `TimeTransactions` / `TimeCostTransactions` | Project | Services firms with project-based billing |
| `Subscriptions` / `SubscriptionLines` / `SubscriptionTypes` | Subscription | Recurring-revenue businesses |
| `Divisions` / `Users` | System | Multi-administration reporting; user activity |

## Known relationships

Beyond entity selection, the connector ships a curated list of
foreign-key relationships between entities
(`EXACT_ONLINE_KNOWN_RELATIONSHIPS` in `entities.ts`). These are fed
to the schema profiler so AI-generated table descriptions and
dashboards know that, for example, `SalesInvoices.InvoiceTo` joins to
`Accounts.ID`.

Adding a new entity? Add its relationships to the same array. The
profiler filters this list against what the user actually selected, so
relationships pointing at unsynced entities drop out cleanly.

Currently the catalog declares ~45 relationships covering header-to-
line joins, account roles (invoice-to / ordered-by / deliver-to), GL
posting paths, item-to-group joins, project / employee links, and
subscription / item linkage. Demo against EpicData uses the existing
~14 relationships from the original 7-entity catalog; the rest become
active only as the corresponding entities are enabled.

## Cross-tenant safety

The expansion is data-only — the ingestion pipeline that already
handles the original 7 entities handles these the same way:

- OAuth credentials are encrypted with AES-256-GCM at rest.
- Sync runs in an **isolated container** with only this one tenant's
  credentials in env, egress restricted to ExactOnline domains, and
  write access only to its own warehouse path (`tenant_<N>/conn_<N>`).
- Every database touch around the connection (state token lookup,
  trigger sync, credential rotation persist) carries an explicit
  `tenant_id` filter as well as RLS enforcement.

Nothing about the expanded entity list changes the security boundary —
the same tenant-isolation guarantees apply to whatever entities the
customer selects.
