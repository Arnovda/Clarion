-- ---------------------------------------------------------------------------
-- Clarion SQL-connector load test — the follow-up runs
--
-- Run these ONE AT A TIME, syncing in Clarion between each, and read the
-- result. Each one has a different right answer, and two of them are the
-- cases where a connector quietly loses data if it gets the rule wrong.
-- ---------------------------------------------------------------------------

SET search_path TO erp;

-- ── 1. Incremental: an ordinary day's edits ────────────────────────────────
-- Expected: the next sync moves ~50,000 rows, not 10,000,000. If the row
-- count on the sync run is the whole table, the cursor is not being stored or
-- not being used.

UPDATE sales_order_lines
   SET unit_price  = round(unit_price * 1.05, 4),
       line_amount = round(quantity * unit_price * 1.05 * (1 - discount_pct), 4),
       updated_at  = now()
 WHERE order_line_id BETWEEN 1 AND 50000;

-- ── 2. Incremental: new rows ───────────────────────────────────────────────
-- Expected: 20,000 more rows arrive. Ids continue past the existing maximum,
-- so nothing collides on the business key.

INSERT INTO sales_order_lines (order_line_id, order_id, product_id, line_number,
                               quantity, unit_price, discount_pct,
                               line_amount, tax_amount, created_at, updated_at)
SELECT 10000000 + gs,
       1 + (gs % 1200000),
       1 + (gs % 25000),
       99,
       q.qty, q.price, q.disc,
       round(q.qty * q.price * (1 - q.disc), 4),
       round(q.qty * q.price * (1 - q.disc) * 0.21, 4),
       now(), now()
FROM generate_series(1, 20000) gs
CROSS JOIN LATERAL (
  SELECT (1 + floor(random() * 40))::numeric(12,3)  AS qty,
         round((5 + random() * 495)::numeric, 4)    AS price,
         (floor(random() * 4) * 0.05)::numeric(5,4) AS disc
) q;

-- ── 3. Deletes: the case an incremental sync CANNOT see ────────────────────
-- A deleted row leaves nothing behind for a cursor to find, so the next
-- ordinary sync will not notice these at all -- and that is correct, not a
-- bug. What must work is "Check for deleted rows" on the source card, which
-- pulls keys only and tombstones what is gone.
--
-- Expected: ordinary sync -> count unchanged in Clarion.
--           reconcile     -> 2,000 rows hidden, and the warning says so.

DELETE FROM order_line_tags     WHERE order_line_id BETWEEN 200001 AND 202000;
DELETE FROM sales_order_lines   WHERE order_line_id BETWEEN 200001 AND 202000;

-- ── 4. Schema drift: a column appears ──────────────────────────────────────
-- Expected: the column arrives on the next sync, with NULL for every row
-- written before it existed. Re-analysing should then describe it.

ALTER TABLE sales_order_lines ADD COLUMN margin_amount numeric(18,4);
UPDATE sales_order_lines
   SET margin_amount = round(line_amount * 0.32, 4),
       updated_at    = now()
 WHERE order_line_id BETWEEN 100001 AND 130000;

-- ── 5. Schema drift: a column disappears ───────────────────────────────────
-- Only run this once a topic has been built ON TOP of the column, or it tests
-- nothing. Expected: the topic table goes `degraded` and names the column
-- rather than failing the whole refresh, and admins get exactly one alert.
--
-- ALTER TABLE sales_order_lines DROP COLUMN tax_amount;

ANALYZE sales_order_lines;
ANALYZE order_line_tags;
