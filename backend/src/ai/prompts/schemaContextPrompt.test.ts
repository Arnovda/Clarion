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

  it('Pass C omits the sibling block for tables outside the batch or without docs', () => {
    const otherDocs: VendorDocsContext = {
      tableDescriptions: {},
      columnsByTable: { SomeOtherTable: [{ name: 'A', description: 'B' }] },
    };
    const p = buildColumnDescriptionsUser('exactonline', tableContext, tables as never, [], '', otherDocs);
    expect(p).not.toContain('VENDOR-DOCUMENTED SIBLING COLUMNS');
  });
});
