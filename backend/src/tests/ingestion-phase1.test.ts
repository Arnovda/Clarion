/**
 * Phase 1 of the ingestion-chain assessment (docs/backlog/ingestion-chain-
 * assessment.md §7): keys and policy. Four items, each pinned at the
 * mechanism:
 *
 *  C1  a design whose key renumbers per run is REFUSED, and no prompt asks
 *      for one any more;
 *  D3  a vanished source column is told apart from a bookkeeping slip (the
 *      DuckDB-backed half lives in core-loop.test.ts);
 *  E5  one provenance ladder, derived the same way everywhere, carried into
 *      product_relationships and column_lineage at persist and on reads;
 *  E6  the declared source type is kept and settles a GUID→code link before
 *      any data is read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { registerUser, request } from './helpers';
import { cleanTestDb, closeTestDb, getTestDb } from './db-helpers';
import { provenanceOf, PROVENANCE_RUNGS, PROVENANCE_LABEL } from '../shared/provenance';
import { unstableKeyViolations, validateBusMatrix, buildBusMatrix } from '../services/busMatrixBuilder';
import { missingColumnFromError, classifyBindFailure, degradedReason } from '../services/schemaLoss';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

const db = getTestDb();
const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const idOf = (row: unknown) => Number((row as { id?: number }).id ?? row);

let token: string;
let tenantId: number;
let connectionId: number;
let guidTable: number;
let guidCol: number;     // Edm.Guid
let codeTable: number;
let codeCol: number;     // Edm.String
let idCol: number;       // Edm.Guid on the second table
let untypedCol: number;  // no source type

beforeAll(async () => {
  await cleanTestDb();
  const admin = await registerUser({ email: 'phase1@test.com', companyName: 'Phase1 BV' });
  token = admin.token; tenantId = admin.user.tenantId;
  connectionId = idOf((await db('connections').insert({
    tenant_id: tenantId, name: 'Exact', type: 'duckdb', connector_type: 'exactonline', config: '{}',
  }).returning('id'))[0]);
  guidTable = idOf((await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'TransactionLines' }).returning('id'))[0]);
  codeTable = idOf((await db('source_tables').insert({ tenant_id: tenantId, connection_id: connectionId, table_name: 'Journals' }).returning('id'))[0]);
  guidCol = idOf((await db('source_columns').insert({ tenant_id: tenantId, table_id: guidTable, column_name: 'Journal', data_type: 'VARCHAR', source_data_type: 'Edm.Guid' }).returning('id'))[0]);
  codeCol = idOf((await db('source_columns').insert({ tenant_id: tenantId, table_id: codeTable, column_name: 'Code', data_type: 'VARCHAR', source_data_type: 'Edm.String' }).returning('id'))[0]);
  idCol = idOf((await db('source_columns').insert({ tenant_id: tenantId, table_id: codeTable, column_name: 'ID', data_type: 'VARCHAR', source_data_type: 'Edm.Guid' }).returning('id'))[0]);
  untypedCol = idOf((await db('source_columns').insert({ tenant_id: tenantId, table_id: codeTable, column_name: 'Legacy', data_type: 'VARCHAR' }).returning('id'))[0]);
});

afterAll(async () => { await closeTestDb(); });

// ─── C1 ────────────────────────────────────────────────────────────────────

const dim = (sql: string, expr: string) => ({
  table_name: 'dim_item', display_name: 'Item', description: 'x', transformation_sql: sql, source_tables: ['Items'],
  columns: [
    { column_name: 'item_key', data_type: 'VARCHAR', display_name: 'Key', description: 'k', column_role: 'surrogate_key', transformation_expression: expr },
    { column_name: 'item_id', data_type: 'VARCHAR', display_name: 'Id', description: 'n', column_role: 'natural_key', transformation_expression: 'i.ID' },
  ],
});

describe('C1 — a key that renumbers per run is refused', () => {
  it('refuses ROW_NUMBER() in a surrogate-key expression and in the SQL alias', () => {
    expect(unstableKeyViolations(dim('SELECT ROW_NUMBER() OVER (ORDER BY i.ID) AS item_key, i.ID AS item_id FROM Items i', 'ROW_NUMBER() OVER (ORDER BY i.ID)')))
      .toHaveLength(1);
    // The column expression is a paraphrase; the SQL is what runs.
    expect(unstableKeyViolations(dim('SELECT ROW_NUMBER() OVER (ORDER BY i.ID) AS item_key, i.ID AS item_id FROM Items i', 'i.ID')))
      .toHaveLength(1);
    expect(unstableKeyViolations(dim('SELECT uuid() AS item_key, i.ID AS item_id FROM Items i', 'uuid()'))).toHaveLength(1);
  });

  it('accepts the natural key carried as the key, and a ROW_NUMBER used only to dedupe', () => {
    expect(unstableKeyViolations(dim('SELECT i.ID AS item_key, i.ID AS item_id FROM Items i', 'i.ID'))).toEqual([]);
    expect(unstableKeyViolations(dim(
      'WITH r AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY ID ORDER BY Modified DESC) AS rn FROM Items) SELECT ID AS item_key, ID AS item_id FROM r WHERE rn = 1',
      'ID',
    ))).toEqual([]);
    expect(unstableKeyViolations(dim("SELECT CONCAT_WS('|', i.Division, i.Code) AS item_key, i.Code AS item_id FROM Items i", "CONCAT_WS('|', i.Division, i.Code)"))).toEqual([]);
  });

  it('validateBusMatrix carries the refusal, for dims and for fact FKs', () => {
    const bad = {
      conformed_dimensions: [dim('SELECT ROW_NUMBER() OVER (ORDER BY i.ID) AS item_key, i.ID AS item_id FROM Items i', 'ROW_NUMBER() OVER (ORDER BY i.ID)')],
      fact_tables: [{
        table_name: 'fact_x', display_name: 'X', description: 'x', grain: 'g', fact_table_type: 'transaction',
        transformation_sql: 'SELECT random() AS item_key, 1 AS qty FROM Lines', source_tables: ['Lines'], dimensions_used: ['dim_item'],
        columns: [{ column_name: 'item_key', data_type: 'DOUBLE', display_name: 'k', description: 'k', column_role: 'foreign_key', transformation_expression: 'random()' }],
      }],
      data_products: [{ name: 'X', build_order: 1, owned_dimensions: ['dim_item'], fact_tables: ['fact_x'] }],
      relationships: [], proposed_kpis: [], rationale: '', dim_date_range: { start: '2024-01-01', end: '2024-12-31' },
    } as unknown as BusMatrixOutput;
    const errors = validateBusMatrix(bad);
    expect(errors.filter((e) => e.includes('minted per run'))).toHaveLength(2);
  });

  it('no design or repair prompt asks for ROW_NUMBER keys any more (source-level)', () => {
    const prompt = read('ai/prompts/busMatrixPrompt.ts');
    expect(prompt).not.toMatch(/via ROW_NUMBER\(\)/);
    expect(prompt).not.toMatch(/Surrogate keys via ROW_NUMBER/);
    expect(prompt).toMatch(/NEVER ROW_NUMBER\(\)/);
    const ai = read('ai/AIService.ts');
    expect(ai).not.toMatch(/ROW_NUMBER for dims/);
    expect(ai).not.toMatch(/surrogate key via ROW_NUMBER\(\) OVER/);
    expect(ai).toMatch(/Never introduce ROW_NUMBER\(\)/);
  });
});

// ─── D3 — the pure half ────────────────────────────────────────────────────

describe('D3 — a vanished source column is told apart from a bookkeeping slip', () => {
  it('reads the column name off every DuckDB message shape the runner meets', () => {
    expect(missingColumnFromError('Binder Error: Referenced column "Phone" not found in FROM clause!')).toBe('Phone');
    expect(missingColumnFromError('Binder Error: Values list "pe" does not have a column named "AccountCode"')).toBe('AccountCode');
    expect(missingColumnFromError('Binder Error: Table "a" does not have a column named "Country"')).toBe('Country');
    expect(missingColumnFromError('Catalog Error: Column with name Phone does not exist!')).toBe('Phone');
    expect(missingColumnFromError('Binder Error: Column "Country" referenced that exists in the SELECT clause - but this column cannot be referenced before it is defined')).toBe('Country');
    expect(missingColumnFromError('Parser Error: syntax error at or near "FORM"')).toBeNull();
  });

  it('schema loss needs BOTH facts: the SQL published before AND the column exists nowhere now', () => {
    const msg = 'Binder Error: Referenced column "Phone" not found in FROM clause!';
    expect(classifyBindFailure({ errorMessage: msg, publishedBefore: true, columnExistsSomewhere: false })).toEqual({ kind: 'schema_loss', column: 'Phone' });
    // First-ever run: the model named a column that never existed.
    expect(classifyBindFailure({ errorMessage: msg, publishedBefore: false, columnExistsSomewhere: false })).toEqual({ kind: 'design_slip', column: 'Phone' });
    // The column is on another alias: a slip, not a loss.
    expect(classifyBindFailure({ errorMessage: msg, publishedBefore: true, columnExistsSomewhere: true })).toEqual({ kind: 'design_slip', column: 'Phone' });
    expect(classifyBindFailure({ errorMessage: 'Conversion Error: Could not convert', publishedBefore: true, columnExistsSomewhere: false })).toBeNull();
  });

  it('the stored sentence names the column and says the SQL was not changed', () => {
    const r = degradedReason('Phone', 'dim_account');
    expect(r).toContain('"Phone"');
    expect(r).toContain('dim_account');
    expect(r).toContain('stored SQL is unchanged');
  });

  it('the runner persists a repair only when it is NOT schema loss (source-level)', () => {
    const src = read('services/transformationRunner.ts');
    expect(src).toMatch(/if \(aiRepaired && !schemaLoss\)/);
    expect(src).toMatch(/recordDegradedState\(tenantId, product, table, schemaLoss\)/);
  });
});

// ─── E5 ────────────────────────────────────────────────────────────────────

describe('E5 — one provenance ladder', () => {
  it('a person outranks every channel; the vendor outranks Clarion; a model is a draft until checked', () => {
    expect(provenanceOf({ semanticSource: 'ai', editedByUser: true })).toBe('human');
    expect(provenanceOf({ semanticSource: 'vendor_docs', confirmedByUser: true })).toBe('human');
    expect(provenanceOf({ semanticSource: 'declared' })).toBe('declared');
    expect(provenanceOf({ semanticSource: 'vendor_docs' })).toBe('declared');
    expect(provenanceOf({ semanticSource: 'curated' })).toBe('curated');
    expect(provenanceOf({ semanticSource: 'name_pattern' })).toBe('derived');
    expect(provenanceOf({ semanticSource: 'value_overlap' })).toBe('derived');
    expect(provenanceOf({ semanticSource: 'ai', aiDraft: true })).toBe('ai_draft');
    expect(provenanceOf({ semanticSource: 'ai_model', aiDraft: true })).toBe('ai_draft');
  });

  it('ai_verified is distinguishable from ai_draft: an approval or a strong measurement', () => {
    expect(provenanceOf({ semanticSource: 'ai', aiDraft: false, approvalStatus: 'approved' })).toBe('ai_verified');
    expect(provenanceOf({ semanticSource: 'ai_enriched', aiDraft: false, approvalStatus: 'approved' })).toBe('ai_verified');
    expect(provenanceOf({ semanticSource: 'ai_model', aiDraft: true, measured: { verdict: 'strong' } })).toBe('ai_verified');
    expect(provenanceOf({ semanticSource: 'ai_model', aiDraft: true, measured: { verdict: 'broken' } })).toBe('ai_draft');
    // A relationship row has no approval_status; not-a-draft is enough there.
    expect(provenanceOf({ semanticSource: 'ai_suggested', aiDraft: false })).toBe('ai_verified');
  });

  it('a row written before provenance was recorded is unknown, never dressed up', () => {
    expect(provenanceOf({ semanticSource: null })).toBe('unknown');
    expect(provenanceOf({ semanticSource: null, aiDraft: false, approvalStatus: 'approved' })).toBe('unknown');
    expect(provenanceOf({ semanticSource: null, editedByUser: true })).toBe('human');
    for (const r of PROVENANCE_RUNGS) expect(PROVENANCE_LABEL[r].label.length).toBeGreaterThan(0);
  });

  it('the builder stamps the rung on product_relationships and column_lineage: asserted vs derived', async () => {
    const matrix = {
      rationale: 'test', dim_date_range: { start: '2024-01-01', end: '2024-12-31' },
      conformed_dimensions: [{
        table_name: 'dim_customer', display_name: 'Customer', description: 'x',
        transformation_sql: 'SELECT c.id AS customer_key, c.name AS customer_name FROM customers c',
        source_tables: ['customers'],
        columns: [
          // Lineage the design ASSERTED.
          { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'k', description: 'k', column_role: 'surrogate_key', transformation_expression: 'c.id',
            lineage: [{ source_table_name: 'customers', source_column_name: 'id', transformation_description: 'Natural key' }] },
          // Lineage Clarion DERIVES from the expression.
          { column_name: 'customer_name', data_type: 'VARCHAR', display_name: 'n', description: 'n', column_role: 'attribute', transformation_expression: 'c.name' },
        ],
      }],
      fact_tables: [{
        table_name: 'fact_sales', display_name: 'Sales', description: 'x', grain: 'g', fact_table_type: 'transaction',
        transformation_sql: 'SELECT s.customer_id AS customer_key, s.amount, TRY_CAST(strftime(s.d, \'%Y%m%d\') AS INTEGER) AS date_key FROM sales s',
        source_tables: ['sales'], dimensions_used: ['dim_customer', 'dim_date'],
        columns: [
          { column_name: 'customer_key', data_type: 'INTEGER', display_name: 'k', description: 'k', column_role: 'foreign_key', transformation_expression: 's.customer_id', fk_target_table: 'dim_customer', fk_target_column: 'customer_key' },
          { column_name: 'date_key', data_type: 'INTEGER', display_name: 'd', description: 'd', column_role: 'foreign_key', transformation_expression: 'TRY_CAST(strftime(s.d, \'%Y%m%d\') AS INTEGER)', fk_target_table: 'dim_date', fk_target_column: 'date_key' },
          { column_name: 'amount', data_type: 'DECIMAL', display_name: 'a', description: 'a', column_role: 'measure', transformation_expression: 's.amount', additivity: 'additive' },
        ],
      }],
      // The customer join is asserted; the dim_date join is NOT (the model
      // reliably omits it) and gets synthesised from the FK metadata.
      relationships: [{ from_table_name: 'fact_sales', from_column_name: 'customer_key', to_table_name: 'dim_customer', to_column_name: 'customer_key', relationship_type: 'fact_to_dim' }],
      data_products: [{ name: 'Sales P1', description: 'x', build_order: 1, fact_tables: ['fact_sales'], owned_dimensions: ['dim_customer'] }],
      proposed_kpis: [],
    } as unknown as BusMatrixOutput;

    const { products } = await buildBusMatrix({ connectionId, tenantId, userEmail: 'a@b', busMatrix: matrix });
    const pid = products[0].id;
    const rels = await db('product_relationships as pr')
      .join('star_schemas as ss', 'ss.id', 'pr.star_schema_id')
      .join('product_tables as tt', 'tt.id', 'pr.to_table_id')
      .where('ss.data_product_id', pid)
      .select('tt.table_name as to_table', 'pr.provenance');
    const byTarget = new Map(rels.map((r: { to_table: string; provenance: string }) => [r.to_table, r.provenance]));
    expect(byTarget.get('dim_customer')).toBe('ai_draft');
    expect(byTarget.get('dim_date')).toBe('derived');

    const lineage = await db('column_lineage as cl')
      .join('product_columns as pc', 'pc.id', 'cl.product_column_id')
      .join('product_tables as pt', 'pt.id', 'pc.product_table_id')
      .join('star_schemas as ss', 'ss.id', 'pt.star_schema_id')
      .where('ss.data_product_id', pid).where('pt.table_name', 'dim_customer')
      .select('pc.column_name', 'cl.provenance');
    const byCol = new Map(lineage.map((l: { column_name: string; provenance: string }) => [l.column_name, l.provenance]));
    expect(byCol.get('customer_key')).toBe('ai_draft');
    expect(byCol.get('customer_name')).toBe('derived');

    // A template build stamps `curated` on what it asserted.
    const { products: tp } = await buildBusMatrix({ connectionId, tenantId, userEmail: 'a@b', busMatrix: { ...matrix, data_products: [{ ...matrix.data_products[0], name: 'Sales T1' }] } as BusMatrixOutput, templateVersion: 1 });
    const trel = await db('product_relationships as pr')
      .join('star_schemas as ss', 'ss.id', 'pr.star_schema_id')
      .join('product_tables as tt', 'tt.id', 'pr.to_table_id')
      .where('ss.data_product_id', tp[0].id).where('tt.table_name', 'dim_customer').first('pr.provenance');
    expect(trel.provenance).toBe('curated');
  });

  it('the review queue and the canvas graph carry the rung', async () => {
    await db('source_tables').where({ id: guidTable }).update({ ai_draft: true, semantic_source: 'ai' });
    await db('source_columns').where({ id: guidCol }).update({ ai_draft: true, semantic_source: 'ai', edited_by_user: true });
    await db('table_relationships').insert({
      tenant_id: tenantId, from_table_id: guidTable, from_column_id: guidCol, to_table_id: codeTable, to_column_id: idCol,
      relationship_type: 'many_to_one', ai_draft: true, semantic_source: 'ai_model',
      measured: JSON.stringify({ verdict: 'strong', reason: 'ok' }),
    });
    const queue = await (await request()).get('/api/semantic/pending-approvals').set('Authorization', `Bearer ${token}`);
    expect(queue.status).toBe(200);
    const items = queue.body.data as Array<{ type: string; id: number; provenance: string }>;
    expect(items.find((i) => i.type === 'table' && i.id === guidTable)?.provenance).toBe('ai_draft');
    expect(items.find((i) => i.type === 'column' && i.id === guidCol)?.provenance).toBe('human');
    expect(items.find((i) => i.type === 'relationship')?.provenance).toBe('ai_verified');

    const graph = await (await request()).get(`/api/relationships/graph?connectionId=${connectionId}&withColumns=1`).set('Authorization', `Bearer ${token}`);
    expect(graph.status).toBe(200);
    expect(graph.body.data.relationships[0].rung).toBe('ai_verified');
    // E6: the declared type rides the column payload the canvas draws from.
    const col = (graph.body.data.columns as Array<{ id: number; source_data_type: string | null }>).find((c) => c.id === guidCol);
    expect(col?.source_data_type).toBe('Edm.Guid');
  });
});

// ─── E6 ────────────────────────────────────────────────────────────────────

describe('E6 — the declared source type settles a GUID→code link before any data is read', () => {
  const measure = (fromColumnId: number, toColumnId: number) =>
    request().then((r) => r.post('/api/relationships/measure').set('Authorization', `Bearer ${token}`)
      .send({ fromTableId: guidTable, fromColumnId, toTableId: codeTable, toColumnId }));

  it('a GUID against a code is broken with reason type-mismatch, and names both types', async () => {
    const res = await measure(guidCol, codeCol);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.verdict).toBe('broken');
    expect(res.body.data.reason).toBe('type-mismatch');
    expect(res.body.data.types).toEqual({ from: 'Edm.Guid', to: 'Edm.String' });
    expect(res.body.data.containment).toBeNull();
  });

  it('rejects only on positive evidence: an untyped column is not refused here', async () => {
    // Same class, or unknown, proceeds to the measurement — which needs a
    // warehouse this connection does not have, so the route errors AFTER
    // the type gate. What is pinned is that the gate did not fire.
    const res = await measure(guidCol, untypedCol);
    expect(res.body?.data?.reason ?? null).not.toBe('type-mismatch');
  });

  it('the profiler persists source_data_type from the connector docs (source-level)', () => {
    const src = read('semantic/SchemaProfiler.ts');
    expect(src).toMatch(/source_data_type: cp\.sourceDataType/);
    expect(src).toMatch(/sourceDataType: cDoc\?\.dataType \?\? null/);
    // …and refuses heuristic candidates on those types before measuring.
    expect(src).toMatch(/typesJoinable\(declaredType\(fk\.fromTable, fk\.fromColumn\), declaredType\(fk\.toTable, fk\.toColumn\)\)/);
  });
});
