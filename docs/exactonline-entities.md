# ExactOnline entity catalog

Reference for the entities the Clarion connector exposes for ingestion.
Users pick a subset during the connection wizard
(`POST /api/source-types/exactonline/list-entities` returns the
catalog; the user's choice is persisted in `connections.selected_entities`).

The catalog is **curated**, not dynamic — every entry maps a stable
name to a specific REST API path. All paths verified May 2026 against
ExactOnline's official REST API reference
(<https://start.exactonline.nl/docs/HlpRestAPIResources.aspx>). Adding
entries is a one-file change to
`packages/connectors/src/exactonline/entities.ts`.

## Volume policy: full history, no date filter

Earlier revisions applied a 2025-01-01 cutoff on transactional entities
to keep first-sync volumes tractable. **Product decision (May 2026): no
date filter.** Customers asking "what did we sell to X in 2018?" should
get an answer. The trade-offs:

- First sync of a 10-year-old active division can run **tens of millions
  of rows on `TransactionLines`**. Expect long durations on the first sync
  — minutes to a few hours depending on division size.
- `Documents`, `BankEntryLines`, `SalesInvoiceLines`,
  `PurchaseInvoiceLines`, `TimeTransactions` are also high-volume.
- Storage cost scales linearly with rows ingested.
- Re-syncs today are full-table (no incremental). The TODO to add
  incremental sync is on the connector roadmap; until then, every sync
  re-pulls the whole history.

If a customer wants to skip ancient history, the safest workaround today
is to **not enable** the heaviest entities (`TransactionLines`,
`Documents`) until the rest of the data is curated, then turn them on.
A per-connection `defaultFilter` override is a future enhancement.

## Catalog (verified May 2026, 55+ entities across 11 categories)

### CRM (9)
| Name | Path |
|---|---|
| Accounts | `/crm/Accounts` |
| Contacts | `/crm/Contacts` |
| Addresses | `/crm/Addresses` |
| AccountClassifications | `/crm/AccountClassifications` |
| AccountClassificationNames | `/crm/AccountClassificationNames` |
| Opportunities | `/crm/Opportunities` |
| Quotations | `/crm/Quotations` |
| QuotationLines | `/crm/QuotationLines` |
| BankAccounts | `/crm/BankAccounts` |

### Sales (6)
| Name | Path |
|---|---|
| SalesInvoices | `/salesinvoice/SalesInvoices` |
| SalesInvoiceLines | `/salesinvoice/SalesInvoiceLines` |
| SalesOrders | `/salesorder/SalesOrders` |
| SalesOrderLines | `/salesorder/SalesOrderLines` |
| SalesEntries | `/salesentry/SalesEntries` |
| SalesEntryLines | `/salesentry/SalesEntryLines` |

### Purchase (6)
| Name | Path |
|---|---|
| PurchaseOrders | `/purchaseorder/PurchaseOrders` |
| PurchaseOrderLines | `/purchaseorder/PurchaseOrderLines` |
| PurchaseInvoices | `/purchase/PurchaseInvoices` |
| PurchaseInvoiceLines | `/purchase/PurchaseInvoiceLines` |
| PurchaseEntries | `/purchaseentry/PurchaseEntries` |
| PurchaseEntryLines | `/purchaseentry/PurchaseEntryLines` |

### Logistics (4)
| Name | Path |
|---|---|
| Items | `/logistics/Items` |
| ItemGroups | `/logistics/ItemGroups` |
| Units | `/logistics/Units` |
| SupplierItems | `/logistics/SupplierItems` |

### Inventory (6)
| Name | Path |
|---|---|
| Warehouses | `/inventory/Warehouses` |
| ItemWarehouses | `/inventory/ItemWarehouses` |
| StockCounts | `/inventory/StockCounts` |
| StockCountLines | `/inventory/StockCountLines` |
| WarehouseTransfers | `/inventory/WarehouseTransfers` |
| WarehouseTransferLines | `/inventory/WarehouseTransferLines` |

### Financial (6)
| Name | Path |
|---|---|
| GLAccounts | `/financial/GLAccounts` |
| Journals | `/financial/Journals` |
| GLClassifications | `/financial/GLClassifications` |
| TransactionLines | `/financialtransaction/TransactionLines` |
| FinancialPeriods | `/financial/FinancialPeriods` |
| Documents | `/documents/Documents` |

### Cashflow (9)
| Name | Path |
|---|---|
| Banks | `/cashflow/Banks` |
| BankEntries | `/financialtransaction/BankEntries` |
| BankEntryLines | `/financialtransaction/BankEntryLines` |
| Payments | `/cashflow/Payments` |
| Receivables | `/cashflow/Receivables` |
| ReceivablesList | `/read/financial/ReceivablesList` |
| PayablesList | `/read/financial/PayablesList` |
| AgingReceivablesList | `/read/financial/AgingReceivablesList` |
| AgingPayablesList | `/read/financial/AgingPayablesList` |
| PaymentConditions | `/cashflow/PaymentConditions` |

### HRM / Payroll (7)
Employees and contract data live under `/payroll/` in the EO API.
Leave registrations live under `/hrm/`.

| Name | Path |
|---|---|
| Employees | `/payroll/Employees` |
| Employments | `/payroll/Employments` |
| ActiveEmployments | `/payroll/ActiveEmployments` |
| EmploymentContracts | `/payroll/EmploymentContracts` |
| EmploymentSalaries | `/payroll/EmploymentSalaries` |
| EmploymentOrganizations | `/payroll/EmploymentOrganizations` |
| LeaveRegistrations | `/hrm/LeaveRegistrations` |

### Project (3)
| Name | Path |
|---|---|
| Projects | `/project/Projects` |
| TimeTransactions | `/project/TimeTransactions` |
| TimeCostTransactions | `/project/TimeCostTransactions` |

### Subscription (3)
| Name | Path |
|---|---|
| Subscriptions | `/subscription/Subscriptions` |
| SubscriptionLines | `/subscription/SubscriptionLines` |
| SubscriptionTypes | `/subscription/SubscriptionTypes` |

### System (1)
| Name | Path |
|---|---|
| Divisions | `/system/Divisions` |

## What was removed and why

Three entities from the previous revision were dropped because they don't
exist as separate endpoints in ExactOnline's API:

- **`StockTransactions`** — not a real endpoint. EO doesn't expose a
  generic stock-transaction log over REST; movement reporting is built
  from `WarehouseTransfers` + `WarehouseTransferLines` and from booked
  ledger lines that touch stock GL accounts. Replaced with
  `ItemWarehouses` (current stock per item per warehouse — far more
  commonly wanted) and the warehouse-transfer pair.
- **`Payables`** — no direct collection endpoint. Replaced with
  `PayablesList` (`/read/financial/PayablesList`, read-only aging view)
  and `AgingPayablesList`.
- **`Users`** — no standalone Users endpoint, only role-management
  resources. Removed.

## Volume guidance for the demo

For a typical Belgian SMB starter set covering full operations:

- **Always pick:** Accounts, Items, GLAccounts, Journals — the master
  tables that drive everything else
- **For sales analytics:** SalesInvoices, SalesInvoiceLines, SalesOrders,
  SalesOrderLines
- **For purchase analytics:** PurchaseInvoices, PurchaseInvoiceLines
- **For finance / accounting:** TransactionLines (HEAVY — be patient on
  first sync), GLClassifications, FinancialPeriods
- **For cash / treasury:** BankEntries, BankEntryLines, Payments,
  Receivables, PayablesList
- **For inventory:** ItemWarehouses, Warehouses, StockCounts (light)
- **Optional, only if relevant:** the HR / payroll set, the project set,
  the subscription set

## Known relationships

Beyond entity selection, the connector ships a curated list of
foreign-key relationships
(`EXACT_ONLINE_KNOWN_RELATIONSHIPS` in `entities.ts`). The schema profiler
uses them to generate accurate table descriptions and to feed the
AI-dashboard prompts.

The expanded catalog declares ~55 relationships covering:

- Every header-to-line join (invoice / order / entry / quotation /
  subscription / transfer / stock-count)
- Account-role FKs on every transactional header (InvoiceTo / OrderedBy /
  DeliverTo / Supplier / Customer)
- GL posting paths from every line type back to GLAccounts
- Item → group, item → unit of measure
- Project → customer, time / cost → project + employee
- Employment / contract / salary → employee
- Stock movements → item + warehouse
- Aging views → account (customer / supplier)

The connector's `getKnownRelationships()` filters this list against the
user's `selected_entities` so a relationship pointing at an unsynced
entity is dropped before being sent to the profiler.

## Cross-tenant safety

The expansion is data-only. The ingestion pipeline that handles the
original 8 entities handles these the same way:

- OAuth credentials are encrypted with AES-256-GCM at rest.
- Sync runs in an **isolated container** with only this one tenant's
  credentials in env, egress restricted to ExactOnline domains, and
  write access only to its own warehouse path (`tenant_<N>/conn_<N>`).
- Every database touch around the connection carries an explicit
  `tenant_id` filter as well as RLS enforcement.

Nothing about the expanded entity list changes the security boundary —
the same tenant-isolation guarantees apply to whatever entities the
customer selects.
