/**
 * designedTopicsFromBusMatrix — the payload behind the `designed` event the
 * Build page renders as materializing topic cards.
 *
 * The invariant worth pinning is the same one products-build-overview.test.ts
 * pins for the plan: the Build page is an outcome-language surface, so no
 * dim_/fact_ table name may reach the payload — only grouping names,
 * descriptions and counts. Plus the mechanics: kind mirrors busMatrixBuilder's
 * "no facts = reference" rule, a grouping whose product did not persist is
 * dropped (a card without an id has nothing to link to), and cards arrive in
 * build order.
 */

import { describe, it, expect } from 'vitest';
import { designedTopicsFromBusMatrix, DesignedTopic } from './busMatrixOrchestrator';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

function fixtureBusMatrix(): BusMatrixOutput {
  return {
    rationale: 'test',
    conformed_dimensions: [],
    fact_tables: [],
    relationships: [],
    proposed_kpis: [],
    dim_date_range: { start: '2020-01-01', end: '2026-12-31' },
    data_products: [
      {
        name: 'Finance',
        description: 'Accounting analytics: general-ledger detail and receivables.',
        build_order: 2,
        fact_tables: ['fact_transaction_lines', 'fact_receivables'],
        owned_dimensions: ['dim_gl_account'],
      },
      {
        name: 'Core dimensions',
        description: 'The shared lookups every topic slices by.',
        build_order: 1,
        fact_tables: [],
        owned_dimensions: ['dim_account', 'dim_item', 'dim_journal'],
      },
      {
        name: 'Sales',
        description: 'Sales analytics: invoice lines and order lines.',
        build_order: 3,
        fact_tables: ['fact_sales_invoice_lines'],
        owned_dimensions: [],
      },
    ],
  };
}

const builtProducts = [
  { name: 'Core dimensions', id: 11, status: 'draft', build_order: 1 },
  { name: 'Finance', id: 12, status: 'draft', build_order: 2 },
  { name: 'Sales', id: 13, status: 'draft', build_order: 3 },
];

describe('designedTopicsFromBusMatrix', () => {
  it('matches groupings to persisted products by name and sorts by build order', () => {
    const topics = designedTopicsFromBusMatrix(fixtureBusMatrix(), builtProducts);
    expect(topics.map((t) => t.name)).toEqual(['Core dimensions', 'Finance', 'Sales']);
    expect(topics.map((t) => t.id)).toEqual([11, 12, 13]);
  });

  it('derives kind with the builder\'s rule: no fact tables = reference', () => {
    const topics = designedTopicsFromBusMatrix(fixtureBusMatrix(), builtProducts);
    const byName = new Map(topics.map((t) => [t.name, t]));
    expect(byName.get('Core dimensions')?.kind).toBe('reference');
    expect(byName.get('Finance')?.kind).toBe('analytics');
    expect(byName.get('Sales')?.kind).toBe('analytics');
  });

  it('counts facts + owned dimensions as tableCount without naming them', () => {
    const topics = designedTopicsFromBusMatrix(fixtureBusMatrix(), builtProducts);
    const byName = new Map(topics.map((t) => [t.name, t]));
    expect(byName.get('Finance')?.tableCount).toBe(3);
    expect(byName.get('Core dimensions')?.tableCount).toBe(3);
    expect(byName.get('Sales')?.tableCount).toBe(1);
  });

  it('never leaks warehouse vocabulary into the payload', () => {
    // The fixture is full of dim_/fact_ names — none may survive into the
    // event the Build page renders. Serialize the whole payload and scan it,
    // so a future field addition cannot smuggle a table name in unnoticed.
    const topics = designedTopicsFromBusMatrix(fixtureBusMatrix(), builtProducts);
    const serialized = JSON.stringify(topics);
    expect(serialized).not.toMatch(/\bdim_/);
    expect(serialized).not.toMatch(/\bfact_/);
  });

  it('drops a grouping whose product did not persist instead of shipping it without an id', () => {
    const missingOne = builtProducts.filter((p) => p.name !== 'Sales');
    const topics = designedTopicsFromBusMatrix(fixtureBusMatrix(), missingOne);
    expect(topics.map((t) => t.name)).toEqual(['Core dimensions', 'Finance']);
    expect(topics.every((t: DesignedTopic) => typeof t.id === 'number')).toBe(true);
  });
});
