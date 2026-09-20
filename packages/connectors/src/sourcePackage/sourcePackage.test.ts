/**
 * The source-package format — validator, loader ordering, projections and
 * the YAML writer. The two shipped packages are exercised by the conformance
 * suite and the connector suites; this file pins the FORMAT's own rules on a
 * small synthetic package, both directions.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import {
  _clearSourcePackageCacheForTests,
  loadSourcePackage,
  toColumnDocs,
  toEntityDescriptors,
  toKnownRelationships,
  toStarSchemaTemplate,
  toYaml,
  validateSourcePackage,
  type SourcePackage,
} from './index';

function basePackage(): SourcePackage {
  return {
    version: 1,
    name: 'demo',
    clarion: {
      provenance: 'curated',
      fieldCoverage: 'complete',
      categories: ['Sales', 'CRM'],
      template: { version: 1, products: [{ name: 'Core', description: 'Shared lookups.', buildOrder: 1 }, { name: 'Sales', description: 'Sales.', buildOrder: 2 }] },
    },
    datasets: [
      {
        name: 'Accounts', label: 'Accounts', description: 'Customers.', source: '/crm/Accounts', primary_key: ['ID'],
        clarion: { kind: 'source', category: 'CRM', sync: { cursor: { field: 'Modified', type: 'timestamp' } } },
        fields: [
          { name: 'ID', description: 'Primary key', datatype: 'Edm.Guid', clarion: { role: 'dimension' } },
          { name: 'Name', description: 'Name', datatype: 'Edm.String', clarion: { role: 'dimension' } },
          { name: 'Modified', description: 'Last modified', datatype: 'Edm.DateTime', clarion: { role: 'dimension' } },
        ],
      },
      {
        name: 'Invoices', label: 'Invoices', description: 'Invoice headers.', source: '/sales/Invoices', primary_key: ['ID'],
        clarion: { kind: 'source', category: 'Sales', sync: { cursor: { field: 'Modified', type: 'timestamp' }, requiresSelect: true } },
        fields: [
          { name: 'ID', description: 'Primary key', datatype: 'Edm.Guid', clarion: { role: 'dimension' } },
          { name: 'Account', description: 'Billed account', datatype: 'Edm.Guid', clarion: { role: 'dimension', references: { dataset: 'Accounts', field: 'ID' } } },
          { name: 'Amount', description: 'Amount', datatype: 'Edm.Double', clarion: { role: 'measure' } },
          { name: 'Modified', description: 'Last modified', datatype: 'Edm.DateTime', clarion: { role: 'dimension' } },
        ],
      },
      {
        name: 'dim_account', label: 'Accounts', description: 'One row per account.', source: 'SELECT ID AS account_id, Name AS account_name FROM Accounts',
        clarion: { kind: 'dimension', product: 'Core', sourceEntities: ['Accounts'] },
        fields: [
          { name: 'account_id', label: 'Account ID', description: 'GUID.', datatype: 'VARCHAR', clarion: { role: 'natural_key', technical: true, lineage: { dataset: 'Accounts', field: 'ID' } } },
          { name: 'account_name', label: 'Account name', description: 'Name.', datatype: 'VARCHAR', clarion: { role: 'attribute', lineage: { dataset: 'Accounts', field: 'Name' } } },
        ],
      },
      {
        name: 'fact_invoices', label: 'Invoices', description: 'One row per invoice.', source: 'SELECT ID AS invoice_id, Account AS account_id, Amount AS amount FROM Invoices',
        clarion: { kind: 'fact', product: 'Sales', sourceEntities: ['Invoices'], grain: 'One row per invoice', factTableType: 'transaction' },
        fields: [
          { name: 'invoice_id', label: 'Invoice ID', description: 'GUID.', datatype: 'VARCHAR', clarion: { role: 'natural_key', technical: true, lineage: { dataset: 'Invoices', field: 'ID' } } },
          { name: 'account_id', label: 'Account', description: 'Billed account.', datatype: 'VARCHAR', clarion: { role: 'foreign_key', technical: true, references: { dataset: 'dim_account', field: 'account_id' }, lineage: { dataset: 'Invoices', field: 'Account' } } },
          { name: 'amount', label: 'Amount', description: 'Invoice amount.', datatype: 'DOUBLE', clarion: { role: 'measure', additivity: 'additive', lineage: { dataset: 'Invoices', field: 'Amount' } } },
        ],
      },
    ],
    relationships: [
      { from: 'Invoices', from_columns: ['Account'], to: 'Accounts', to_columns: ['ID'], description: 'Billed account.' },
    ],
    metrics: [
      { name: 'Revenue', description: 'Sum of invoices.', expression: 'SELECT SUM(amount) FROM fact_invoices', clarion: { formulaPlainText: 'Sum of amounts', additivity: 'additive', product: 'Sales', requiresTables: ['fact_invoices'] } },
    ],
  };
}

const clone = (p: SourcePackage): SourcePackage => JSON.parse(JSON.stringify(p));

describe('validateSourcePackage', () => {
  it('accepts the demo package', () => {
    expect(validateSourcePackage(basePackage())).toEqual([]);
  });

  it('refuses an unknown key — a typo must not silently vanish', () => {
    const p = clone(basePackage()) as unknown as Record<string, unknown>;
    (p.datasets as Array<Record<string, unknown>>)[0].descripton = 'oops';
    const errs = validateSourcePackage(p);
    expect(errs.some((e) => e.includes("unknown key 'descripton'"))).toBe(true);
  });

  it('refuses a template join written in the relationships list — it belongs on the FK field', () => {
    const p = clone(basePackage());
    p.relationships!.push({ from: 'fact_invoices', from_columns: ['account_id'], to: 'dim_account', to_columns: ['account_id'] });
    expect(validateSourcePackage(p).some((e) => e.includes('template joins are written on the fact'))).toBe(true);
  });

  it('refuses a source role on a modelled field and a modelled role on a source field', () => {
    const p = clone(basePackage());
    p.datasets[0].fields![0].clarion = { role: 'natural_key' };
    p.datasets[2].fields![1].clarion = { role: 'dimension', lineage: { dataset: 'Accounts', field: 'Name' } };
    const errs = validateSourcePackage(p);
    expect(errs.some((e) => e.includes("role 'natural_key' is not a source-field role"))).toBe(true);
    expect(errs.some((e) => e.includes("role 'dimension' is not a modelled-field role"))).toBe(true);
  });

  it('holds lineage and relationships to the documented fields only when fieldCoverage is complete', () => {
    const p = clone(basePackage());
    p.datasets[2].fields![1].clarion!.lineage = { dataset: 'Accounts', field: 'Nope' };
    expect(validateSourcePackage(p).some((e) => e.includes('lineage Accounts.Nope is not a documented field'))).toBe(true);
    p.clarion.fieldCoverage = 'partial';
    expect(validateSourcePackage(p)).toEqual([]);
  });

  it('refuses two datasets whose names differ only by case (warehouse names are case-insensitive)', () => {
    const p = clone(basePackage());
    p.datasets.push({ ...clone(p.datasets[0]), name: 'accounts' });
    expect(validateSourcePackage(p).some((e) => e.includes('collides with'))).toBe(true);
  });

  it('refuses a product that builds nothing, a metric on an unknown product, and a fact without a grain', () => {
    const p = clone(basePackage());
    p.clarion.template!.products.push({ name: 'Idle', description: 'Nothing.', buildOrder: 3 });
    p.metrics![0].clarion.product = 'Elsewhere';
    delete p.datasets[3].clarion.grain;
    const errs = validateSourcePackage(p);
    expect(errs.some((e) => e.includes("template product 'Idle' builds no table"))).toBe(true);
    expect(errs.some((e) => e.includes("product 'Elsewhere' is not a template product"))).toBe(true);
    expect(errs.some((e) => e.includes("grain must start with 'One row per'"))).toBe(true);
  });

  it('refuses a cursor without a primary key — incremental sync would wipe unchanged rows', () => {
    const p = clone(basePackage());
    delete p.datasets[0].primary_key;
    expect(validateSourcePackage(p).some((e) => e.includes('declares a sync cursor but no primary_key'))).toBe(true);
  });
});

describe('projections', () => {
  it('derives supportsIncremental, the business key and the display name for entities', () => {
    const [accounts, invoices] = toEntityDescriptors(basePackage());
    expect(accounts).toEqual({
      name: 'Accounts', displayName: 'Accounts', category: 'CRM', description: 'Customers.',
      supportsIncremental: true, incrementalCursor: { field: 'Modified', type: 'timestamp' }, businessKey: 'ID',
    });
    expect(invoices.name).toBe('Invoices');
  });

  it('maps fields to column docs with the vendor type verbatim and the reference in table/column space', () => {
    const docs = toColumnDocs(basePackage());
    expect(docs.Invoices[1]).toEqual({
      name: 'Account', description: 'Billed account', role: 'dimension', dataType: 'Edm.Guid',
      references: { table: 'Accounts', column: 'ID' },
    });
    expect(Object.keys(docs)).toEqual(['Accounts', 'Invoices']);
  });

  it('defaults a relationship to many_to_one', () => {
    expect(toKnownRelationships(basePackage())).toEqual([
      { fromTable: 'Invoices', fromColumn: 'Account', toTable: 'Accounts', toColumn: 'ID', type: 'many_to_one', description: 'Billed account.' },
    ]);
  });

  it('derives the template joins, dimensionsUsed and product ownership from the fields', () => {
    const t = toStarSchemaTemplate(basePackage())!;
    expect(t.relationships).toEqual([
      { fromTable: 'fact_invoices', fromColumn: 'account_id', toTable: 'dim_account', toColumn: 'account_id', type: 'fact_to_dim' },
    ]);
    expect(t.facts[0].dimensionsUsed).toEqual(['dim_account']);
    expect(t.products).toEqual([
      { name: 'Core', description: 'Shared lookups.', buildOrder: 1, factTables: [], ownedDimensions: ['dim_account'] },
      { name: 'Sales', description: 'Sales.', buildOrder: 2, factTables: ['fact_invoices'], ownedDimensions: [] },
    ]);
    expect(t.facts[0].columns[1]).toMatchObject({ role: 'foreign_key', fkTargetTable: 'dim_account', fkTargetColumn: 'account_id', isTechnical: true, sourceEntity: 'Invoices', sourceColumn: 'Account' });
    expect(t.kpis[0]).toEqual({
      name: 'Revenue', description: 'Sum of invoices.', formulaPlainText: 'Sum of amounts', formulaSql: 'SELECT SUM(amount) FROM fact_invoices',
      additivity: 'additive', productName: 'Sales', requiresTables: ['fact_invoices'],
    });
  });

  it('keeps an explicit dimensionsUsed (dim_date is never derivable)', () => {
    const p = basePackage();
    p.datasets[3].clarion.dimensionsUsed = ['dim_account', 'dim_date'];
    expect(toStarSchemaTemplate(p)!.facts[0].dimensionsUsed).toEqual(['dim_account', 'dim_date']);
  });

  it('returns null for a package without a template', () => {
    const p = basePackage();
    p.datasets = p.datasets.slice(0, 2);
    delete p.clarion.template;
    p.metrics = [];
    expect(toStarSchemaTemplate(p)).toBeNull();
  });
});

describe('loadSourcePackage', () => {
  it('merges datasets/ and model/ files, validates, and orders by category then name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-pkg-'));
    try {
      const p = basePackage();
      const [accounts, invoices, dim, fact] = p.datasets;
      fs.mkdirSync(path.join(dir, 'datasets')); fs.mkdirSync(path.join(dir, 'model'));
      fs.writeFileSync(path.join(dir, 'package.yaml'), toYaml({ ...p, datasets: undefined }));
      // File names deliberately out of the wanted order: the loader must not care.
      fs.writeFileSync(path.join(dir, 'datasets', 'a_Invoices.yaml'), toYaml(invoices));
      fs.writeFileSync(path.join(dir, 'datasets', 'b_Accounts.yaml'), toYaml(accounts));
      fs.writeFileSync(path.join(dir, 'model', 'z_fact.yaml'), toYaml(fact));
      fs.writeFileSync(path.join(dir, 'model', 'a_dim.yaml'), toYaml(dim));
      _clearSourcePackageCacheForTests();
      const loaded = loadSourcePackage(dir);
      // Sales is listed before CRM in clarion.categories, so Invoices leads.
      expect(loaded.datasets.map((d) => d.name)).toEqual(['Invoices', 'Accounts', 'dim_account', 'fact_invoices']);
      expect(validateSourcePackage(loaded)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws naming every violation when a file is invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarion-pkg-'));
    try {
      const p = basePackage();
      fs.writeFileSync(path.join(dir, 'package.yaml'), toYaml({ ...p, datasets: [p.datasets[0], { ...p.datasets[2], clarion: { ...p.datasets[2].clarion, product: 'Nowhere' } }] }));
      _clearSourcePackageCacheForTests();
      expect(() => loadSourcePackage(dir)).toThrow(/product 'Nowhere' is not a template product/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('toYaml', () => {
  it('renders the small always-together maps inline, keeps SQL as a literal block, and round-trips', () => {
    const p = basePackage();
    const text = toYaml(p.datasets[3], 'header line');
    expect(text.startsWith('# header line\n')).toBe(true);
    // A field's `clarion` map renders inline while it is small (≤3 entries)…
    expect(text).toContain('clarion: { role: measure, additivity: additive, lineage: { dataset: Invoices, field: Amount } }');
    // …and a foreign key's four-entry map stays in block style, with only the
    // two always-together maps inline — the same shape the generated
    // model/*.yaml files carry, so a regenerated file diffs clean.
    expect(text).toContain(
      '    clarion:\n      role: foreign_key\n      technical: true\n'
      + '      references: { dataset: dim_account, field: account_id }\n'
      + '      lineage: { dataset: Invoices, field: Account }\n',
    );
    expect(text).toContain('sourceEntities: [ Invoices ]');
    expect(parseYaml(text)).toEqual(p.datasets[3]);
    // A dataset-level clarion block with a nested sync map stays in block style.
    const src = toYaml(p.datasets[1]);
    expect(src).toContain('clarion:\n  kind: source\n  category: Sales\n  sync:\n    cursor: { field: Modified, type: timestamp }\n    requiresSelect: true');
  });
});
