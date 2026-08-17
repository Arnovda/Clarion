/**
 * The rule that decides whether a documented foreign key may claim the
 * source's authority. Its two failure modes are opposite and both costly:
 * too strict and it deletes real relationships from connectors that publish
 * odd type names; too loose and a GUID key keeps swallowing code columns.
 */
import { describe, expect, it } from 'vitest';
import { typeClass, typesJoinable } from './columnTypes';
import { EXACT_ONLINE_COLUMN_DOCS } from './exactonline/docs';
import { EXACT_ONLINE_KNOWN_RELATIONSHIPS } from './exactonline/entities';

describe('typeClass', () => {
  it('reads OData, SQL and plain type names', () => {
    expect(typeClass('Edm.Guid')).toBe('guid');
    expect(typeClass('uniqueidentifier')).toBe('guid');
    expect(typeClass('Edm.String')).toBe('string');
    expect(typeClass('varchar(64)')).toBe('string');
    expect(typeClass('Edm.Int32')).toBe('number');
    expect(typeClass('bigint')).toBe('number');
    expect(typeClass('Edm.Byte')).toBe('number');
    expect(typeClass('Edm.Boolean')).toBe('bool');
    expect(typeClass('Edm.DateTime')).toBe('datetime');
  });

  it('says unknown rather than guessing', () => {
    expect(typeClass(undefined)).toBe('unknown');
    expect(typeClass('')).toBe('unknown');
    expect(typeClass('some_vendor_type')).toBe('unknown');
  });
});

describe('typesJoinable', () => {
  it('separates a GUID key from a code column — the defect this exists for', () => {
    // TransactionLines.JournalCode → Journals.ID, as the vendor's docs
    // hyperlink resolved it. Measures 0%; Journals.Code measures 100%.
    expect(typesJoinable('Edm.String', 'Edm.Guid')).toBe(false);
    expect(typesJoinable('Edm.Int32', 'Edm.Guid')).toBe(false);
    expect(typesJoinable('Edm.String', 'Edm.String')).toBe(true);
    expect(typesJoinable('Edm.Guid', 'Edm.Guid')).toBe(true);
  });

  it('REJECTS ONLY ON EVIDENCE — an unreadable or absent type is joinable', () => {
    // Odoo's docs channel publishes no types at all. If unknown were treated
    // as a mismatch this rule would silently delete every relationship it
    // ships, which is the opposite of the bug being fixed.
    expect(typesJoinable(undefined, 'Edm.Guid')).toBe(true);
    expect(typesJoinable('Edm.Guid', undefined)).toBe(true);
    expect(typesJoinable('some_vendor_type', 'Edm.Guid')).toBe(true);
    expect(typesJoinable(undefined, undefined)).toBe(true);
  });
});

describe('the Exact Online catalogue, against the rule', () => {
  const col = (entity: string, name: string) =>
    EXACT_ONLINE_COLUMN_DOCS[entity]?.find((c) => c.name === name);

  it('every curated relationship names real columns whose types line up', () => {
    // 15 of the original 81 named a column absent from the vendor's own
    // property list (`BankEntries.Journal` where the API has `JournalCode`);
    // the profiler dropped those at runtime, so the link just never appeared.
    const errs: string[] = [];
    for (const r of EXACT_ONLINE_KNOWN_RELATIONSHIPS) {
      const from = col(r.fromTable, r.fromColumn);
      const to = col(r.toTable, r.toColumn);
      const id = `${r.fromTable}.${r.fromColumn}→${r.toTable}.${r.toColumn}`;
      if (!from) errs.push(`${id}: fromColumn not documented`);
      if (!to) errs.push(`${id}: toColumn not documented`);
      if (from && to && !typesJoinable(from.dataType, to.dataType)) {
        errs.push(`${id}: ${from.dataType} vs ${to.dataType}`);
      }
    }
    expect(errs).toEqual([]);
  });

  it('still carries the journal link the vendor got wrong', () => {
    // The vendor's own reference sends JournalCode to Journals.ID and is now
    // refused, so this curated entry is the ONLY thing asserting the link.
    // If it is ever removed, the relationship disappears from Confirmed.
    const journal = EXACT_ONLINE_KNOWN_RELATIONSHIPS.find(
      (r) => r.fromTable === 'TransactionLines' && r.fromColumn === 'JournalCode',
    );
    expect(journal?.toTable).toBe('Journals');
    expect(journal?.toColumn).toBe('Code');
  });
});
