-- ---------------------------------------------------------------------------
-- Clarion SQL-connector load test — schema
--
-- A synthetic mid-size ERP slice: 17 tables, ~14M rows, 10M of them in the
-- sales fact. It is shaped to exercise the behaviour the Postgres / MySQL /
-- SQL Server connectors DECLARE, not just to be big. Every quirk below is
-- deliberate and has an expected reading in 03-verify.sql:
--
--   • every table but three has a single-column bigint PRIMARY KEY
--       -> business key at the `declared` rung, keyset paging, merge-by-key
--   • most carry `updated_at` NOT NULL
--       -> incremental sync
--   • `inventory_movements` has only `created_at`
--       -> MUST sync in full; a creation stamp never moves on update
--   • `price_list_entries.updated_at` is NULLABLE
--       -> MUST sync in full; `>= x` never matches a NULL
--   • `order_line_tags` has a COMPOSITE primary key
--       -> no business key, no cursor, OFFSET paging, and a warning
--   • `customer_documents.file_blob` is bytea
--       -> excluded from the sync and REPORTED, never silently dropped
--   • `legacy_metrics` carries bit / jsonb / uuid / text[] and a column
--     literally called "Order Date"
--       -> everything unrecognised lands as VARCHAR; the space becomes `_`
--   • about half the tables carry COMMENTs
--       -> those descriptions are Tier 1; the rest are left for the AI pass
--
-- Run against an EMPTY database. Creates schema `erp`.
-- ---------------------------------------------------------------------------

DROP SCHEMA IF EXISTS erp CASCADE;
CREATE SCHEMA erp;
SET search_path TO erp;

-- ── Lookups ────────────────────────────────────────────────────────────────

CREATE TABLE countries (
  country_id   bigint PRIMARY KEY,
  iso_code     varchar(2)  NOT NULL,
  country_name varchar(80) NOT NULL,
  region_name  varchar(40) NOT NULL,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

CREATE TABLE currencies (
  currency_id bigint PRIMARY KEY,
  code        varchar(3)  NOT NULL,
  name        varchar(40) NOT NULL,
  symbol      varchar(4),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE payment_terms (
  payment_term_id bigint PRIMARY KEY,
  code            varchar(16) NOT NULL,
  description     varchar(80) NOT NULL,
  days_net        integer     NOT NULL,
  discount_pct    numeric(5,4),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

CREATE TABLE regions (
  region_id  bigint PRIMARY KEY,
  code       varchar(8)  NOT NULL,
  name       varchar(60) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE product_categories (
  category_id        bigint PRIMARY KEY,
  name               varchar(60) NOT NULL,
  parent_category_id bigint REFERENCES product_categories(category_id),
  created_at         timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL
);

CREATE TABLE suppliers (
  supplier_id bigint PRIMARY KEY,
  name        varchar(120) NOT NULL,
  country_id  bigint NOT NULL REFERENCES countries(country_id),
  vat_number  varchar(20),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE sales_reps (
  rep_id         bigint PRIMARY KEY,
  full_name      varchar(120) NOT NULL,
  region_id      bigint NOT NULL REFERENCES regions(region_id),
  hire_date      date NOT NULL,
  commission_pct numeric(5,4) NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);

CREATE TABLE stores (
  store_id   bigint PRIMARY KEY,
  code       varchar(12) NOT NULL,
  name       varchar(80) NOT NULL,
  region_id  bigint NOT NULL REFERENCES regions(region_id),
  country_id bigint NOT NULL REFERENCES countries(country_id),
  opened_on  date,
  floor_m2   double precision,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE products (
  product_id  bigint PRIMARY KEY,
  sku         varchar(24)  NOT NULL,
  name        varchar(140) NOT NULL,
  category_id bigint NOT NULL REFERENCES product_categories(category_id),
  supplier_id bigint NOT NULL REFERENCES suppliers(supplier_id),
  unit_cost   numeric(18,4) NOT NULL,
  list_price  numeric(18,4) NOT NULL,
  weight_kg   double precision,
  is_active   boolean NOT NULL DEFAULT true,
  barcode     varchar(32),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

CREATE TABLE customers (
  customer_id     bigint PRIMARY KEY,
  customer_code   varchar(16)  NOT NULL,
  company_name    varchar(140) NOT NULL,
  country_id      bigint NOT NULL REFERENCES countries(country_id),
  payment_term_id bigint NOT NULL REFERENCES payment_terms(payment_term_id),
  rep_id          bigint REFERENCES sales_reps(rep_id),
  vat_number      varchar(20),
  email           varchar(120),
  credit_limit    money,                      -- localised on read -> VARCHAR
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- ── Facts (created bare; keys and indexes are added after the load) ─────────

CREATE TABLE sales_orders (
  order_id        bigint       NOT NULL,
  order_number    varchar(24)  NOT NULL,
  customer_id     bigint       NOT NULL,
  rep_id          bigint,
  store_id        bigint       NOT NULL,
  currency_id     bigint       NOT NULL,
  payment_term_id bigint       NOT NULL,
  order_date      date         NOT NULL,
  status          varchar(16)  NOT NULL,
  order_total     numeric(18,4) NOT NULL,
  created_at      timestamptz  NOT NULL,
  updated_at      timestamptz  NOT NULL
);

CREATE TABLE sales_order_lines (
  order_line_id bigint        NOT NULL,
  order_id      bigint        NOT NULL,
  product_id    bigint        NOT NULL,
  line_number   integer       NOT NULL,
  quantity      numeric(12,3) NOT NULL,
  unit_price    numeric(18,4) NOT NULL,
  discount_pct  numeric(5,4)  NOT NULL,
  line_amount   numeric(18,4) NOT NULL,
  tax_amount    numeric(18,4) NOT NULL,
  created_at    timestamptz   NOT NULL,
  updated_at    timestamptz   NOT NULL
);

-- No `updated_at` at all: must sync in FULL every time.
CREATE TABLE inventory_movements (
  movement_id   bigint        NOT NULL,
  product_id    bigint        NOT NULL,
  store_id      bigint        NOT NULL,
  movement_type varchar(12)   NOT NULL,
  quantity      numeric(12,3) NOT NULL,
  movement_ts   timestamptz   NOT NULL,
  created_at    timestamptz   NOT NULL
);

-- `updated_at` is NULLABLE: must sync in FULL every time.
CREATE TABLE price_list_entries (
  price_id    bigint        NOT NULL,
  product_id  bigint        NOT NULL,
  currency_id bigint        NOT NULL,
  valid_from  date          NOT NULL,
  valid_to    date,
  price       numeric(18,4) NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz            -- nullable on purpose
);

-- Composite primary key: no business key, no cursor, OFFSET paging.
CREATE TABLE order_line_tags (
  order_line_id bigint      NOT NULL,
  tag           varchar(24) NOT NULL,
  tagged_by     varchar(60) NOT NULL,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL
);

-- Binary column: excluded from the sync and reported.
CREATE TABLE customer_documents (
  document_id bigint PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(customer_id),
  doc_type    varchar(24) NOT NULL,
  file_name   varchar(160) NOT NULL,
  file_blob   bytea,
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL
);

-- Awkward types and an awkward column name.
CREATE TABLE legacy_metrics (
  metric_id    bigint PRIMARY KEY,
  metric_code  varchar(24) NOT NULL,
  flags        bit(8),
  payload      jsonb,
  external_ref uuid,
  tags         text[],
  "Order Date" date,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

-- ── Documentation channel: comments are read as Tier 1 descriptions ─────────
-- Deliberately partial. The commented tables should arrive in Clarion already
-- described; the rest should show up in the AI review queue.

COMMENT ON TABLE  customers                  IS 'Companies we invoice. One row per legal entity, not per contact.';
COMMENT ON COLUMN customers.credit_limit     IS 'Maximum outstanding balance allowed before orders are held.';
COMMENT ON COLUMN customers.vat_number       IS 'EU VAT identification number, unformatted.';
COMMENT ON TABLE  products                   IS 'Everything we can sell, including discontinued items.';
COMMENT ON COLUMN products.unit_cost         IS 'Standard cost used for margin, excluding freight.';
COMMENT ON COLUMN products.list_price        IS 'Catalogue price before customer discounts.';
COMMENT ON TABLE  sales_orders               IS 'Order headers. One row per confirmed customer order.';
COMMENT ON COLUMN sales_orders.order_total   IS 'Order value net of discount, excluding VAT, in order currency.';
COMMENT ON TABLE  sales_order_lines          IS 'Order detail. One row per product on an order; the sales grain.';
COMMENT ON COLUMN sales_order_lines.line_amount  IS 'Quantity x unit price less discount, excluding VAT.';
COMMENT ON COLUMN sales_order_lines.tax_amount   IS 'VAT charged on this line.';
COMMENT ON COLUMN sales_order_lines.discount_pct IS 'Line discount as a fraction: 0.15 is 15%.';
COMMENT ON TABLE  payment_terms              IS 'Agreed payment windows, e.g. 30 days net.';
