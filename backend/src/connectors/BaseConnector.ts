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
  source: 'declared' | 'name_pattern' | 'ai_suggested' | 'value_overlap';
  /** 0-1 — how confident the heuristic is */
  confidence: number;
  /** Fraction of fromColumn values found in toColumn (null if not checked) */
  overlapRatio?: number;
}

/** Row-count info per table, used by fact/dimension classification. */
export interface TableRowCount {
  tableName: string;
  rowCount: number;
}

/** Classification of a table as fact, dimension, or bridge. */
export type TableRole = 'fact' | 'dimension' | 'bridge' | 'unknown';

export interface TableClassification {
  tableName: string;
  role: TableRole;
  rowCount: number;
  /** Columns that look like business keys (PKs, _code, _key, _no, etc.) */
  businessKeys: string[];
  /** Columns that look like foreign keys pointing elsewhere */
  keyColumns: string[];
}

export interface SchemaResult {
  tables: TableInfo[];
  /** Pre-detected FK candidates from heuristics */
  fkCandidates?: FkCandidate[];
  /** Fact/dimension classification for each table */
  tableClassifications?: TableClassification[];
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

// ---------------------------------------------------------------------------
// Common abbreviation map for name-pattern matching.
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

// Columns that are never business keys — skip entirely
const MEASURE_PATTERNS = /^(amount|total|price|cost|qty|quantity|sum|count|avg|balance|weight|rate|pct|percentage|margin|tax|discount|subtotal|grand_total|net|gross|debit|credit)/i;
const META_COLUMNS = new Set([
  'id', 'created_at', 'updated_at', 'deleted_at', 'is_active', 'is_deleted',
  'created_by', 'updated_by', 'modified_at', 'modified_by',
  'row_version', 'version', 'notes', 'remarks', 'comment', 'comments',
  'description',
]);
const KEY_SUFFIXES = ['_id', '_code', '_key', '_ref', '_no', '_num', '_number', '_nr'];

// PascalCase / camelCase variants — same suffixes but without the underscore.
// Common in API-style sources (ExactOnline, NetSuite, Stripe, Salesforce).
// e.g. `InvoiceID` → suffix `id`, stem `invoice`. We require a 3+ char stem
// so noise like `paid` (suffix `id`, stem `pa`) doesn't match.
const KEY_SUFFIXES_PASCAL = ['id', 'code', 'key', 'ref', 'number'];

/**
 * Extract the "stem" of a key-shaped column name, supporting both
 * snake_case (`customer_id` → `customer`) and PascalCase / camelCase
 * (`CustomerID` → `customer`). Returns null if the column doesn't look
 * like a key.
 *
 * The stem is what we then match against TABLE NAMES to find the FK target.
 * Caller is responsible for confirming the stem corresponds to an actual
 * table — that's the safety net for any over-matching here.
 */
export function getKeyStem(columnName: string): string | null {
  const cn = columnName.toLowerCase();
  if (cn === 'id') return null; // bare `id` is the table's PK, not a stem

  // 1. snake_case suffixes (longest match first via array order)
  for (const suffix of KEY_SUFFIXES) {
    if (cn.endsWith(suffix)) {
      const stem = cn.slice(0, -suffix.length);
      if (stem.length >= 2) return stem;
    }
  }
  // 2. PascalCase / camelCase suffixes — stricter min-stem to suppress noise
  for (const suffix of KEY_SUFFIXES_PASCAL) {
    if (cn.endsWith(suffix) && cn.length > suffix.length + 2) {
      const stem = cn.slice(0, -suffix.length);
      if (stem.length >= 3) return stem;
    }
  }
  return null;
}

/**
 * Tokenise a table name into its word components, lowercase + singularised.
 * Handles PascalCase (`SalesInvoices` → ['sales', 'invoice']) and snake_case
 * (`sales_invoices` → ['sales', 'invoice']). Used to recognise that a
 * column like `InvoiceID` "belongs to" the `SalesInvoices` table even
 * though `invoice` ≠ `salesinvoice`.
 */
export function tokenizeTableName(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // SalesInvoices → 'Sales Invoices'
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2') // GLAccounts → 'GL Accounts'
    .replace(/[_-]+/g, ' ')                  // sales_invoices → 'sales invoices'
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase().replace(/s$/, ''));
}

export abstract class BaseConnector {
  abstract connect(): Promise<void>;
  abstract testConnection(): Promise<{ ok: boolean; message: string }>;
  abstract introspectSchema(): Promise<SchemaResult>;
  abstract executeQuery(sql: string): Promise<QueryResult>;
  abstract disconnect(): void;

  /**
   * Override in subclass to return FKs declared in the database schema
   * (e.g. PRAGMA for SQLite, information_schema for PostgreSQL/MySQL).
   */
  async introspectDeclaredFks(_tables: TableInfo[]): Promise<FkCandidate[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // Table classification: fact vs dimension
  // ---------------------------------------------------------------------------

  async classifyTables(tables: TableInfo[]): Promise<TableClassification[]> {
    // Get row counts
    const rowCounts = new Map<string, number>();
    for (const t of tables) {
      try {
        const result = await this.executeQuery(`SELECT COUNT(*) as cnt FROM "${t.tableName}"`);
        rowCounts.set(t.tableName, (result.rows[0] as { cnt: number }).cnt);
      } catch {
        rowCounts.set(t.tableName, 0);
      }
    }

    const medianRowCount = [...rowCounts.values()].sort((a, b) => a - b)[Math.floor(rowCounts.size / 2)] || 0;

    return tables.map((t) => {
      const rc = rowCounts.get(t.tableName) ?? 0;
      const cols = t.columns.map((c) => c.name.toLowerCase());

      // Identify key-looking columns (potential FKs outward)
      const keyColumns: string[] = [];
      // Identify business key columns (what other tables might point TO)
      const businessKeys: string[] = [];

      const tnLower = t.tableName.toLowerCase();
      const tnStem = tnLower.replace(/s$/, ''); // "verkooporders" → "verkooporder"
      // Tokenised forms — handles `SalesInvoices` → ['sales', 'invoice'] so
      // `InvoiceID` is recognised as the table's own business key (not an
      // outward FK to a non-existent `Invoice` table).
      const tableTokens = new Set(tokenizeTableName(t.tableName));

      for (const col of t.columns) {
        const cn = col.name.toLowerCase();
        if (META_COLUMNS.has(cn)) continue;
        if (MEASURE_PATTERNS.test(cn)) continue;

        // Bare `id` is always the table's own PK.
        if (cn === 'id') {
          businessKeys.push(col.name);
          continue;
        }

        const colStem = getKeyStem(col.name);
        if (!colStem) continue;

        // Check if this key column belongs to THIS table (= business key)
        // or points to ANOTHER table (= FK outward).
        const belongsToThisTable =
          cn === `${tnLower}_id` || cn === `${tnStem}_id` ||
          cn === `${tnLower}id`  || cn === `${tnStem}id`  ||
          colStem === tnLower || colStem === tnStem ||
          tableTokens.has(colStem);

        if (belongsToThisTable) {
          businessKeys.push(col.name);
        } else {
          keyColumns.push(col.name); // FK pointing outward
        }
      }

      // Also add short generic key columns as business keys (for dimensions)
      for (const col of t.columns) {
        const cn = col.name.toLowerCase();
        if (['code', 'name', 'naam', 'nummer', 'key', 'ref'].includes(cn) && !businessKeys.includes(col.name)) {
          businessKeys.push(col.name);
        }
      }

      // Classification heuristics
      const fkCount = keyColumns.length;
      const hasDateCols = cols.some((c) => c.includes('date') || c.includes('datum') || c.includes('_dt'));
      const hasMeasures = t.columns.some((c) => MEASURE_PATTERNS.test(c.name.toLowerCase()));
      const hasDescriptive = cols.some((c) => c === 'name' || c === 'description' || c === 'label' || c === 'naam' || c === 'omschrijving');

      let role: TableRole = 'unknown';
      if (fkCount >= 2 && (hasDateCols || hasMeasures) && rc > medianRowCount * 0.5) {
        role = 'fact';
      } else if (hasDescriptive && rc <= medianRowCount * 2 && fkCount <= 2) {
        role = 'dimension';
      } else if (fkCount >= 2 && !hasDateCols && !hasMeasures && rc <= medianRowCount) {
        role = 'bridge'; // junction/bridge table
      } else if (rc > medianRowCount && fkCount >= 1) {
        role = 'fact';
      } else if (rc <= medianRowCount) {
        role = 'dimension';
      }

      console.log(`[FK] classify: ${t.tableName} → ${role} (${rc} rows, ${fkCount} key cols, ${businessKeys.length} biz keys)`);
      return { tableName: t.tableName, role, rowCount: rc, businessKeys, keyColumns };
    });
  }

  // ---------------------------------------------------------------------------
  // FK detection pipeline
  // ---------------------------------------------------------------------------

  /**
   * Run all FK detection layers:
   *   1. Declared FKs (engine-specific)
   *   2. Name-pattern matching (_id/_code/_key suffix → matching table)
   *   3. Value overlap verification (runs JOINs against actual data)
   *   4. Value overlap discovery (integer columns in facts → dimension PKs)
   *
   * Layer 3 (old fuzzy brute-force) is removed.
   * AI-assisted matching is handled separately by SchemaProfiler.
   */
  async detectForeignKeys(tables: TableInfo[]): Promise<{ candidates: FkCandidate[]; classifications: TableClassification[] }> {
    const candidates: FkCandidate[] = [];
    const seen = new Set<string>();
    const tableNamesLower = new Set(tables.map((t) => t.tableName.toLowerCase()));

    const addCandidate = (c: FkCandidate) => {
      const key = `${c.fromTable}.${c.fromColumn}→${c.toTable}.${c.toColumn}`;
      if (!seen.has(key)) { seen.add(key); candidates.push(c); }
    };

    // ── Classify tables ─────────────────────────────────────────────────────
    const classifications = await this.classifyTables(tables);
    const classMap = new Map(classifications.map((c) => [c.tableName, c]));

    // ── Layer 1: Engine-specific declared FKs ────────────────────────────────
    console.log(`[FK] Layer 1: checking declared FKs for ${tables.length} tables…`);
    try {
      const declared = await this.introspectDeclaredFks(tables);
      for (const fk of declared) addCandidate(fk);
      console.log(`[FK] Layer 1: ${declared.length} declared FK(s)${declared.length ? ': ' + declared.map(f => `${f.fromTable}.${f.fromColumn}→${f.toTable}.${f.toColumn}`).join(', ') : ''}`);
    } catch (err) {
      console.warn('[FK] Layer 1 failed:', err);
    }

    // ── Layer 2: Name-pattern matching ───────────────────────────────────────
    // Matches snake_case (`customer_id`) AND PascalCase (`CustomerID`) suffixes
    // to table names. The `getKeyStem` helper hides the casing logic.
    const preLayer2 = candidates.length;
    for (const table of tables) {
      for (const col of table.columns) {
        const colLower = col.name.toLowerCase();
        if (colLower === 'id') continue;
        const stem = getKeyStem(col.name);
        if (!stem) continue;

        // Expand abbreviations: cust → customer, prod → product
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
          // Look for the target column — strict priority order:
          //   1. 'id' (surrogate PK — most common FK target)
          //   2. '{tablename}_id' (natural PK convention)
          //   3. Business keys from classification (fallback)
          const targetClass = classMap.get(targetTable.tableName);
          const targetPk =
            targetTable.columns.find((c) => c.name.toLowerCase() === 'id') ??
            targetTable.columns.find((c) => c.name.toLowerCase() === `${targetTable.tableName.toLowerCase()}_id`) ??
            targetTable.columns.find((c) =>
              (targetClass?.businessKeys ?? []).map(k => k.toLowerCase()).includes(c.name.toLowerCase()),
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
    const layer2Added = candidates.length - preLayer2;
    console.log(`[FK] Layer 2: ${layer2Added} name-pattern match(es)${layer2Added ? ': ' + candidates.slice(preLayer2).map(c => `${c.fromTable}.${c.fromColumn}→${c.toTable}.${c.toColumn}`).join(', ') : ''}`);

    // ── Layer 3: Value overlap verification ──────────────────────────────────
    // Time-boxed: 10s per query, 2 min total budget for Layer 3+4
    const FK_QUERY_TIMEOUT = 10_000;
    const FK_TOTAL_BUDGET  = 120_000; // 2 minutes for all overlap checks
    const fkBudgetStart = Date.now();
    const fkTimedOut = () => Date.now() - fkBudgetStart > FK_TOTAL_BUDGET;

    const toVerify = candidates.filter(c => c.overlapRatio === undefined).length;
    console.log(`[FK] Layer 3: verifying ${toVerify} candidate(s) with value overlap JOINs…`);
    let verified = 0, killed = 0, skipped = 0;
    for (const c of [...candidates]) {
      if (c.overlapRatio !== undefined) continue;
      if (fkTimedOut()) { skipped++; continue; }
      try {
        const result = await Promise.race([
          this.executeQuery(
            `SELECT COUNT(DISTINCT f.v) as matched,
                    (SELECT COUNT(DISTINCT "${c.fromColumn}") FROM "${c.fromTable}" WHERE "${c.fromColumn}" IS NOT NULL) as total
             FROM (SELECT DISTINCT "${c.fromColumn}" as v FROM "${c.fromTable}" WHERE "${c.fromColumn}" IS NOT NULL ORDER BY "${c.fromColumn}" LIMIT 500) f
             INNER JOIN "${c.toTable}" t ON CAST(f.v AS TEXT) = CAST(t."${c.toColumn}" AS TEXT)`,
          ),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('FK query timeout')), FK_QUERY_TIMEOUT)),
        ]);
        const row = result.rows[0] as { matched: number; total: number } | undefined;
        if (row && row.total > 0) {
          c.overlapRatio = row.matched / row.total;
          if (c.overlapRatio >= 0.95) { c.confidence = Math.max(c.confidence, 0.95); verified++; }
          else if (c.overlapRatio >= 0.80) { c.confidence = Math.max(c.confidence, 0.85); verified++; }
          else if (c.overlapRatio >= 0.50) { c.confidence = Math.max(c.confidence, 0.7); verified++; }
          else { c.confidence = Math.min(c.confidence, 0.3); killed++; }
          console.log(`[FK]   ${c.fromTable}.${c.fromColumn} → ${c.toTable}.${c.toColumn}: overlap ${Math.round(c.overlapRatio * 100)}% → conf ${c.confidence.toFixed(2)}`);
        } else {
          c.confidence = 0.1; c.overlapRatio = 0; killed++;
          console.log(`[FK]   ${c.fromTable}.${c.fromColumn} → ${c.toTable}.${c.toColumn}: no overlap → killed`);
        }
      } catch { /* type mismatch or timeout */ }
    }
    console.log(`[FK] Layer 3: ${verified} verified, ${killed} killed${skipped ? `, ${skipped} skipped (budget)` : ''}`);

    // ── Layer 4: Value overlap discovery (fact key columns → dimension PKs) ──
    // Only check fact/bridge tables against dimension/unknown tables
    if (fkTimedOut()) {
      console.log(`[FK] Layer 4: skipped (time budget exhausted)`);
    } else {
      console.log(`[FK] Layer 4: scanning fact key columns against dimension PKs…`);
    }
    const preLayer4 = candidates.length;
    const factTables = classifications.filter((c) => c.role === 'fact' || c.role === 'bridge');
    const dimTables  = classifications.filter((c) => c.role === 'dimension' || c.role === 'unknown');

    for (const factClass of factTables) {
      if (fkTimedOut()) break;
      const factTable = tables.find((t) => t.tableName === factClass.tableName)!;
      for (const fromCol of factTable.columns) {
        if (fkTimedOut()) break;
        const cn = fromCol.name.toLowerCase();
        if (META_COLUMNS.has(cn)) continue;
        if (MEASURE_PATTERNS.test(cn)) continue;
        // Any column that LOOKS like a key (snake_case suffix OR PascalCase
        // suffix). The old INT-only fallback excluded GUID-shaped FKs that
        // API connectors (ExactOnline, Salesforce, ...) materialise as
        // VARCHAR. Value-overlap verification below filters out noise.
        if (!getKeyStem(fromCol.name)) continue;

        for (const dimClass of dimTables) {
          if (fkTimedOut()) break;
          if (dimClass.tableName === factClass.tableName) continue;
          const dimTable = tables.find((t) => t.tableName === dimClass.tableName)!;

          // Try matching against dimension's business keys and 'id'
          const targetCols = dimTable.columns.filter((c) =>
            c.name.toLowerCase() === 'id' || dimClass.businessKeys.map(k => k.toLowerCase()).includes(c.name.toLowerCase()),
          );

          for (const toCol of targetCols) {
            if (fkTimedOut()) break;
            const key = `${factClass.tableName}.${fromCol.name}→${dimClass.tableName}.${toCol.name}`;
            if (seen.has(key)) continue;

            try {
              const result = await Promise.race([
                this.executeQuery(
                  `SELECT COUNT(DISTINCT f.v) as matched,
                          (SELECT COUNT(DISTINCT "${fromCol.name}") FROM "${factClass.tableName}" WHERE "${fromCol.name}" IS NOT NULL) as total,
                          (SELECT COUNT(*) FROM "${dimClass.tableName}") as target_rows
                   FROM (SELECT DISTINCT "${fromCol.name}" as v FROM "${factClass.tableName}" WHERE "${fromCol.name}" IS NOT NULL ORDER BY "${fromCol.name}" LIMIT 500) f
                   INNER JOIN "${dimClass.tableName}" t ON CAST(f.v AS TEXT) = CAST(t."${toCol.name}" AS TEXT)`,
                ),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('FK query timeout')), FK_QUERY_TIMEOUT)),
              ]);
              const row = result.rows[0] as { matched: number; total: number; target_rows: number } | undefined;
              if (row && row.total > 0 && row.matched > 0) {
                const ratio = row.matched / row.total;
                if (ratio >= 0.7 && row.total <= row.target_rows * 1.5) {
                  console.log(`[FK]   discovered: ${factClass.tableName}.${fromCol.name} → ${dimClass.tableName}.${toCol.name}: overlap ${Math.round(ratio * 100)}%`);
                  addCandidate({
                    fromTable: factClass.tableName, fromColumn: fromCol.name,
                    toTable: dimClass.tableName, toColumn: toCol.name,
                    source: 'value_overlap',
                    confidence: ratio >= 0.95 ? 0.9 : 0.7,
                    overlapRatio: ratio,
                  });
                }
              }
            } catch { /* skip — timeout or type mismatch */ }
          }
        }
      }
    }
    const layer4Added = candidates.length - preLayer4;
    const fkElapsed = Math.round((Date.now() - fkBudgetStart) / 1000);
    console.log(`[FK] Layer 4: ${layer4Added} new FK(s) discovered (${fkElapsed}s elapsed)`);

    // Drop candidates with very low confidence
    const final = candidates.filter((c) => c.confidence >= 0.3);
    console.log(`[FK] Heuristic done: ${final.length} candidates kept (${candidates.length - final.length} dropped)`);
    return { candidates: final.sort((a, b) => b.confidence - a.confidence), classifications };
  }

  /**
   * Returns unmatched key-looking columns from fact/bridge tables
   * that weren't matched by heuristic layers. Used to feed the AI-assisted layer.
   */
  getUnmatchedKeyColumns(
    tables: TableInfo[],
    classifications: TableClassification[],
    matched: FkCandidate[],
  ): { table: string; column: string; sampleValues: unknown[] }[] {
    const matchedKeys = new Set(matched.map((c) => `${c.fromTable}.${c.fromColumn}`));
    const result: { table: string; column: string; sampleValues: unknown[] }[] = [];

    const factBridge = new Set(
      classifications.filter((c) => c.role === 'fact' || c.role === 'bridge').map((c) => c.tableName),
    );

    for (const t of tables) {
      if (!factBridge.has(t.tableName)) continue;
      for (const col of t.columns) {
        const cn = col.name.toLowerCase();
        if (META_COLUMNS.has(cn)) continue;
        if (MEASURE_PATTERNS.test(cn)) continue;
        if (cn === 'id') continue;
        // Only key-like columns
        const isKeyLike = KEY_SUFFIXES.some((s) => cn.endsWith(s));
        if (!isKeyLike) continue;
        if (matchedKeys.has(`${t.tableName}.${col.name}`)) continue;

        result.push({ table: t.tableName, column: col.name, sampleValues: col.sampleValues });
      }
    }
    return result;
  }
}
