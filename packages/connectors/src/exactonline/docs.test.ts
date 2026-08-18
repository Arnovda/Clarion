/**
 * ExactOnline curated column-docs tests.
 *
 * `EXACT_ONLINE_COLUMN_DOCS` is transcribed from the vendor's REST reference
 * (Tier 2 curation, docs/SOURCE_ONBOARDING.md). These tests are the
 * conformance gate for the transcription data: entity keys must exist in the
 * catalog, column docs must be warehouse-safe and non-empty, and
 * `describeEntities` must serve them statically at `curated` provenance.
 */

import { describe, expect, it } from 'vitest';
import { ExactOnlineConnector } from './ExactOnlineConnector';
import { EXACT_ONLINE_COLUMN_DOCS } from './docs';
import { ENTITIES_BY_NAME, EXACT_ONLINE_ENTITIES } from './entities';
import { validateDocumentedRelationships } from '../conformance';
import { typesJoinable } from '../columnTypes';
import { createNoopLogger } from '../logging';
import type { ProbeContext } from '../types';

const SAFE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const config = {
  clientId: 'id',
  clientSecret: 'secret',
  refreshToken: 'token',
  division: '123456',
  baseUrl: 'https://start.exactonline.nl',
};
const probeCtx: ProbeContext = { log: createNoopLogger() };

describe('EXACT_ONLINE_COLUMN_DOCS (transcription data invariants)', () => {
  it('documents only entities that exist in the catalog', () => {
    const unknown = Object.keys(EXACT_ONLINE_COLUMN_DOCS).filter((k) => !ENTITIES_BY_NAME.has(k));
    expect(unknown).toEqual([]);
  });

  it('has meaningful coverage', () => {
    const entityCount = Object.keys(EXACT_ONLINE_COLUMN_DOCS).length;
    const columnCount = Object.values(EXACT_ONLINE_COLUMN_DOCS).reduce((s, c) => s + c.length, 0);
    expect(entityCount).toBeGreaterThanOrEqual(40);
    expect(columnCount).toBeGreaterThanOrEqual(1000);
  });

  it('every column doc is warehouse-safe, described, deduped, with a valid role', () => {
    const errs: string[] = [];
    for (const [entity, cols] of Object.entries(EXACT_ONLINE_COLUMN_DOCS)) {
      const seen = new Set<string>();
      for (const c of cols) {
        const id = `${entity}.${c.name}`;
        if (!SAFE_COLUMN.test(c.name)) errs.push(`${id}: unsafe column name`);
        if (!c.description || !c.description.trim()) errs.push(`${id}: empty description`);
        if (seen.has(c.name)) errs.push(`${id}: duplicate`);
        seen.add(c.name);
        if (c.role !== undefined && c.role !== 'measure' && c.role !== 'dimension') {
          errs.push(`${id}: invalid role '${String(c.role)}'`);
        }
      }
    }
    expect(errs).toEqual([]);
  });

  it('FK references point at catalog entities and their documented key columns', () => {
    const errs: string[] = [];
    let refCount = 0;
    for (const [entity, cols] of Object.entries(EXACT_ONLINE_COLUMN_DOCS)) {
      for (const c of cols) {
        if (!c.references) continue;
        refCount++;
        const id = `${entity}.${c.name}`;
        if (!ENTITIES_BY_NAME.has(c.references.table)) {
          errs.push(`${id}: references unknown entity ${c.references.table}`);
          continue;
        }
        const targetCols = EXACT_ONLINE_COLUMN_DOCS[c.references.table] ?? [];
        if (!targetCols.some((t) => t.name === c.references!.column)) {
          errs.push(`${id}: references ${c.references.table}.${c.references.column}, which is not a documented column`);
        }
      }
    }
    expect(errs).toEqual([]);
    // The docs pages hyperlink every FK property — well over a hundred
    // resolve inside our 61-entity catalog. A collapse in this number means
    // the transcription lost the link capture.
    expect(refCount).toBeGreaterThanOrEqual(150);
  });

  it('vendor FK targets match the hand-curated known-relationships catalog on core joins', () => {
    const get = (entity: string, col: string) =>
      (EXACT_ONLINE_COLUMN_DOCS[entity] ?? []).find((c) => c.name === col)?.references;
    expect(get('Accounts', 'Accountant')).toEqual({ table: 'Accounts', column: 'ID' });
    // EO's sales-invoice header PK is InvoiceID (not ID) — the key-marker
    // parse must have picked that up for the header↔lines join.
    expect(get('SalesInvoiceLines', 'InvoiceID')).toEqual({ table: 'SalesInvoices', column: 'InvoiceID' });
    expect(get('SalesInvoiceLines', 'Item')).toEqual({ table: 'Items', column: 'ID' });
    expect(get('TransactionLines', 'Account')).toEqual({ table: 'Accounts', column: 'ID' });
  });

  it('core financial columns carry the vendor descriptions', () => {
    // Spot-checks against well-known EO fields — if these drift, the
    // transcription (or EO's data model) changed and needs a re-look.
    const accounts = EXACT_ONLINE_COLUMN_DOCS['Accounts'] ?? [];
    expect(accounts.find((c) => c.name === 'ID')?.description).toMatch(/primary key/i);

    const glAccounts = EXACT_ONLINE_COLUMN_DOCS['GLAccounts'] ?? [];
    expect(glAccounts.length).toBeGreaterThan(10);

    const txLines = EXACT_ONLINE_COLUMN_DOCS['TransactionLines'] ?? [];
    expect(txLines.length).toBeGreaterThan(20);
    const amountDc = txLines.find((c) => c.name === 'AmountDC');
    expect(amountDc).toBeDefined();
    expect(amountDc?.role).toBe('measure');
  });
});

describe('ExactOnlineConnector.describeEntities', () => {
  it('serves curated docs statically for selected entities, skipping unknown names', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(config, ['Accounts', 'TransactionLines', 'NotARealEntity'], probeCtx);

    expect(docs.map((d) => d.entityName)).toEqual(['Accounts', 'TransactionLines']);
    for (const d of docs) {
      expect(d.provenance).toBe('curated');
      expect(d.description).toBeTruthy(); // catalog table description
      expect(d.displayName).toBeTruthy();
      expect(d.columns.length).toBeGreaterThan(0);
    }
  });

  it('emits declared relationships from docs FK references, filtered to selected entities', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(config, ['SalesInvoices', 'SalesInvoiceLines'], probeCtx);

    const lines = docs.find((d) => d.entityName === 'SalesInvoiceLines');
    expect(lines?.relationships?.length).toBeGreaterThan(0);
    expect(lines?.relationships).toContainEqual(
      expect.objectContaining({
        fromTable: 'SalesInvoiceLines',
        fromColumn: 'InvoiceID',
        toTable: 'SalesInvoices',
        toColumn: 'InvoiceID',
        type: 'many_to_one',
      }),
    );
    // Items is NOT selected → the Item→Items reference must be filtered out.
    expect(lines?.relationships?.some((r) => r.toTable === 'Items')).toBe(false);
  });

  it('returns an entry with empty columns for a catalog entity without transcribed docs', async () => {
    // Simulated via the weakest guarantee: every catalog entity still returns
    // its table-level docs even if the column map has no entry for it.
    const connector = new ExactOnlineConnector();
    const all = await connector.describeEntities(config, [...ENTITIES_BY_NAME.keys()], probeCtx);
    expect(all.length).toBe(ENTITIES_BY_NAME.size);
    for (const d of all) {
      expect(d.provenance).toBe('curated');
      expect(Array.isArray(d.columns)).toBe(true);
    }
  });
});

describe('documented references — the target column is inferred, so it is checked', () => {
  /**
   * The vendor hyperlinks an FK property to the target ENTITY's page. Which
   * COLUMN the key lands on is not on that row; the transcription infers it
   * from the target's key-marked property, and that inference is wrong wherever
   * the entity carries a second, readable key: `JournalCode` (Edm.String) was
   * sent to `Journals.ID` (Edm.Guid) rather than `Journals.Code`, and measured
   * 0% containment against real data while the curated version measured 100%.
   *
   * 35 of the 245 references crossed a type boundary that way. This asserts
   * none of them are still emitted under the source's authority.
   */
  it('emits no relationship whose two ends cannot be one key', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(
      config, EXACT_ONLINE_ENTITIES.map((e) => e.name), probeCtx,
    );
    expect(validateDocumentedRelationships('exactonline', docs, EXACT_ONLINE_COLUMN_DOCS)).toEqual([]);
  });

  it('refuses JournalCode → Journals.ID specifically', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(config, ['TransactionLines', 'Journals'], probeCtx);
    const rels = docs.flatMap((d) => d.relationships ?? []);
    expect(rels.find((r) => r.fromColumn === 'JournalCode')).toBeUndefined();
  });

  /**
   * Refusing is not the end of it. The connector cannot settle the column —
   * that needs values — but it CAN say which columns of the target could carry
   * the key by type, and hand the question to the profiler, which has the data.
   * Dropping the reference instead would throw away a relationship the vendor
   * genuinely documents.
   */
  it('hands the unsettled reference to the profiler with its candidates', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(config, ['TransactionLines', 'Journals'], probeCtx);
    const u = docs.flatMap((d) => d.unresolvedReferences ?? []);
    const journal = u.find((x) => x.fromColumn === 'JournalCode');

    expect(journal).toBeDefined();
    expect(journal?.toTable).toBe('Journals');
    // What the vendor's own key marking implied, and why it does not fit.
    expect(journal?.rejectedColumn).toBe('ID');
    // Code must be offered; ID must not be re-offered as its own alternative.
    expect(journal?.candidates).toContain('Code');
    expect(journal?.candidates).not.toContain('ID');
    // Candidates are type-compatible ONLY. Narrowing by name here would be the
    // same class of guess that produced the defect — the profiler narrows the
    // rest by measuring uniqueness.
    expect(journal!.candidates.length).toBeGreaterThan(1);
  });

  it('never offers a candidate whose type could not carry the key', async () => {
    const connector = new ExactOnlineConnector();
    const docs = await connector.describeEntities(
      config, EXACT_ONLINE_ENTITIES.map((e) => e.name), probeCtx,
    );
    const bad: string[] = [];
    for (const d of docs) {
      for (const u of d.unresolvedReferences ?? []) {
        const from = EXACT_ONLINE_COLUMN_DOCS[d.entityName]?.find((c) => c.name === u.fromColumn);
        for (const cand of u.candidates) {
          const to = EXACT_ONLINE_COLUMN_DOCS[u.toTable]?.find((c) => c.name === cand);
          if (!to) { bad.push(`${u.toTable}.${cand} is not a documented column`); continue; }
          if (!typesJoinable(from?.dataType, to.dataType)) {
            bad.push(`${d.entityName}.${u.fromColumn} (${from?.dataType}) vs ${u.toTable}.${cand} (${to.dataType})`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
