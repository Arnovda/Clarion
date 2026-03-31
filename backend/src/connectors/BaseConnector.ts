export interface ColumnInfo {
  name: string;
  type: string;
  sampleValues: unknown[];
}

export interface TableInfo {
  tableName: string;
  columns: ColumnInfo[];
}

/**
 * A candidate foreign-key relationship detected programmatically
 * (before any AI involvement).
 */
export interface FkCandidate {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  /** How was this candidate detected? */
  source: 'declared' | 'name_pattern' | 'fuzzy_name' | 'value_overlap';
  /** 0-1 — how confident the heuristic is */
  confidence: number;
  /** Fraction of fromColumn values found in toColumn (null if not checked) */
  overlapRatio?: number;
}

export interface SchemaResult {
  tables: TableInfo[];
  /** Pre-detected FK candidates from heuristics (PRAGMA, name patterns, value overlap) */
  fkCandidates?: FkCandidate[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

// ---------------------------------------------------------------------------
// Common abbreviation map for fuzzy column-name matching.
// Maps short form → canonical long form.
// ---------------------------------------------------------------------------
const ABBREVIATIONS: Record<string, string> = {
  cust: 'customer', cst: 'customer', cstmr: 'customer',
  prod: 'product', prd: 'product',
  inv: 'invoice', invc: 'invoice',
  ord: 'order',
  emp: 'employee', empl: 'employee',
  dept: 'department', dep: 'department',
  cat: 'category', categ: 'category',
  qty: 'quantity', quant: 'quantity',
  amt: 'amount',
  desc: 'description', descr: 'description',
  addr: 'address',
  num: 'number', no: 'number', nbr: 'number', nr: 'number',
  dt: 'date',
  nm: 'name',
  cd: 'code',
  tp: 'type', typ: 'type',
  st: 'status', stat: 'status',
  ref: 'reference',
  grp: 'group',
  acc: 'account', acct: 'account',
  trx: 'transaction', txn: 'transaction', trans: 'transaction',
  pmt: 'payment', pay: 'payment',
  shp: 'shipment', ship: 'shipment',
  wh: 'warehouse', whse: 'warehouse',
  loc: 'location',
  rgn: 'region', reg: 'region',
  cntry: 'country', ctry: 'country',
  yr: 'year', mo: 'month',
  curr: 'currency', ccy: 'currency',
  mgr: 'manager',
  sup: 'supplier', supp: 'supplier',
  ven: 'vendor', vnd: 'vendor',
};

/** Expand abbreviations and normalise a column name into canonical tokens. */
function canonicalTokens(colName: string): string[] {
  const raw = colName.toLowerCase().split(/[_\s]+/).filter(Boolean);
  return raw.map((t) => ABBREVIATIONS[t] ?? t);
}

/**
 * Compute token-level similarity between two column names.
 * Returns 0-1: 1 = all tokens match, 0 = nothing in common.
 */
function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / Math.max(setA.size, setB.size);
}

/** Columns to always skip during fuzzy matching — too generic to be meaningful. */
const SKIP_COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'deleted_at', 'is_active',
  'created_by', 'updated_by', 'modified_at', 'modified_by',
  'row_version', 'version',
]);

export abstract class BaseConnector {
  abstract connect(): Promise<void>;
  abstract testConnection(): Promise<{ ok: boolean; message: string }>;
  abstract introspectSchema(): Promise<SchemaResult>;
  abstract executeQuery(sql: string): Promise<QueryResult>;
  abstract disconnect(): void;

  /**
   * Override in subclass to return FKs declared in the database schema
   * (e.g. PRAGMA for SQLite, information_schema for PostgreSQL/MySQL).
   * Default returns empty — subclasses add engine-specific logic.
   */
  async introspectDeclaredFks(_tables: TableInfo[]): Promise<FkCandidate[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Engine-agnostic FK detection layers
  // These work on any SQL database — they use executeQuery() internally.
  // ---------------------------------------------------------------------------

  /**
   * Run all FK detection layers:
   *   1. Declared FKs (engine-specific)
   *   2. Strict name-pattern (_id suffix → matching table)
   *   3. Fuzzy name matching (abbreviations, shared tokens, same-name columns)
   *   4. Value overlap verification (runs JOINs against actual data)
   *   5. Value overlap discovery (integer columns vs PKs)
   */
  async detectForeignKeys(tables: TableInfo[]): Promise<FkCandidate[]> {
    const candidates: FkCandidate[] = [];
    const seen = new Set<string>();
    const tableNamesLower = new Set(tables.map((t) => t.tableName.toLowerCase()));

    const addCandidate = (c: FkCandidate) => {
      const key = `${c.fromTable}.${c.fromColumn}→${c.toTable}.${c.toColumn}`;
      if (!seen.has(key)) { seen.add(key); candidates.push(c); }
    };

    // ── Layer 1: Engine-specific declared FKs ────────────────────────────────
    try {
      const declared = await this.introspectDeclaredFks(tables);
      for (const fk of declared) addCandidate(fk);
    } catch (err) {
      console.warn('[FK detection] declared FK introspection failed:', err);
    }

    // ── Layer 2: Strict name-pattern (_id suffix → matching table) ──────────
    for (const table of tables) {
      for (const col of table.columns) {
        const colLower = col.name.toLowerCase();
        if (!colLower.endsWith('_id') || colLower === 'id') continue;

        const stem = colLower.replace(/_id$/, '');
        // Also expand abbreviations: cust_id → customer → customers
        const expandedStem = ABBREVIATIONS[stem] ?? stem;
        const allStems = stem === expandedStem ? [stem] : [stem, expandedStem];

        const variants: string[] = [];
        for (const s of allStems) {
          variants.push(s, s + 's', s + 'es');
          if (s.endsWith('y')) variants.push(s.replace(/y$/, 'ies'));
          if (s.endsWith('ies')) variants.push(s.replace(/ies$/, 'y'));
        }

        for (const variant of variants) {
          if (variant === table.tableName.toLowerCase()) continue;
          if (!tableNamesLower.has(variant)) continue;

          const targetTable = tables.find((t) => t.tableName.toLowerCase() === variant)!;
          const targetPk = targetTable.columns.find(
            (c) => c.name.toLowerCase() === 'id' ||
                   c.name.toLowerCase() === `${targetTable.tableName.toLowerCase()}_id`,
          );
          if (!targetPk) continue;

          addCandidate({
            fromTable: table.tableName, fromColumn: col.name,
            toTable: targetTable.tableName, toColumn: targetPk.name,
            source: 'name_pattern', confidence: 0.8,
          });
        }
      }
    }

    // ── Layer 3: Fuzzy name matching ─────────────────────────────────────────
    // Generates candidates that Layer 4 will verify with actual data.
    //
    // Strategy A: Same column name in different tables
    //   e.g. customers.email ↔ orders.email → natural join key
    //
    // Strategy B: Fuzzy token match after abbreviation expansion
    //   e.g. orders.cust_no ↔ customers.customer_number
    //        (tokens: [customer, number] vs [customer, number] → similarity 1.0)
    //
    // Strategy C: Table-name prefix stripping
    //   e.g. orders.product_code ↔ products.code
    //        (strip "product_" prefix on orders column → "code" matches products.code)

    // Build a lookup: canonical tokens → [{ table, column, tokens }]
    type ColRef = { table: TableInfo; col: ColumnInfo; tokens: string[] };
    const allCols: ColRef[] = [];
    for (const table of tables) {
      for (const col of table.columns) {
        if (SKIP_COLUMNS.has(col.name.toLowerCase())) continue;
        allCols.push({ table, col, tokens: canonicalTokens(col.name) });
      }
    }

    // Strategy A: Exact same column name across different tables
    const colNameToRefs = new Map<string, ColRef[]>();
    for (const ref of allCols) {
      const key = ref.col.name.toLowerCase();
      if (!colNameToRefs.has(key)) colNameToRefs.set(key, []);
      colNameToRefs.get(key)!.push(ref);
    }
    for (const [colName, refs] of colNameToRefs) {
      if (refs.length < 2) continue;
      if (colName.endsWith('_id')) continue; // already handled by Layer 2
      // Only consider columns with moderate cardinality (not booleans, not pure PKs)
      // — verification in Layer 4 will confirm
      for (let i = 0; i < refs.length; i++) {
        for (let j = i + 1; j < refs.length; j++) {
          const a = refs[i], b = refs[j];
          if (a.table.tableName === b.table.tableName) continue;
          // Add both directions — Layer 4 will verify which direction has containment
          addCandidate({
            fromTable: a.table.tableName, fromColumn: a.col.name,
            toTable: b.table.tableName, toColumn: b.col.name,
            source: 'fuzzy_name', confidence: 0.5, // low until verified
          });
          addCandidate({
            fromTable: b.table.tableName, fromColumn: b.col.name,
            toTable: a.table.tableName, toColumn: a.col.name,
            source: 'fuzzy_name', confidence: 0.5,
          });
        }
      }
    }

    // Strategy B: Token similarity after abbreviation expansion
    for (let i = 0; i < allCols.length; i++) {
      for (let j = i + 1; j < allCols.length; j++) {
        const a = allCols[i], b = allCols[j];
        if (a.table.tableName === b.table.tableName) continue;
        if (a.tokens.length < 2 || b.tokens.length < 2) continue; // single-token = too vague

        const sim = tokenSimilarity(a.tokens, b.tokens);
        if (sim < 0.6) continue; // need at least 60% token overlap

        // Skip if exact same name (already handled in Strategy A)
        if (a.col.name.toLowerCase() === b.col.name.toLowerCase()) continue;

        addCandidate({
          fromTable: a.table.tableName, fromColumn: a.col.name,
          toTable: b.table.tableName, toColumn: b.col.name,
          source: 'fuzzy_name', confidence: 0.4 + sim * 0.3, // 0.4–0.7 range
        });
        addCandidate({
          fromTable: b.table.tableName, fromColumn: b.col.name,
          toTable: a.table.tableName, toColumn: a.col.name,
          source: 'fuzzy_name', confidence: 0.4 + sim * 0.3,
        });
      }
    }

    // Strategy C: Table-name prefix stripping
    // If orders has "product_code" and products has "code", that's likely a match
    for (const fromTable of tables) {
      for (const fromCol of fromTable.columns) {
        const colLower = fromCol.name.toLowerCase();
        if (SKIP_COLUMNS.has(colLower)) continue;

        for (const toTable of tables) {
          if (toTable.tableName === fromTable.tableName) continue;

          // Check if column starts with target table name (singular form)
          const tableStem = toTable.tableName.toLowerCase().replace(/s$/, '');
          if (!colLower.startsWith(tableStem + '_')) continue;
          const strippedName = colLower.slice(tableStem.length + 1); // e.g. "code" from "product_code"
          if (!strippedName || strippedName === 'id') continue; // _id handled in Layer 2

          const matchedCol = toTable.columns.find((c) => c.name.toLowerCase() === strippedName);
          if (!matchedCol) continue;

          addCandidate({
            fromTable: fromTable.tableName, fromColumn: fromCol.name,
            toTable: toTable.tableName, toColumn: matchedCol.name,
            source: 'fuzzy_name', confidence: 0.55,
          });
        }
      }
    }

    // ── Layer 4: Value overlap verification ──────────────────────────────────
    // Runs actual JOINs to check what fraction of values in fromColumn
    // exist in toColumn. This is the definitive test — upgrades or kills
    // candidates from layers 1–3.
    for (const c of [...candidates]) {
      if (c.overlapRatio !== undefined) continue;
      try {
        const result = await this.executeQuery(
          `SELECT COUNT(DISTINCT f.v) as matched,
                  (SELECT COUNT(DISTINCT "${c.fromColumn}") FROM "${c.fromTable}" WHERE "${c.fromColumn}" IS NOT NULL) as total
           FROM (SELECT DISTINCT "${c.fromColumn}" as v FROM "${c.fromTable}" WHERE "${c.fromColumn}" IS NOT NULL LIMIT 500) f
           INNER JOIN "${c.toTable}" t ON CAST(f.v AS TEXT) = CAST(t."${c.toColumn}" AS TEXT)`,
        );
        const row = result.rows[0] as { matched: number; total: number } | undefined;
        if (row && row.total > 0) {
          c.overlapRatio = row.matched / row.total;
          if (c.overlapRatio >= 0.95) c.confidence = Math.max(c.confidence, 0.95);
          else if (c.overlapRatio >= 0.80) c.confidence = Math.max(c.confidence, 0.85);
          else if (c.overlapRatio >= 0.50) c.confidence = Math.max(c.confidence, 0.7);
          else c.confidence = Math.min(c.confidence, 0.3);
        } else {
          // No overlap at all — downgrade hard
          c.confidence = 0.1;
          c.overlapRatio = 0;
        }
      } catch {
        // Query failed (type mismatch etc.) — leave confidence as-is
      }
    }

    // ── Layer 5: Value overlap discovery (integer columns vs PKs) ────────────
    // Catches FKs that aren't named conventionally at all
    for (const fromTable of tables) {
      for (const fromCol of fromTable.columns) {
        const colType = fromCol.type.toUpperCase();
        if (!colType.includes('INT') && !colType.includes('NUM') && !colType.includes('SERIAL')) continue;
        if (fromCol.name.toLowerCase() === 'id') continue;

        for (const toTable of tables) {
          if (toTable.tableName === fromTable.tableName) continue;
          const toCol = toTable.columns.find((c) => c.name.toLowerCase() === 'id');
          if (!toCol) continue;

          const key = `${fromTable.tableName}.${fromCol.name}→${toTable.tableName}.${toCol.name}`;
          if (seen.has(key)) continue;

          try {
            const result = await this.executeQuery(
              `SELECT COUNT(DISTINCT f.v) as matched,
                      (SELECT COUNT(DISTINCT "${fromCol.name}") FROM "${fromTable.tableName}" WHERE "${fromCol.name}" IS NOT NULL) as total,
                      (SELECT COUNT(*) FROM "${toTable.tableName}") as target_rows
               FROM (SELECT DISTINCT "${fromCol.name}" as v FROM "${fromTable.tableName}" WHERE "${fromCol.name}" IS NOT NULL LIMIT 500) f
               INNER JOIN "${toTable.tableName}" t ON f.v = t."${toCol.name}"`,
            );
            const row = result.rows[0] as { matched: number; total: number; target_rows: number } | undefined;
            if (row && row.total > 0 && row.matched > 0) {
              const ratio = row.matched / row.total;
              if (ratio >= 0.7 && row.total <= row.target_rows * 1.1) {
                addCandidate({
                  fromTable: fromTable.tableName, fromColumn: fromCol.name,
                  toTable: toTable.tableName, toColumn: toCol.name,
                  source: 'value_overlap',
                  confidence: ratio >= 0.95 ? 0.9 : 0.7,
                  overlapRatio: ratio,
                });
              }
            }
          } catch { /* skip */ }
        }
      }
    }

    // Drop candidates with very low confidence (failed verification)
    return candidates
      .filter((c) => c.confidence >= 0.3)
      .sort((a, b) => b.confidence - a.confidence);
  }
}
