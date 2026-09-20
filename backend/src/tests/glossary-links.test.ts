/**
 * Glossary links — a business term gets an ADDRESS in the data.
 *
 * What this guards, beyond "the route returns 200":
 *  1. **A link is checked on WRITE.** A target that is not in the catalog is
 *     refused (400) and nothing is stored — a typo must never become a fact
 *     the model is told to rely on.
 *  2. **A vanished target reads `resolved: false`, and the term stays.** A
 *     rebuild that drops a column must make the term visibly point at nothing,
 *     never silently drift and never delete the definition.
 *  3. **Tenant isolation** — another tenant's table is "not in your topics".
 *  4. **The picker's targets** exclude technical columns (the is_technical
 *     firewall) and include KPIs; viewers are refused.
 *  5. **The prompt** states a resolved link as a fact, only when asked to
 *     (product layer), and never an unresolved one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { request, registerUser, createUserWithToken } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { getGlossaryPromptBlock } from '../services/glossaryContext';
import { parseGlossaryLinks, formatLinksForPrompt } from '../services/glossaryLinks';

let adminToken: string;
let analystToken: string;
let viewerToken: string;
let otherAdminToken: string;
let tenantId: number;
let factId: number;
let termId: number;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await cleanTestDb();
  const a = await registerUser({ companyName: 'Glossary Co', email: 'glossary-admin@test.com' });
  adminToken = a.token;
  tenantId = a.user.tenantId;
  analystToken = (await createUserWithToken({ tenantId, role: 'analyst', email: 'glossary-analyst@test.com' })).token;
  viewerToken = (await createUserWithToken({ tenantId, role: 'viewer', email: 'glossary-viewer@test.com' })).token;
  const b = await registerUser({ companyName: 'Other Glossary Co', email: 'glossary-other@test.com' });
  otherAdminToken = b.token;

  // One topic, one lookup, one measures table, one KPI — persisted the way
  // the bus-matrix builder persists them.
  const db = getTestDb();
  const [product] = await db('data_products')
    .insert({ tenant_id: tenantId, connection_id: null, name: 'Finance', status: 'approved', kind: 'analytics' })
    .returning('id');
  const productId = Number((product as { id?: number }).id ?? product);
  const [schema] = await db('star_schemas')
    .insert({ tenant_id: tenantId, data_product_id: productId, name: 'finance_star', fact_table_type: 'transaction' })
    .returning('id');
  const schemaId = Number((schema as { id?: number }).id ?? schema);
  const inserted = await db('product_tables')
    .insert([
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'dim_customer',
        display_name: 'Customers', table_role: 'dimension', dag_order: 0,
        transformation_status: 'success', delta_path: '/tmp/x/dim_customer',
      },
      {
        tenant_id: tenantId, star_schema_id: schemaId, table_name: 'fact_receivables',
        display_name: 'Receivables', table_role: 'fact', dag_order: 1,
        transformation_status: 'success', delta_path: '/tmp/x/fact_receivables',
      },
    ])
    .returning('id');
  const dimId = Number((inserted[0] as { id?: number }).id ?? inserted[0]);
  factId = Number((inserted[1] as { id?: number }).id ?? inserted[1]);
  await db('product_columns').insert([
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'customer_name', display_name: 'Customer name', data_type: 'VARCHAR', column_role: 'attribute', is_technical: false },
    { tenant_id: tenantId, product_table_id: dimId, column_name: 'customer_key', data_type: 'INTEGER', column_role: 'surrogate_key', is_technical: true },
    { tenant_id: tenantId, product_table_id: factId, column_name: 'outstanding_amount', display_name: 'Outstanding amount', data_type: 'DOUBLE', column_role: 'measure', is_technical: false },
  ]);
  await db('product_kpis').insert({
    tenant_id: tenantId, data_product_id: productId, name: 'Outstanding receivables',
    description: 'Open amounts customers still owe.',
    formula_sql: 'SELECT SUM(outstanding_amount) FROM fact_receivables', ai_draft: false,
  });
});

afterAll(async () => { await closeTestDb(); });

describe('glossary links — pure helpers', () => {
  it('parseGlossaryLinks drops malformed entries, keeps valid ones, dedupes', () => {
    const links = parseGlossaryLinks([
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' },
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' }, // dupe
      { kind: 'column', table: 'dim; DROP', column: 'a' },                          // unsafe
      { kind: 'bogus', table: 'x' },                                                // unknown kind
      { kind: 'kpi', kpi: '  Outstanding receivables ' },
      { kind: 'table', table: 'dim_customer' },
      'not an object',
    ]);
    expect(links).toEqual([
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' },
      { kind: 'kpi', kpi: 'Outstanding receivables' },
      { kind: 'table', table: 'dim_customer' },
    ]);
    expect(parseGlossaryLinks('garbage')).toEqual([]);
    expect(parseGlossaryLinks(JSON.stringify([{ kind: 'table', table: 'dim_customer' }]))).toEqual([{ kind: 'table', table: 'dim_customer' }]);
  });

  it('formatLinksForPrompt renders resolved links only, and null when nothing is resolved', () => {
    expect(formatLinksForPrompt([
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount', resolved: true, topic: 'Finance', label: 'Outstanding amount' },
      { kind: 'column', table: 'fact_gone', column: 'x', resolved: false, topic: null, label: null },
      { kind: 'kpi', kpi: 'Outstanding receivables', resolved: true, topic: 'Finance', label: 'Outstanding receivables' },
    ])).toBe('In the data: `fact_receivables.outstanding_amount` (topic Finance) · KPI "Outstanding receivables" (topic Finance)');
    expect(formatLinksForPrompt([{ kind: 'table', table: 'gone', resolved: false, topic: null, label: null }])).toBeNull();
  });
});

describe('/api/semantic/glossary links', () => {
  it('saves a term with column, KPI and table links and reports them resolved with their topic', async () => {
    const res = await (await request())
      .post('/api/semantic/glossary')
      .set(auth(adminToken))
      .send({
        term: 'Openstaande vordering',
        meaning: 'Het bedrag dat klanten nog moeten betalen op verstuurde facturen.',
        links: [
          { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' },
          { kind: 'kpi', kpi: 'Outstanding receivables' },
          { kind: 'table', table: 'dim_customer' },
        ],
      });
    expect(res.status).toBe(201);
    termId = res.body.data.id;
    expect(res.body.data.links).toEqual([
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount', resolved: true, topic: 'Finance', label: 'Outstanding amount' },
      { kind: 'kpi', kpi: 'Outstanding receivables', resolved: true, topic: 'Finance', label: 'Outstanding receivables' },
      { kind: 'table', table: 'dim_customer', resolved: true, topic: 'Finance', label: 'Customers' },
    ]);
  });

  it('refuses a link whose target is not in the catalog, and stores nothing', async () => {
    const before = await getTestDb()('business_glossary').where({ tenant_id: tenantId }).count<{ count: string }[]>('* as count');
    const res = await (await request())
      .post('/api/semantic/glossary')
      .set(auth(analystToken))
      .send({ term: 'Typo', meaning: 'A link to a column that does not exist.', links: [{ kind: 'column', table: 'fact_receivables', column: 'nope' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('fact_receivables.nope');
    const after = await getTestDb()('business_glossary').where({ tenant_id: tenantId }).count<{ count: string }[]>('* as count');
    expect(after[0].count).toBe(before[0].count);
  });

  it('refuses a malformed link before touching the database (Zod)', async () => {
    const bogusKind = await (await request())
      .post('/api/semantic/glossary')
      .set(auth(adminToken))
      .send({ term: 'Bogus', meaning: 'x', links: [{ kind: 'bogus', table: 'dim_customer' }] });
    expect(bogusKind.status).toBe(400);
    const unsafe = await (await request())
      .post('/api/semantic/glossary')
      .set(auth(adminToken))
      .send({ term: 'Unsafe', meaning: 'x', links: [{ kind: 'table', table: 'dim; DROP TABLE x' }] });
    expect(unsafe.status).toBe(400);
  });

  it('another tenant cannot link a term to this tenant\'s table', async () => {
    const res = await (await request())
      .post('/api/semantic/glossary')
      .set(auth(otherAdminToken))
      .send({ term: 'Openstaande vordering', meaning: 'Same words, other company.', links: [{ kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not in your topics');
  });

  it('the picker lists tables with their non-technical columns and the KPIs; a viewer is refused', async () => {
    const res = await (await request()).get('/api/semantic/glossary/link-targets').set(auth(analystToken));
    expect(res.status).toBe(200);
    const dim = res.body.data.tables.find((t: { tableName: string }) => t.tableName === 'dim_customer');
    expect(dim.topic).toBe('Finance');
    expect(dim.displayName).toBe('Customers');
    expect(dim.columns.map((c: { name: string }) => c.name)).toEqual(['customer_name']); // customer_key is technical
    const fact = res.body.data.tables.find((t: { tableName: string }) => t.tableName === 'fact_receivables');
    expect(fact.columns).toEqual([{ name: 'outstanding_amount', displayName: 'Outstanding amount', role: 'measure' }]);
    expect(res.body.data.kpis).toEqual([{ name: 'Outstanding receivables', topic: 'Finance', description: 'Open amounts customers still owe.' }]);

    const viewer = await (await request()).get('/api/semantic/glossary/link-targets').set(auth(viewerToken));
    expect(viewer.status).toBe(403);
  });

  it('PATCH replaces the links when sent and leaves them alone when absent', async () => {
    const renamed = await (await request())
      .patch(`/api/semantic/glossary/${termId}`)
      .set(auth(adminToken))
      .send({ meaning: 'Het openstaande bedrag op klantfacturen.' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.links).toHaveLength(3);
    expect(renamed.body.data.links.every((l: { resolved: boolean }) => l.resolved)).toBe(true);

    const replaced = await (await request())
      .patch(`/api/semantic/glossary/${termId}`)
      .set(auth(adminToken))
      .send({ links: [{ kind: 'column', table: 'fact_receivables', column: 'outstanding_amount' }] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.links).toEqual([
      { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount', resolved: true, topic: 'Finance', label: 'Outstanding amount' },
    ]);

    const bad = await (await request())
      .patch(`/api/semantic/glossary/${termId}`)
      .set(auth(adminToken))
      .send({ links: [{ kind: 'kpi', kpi: 'No such KPI' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('KPI "No such KPI"');
  });

  it('the prompt states a resolved link as a fact — on the product layer only', async () => {
    const product = await getGlossaryPromptBlock(tenantId, { links: true });
    expect(product).toContain('**Openstaande vordering**');
    expect(product).toContain('In the data: `fact_receivables.outstanding_amount` (topic Finance)');
    expect(product).toContain('use EXACTLY that table, column or KPI');
    const source = await getGlossaryPromptBlock(tenantId);
    expect(source).toContain('**Openstaande vordering**');
    expect(source).not.toContain('In the data:');
    expect(source).not.toContain('use EXACTLY');
  });

  it('a column a rebuild dropped reads resolved:false on the term — the term itself stays, and the prompt omits it', async () => {
    const db = getTestDb();
    await db('product_columns').where({ product_table_id: factId, column_name: 'outstanding_amount' }).delete();
    try {
      const list = await (await request()).get('/api/semantic/glossary').set(auth(viewerToken));
      expect(list.status).toBe(200);
      const term = list.body.data.find((e: { id: number }) => e.id === termId);
      expect(term).toBeTruthy();
      expect(term.links).toEqual([
        { kind: 'column', table: 'fact_receivables', column: 'outstanding_amount', resolved: false, topic: null, label: null },
      ]);
      const prompt = await getGlossaryPromptBlock(tenantId, { links: true });
      expect(prompt).toContain('**Openstaande vordering**');
      expect(prompt).not.toContain('In the data:');
    } finally {
      await db('product_columns').insert({
        tenant_id: tenantId, product_table_id: factId, column_name: 'outstanding_amount',
        display_name: 'Outstanding amount', data_type: 'DOUBLE', column_role: 'measure', is_technical: false,
      });
    }
  });
});
