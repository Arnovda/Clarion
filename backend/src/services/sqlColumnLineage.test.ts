import { describe, it, expect } from 'vitest';
import { deriveSqlLineage, type SourceCatalog } from './sqlColumnLineage';

function catalog(tables: Record<string, string[] | null>): SourceCatalog {
  const c: SourceCatalog = new Map();
  for (const [name, cols] of Object.entries(tables)) {
    c.set(name.toLowerCase(), {
      name,
      columns: cols ? new Map(cols.map((x) => [x.toLowerCase(), x])) : undefined,
    });
  }
  return c;
}

const EO = catalog({
  SalesInvoices: ['InvoiceID', 'InvoiceTo', 'OrderedBy', 'InvoiceDate', 'InvoiceNumber', 'Currency', 'Type', 'AmountDC', 'VATAmountDC'],
  SalesInvoiceLines: ['ID', 'InvoiceID', 'Item', 'GLAccount', 'Quantity', 'UnitPrice', 'AmountDC', 'LineNumber', 'Description'],
  Accounts: ['ID', 'Code', 'Name', 'City'],
});

describe('deriveSqlLineage', () => {
  it('reads the fact from the screenshot: keys, dates, passthroughs', () => {
    const sql = `
      SELECT
        clarion_key('accounts', h.InvoiceTo) AS invoice_to_account_key,
        clarion_key('items', l.Item) AS item_key,
        COALESCE(TRY_CAST(strftime(TRY_CAST(h.InvoiceDate AS DATE), '%Y%m%d') AS INTEGER), -1) AS invoice_date_key,
        l.ID AS sales_invoice_line_id,
        h.InvoiceNumber,
        l.LineNumber,
        h.Type AS invoice_type,
        l.AmountDC
      FROM SalesInvoiceLines l
      LEFT JOIN SalesInvoices h ON h.InvoiceID = l.InvoiceID`;
    const r = deriveSqlLineage(sql, EO);
    expect(r.parsed).toBe(true);

    const key = r.columns.get('invoice_to_account_key')!;
    expect(key.refs).toEqual([{ table: 'SalesInvoices', column: 'InvoiceTo' }]);
    // The string literal 'accounts' is not a column.
    expect(key.transformation).toContain('clarion_key');

    expect(r.columns.get('item_key')!.refs).toEqual([{ table: 'SalesInvoiceLines', column: 'Item' }]);
    const date = r.columns.get('invoice_date_key')!;
    expect(date.refs).toEqual([{ table: 'SalesInvoices', column: 'InvoiceDate' }]);
    expect(date.transformation).toMatch(/strftime/);

    expect(r.columns.get('invoicenumber')).toMatchObject({
      name: 'InvoiceNumber', refs: [{ table: 'SalesInvoices', column: 'InvoiceNumber' }], transformation: null,
    });
    expect(r.columns.get('sales_invoice_line_id')!.transformation).toBeNull();
    expect(r.columns.get('invoice_type')!.refs).toEqual([{ table: 'SalesInvoices', column: 'Type' }]);
    expect(r.columns.get('amountdc')!.refs).toEqual([{ table: 'SalesInvoiceLines', column: 'AmountDC' }]);
  });

  it('reads SQL as the SQL tab formats it (space before the parenthesis, upper-case keywords)', () => {
    const r = deriveSqlLineage(`SELECT
  clarion_key ('accounts', h.InvoiceTo) AS invoice_to_account_key,
  COALESCE(
    TRY_CAST (
      strftime(TRY_CAST (h.InvoiceDate AS DATE), '%Y%m%d') AS INTEGER
    ),
    -1
  ) AS invoice_date_key,
  h.InvoiceID
FROM
  SalesInvoiceLines AS l
  LEFT JOIN SalesInvoices AS h ON h.InvoiceID = l.InvoiceID`, EO);
    expect(r.columns.get('invoice_to_account_key')!.refs).toEqual([{ table: 'SalesInvoices', column: 'InvoiceTo' }]);
    expect(r.columns.get('invoice_date_key')!.refs).toEqual([{ table: 'SalesInvoices', column: 'InvoiceDate' }]);
    expect(r.columns.get('invoiceid')!).toMatchObject({ refs: [{ table: 'SalesInvoices', column: 'InvoiceID' }], transformation: null });
  });

  it('two fields combined into one give two edges into that one column', () => {
    const r = deriveSqlLineage(
      `SELECT concat_ws(' - ', a.Code, a.Name) AS account_label, l.Quantity * l.UnitPrice AS line_total
       FROM SalesInvoiceLines l JOIN SalesInvoices h ON h.InvoiceID = l.InvoiceID JOIN Accounts a ON a.ID = h.InvoiceTo`,
      EO,
    );
    const label = r.columns.get('account_label')!;
    expect(label.refs).toEqual([
      { table: 'Accounts', column: 'Code' },
      { table: 'Accounts', column: 'Name' },
    ]);
    expect(label.transformation).toBe("concat_ws(' - ', a.Code, a.Name)");
    expect(r.columns.get('line_total')!.refs).toEqual([
      { table: 'SalesInvoiceLines', column: 'Quantity' },
      { table: 'SalesInvoiceLines', column: 'UnitPrice' },
    ]);
  });

  it('follows CTEs, including a transformation made inside the CTE', () => {
    const r = deriveSqlLineage(
      `WITH lines AS (
         SELECT l.InvoiceID, l.Quantity * l.UnitPrice AS gross, l.Item FROM SalesInvoiceLines l
       ), hdr AS (SELECT InvoiceID, upper(Currency) AS currency_code FROM SalesInvoices)
       SELECT x.gross, x.Item AS item_code, h.currency_code
       FROM lines x JOIN hdr h USING (InvoiceID)`,
      EO,
    );
    const gross = r.columns.get('gross')!;
    expect(gross.refs).toEqual([
      { table: 'SalesInvoiceLines', column: 'Quantity' },
      { table: 'SalesInvoiceLines', column: 'UnitPrice' },
    ]);
    // Passed through at the top, transformed in the CTE: the CTE's expression.
    expect(gross.transformation).toBe('l.Quantity * l.UnitPrice');
    expect(r.columns.get('item_code')!).toMatchObject({ refs: [{ table: 'SalesInvoiceLines', column: 'Item' }], transformation: null });
    // Bare identifier resolved inside a single-relation CTE.
    expect(r.columns.get('currency_code')!.refs).toEqual([{ table: 'SalesInvoices', column: 'Currency' }]);
  });

  it('expands SELECT * over a CTE and over a subquery', () => {
    const r = deriveSqlLineage(
      `WITH final AS (SELECT a.Code AS account_code, a.Name FROM Accounts a)
       SELECT * FROM final`,
      EO,
    );
    expect([...r.columns.keys()]).toEqual(['account_code', 'name']);
    expect(r.columns.get('account_code')!.refs).toEqual([{ table: 'Accounts', column: 'Code' }]);

    const sub = deriveSqlLineage(`SELECT s.* FROM (SELECT City AS town FROM Accounts) s`, EO);
    expect(sub.columns.get('town')!.refs).toEqual([{ table: 'Accounts', column: 'City' }]);
  });

  it('merges union branches by position', () => {
    const r = deriveSqlLineage(
      `SELECT h.AmountDC AS amount FROM SalesInvoices h
       UNION ALL
       SELECT l.AmountDC FROM SalesInvoiceLines l`,
      EO,
    );
    expect(r.columns.get('amount')!.refs).toEqual([
      { table: 'SalesInvoices', column: 'AmountDC' },
      { table: 'SalesInvoiceLines', column: 'AmountDC' },
    ]);
  });

  it('never attributes to a table outside the source catalog, nor guesses an ambiguous bare name', () => {
    const r = deriveSqlLineage(
      `SELECT d.item_key, AmountDC, l.Description
       FROM SalesInvoiceLines l JOIN SalesInvoices h ON h.InvoiceID = l.InvoiceID JOIN dim_item d ON d.code = l.Item`,
      EO,
    );
    expect(r.columns.get('item_key')!.refs).toEqual([]);      // a lookup, not a source table
    expect(r.columns.get('amountdc')!.refs).toEqual([]);      // both SalesInvoices and SalesInvoiceLines have it
    expect(r.columns.get('description')!.refs).toEqual([{ table: 'SalesInvoiceLines', column: 'Description' }]);
  });

  it('ignores comments and literals, and survives SQL it cannot read', () => {
    const r = deriveSqlLineage(
      `-- FROM Accounts a
       SELECT 'Accounts.Code' AS label, /* a.Name */ h.Currency AS cur FROM SalesInvoices h;`,
      EO,
    );
    expect(r.columns.get('label')!.refs).toEqual([]);
    expect(r.columns.get('cur')!.refs).toEqual([{ table: 'SalesInvoices', column: 'Currency' }]);
    expect(deriveSqlLineage('not sql at all', EO).parsed).toBe(false);
    expect(deriveSqlLineage(null, EO).parsed).toBe(false);
  });

  it('reads CASE, CAST and implicit aliases without mistaking a type for a column', () => {
    const r = deriveSqlLineage(
      `SELECT CASE WHEN h.Type = 21 THEN -h.AmountDC ELSE h.AmountDC END AS signed_amount,
              CAST(h.InvoiceDate AS DATE) invoice_date,
              h.Currency cur
       FROM SalesInvoices h`,
      EO,
    );
    expect(r.columns.get('signed_amount')!.refs).toEqual([
      { table: 'SalesInvoices', column: 'Type' },
      { table: 'SalesInvoices', column: 'AmountDC' },
    ]);
    expect(r.columns.get('invoice_date')!.refs).toEqual([{ table: 'SalesInvoices', column: 'InvoiceDate' }]);
    expect(r.columns.get('cur')!.refs).toEqual([{ table: 'SalesInvoices', column: 'Currency' }]);
  });
});
