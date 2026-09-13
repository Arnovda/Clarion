-- ---------------------------------------------------------------------------
-- Clarion SQL-connector load test — expected reading
--
-- Run this after the load and BEFORE you add the source in Clarion. It applies
-- the connector's own rules to the same catalog the connector reads, so the
-- four numbers "Test connection" reports can be diffed against a known answer
-- instead of being taken on trust.
--
-- A mismatch on "tables" or "with a primary key" is the signal the connector's
-- own docs call out: a catalog query that is wrong for this server version.
-- ---------------------------------------------------------------------------

\pset footer off
SET search_path TO erp;

-- The cursor names the connector accepts, verbatim from
-- packages/connectors/src/sql/catalog.ts. `created_at` is absent on purpose.
CREATE TEMP VIEW cursor_names(n) AS SELECT unnest(ARRAY[
  'updated_at','updatedat','updated_on','updatedon','updated',
  'modified_at','modifiedat','modified_on','modifiedon','modified',
  'last_modified','lastmodified','last_modified_at','lastmodifieddate',
  'last_updated','lastupdated','last_update','lastupdate',
  'date_modified','datemodified','modified_date','modifieddate',
  'date_updated','dateupdated','updated_date','updateddate',
  'write_date','changed_at','changed_on','changedate',
  'sys_updated_at','row_updated_at','record_updated_at']);

CREATE TEMP VIEW reading AS
WITH t AS (
  SELECT c.oid, c.relname::text AS table_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'erp' AND c.relkind IN ('r','p')
),
pk AS (
  SELECT con.conrelid AS oid, array_length(con.conkey, 1) AS key_cols,
         (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid = con.conrelid AND a.attnum = con.conkey[1]) AS key_col
  FROM pg_constraint con WHERE con.contype = 'p'
),
cur AS (
  SELECT a.attrelid AS oid, min(a.attname::text) AS cursor_col
  FROM pg_attribute a
  JOIN pg_type ty ON ty.oid = a.atttypid
  JOIN cursor_names cn ON cn.n = lower(a.attname::text)
  WHERE a.attnum > 0 AND NOT a.attisdropped
    AND a.attnotnull                                   -- nullable is refused
    AND ty.typname IN ('timestamptz','timestamp','date')
  GROUP BY a.attrelid
)
SELECT t.table_name,
       COALESCE(pk.key_cols, 0)                                    AS pk_columns,
       CASE WHEN pk.key_cols = 1 THEN pk.key_col END               AS business_key,
       CASE WHEN pk.key_cols = 1 THEN cur.cursor_col END           AS cursor_column,
       (SELECT count(*) FROM pg_attribute a
         WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
       (SELECT count(*) FROM pg_attribute a JOIN pg_type ty ON ty.oid = a.atttypid
         WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
           AND ty.typname IN ('bytea'))                            AS binary_columns
FROM t LEFT JOIN pk ON pk.oid = t.oid LEFT JOIN cur ON cur.oid = t.oid;

\echo
\echo '=== Per table: what Clarion should decide ==========================='
SELECT table_name,
       pk_columns,
       COALESCE(business_key, '-- none --')   AS business_key,
       COALESCE(cursor_column, '-- full sync --') AS cursor_column,
       columns,
       binary_columns
FROM reading ORDER BY table_name;

\echo
\echo '=== The four numbers "Test connection" should report ================'
SELECT (SELECT count(*) FROM reading)                                   AS "tables",
       (SELECT count(*) FROM reading WHERE business_key IS NOT NULL)
         || ' of ' || (SELECT count(*) FROM reading)                    AS "with a primary key",
       (SELECT count(*) FROM reading WHERE cursor_column IS NOT NULL)
         || ' of ' || (SELECT count(*) FROM reading)                    AS "synced incrementally",
       (SELECT count(*) FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f' AND n.nspname = 'erp')                  AS "relationships";

\echo
\echo '=== Row counts ====================================================='
SELECT table_name, to_char(n, 'FM999,999,999') AS rows FROM (
  SELECT 'sales_order_lines'   AS table_name, count(*) n FROM sales_order_lines
  UNION ALL SELECT 'sales_orders',        count(*) FROM sales_orders
  UNION ALL SELECT 'inventory_movements', count(*) FROM inventory_movements
  UNION ALL SELECT 'order_line_tags',     count(*) FROM order_line_tags
  UNION ALL SELECT 'price_list_entries',  count(*) FROM price_list_entries
  UNION ALL SELECT 'customers',           count(*) FROM customers
  UNION ALL SELECT 'products',            count(*) FROM products
) q ORDER BY n DESC;

\echo
\echo '=== The cursor tie (these rows must all arrive exactly once) ========'
SELECT count(*) AS rows_sharing_one_updated_at,
       min(order_line_id) AS first_id, max(order_line_id) AS last_id
FROM sales_order_lines WHERE updated_at = timestamptz '2024-06-01 03:00:00+00';

\echo
\echo '=== Totals to reconcile against Clarion afterwards =================='
SELECT to_char(count(*), 'FM999,999,999')          AS lines,
       to_char(sum(line_amount), 'FM999,999,999.00') AS total_line_amount,
       to_char(sum(quantity), 'FM999,999,999.000')   AS total_quantity
FROM sales_order_lines;
