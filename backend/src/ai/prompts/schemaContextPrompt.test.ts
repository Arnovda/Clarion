/**
 * Pure-function tests for the vendor-docs context blocks added to the
 * Pass B / Pass C prompt builders (semantic-enrichment-plan Phase 1).
 * No DB, no AI — string assembly only.
 */
import { describe, expect, it } from 'vitest';
import {
  buildTableContextUser,
  buildColumnDescriptionsUser,
  type VendorDocsContext,
  type TableContextOutput,
} from './schemaContextPrompt';

const tables = [
  {
    tableName: 'Accounts',
    columns: [{ name: 'x_custom_field', type: 'VARCHAR', sampleValues: ['a'] }],
  },
] as never[];

const tableContext: TableContextOutput = {
  tables: [{ table_name: 'Accounts', display_name: 'Accounts', description: 'Customers', grain: '1 row per account' }],
  relationships: [],
};

const vendorDocs: VendorDocsContext = {
  tableDescriptions: { Accounts: 'CRM accounts: customers, suppliers and leads' },
  columnsByTable: {
    Accounts: [
      { name: 'Classification1', description: 'Account classification 1' },
      { name: 'City', description: 'Visit address City' },
      { name: 'LongOne', description: 'x'.repeat(400) },
    ],
  },
};

describe('vendor-docs context in AI prompts', () => {
  it('Pass B includes vendor table definitions when supplied', () => {
    const withDocs = buildTableContextUser('exactonline', null, tables, [], [], '', vendorDocs);
    expect(withDocs).toContain('VENDOR-DOCUMENTED TABLES');
    expect(withDocs).toContain('CRM accounts: customers, suppliers and leads');

    const withoutDocs = buildTableContextUser('exactonline', null, tables, [], []);
    expect(withoutDocs).not.toContain('VENDOR-DOCUMENTED TABLES');
  });

  it('Pass C includes sibling vocabulary for batch tables, truncated', () => {
    const p = buildColumnDescriptionsUser('exactonline', tableContext, tables as never, [], '', vendorDocs);
    expect(p).toContain('VENDOR-DOCUMENTED SIBLING COLUMNS');
    expect(p).toContain('Classification1: Account classification 1');
    // 400-char description truncated to the cap (119 chars + ellipsis).
    expect(p).toContain(`${'x'.repeat(119)}…`);
    expect(p).not.toContain('x'.repeat(200));
  });

  // ── Soft context: source-package notes (source-wide + per table) ──────
  const notesDocs: VendorDocsContext = {
    tableDescriptions: {},
    columnsByTable: {},
    sourceNotes: 'Columns ending in `DC` are in the division currency and additive.\n\nCredit notes are natively negative.',
    tableNotes: {
      Accounts: 'Three account ROLES exist on invoices: InvoiceTo, OrderedBy, DeliverTo.',
      SomeOtherTable: 'Must not appear — not in scope.',
      Long: 'y'.repeat(900),
    },
  };

  it('Pass B renders the VENDOR NOTES block: whole-source note first, then only in-scope tables, flattened', () => {
    const p = buildTableContextUser('exactonline', null, tables, [], [], '', notesDocs);
    expect(p).toContain('VENDOR NOTES');
    const whole = p.indexOf('- Whole source: Columns ending in `DC` are in the division currency and additive. Credit notes are natively negative.');
    const acc = p.indexOf('- Accounts: Three account ROLES exist on invoices');
    expect(whole).toBeGreaterThan(-1);
    expect(acc).toBeGreaterThan(whole);
    expect(p).not.toContain('Must not appear');
    // Markdown paragraphs are flattened to one line — a note never breaks the list.
    expect(p).not.toContain('additive.\n\nCredit');
  });

  it('Pass C carries the same notes into every batch, scoped to the batch tables, and caps a long table note', () => {
    const longTables = [
      ...tables,
      { tableName: 'Long', columns: [{ name: 'a', type: 'VARCHAR', sampleValues: ['a'] }] },
    ] as never[];
    const ctx: TableContextOutput = {
      tables: [
        ...tableContext.tables,
        { table_name: 'Long', display_name: 'Long', description: 'Long', grain: '1 row' },
      ],
      relationships: [],
    };
    const p = buildColumnDescriptionsUser('exactonline', ctx, longTables as never, [], '', notesDocs);
    expect(p).toContain('- Whole source: Columns ending in `DC`');
    expect(p).toContain('- Accounts: Three account ROLES');
    expect(p).not.toContain('Must not appear');
    // 900-char table note truncated to the 700 cap (699 chars + ellipsis).
    expect(p).toContain(`${'y'.repeat(699)}…`);
    expect(p).not.toContain('y'.repeat(800));
  });

  it('renders no VENDOR NOTES block when the package ships none', () => {
    const p = buildTableContextUser('exactonline', null, tables, [], [], '', vendorDocs);
    expect(p).not.toContain('VENDOR NOTES');
    const c = buildColumnDescriptionsUser('exactonline', tableContext, tables as never, [], '', vendorDocs);
    expect(c).not.toContain('VENDOR NOTES');
  });

  it('Pass C omits the sibling block for tables outside the batch or without docs', () => {
    const otherDocs: VendorDocsContext = {
      tableDescriptions: {},
      columnsByTable: { SomeOtherTable: [{ name: 'A', description: 'B' }] },
    };
    const p = buildColumnDescriptionsUser('exactonline', tableContext, tables as never, [], '', otherDocs);
    expect(p).not.toContain('VENDOR-DOCUMENTED SIBLING COLUMNS');
  });
});
