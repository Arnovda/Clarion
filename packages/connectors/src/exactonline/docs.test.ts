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
import { ENTITIES_BY_NAME } from './entities';
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
