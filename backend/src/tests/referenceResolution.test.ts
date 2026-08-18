/**
 * Settling a documented reference's target column by measurement.
 *
 * The rule this protects: a source names the target ENTITY, never the target
 * COLUMN, and resolving the column from the entity's primary key sent Exact
 * Online's `JournalCode` (journal codes) at `Journals.ID` (GUIDs) — 0%
 * containment where `Journals.Code` measures 100%.
 *
 * Two failure modes matter equally and pull in opposite directions: resolving
 * to the wrong column silently re-creates the defect under the vendor's name,
 * and refusing too readily throws away 30-odd real relationships.
 */
import { describe, expect, it } from 'vitest';
import { keyLikeColumns, resolveDocumentedReferences } from '../semantic/referenceResolution';

/**
 * A stand-in warehouse. `unique` lists the near-unique columns per table;
 * `holds` lists the (fromTable.fromColumn → toTable.toColumn) pairs whose
 * values actually line up. Everything else measures as a miss.
 */
function fakeWarehouse(opts: {
  rows?: Record<string, number>;
  distinct?: Record<string, number>;
  holds?: ReadonlySet<string>;
  fail?: ReadonlySet<string>;
}) {
  const calls: string[] = [];
  const connector = {
    async executeQuery(sql: string): Promise<{ rows: unknown[] }> {
      calls.push(sql);
      const table = /FROM "([^"]+)"/.exec(sql)?.[1] ?? '';
      if (opts.fail?.has(table)) throw new Error('table not found');

      // The uniqueness probe: SELECT COUNT(*) AS n, COUNT(DISTINCT "x") AS d0 …
      if (sql.startsWith('SELECT COUNT(*) AS n')) {
        const n = opts.rows?.[table] ?? 100;
        const cols = [...sql.matchAll(/COUNT\(DISTINCT "([^"]+)"\) AS d(\d+)/g)];
        const row: Record<string, number> = { n };
        for (const [, col, i] of cols) row[`d${i}`] = opts.distinct?.[`${table}.${col}`] ?? 1;
        return { rows: [row] };
      }

      // The containment probe from verifyFkCandidate.
      const from = /FROM "([^"]+)" WHERE/.exec(sql);
      const fromCol = /SELECT DISTINCT "([^"]+)" AS v/.exec(sql)?.[1] ?? '';
      const toCol = /CAST\(t\."([^"]+)" AS TEXT\)/.exec(sql)?.[1] ?? '';
      const toTable = /FROM "([^"]+)" t\s/.exec(sql)?.[1]
        ?? /EXISTS \(SELECT 1 FROM "([^"]+)"/.exec(sql)?.[1] ?? '';
      const key = `${from?.[1]}.${fromCol}→${toTable}.${toCol}`;
      const sampled = 40;
      const targetRows = opts.rows?.[toTable] ?? 100;
      return {
        rows: [{
          sampled,
          matched: opts.holds?.has(key) ? sampled : 0,
          target_rows: targetRows,
          target_distinct: opts.distinct?.[`${toTable}.${toCol}`] ?? 1,
        }],
      };
    },
  };
  return { connector, calls };
}

describe('keyLikeColumns', () => {
  it('keeps only near-unique columns, in ONE query for the whole table', async () => {
    const { connector, calls } = fakeWarehouse({
      rows: { Journals: 40 },
      distinct: { 'Journals.Code': 40, 'Journals.Description': 38, 'Journals.Currency': 2 },
    });
    const keys = await keyLikeColumns(connector, 'Journals', ['Code', 'Description', 'Currency']);
    expect(keys).toEqual(['Code']);
    // The whole point of the pre-filter: 371 candidate columns across Exact
    // Online's 35 references would be 371 containment queries without it.
    expect(calls).toHaveLength(1);
  });

  it('refuses rather than concludes when the table cannot be read', async () => {
    const { connector } = fakeWarehouse({ fail: new Set(['Journals']) });
    expect(await keyLikeColumns(connector, 'Journals', ['Code'])).toBeNull();
  });

  it('refuses on an empty table — no rows proves nothing either way', async () => {
    const { connector } = fakeWarehouse({ rows: { Journals: 0 } });
    expect(await keyLikeColumns(connector, 'Journals', ['Code'])).toBeNull();
  });
});

describe('resolveDocumentedReferences', () => {
  const journalRef = {
    fromTable: 'TransactionLines', fromColumn: 'JournalCode',
    toTable: 'Journals', rejectedColumn: 'ID',
    candidates: ['Code', 'Description', 'Currency'],
  };

  it('resolves the production case: JournalCode lands on Journals.Code', async () => {
    const { connector } = fakeWarehouse({
      rows: { Journals: 40, TransactionLines: 5000 },
      distinct: { 'Journals.Code': 40, 'Journals.Description': 38, 'Journals.Currency': 2 },
      holds: new Set(['TransactionLines.JournalCode→Journals.Code']),
    });
    const r = await resolveDocumentedReferences(connector, [journalRef]);
    expect(r.resolved).toEqual([expect.objectContaining({ toColumn: 'Code', containment: 1 })]);
    expect(r.refused).toBe(0);
  });

  it('REFUSES when two columns both pass — never picks one', async () => {
    // Code and Description are both near-unique and both contain the values.
    // We cannot tell which the vendor meant, and choosing would be the guess
    // this mechanism exists to remove.
    const { connector } = fakeWarehouse({
      rows: { Journals: 40 },
      distinct: { 'Journals.Code': 40, 'Journals.Description': 40 },
      holds: new Set([
        'TransactionLines.JournalCode→Journals.Code',
        'TransactionLines.JournalCode→Journals.Description',
      ]),
    });
    const r = await resolveDocumentedReferences(connector, [journalRef]);
    expect(r.resolved).toEqual([]);
    expect(r.ambiguous).toBe(1);
  });

  it('refuses when no candidate holds — a documented link is not a licence', async () => {
    const { connector } = fakeWarehouse({
      rows: { Journals: 40 },
      distinct: { 'Journals.Code': 40 },
      holds: new Set(),
    });
    const r = await resolveDocumentedReferences(connector, [journalRef]);
    expect(r.resolved).toEqual([]);
    expect(r.refused).toBe(1);
  });

  it('refuses when the target table is unreadable, and does not throw', async () => {
    const { connector } = fakeWarehouse({ fail: new Set(['Journals']) });
    const r = await resolveDocumentedReferences(connector, [journalRef]);
    expect(r.resolved).toEqual([]);
    expect(r.refused).toBe(1);
  });

  it('probes each target table once however many references point at it', async () => {
    // Thirteen Exact Online references point at PaymentConditions. Uniqueness
    // is a property of the column, not of the reference.
    const refs = ['Accounts', 'SalesInvoices', 'Payments'].map((t) => ({
      fromTable: t, fromColumn: 'PaymentCondition',
      toTable: 'PaymentConditions', rejectedColumn: 'ID',
      candidates: ['Code', 'Description'],
    }));
    const { connector, calls } = fakeWarehouse({
      rows: { PaymentConditions: 12 },
      distinct: { 'PaymentConditions.Code': 12, 'PaymentConditions.Description': 3 },
      holds: new Set(refs.map((r) => `${r.fromTable}.PaymentCondition→PaymentConditions.Code`)),
    });
    const r = await resolveDocumentedReferences(connector, refs);
    expect(r.resolved).toHaveLength(3);
    const probes = calls.filter((c) => c.startsWith('SELECT COUNT(*) AS n'));
    expect(probes).toHaveLength(1);
    // One probe + one containment query per reference, not per candidate.
    expect(calls).toHaveLength(4);
  });
});
