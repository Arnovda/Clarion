/**
 * Cross-source questions, end to end against real DuckDB.
 *
 * The unit tests in `warehouseRegistration.test.ts` pin the naming RULE. This
 * pins that the rule survives contact with the thing it is protecting: two
 * connections, two materialised product layers, one session, real parquet on
 * disk, real SQL.
 *
 * Three claims, in order of how much they matter:
 *
 *   1. A JOIN ACROSS TWO SOURCES RETURNS THE RIGHT ROWS. This is the feature.
 *      Until now `tableCatalog` filtered every product read to one connection,
 *      so this query could not be expressed at all.
 *   2. A CONTESTED BARE NAME DOES NOT RESOLVE. Both sources have a
 *      `dim_customer` and they mean different things. `FROM dim_customer` must
 *      fail — because the alternative is DuckDB's `search_path` picking one by
 *      registration order and quietly answering with the wrong company's data.
 *   3. NOTHING CHANGES FOR A SINGLE-SOURCE SCOPE. Same names, same behaviour.
 *      Everything that exists today runs in that scope.
 *
 * Nothing is mocked: the parquet is written where the sync worker writes it,
 * the session is the real `createProductConnector`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Database } from 'duckdb-async';
import { registerUser } from './helpers';
import { getTestDb, cleanTestDb, closeTestDb } from './db-helpers';
import { createProductConnector } from '../connectors/ConnectorFactory';
import { buildProductSemanticContext } from '../services/productContext';
import { scopeOf, resolveScope, listAnswerableConnectionIds } from '../services/queryScope';

const warehouse = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-cross-source-'));
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

let tenantId: number;
let erpConnId: number;
let crmConnId: number;

/** Materialise a product table exactly where the runner publishes one. */
async function writeTable(name: string, selectSql: string): Promise<string> {
  const dir = path.join(warehouse, name);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'data.parquet');
  const db = await Database.create(':memory:');
  try {
    await db.exec(`COPY (${selectSql}) TO '${out.replace(/'/g, "''")}' (FORMAT PARQUET)`);
  } finally {
    await db.close();
  }
  return dir;
}

/** A connection with one product, and the tables it materialised. */
async function seedSource(
  name: string,
  productName: string,
  tables: { table: string; role: string; sql: string }[],
): Promise<number> {
  const db = getTestDb();
  const [conn] = await db('connections').insert({
    tenant_id: tenantId, name, type: 'duckdb', connector_type: 'exactonline',
    warehouse_path: warehouse, query_engine: 'duckdb',
    last_sync_status: 'succeeded', config: JSON.stringify({}),
  }).returning('id');
  const connectionId = idOf(conn);

  const [product] = await db('data_products').insert({
    tenant_id: tenantId, connection_id: connectionId, name: productName,
    description: 'cross-source test', status: 'approved', kind: 'analytics',
  }).returning('id');
  const [schema] = await db('star_schemas').insert({
    tenant_id: tenantId, data_product_id: idOf(product), name: `${productName} star`,
  }).returning('id');

  for (const [i, t] of tables.entries()) {
    // The directory name has to be unique per source, or the two sources would
    // share one physical file and the collision this test exists to catch
    // could not happen.
    const dir = await writeTable(`${name.toLowerCase()}__${t.table}`, t.sql);
    await db('product_tables').insert({
      tenant_id: tenantId, star_schema_id: idOf(schema), table_name: t.table,
      table_role: t.role, dag_order: i,
      transformation_status: 'success', delta_path: dir, row_count: 3,
    });
  }
  return connectionId;
}

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'admin@crosssource.test', companyName: 'Cross BV' });
  tenantId = admin.user.tenantId;

  // The ERP knows what was invoiced, and calls a customer a customer.
  erpConnId = await seedSource('Exact', 'Sales', [
    { table: 'dim_customer', role: 'dimension', sql: `SELECT * FROM (VALUES
        ('c1', 'Van Damme BVBA'), ('c2', 'Peeters NV'), ('c3', 'Nord GmbH')
      ) AS t(customer_key, customer_name)` },
    { table: 'fact_invoices', role: 'fact', sql: `SELECT * FROM (VALUES
        ('c1', 1000.0), ('c2', 250.0), ('c1', 400.0)
      ) AS t(customer_key, amount)` },
  ]);

  // The CRM also has a "dim_customer" — DIFFERENT people, same table name.
  // That is the whole hazard: the names collide, the data does not agree.
  crmConnId = await seedSource('Teamleader', 'Delivery', [
    { table: 'dim_customer', role: 'dimension', sql: `SELECT * FROM (VALUES
        ('t9', 'Someone Else BV'), ('t8', 'Not In The ERP NV')
      ) AS t(customer_key, customer_name)` },
    { table: 'fact_hours', role: 'fact', sql: `SELECT * FROM (VALUES
        ('c1', 12.0), ('c2', 4.0), ('c1', 8.0)
      ) AS t(customer_key, hours)` },
  ]);
});

afterAll(async () => {
  await closeTestDb();
  fs.rmSync(warehouse, { recursive: true, force: true });
});

describe('a session that spans two sources', () => {
  it('joins a fact in one source to a fact in the other — the feature', async () => {
    const connector = await createProductConnector(
      warehouse, { tenantId, connectionIds: [erpConnId, crmConnId] },
    );
    await connector.connect();
    try {
      // Invoiced amount from the ERP against hours logged in the CRM. Before
      // this change the two tables could not appear in one session at all.
      const rows = (await connector.executeQuery(`
        SELECT i.customer_key, SUM(i.amount) AS invoiced, MAX(h.hours_total) AS hours
        FROM fact_invoices i
        JOIN (SELECT customer_key, SUM(hours) AS hours_total FROM fact_hours GROUP BY 1) h
          ON h.customer_key = i.customer_key
        GROUP BY 1 ORDER BY 1
      `)).rows;

      expect(rows).toHaveLength(2);
      expect(Number(rows[0].invoiced)).toBe(1400);  // c1: 1000 + 400
      expect(Number(rows[0].hours)).toBe(20);       // c1: 12 + 8
      expect(Number(rows[1].invoiced)).toBe(250);
      expect(Number(rows[1].hours)).toBe(4);
    } finally {
      await connector.disconnect();
    }
  });

  it('REFUSES a bare name the two sources disagree about', async () => {
    const connector = await createProductConnector(
      warehouse, { tenantId, connectionIds: [erpConnId, crmConnId] },
    );
    await connector.connect();
    try {
      // The assertion that matters. If this ever resolves, it returns one
      // source's customers to a reader who believes they asked about both —
      // silently, with no error anywhere.
      await expect(connector.executeQuery('SELECT * FROM dim_customer'))
        .rejects.toThrow();
    } finally {
      await connector.disconnect();
    }
  });

  it('serves both contested tables under their source-prefixed names', async () => {
    const connector = await createProductConnector(
      warehouse, { tenantId, connectionIds: [erpConnId, crmConnId] },
    );
    await connector.connect();
    try {
      const erp = (await connector.executeQuery(
        'SELECT customer_name FROM exact_dim_customer ORDER BY customer_key',
      )).rows;
      const crm = (await connector.executeQuery(
        'SELECT customer_name FROM teamleader_dim_customer ORDER BY customer_key',
      )).rows;

      expect(erp.map((r) => r.customer_name)).toEqual(['Van Damme BVBA', 'Peeters NV', 'Nord GmbH']);
      expect(crm.map((r) => r.customer_name)).toEqual(['Not In The ERP NV', 'Someone Else BV']);
    } finally {
      await connector.disconnect();
    }
  });

  it('leaves an uncontested name alone', async () => {
    // Only the contested name pays the prefix; `fact_hours` exists once.
    const connector = await createProductConnector(
      warehouse, { tenantId, connectionIds: [erpConnId, crmConnId] },
    );
    await connector.connect();
    try {
      const rows = (await connector.executeQuery('SELECT COUNT(*) AS n FROM fact_hours')).rows;
      expect(Number(rows[0].n)).toBe(3);
    } finally {
      await connector.disconnect();
    }
  });
});

describe('a single-source scope is untouched', () => {
  it('still serves the bare name, with that source’s data', async () => {
    // Everything that exists today runs in this scope. If the collision rule
    // ever leaked into it, every saved dashboard on a tenant with two sources
    // would break at once.
    const connector = await createProductConnector(warehouse, scopeOf(tenantId, erpConnId));
    await connector.connect();
    try {
      const rows = (await connector.executeQuery(
        'SELECT customer_name FROM dim_customer ORDER BY customer_key',
      )).rows;
      expect(rows.map((r) => r.customer_name)).toEqual(['Van Damme BVBA', 'Peeters NV', 'Nord GmbH']);
    } finally {
      await connector.disconnect();
    }
  });

  it('cannot see the other source at all', async () => {
    const connector = await createProductConnector(warehouse, scopeOf(tenantId, erpConnId));
    await connector.connect();
    try {
      await expect(connector.executeQuery('SELECT * FROM fact_hours')).rejects.toThrow();
    } finally {
      await connector.disconnect();
    }
  });
});

describe('scope resolution', () => {
  it('lists only connections that have materialised output', async () => {
    const ids = await listAnswerableConnectionIds(tenantId, getTestDb());
    expect(ids.sort()).toEqual([erpConnId, crmConnId].sort());
  });

  it('widens to the whole tenant only when asked', async () => {
    const narrow = await resolveScope({ tenantId, connectionId: erpConnId }, getTestDb());
    expect(narrow.connectionIds).toEqual([erpConnId]);

    const wide = await resolveScope({ tenantId, connectionId: erpConnId, crossSource: true }, getTestDb());
    expect(wide.connectionIds.sort()).toEqual([erpConnId, crmConnId].sort());
  });

  it('always includes the requested connection, even when it has no output yet', async () => {
    // A source mid-first-build must not vanish from its own question.
    const db = getTestDb();
    const [empty] = await db('connections').insert({
      tenant_id: tenantId, name: 'Fresh', type: 'duckdb', connector_type: 'exactonline',
      warehouse_path: warehouse, query_engine: 'duckdb', config: JSON.stringify({}),
    }).returning('id');
    const scope = await resolveScope({ tenantId, connectionId: idOf(empty), crossSource: true }, db);
    expect(scope.connectionIds).toContain(idOf(empty));
  });
});

describe('the semantic context describes what the session actually serves', () => {
  it('names tables by their resolvable name and says which system each is from', async () => {
    const ctx = await buildProductSemanticContext(
      { tenantId, connectionIds: [erpConnId, crmConnId] }, getTestDb(),
    );
    expect(ctx).not.toBeNull();
    const text = ctx!.semanticContext;

    // The contested table is described under the names that resolve...
    expect(text).toContain('exact_dim_customer');
    expect(text).toContain('teamleader_dim_customer');
    // ...and the model is told the bare one is not a table, or it will use it.
    expect(text).toContain('There is no table called dim_customer');
    // Provenance on the table line — "which system is this number from?".
    expect(text).toContain('from Exact');
    expect(text).toContain('from Teamleader');
  });

  it('refuses to invent a join when no confirmed link exists', async () => {
    // Two systems share no foreign key. Left unsaid, the model joins on
    // whatever looks similar and produces a confident, wrong total.
    const ctx = await buildProductSemanticContext(
      { tenantId, connectionIds: [erpConnId, crmConnId] }, getTestDb(),
    );
    expect(ctx!.semanticContext).toContain('NO confirmed link between these systems exists yet');
    expect(ctx!.semanticContext).toContain('Do NOT invent a join');
  });

  it('says none of that for a single-source scope', async () => {
    const ctx = await buildProductSemanticContext(scopeOf(tenantId, erpConnId), getTestDb());
    expect(ctx!.semanticContext).not.toContain('MORE THAN ONE SOURCE SYSTEM');
    expect(ctx!.semanticContext).not.toContain('exact_dim_customer');
    // Not one extra token for a customer who will never need it.
    expect(ctx!.semanticContext).toContain('Table dim_customer');
  });
});

// ─── The replay paths ───────────────────────────────────────────────────────
//
// A cross-source answer is not one execution. Its SQL is re-run later by a
// scheduled email, by the Excel add-in, and by the verified fast path in
// /think — and each of those built its session from a hard single-source
// scope until this was fixed. That is not a cosmetic gap: a cross-source
// dashboard on a schedule would MAIL OUT a report with every widget reading
// the second system rendered as an error, to recipients who did not ask for
// it and cannot see why.
//
// Source-level assertions, because driving them needs an SMTP transport, an
// Office host and a live model between them. They make the regression a red
// build rather than a silent one — the same trick the overnight-investigation
// wiring tests use.

describe('every replay of a saved query honours the scope it was written in', () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('the scheduled dashboard email reads the spec, not a fixed connection', () => {
    const src = read('services/reportEmailService.ts');
    expect(src).toContain('crossSource: spec.crossSource === true');
    // The old hard-coded single-source scope must not come back on this path.
    expect(src).not.toContain('scopeOf(tenantId, product.connection_id as number)');
  });

  it('the scheduled saved-question email reads the stored scope', () => {
    const src = read('services/reportEmailService.ts');
    expect(src).toContain('crossSource: sq.cross_source === true');
  });

  it('the Excel add-in reads the stored scope', () => {
    const src = read('routes/addin.ts');
    expect(src).toContain('crossSource: sq.cross_source === true');
  });

  it('the verified fast path replays in the scope the SQL was written in', () => {
    const src = read('routes/query.ts');
    expect(src).toContain('crossSource: vq.cross_source === true');
  });

  it('saving a question records the scope', () => {
    // Without this the three readers above have nothing to read, and the
    // whole chain silently degrades to single-source.
    expect(read('routes/savedQuestions.ts')).toContain('cross_source: crossSource === true');
  });
});
