-- ---------------------------------------------------------------------------
-- Clarion SQL-connector load test — data
--
-- ~14M rows, 10M of them in erp.sales_order_lines. Expect 15-30 minutes and
-- roughly 4 GB of disk on a 2-vCPU server.
--
-- The big tables are loaded BARE and get their keys and indexes afterwards:
-- building a btree during a 10M-row insert roughly doubles the load time.
--
-- THE INDEX ON (updated_at, order_line_id) IS NOT OPTIONAL. Clarion pages a
-- SQL source by keyset -- `WHERE (updated_at > ? OR (updated_at = ? AND
-- order_line_id > ?)) ORDER BY updated_at, order_line_id LIMIT 5000` -- so
-- without a composite index on exactly that pair, every one of the 2,000
-- pages sorts the whole table. With it, each page is an index range scan.
-- ---------------------------------------------------------------------------

SET search_path TO erp;
SET synchronous_commit = off;
SET maintenance_work_mem = '512MB';

\timing on

-- ── Lookups ────────────────────────────────────────────────────────────────

INSERT INTO countries (country_id, iso_code, country_name, region_name, created_at, updated_at)
SELECT gs,
       chr(65 + (gs % 26)) || chr(65 + ((gs / 26) % 26)),
       'Country ' || gs,
       (ARRAY['EMEA','AMER','APAC','LATAM'])[1 + (gs % 4)::int],
       now() - interval '900 days',
       now() - (random() * interval '400 days')
FROM generate_series(1, 200) gs;

INSERT INTO currencies (currency_id, code, name, symbol, created_at, updated_at)
SELECT row_number() OVER (), c.code, c.name, c.sym,
       now() - interval '900 days', now() - (random() * interval '400 days')
FROM (VALUES
  ('EUR','Euro','EUR'),('USD','US Dollar','$'),('GBP','Pound Sterling','GBP'),
  ('CHF','Swiss Franc','Fr'),('SEK','Swedish Krona','kr'),('NOK','Norwegian Krone','kr'),
  ('DKK','Danish Krone','kr'),('PLN','Polish Zloty','zl'),('CZK','Czech Koruna','Kc'),
  ('JPY','Japanese Yen','JPY'),('CAD','Canadian Dollar','$'),('AUD','Australian Dollar','$')
) AS c(code, name, sym);

INSERT INTO payment_terms (payment_term_id, code, description, days_net, discount_pct, created_at, updated_at)
SELECT row_number() OVER (), t.code, t.descr, t.days, t.disc,
       now() - interval '900 days', now() - (random() * interval '400 days')
FROM (VALUES
  ('IMMEDIATE','Payable on receipt',0,NULL),('NET14','14 days net',14,NULL),
  ('NET30','30 days net',30,NULL),('NET45','45 days net',45,NULL),
  ('NET60','60 days net',60,NULL),('NET90','90 days net',90,NULL),
  ('2_10_N30','2% if paid within 10 days, otherwise 30 days net',30,0.0200),
  ('EOM30','30 days end of month',30,NULL),
  ('PREPAID','Paid before dispatch',0,NULL),('CONSIGN','Consignment settlement',120,NULL)
) AS t(code, descr, days, disc);

INSERT INTO regions (region_id, code, name, created_at, updated_at)
SELECT gs, 'R' || lpad(gs::text, 3, '0'), 'Region ' || gs,
       now() - interval '900 days', now() - (random() * interval '400 days')
FROM generate_series(1, 25) gs;

-- 10 roots, then 50 children pointing at them.
INSERT INTO product_categories (category_id, name, parent_category_id, created_at, updated_at)
SELECT gs, 'Category group ' || gs, NULL, now() - interval '900 days', now() - (random() * interval '400 days')
FROM generate_series(1, 10) gs;
INSERT INTO product_categories (category_id, name, parent_category_id, created_at, updated_at)
SELECT gs, 'Category ' || gs, 1 + (gs % 10), now() - interval '900 days', now() - (random() * interval '400 days')
FROM generate_series(11, 60) gs;

INSERT INTO suppliers (supplier_id, name, country_id, vat_number, is_active, created_at, updated_at)
SELECT gs, 'Supplier ' || gs, 1 + (gs % 200), 'BE' || lpad(gs::text, 10, '0'),
       (gs % 17) <> 0, now() - interval '800 days', now() - (random() * interval '400 days')
FROM generate_series(1, 2000) gs;

INSERT INTO sales_reps (rep_id, full_name, region_id, hire_date, commission_pct, created_at, updated_at)
SELECT gs, 'Rep ' || gs, 1 + (gs % 25),
       date '2015-01-01' + (gs % 3000), round((0.01 + random() * 0.04)::numeric, 4),
       now() - interval '800 days', now() - (random() * interval '400 days')
FROM generate_series(1, 400) gs;

INSERT INTO stores (store_id, code, name, region_id, country_id, opened_on, floor_m2, created_at, updated_at)
SELECT gs, 'ST' || lpad(gs::text, 4, '0'), 'Store ' || gs, 1 + (gs % 25), 1 + (gs % 200),
       date '2005-01-01' + (gs * 37 % 6000), round((200 + random() * 4000)::numeric, 1),
       now() - interval '800 days', now() - (random() * interval '400 days')
FROM generate_series(1, 150) gs;

INSERT INTO products (product_id, sku, name, category_id, supplier_id, unit_cost, list_price,
                      weight_kg, is_active, barcode, created_at, updated_at)
SELECT gs,
       'SKU-' || lpad(gs::text, 8, '0'),
       'Product ' || gs,
       1 + (gs % 60),
       1 + (gs % 2000),
       c.cost,
       round(c.cost * (1.25 + random() * 0.9)::numeric, 4),
       round((0.05 + random() * 40)::numeric, 3),
       (gs % 23) <> 0,
       lpad((gs * 7919 % 1000000000000)::text, 13, '0'),
       now() - interval '700 days',
       now() - (random() * interval '400 days')
FROM generate_series(1, 25000) gs
CROSS JOIN LATERAL (SELECT round((2 + random() * 380)::numeric, 4) AS cost) c;

INSERT INTO customers (customer_id, customer_code, company_name, country_id, payment_term_id, rep_id,
                       vat_number, email, credit_limit, is_active, created_at, updated_at)
SELECT gs,
       'C' || lpad(gs::text, 8, '0'),
       'Customer ' || gs || ' ' || (ARRAY['BVBA','NV','SA','GmbH','Ltd','SARL'])[1 + (gs % 6)::int],
       1 + (gs % 200),
       1 + (gs % 10),
       CASE WHEN gs % 11 = 0 THEN NULL ELSE 1 + (gs % 400) END,
       'BE' || lpad(gs::text, 10, '0'),
       'contact' || gs || '@example.com',
       (round((1000 + random() * 90000)::numeric, 2))::money,
       (gs % 29) <> 0,
       now() - interval '600 days',
       now() - (random() * interval '400 days')
FROM generate_series(1, 120000) gs;

-- ── Order headers: 1.2M ────────────────────────────────────────────────────

DO $$
DECLARE
  batch bigint := 400000;
  total bigint := 1200000;
  i     bigint := 0;
  t0    timestamptz := clock_timestamp();
BEGIN
  WHILE i < total LOOP
    INSERT INTO sales_orders (order_id, order_number, customer_id, rep_id, store_id, currency_id,
                              payment_term_id, order_date, status, order_total, created_at, updated_at)
    SELECT gs,
           'SO' || lpad(gs::text, 10, '0'),
           1 + (gs % 120000),
           CASE WHEN gs % 13 = 0 THEN NULL ELSE 1 + (gs % 400) END,
           1 + (gs % 150),
           1 + (gs % 12),
           1 + (gs % 10),
           s.stamp::date,
           (ARRAY['open','confirmed','shipped','invoiced','cancelled'])[1 + (gs % 5)::int],
           round((50 + random() * 12000)::numeric, 4),
           s.stamp,
           s.stamp
    FROM generate_series(i + 1, i + batch) gs
    CROSS JOIN LATERAL (
      SELECT timestamptz '2023-01-01 00:00:00+00'
             + (gs::float8 / total) * interval '1000 days'
             + (random() * interval '20 hours') AS stamp
    ) s;
    i := i + batch;
    RAISE NOTICE 'sales_orders: % rows after % s', i,
      round(extract(epoch FROM clock_timestamp() - t0));
  END LOOP;
END $$;

-- ── The 10M-row sales fact ─────────────────────────────────────────────────

DO $$
DECLARE
  batch    bigint := 500000;
  total    bigint := 10000000;
  n_orders bigint := 1200000;
  n_prod   bigint := 25000;
  i        bigint := 0;
  t0       timestamptz := clock_timestamp();
BEGIN
  WHILE i < total LOOP
    INSERT INTO sales_order_lines (order_line_id, order_id, product_id, line_number,
                                   quantity, unit_price, discount_pct,
                                   line_amount, tax_amount, created_at, updated_at)
    SELECT gs,
           1 + (gs % n_orders),
           1 + (gs % n_prod),
           1 + (gs / n_orders)::int,
           q.qty,
           q.price,
           q.disc,
           round(q.qty * q.price * (1 - q.disc), 4),
           round(q.qty * q.price * (1 - q.disc) * 0.21, 4),
           s.stamp,
           s.stamp
    FROM generate_series(i + 1, i + batch) gs
    CROSS JOIN LATERAL (
      SELECT (1 + floor(random() * 40))::numeric(12,3)  AS qty,
             round((5 + random() * 495)::numeric, 4)    AS price,
             (floor(random() * 4) * 0.05)::numeric(5,4) AS disc
    ) q
    CROSS JOIN LATERAL (
      SELECT timestamptz '2023-01-01 00:00:00+00'
             + (gs::float8 / total) * interval '1000 days'
             + (random() * interval '20 hours') AS stamp
    ) s;
    i := i + batch;
    RAISE NOTICE 'sales_order_lines: % rows after % s', i,
      round(extract(epoch FROM clock_timestamp() - t0));
  END LOOP;
END $$;

-- A bulk backdated update: 200,000 rows sharing ONE cursor value.
--
-- This is the case keyset paging exists to survive. The page size is 5,000,
-- so this tie spans forty pages and the `(cursor > ? OR (cursor = ? AND
-- key > ?))` comparison is the only thing stopping the sync from either
-- looping on the same page forever or skipping 195,000 rows. Real ERP data
-- produces this constantly -- any mass price or status update does it.
UPDATE sales_order_lines
   SET updated_at = timestamptz '2024-06-01 03:00:00+00'
 WHERE order_line_id BETWEEN 4000001 AND 4200000;

-- ── Remaining facts ────────────────────────────────────────────────────────

DO $$
DECLARE
  batch bigint := 500000;
  total bigint := 2000000;
  i     bigint := 0;
BEGIN
  WHILE i < total LOOP
    INSERT INTO inventory_movements (movement_id, product_id, store_id, movement_type,
                                     quantity, movement_ts, created_at)
    SELECT gs,
           1 + (gs % 25000),
           1 + (gs % 150),
           (ARRAY['receipt','issue','transfer','adjust','return'])[1 + (gs % 5)::int],
           round((1 + random() * 250)::numeric, 3),
           s.stamp, s.stamp
    FROM generate_series(i + 1, i + batch) gs
    CROSS JOIN LATERAL (
      SELECT timestamptz '2023-01-01 00:00:00+00'
             + (gs::float8 / total) * interval '1000 days' AS stamp
    ) s;
    i := i + batch;
    RAISE NOTICE 'inventory_movements: % rows', i;
  END LOOP;
END $$;

-- Half the rows get no updated_at at all -- which is exactly why a nullable
-- column may never be used as a cursor.
INSERT INTO price_list_entries (price_id, product_id, currency_id, valid_from, valid_to, price,
                                created_at, updated_at)
SELECT gs,
       1 + (gs % 25000),
       1 + (gs % 12),
       date '2023-01-01' + (gs % 900),
       CASE WHEN gs % 3 = 0 THEN NULL ELSE date '2023-01-01' + (gs % 900) + 180 END,
       round((5 + random() * 500)::numeric, 4),
       now() - interval '500 days',
       CASE WHEN gs % 2 = 0 THEN NULL ELSE now() - (random() * interval '300 days') END
FROM generate_series(1, 300000) gs;

INSERT INTO order_line_tags (order_line_id, tag, tagged_by, created_at, updated_at)
SELECT 1 + ((gs - 1) / 2),
       CASE (gs - 1) % 2 WHEN 0 THEN 'promo' ELSE 'review' END,
       'user' || (gs % 50),
       now() - interval '200 days',
       now() - (random() * interval '180 days')
FROM generate_series(1, 500000) gs;

INSERT INTO customer_documents (document_id, customer_id, doc_type, file_name, file_blob,
                                created_at, updated_at)
SELECT gs,
       1 + (gs % 120000),
       (ARRAY['contract','invoice','credit_note','statement'])[1 + (gs % 4)::int],
       'doc-' || gs || '.pdf',
       decode(repeat('deadbeef', 64), 'hex'),
       now() - interval '400 days',
       now() - (random() * interval '300 days')
FROM generate_series(1, 5000) gs;

INSERT INTO legacy_metrics (metric_id, metric_code, flags, payload, external_ref, tags,
                            "Order Date", created_at, updated_at)
SELECT gs,
       'M' || lpad(gs::text, 6, '0'),
       (gs % 256)::int::bit(8),
       jsonb_build_object('score', round(random()::numeric, 4), 'bucket', gs % 7),
       gen_random_uuid(),
       ARRAY['alpha', 'beta', 'tag' || (gs % 9)],
       date '2023-01-01' + (gs % 900),
       now() - interval '400 days',
       now() - (random() * interval '300 days')
FROM generate_series(1, 1000) gs;

-- ── Keys, indexes, constraints ─────────────────────────────────────────────

ALTER TABLE sales_orders        ADD PRIMARY KEY (order_id);
ALTER TABLE sales_order_lines   ADD PRIMARY KEY (order_line_id);
ALTER TABLE inventory_movements ADD PRIMARY KEY (movement_id);
ALTER TABLE price_list_entries  ADD PRIMARY KEY (price_id);
ALTER TABLE order_line_tags     ADD PRIMARY KEY (order_line_id, tag);  -- composite on purpose

ALTER TABLE sales_orders
  ADD FOREIGN KEY (customer_id)     REFERENCES customers(customer_id),
  ADD FOREIGN KEY (rep_id)          REFERENCES sales_reps(rep_id),
  ADD FOREIGN KEY (store_id)        REFERENCES stores(store_id),
  ADD FOREIGN KEY (currency_id)     REFERENCES currencies(currency_id),
  ADD FOREIGN KEY (payment_term_id) REFERENCES payment_terms(payment_term_id);

ALTER TABLE sales_order_lines
  ADD FOREIGN KEY (order_id)   REFERENCES sales_orders(order_id),
  ADD FOREIGN KEY (product_id) REFERENCES products(product_id);

ALTER TABLE inventory_movements
  ADD FOREIGN KEY (product_id) REFERENCES products(product_id),
  ADD FOREIGN KEY (store_id)   REFERENCES stores(store_id);

ALTER TABLE price_list_entries
  ADD FOREIGN KEY (product_id)  REFERENCES products(product_id),
  ADD FOREIGN KEY (currency_id) REFERENCES currencies(currency_id);

ALTER TABLE order_line_tags
  ADD FOREIGN KEY (order_line_id) REFERENCES sales_order_lines(order_line_id);

-- The keyset-paging indexes. Read the header of this file before removing one.
CREATE INDEX ix_sol_cursor ON sales_order_lines (updated_at, order_line_id);
CREATE INDEX ix_so_cursor  ON sales_orders      (updated_at, order_id);
CREATE INDEX ix_ple_key    ON price_list_entries (price_id);
CREATE INDEX ix_im_key     ON inventory_movements (movement_id);
CREATE INDEX ix_sol_order  ON sales_order_lines (order_id);

-- `reltuples` is what Clarion reads for the row estimate it shows in the
-- entity picker, and it stays at -1 until the planner has seen the table.
ANALYZE;

\timing off
