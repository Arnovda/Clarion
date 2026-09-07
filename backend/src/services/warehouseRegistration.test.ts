/**
 * The naming rule that makes cross-source safe.
 *
 * The assertion that matters is the second describe block: when two sources
 * disagree about what `dim_customer` means, the bare name must NOT be
 * registered. Registering it would let DuckDB's `search_path` resolve the
 * name against whichever source happened to come first — silently answering
 * with the wrong company's data. That is the one failure mode this whole
 * design exists to prevent, and it is invisible on screen, so it has to be
 * pinned by test rather than caught in review.
 *
 * Pure — no DuckDB, no database. That is deliberate: the rule is too
 * load-bearing to be reachable only through the native binding.
 */

import { describe, it, expect } from 'vitest';
import { planRegistration, sourceSlug, type RegisterableTable } from './warehouseRegistration';

const rollupName = (t: string) => `rollup_monthly_${t}`;

const tbl = (over: Partial<RegisterableTable> = {}): RegisterableTable => ({
  tableName: 'dim_customer',
  uri: 'az://warehouse/tenant_1/product_1/dim_customer',
  productName: 'Sales',
  connectionId: 1,
  connectionName: 'Exact Online',
  rollupUri: null,
  ...over,
});

describe('sourceSlug', () => {
  it('lowercases and collapses punctuation', () => {
    expect(sourceSlug('Exact Online', 1)).toBe('exact_online');
    expect(sourceSlug('Teamleader (BE)', 2)).toBe('teamleader_be');
  });

  it('never produces an identifier starting with a digit', () => {
    // "2024 Migration" is an ordinary thing to call a connection, and
    // `2024_migration` is not a legal identifier.
    expect(sourceSlug('2024 Migration', 3)).toBe('s_2024_migration');
  });

  it('falls back to the connection id when the name yields nothing', () => {
    // Two sources both named "***" must still get DISTINCT prefixes, or the
    // disambiguation itself collides.
    expect(sourceSlug('***', 7)).toBe('source_7');
    expect(sourceSlug('***', 8)).toBe('source_8');
    expect(sourceSlug(null, 9)).toBe('source_9');
  });
});

describe('single-source scope is unchanged', () => {
  it('registers bare names under the product schema, exactly as before', () => {
    const plan = planRegistration(
      [tbl({ tableName: 'fact_sales', productName: 'Sales' }), tbl({ tableName: 'dim_item', productName: 'Catalogue' })],
      { crossSource: false, rollupName },
    );
    expect(plan.tableNames.sort()).toEqual(['dim_item', 'fact_sales']);
    expect(plan.tableSchemas.get('fact_sales')).toBe('Sales');
    expect(plan.tableSchemas.get('dim_item')).toBe('Catalogue');
    expect(plan.ambiguous).toEqual([]);
  });

  it('registers a rollup beside its fact', () => {
    // The context advertises `rollup_monthly_<fact>` and the dashboard prompt
    // tells the model to PREFER it, so an advertised-but-unregistered rollup
    // is a guaranteed query failure. Fix both or neither.
    const plan = planRegistration(
      [tbl({ tableName: 'fact_sales', rollupUri: 'az://w/roll' })],
      { crossSource: false, rollupName },
    );
    expect(plan.tablePaths.get('rollup_monthly_fact_sales')).toBe('az://w/roll');
  });
});

describe('the collision rule', () => {
  it('keeps the bare name when claimants agree on the uri (the stub case)', () => {
    // A shared dimension is deliberately stubbed into several products, and
    // publishStubFromUpstream mirrors the OWNER's uri onto the stub. Same
    // physical table, several rows — the bare name must survive, because it
    // is the name every existing dashboard already uses.
    const uri = 'az://warehouse/tenant_1/product_1/dim_customer';
    const plan = planRegistration(
      [
        tbl({ uri, productName: 'Sales' }),
        tbl({ uri, productName: 'Purchasing' }),
      ],
      { crossSource: false, rollupName },
    );
    expect(plan.tableNames).toEqual(['dim_customer']);
    expect(plan.tablePaths.get('dim_customer')).toBe(uri);
    expect(plan.ambiguous).toEqual([]);
  });

  it('WITHHOLDS the bare name when two sources disagree', () => {
    // The load-bearing assertion. If `dim_customer` is registered here, a
    // query naming it returns one source's customers while the reader
    // believes they asked about both.
    const plan = planRegistration(
      [
        tbl({ connectionId: 1, connectionName: 'Exact Online', uri: 'az://w/exact/dim_customer' }),
        tbl({ connectionId: 2, connectionName: 'Teamleader', uri: 'az://w/tl/dim_customer' }),
      ],
      { crossSource: true, rollupName },
    );

    expect(plan.tablePaths.has('dim_customer')).toBe(false);
    expect(plan.tableNames.sort()).toEqual(['exact_online_dim_customer', 'teamleader_dim_customer']);
    expect(plan.tablePaths.get('exact_online_dim_customer')).toBe('az://w/exact/dim_customer');
    expect(plan.tablePaths.get('teamleader_dim_customer')).toBe('az://w/tl/dim_customer');
  });

  it('reports every withheld name with its alternatives', () => {
    // An unregistered name the model was never told about is just a failed
    // query. The report is what the semantic context turns into guidance.
    const plan = planRegistration(
      [
        tbl({ connectionId: 1, connectionName: 'Exact Online', uri: 'az://w/a' }),
        tbl({ connectionId: 2, connectionName: 'Teamleader', uri: 'az://w/b' }),
      ],
      { crossSource: true, rollupName },
    );
    expect(plan.ambiguous).toHaveLength(1);
    expect(plan.ambiguous[0].bareName).toBe('dim_customer');
    expect(plan.ambiguous[0].alternatives.map((a) => a.name).sort())
      .toEqual(['exact_online_dim_customer', 'teamleader_dim_customer']);
  });

  it('leaves unambiguous tables in a cross-source scope alone', () => {
    // Only the contested name pays the prefix. `fact_hours` exists in one
    // source, so it keeps a name the model can use without ceremony.
    const plan = planRegistration(
      [
        tbl({ tableName: 'fact_hours', connectionId: 2, connectionName: 'Teamleader', uri: 'az://w/tl/hours' }),
        tbl({ tableName: 'dim_customer', connectionId: 1, connectionName: 'Exact Online', uri: 'az://w/a' }),
        tbl({ tableName: 'dim_customer', connectionId: 2, connectionName: 'Teamleader', uri: 'az://w/b' }),
      ],
      { crossSource: true, rollupName },
    );
    expect(plan.tablePaths.has('fact_hours')).toBe(true);
    expect(plan.tablePaths.has('dim_customer')).toBe(false);
  });

  it('prefixes the rollup too, so it cannot outlive its fact', () => {
    const plan = planRegistration(
      [
        tbl({ tableName: 'fact_sales', connectionId: 1, connectionName: 'A', uri: 'az://w/a', rollupUri: 'az://w/a_roll' }),
        tbl({ tableName: 'fact_sales', connectionId: 2, connectionName: 'B', uri: 'az://w/b', rollupUri: 'az://w/b_roll' }),
      ],
      { crossSource: true, rollupName },
    );
    expect(plan.tablePaths.has('rollup_monthly_fact_sales')).toBe(false);
    expect(plan.tablePaths.get('a_rollup_monthly_fact_sales')).toBe('az://w/a_roll');
    expect(plan.tablePaths.get('b_rollup_monthly_fact_sales')).toBe('az://w/b_roll');
  });

  it('uses the source as the schema in a cross-source scope', () => {
    // Product names are not unique across sources — two customers can both
    // call a product "Finance" — so the schema has to key on the source.
    const plan = planRegistration(
      [tbl({ tableName: 'fact_hours', connectionId: 2, connectionName: 'Teamleader', productName: 'Finance' })],
      { crossSource: true, rollupName },
    );
    expect(plan.tableSchemas.get('fact_hours')).toBe('teamleader');
  });
});

describe('degenerate input', () => {
  it('returns an empty plan for no tables', () => {
    const plan = planRegistration([], { crossSource: true, rollupName });
    expect(plan.tableNames).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('never registers the same name twice', () => {
    const plan = planRegistration(
      [tbl({ uri: 'az://same' }), tbl({ uri: 'az://same' }), tbl({ uri: 'az://same' })],
      { crossSource: false, rollupName },
    );
    expect(plan.tableNames).toEqual(['dim_customer']);
  });
});
