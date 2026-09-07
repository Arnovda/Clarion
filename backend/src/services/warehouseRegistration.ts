/**
 * Which name does each warehouse table get in a DuckDB session?
 *
 * Trivial for one connection, and the reason cross-source could not simply be
 * switched on. Two source systems both have a `dim_customer`. Views are
 * registered as `"<schema>"."<table>"` with a `search_path` covering every
 * schema, and DuckDB resolves an unqualified name against that path IN ORDER
 * — so a bare `dim_customer` in a two-source session silently returns
 * whichever source happened to register first.
 *
 * That is the worst failure this platform can produce. Not an error: a
 * plausible total, computed from the wrong company's data, rendered on a
 * dashboard that looks fine. Nobody catches it by eye, and the product's
 * entire pitch is trust in the number.
 *
 * So ambiguity is resolved BY CONSTRUCTION here, and the rule is:
 *
 *   A bare name is registered only when every table claiming it points at
 *   the SAME uri. Otherwise the bare name is not registered at all, and each
 *   claimant gets a source-prefixed name instead.
 *
 * Keying on URI rather than on connection is what makes it correct in both
 * directions. Within one connection a shared dimension is deliberately
 * stubbed into several products, and `publishStubFromUpstream` mirrors the
 * OWNER's uri onto the stub — so those rows collide by name, agree by uri,
 * and must keep the bare name they have always had. Across connections the
 * uris differ, so the bare name disappears and a query naming it fails
 * loudly. Loud is the point: a missing table is a bug report, a wrong number
 * is a lost customer.
 *
 * Pure and dependency-free on purpose — no DuckDB, no knex — so the naming
 * rule can be unit-tested directly. Same reasoning that split
 * `semantic/fkVerification` out of SchemaProfiler and `matchMeasure` out of
 * the cross-source session: a rule this load-bearing must not be reachable
 * only through the native binding.
 */

/** One table as the catalog resolved it, reduced to what naming needs. */
export interface RegisterableTable {
  tableName: string;
  uri: string;
  /** Schema to use in single-source mode. Today: the data product's name. */
  productName: string | null;
  connectionId: number;
  /** Human name of the source, used to build the disambiguating prefix. */
  connectionName: string | null;
  /** Monthly pre-aggregation, registered as `rollup_monthly_<tableName>`. */
  rollupUri?: string | null;
}

export interface RegistrationPlan {
  /** Every logical name to register, in a stable order. */
  tableNames: string[];
  /** name → uri */
  tablePaths: Map<string, string>;
  /** name → schema. Absent means the default schema. */
  tableSchemas: Map<string, string>;
  /**
   * Bare names that were NOT registered because two sources disagreed about
   * what they mean. Surfaced so the semantic context can tell the model the
   * prefixed names to use instead — an unregistered name the model has not
   * been told about is just a failed query.
   */
  ambiguous: AmbiguousName[];
}

export interface AmbiguousName {
  /** The bare name that could not be registered, e.g. `dim_customer`. */
  bareName: string;
  /** The prefixed names that WERE registered, one per source. */
  alternatives: { name: string; connectionId: number; connectionName: string | null }[];
}

/**
 * Turn a source name into a SQL-safe identifier fragment.
 *
 * Lowercase, non-alphanumerics collapsed to `_`, leading digits prefixed —
 * an identifier may not start with a digit, and "2024 Migration" is a
 * perfectly ordinary thing to call a connection. Empty input falls back to
 * the connection id, which is always available and always unique, so a
 * source named `"***"` still produces a usable, distinct prefix rather than
 * colliding with every other unnameable source.
 */
export function sourceSlug(connectionName: string | null, connectionId: number): string {
  const base = (connectionName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) return `source_${connectionId}`;
  return /^[0-9]/.test(base) ? `s_${base}` : base;
}

/**
 * Plan the view registration for a set of tables.
 *
 * `crossSource` is passed rather than inferred from the table list because a
 * scope can legitimately span two connections of which only one currently
 * has materialised output. Inferring would make the naming flip the moment
 * the second source finishes its first build — silently changing what every
 * saved query means.
 */
export function planRegistration(
  tables: RegisterableTable[],
  opts: { crossSource: boolean; rollupName: (table: string) => string },
): RegistrationPlan {
  const plan: RegistrationPlan = {
    tableNames: [],
    tablePaths: new Map(),
    tableSchemas: new Map(),
    ambiguous: [],
  };

  // Group by bare name so a disagreement is visible before anything is named.
  const byName = new Map<string, RegisterableTable[]>();
  for (const t of tables) {
    const list = byName.get(t.tableName);
    if (list) list.push(t);
    else byName.set(t.tableName, [t]);
  }

  const add = (name: string, uri: string, schema: string | null) => {
    if (plan.tablePaths.has(name)) return; // first writer wins; see dedupe note below
    plan.tableNames.push(name);
    plan.tablePaths.set(name, uri);
    if (schema) plan.tableSchemas.set(name, schema);
  };

  for (const [bareName, claimants] of byName) {
    const uris = new Set(claimants.map((c) => c.uri));

    // Agreed — one physical table, however many products list it. This is the
    // stub case, and it is the common one: keep the name it has always had.
    if (uris.size === 1) {
      const first = claimants[0];
      add(bareName, first.uri, opts.crossSource ? sourceSlug(first.connectionName, first.connectionId) : first.productName);
      registerRollups(plan, claimants, bareName, opts, add);
      continue;
    }

    // Disagreed. The bare name is deliberately left unregistered.
    const alternatives: AmbiguousName['alternatives'] = [];
    for (const c of claimants) {
      const slug = sourceSlug(c.connectionName, c.connectionId);
      const prefixed = `${slug}_${bareName}`;
      add(prefixed, c.uri, null); // default schema — the prefix already disambiguates
      alternatives.push({ name: prefixed, connectionId: c.connectionId, connectionName: c.connectionName });
      if (c.rollupUri) add(`${slug}_${opts.rollupName(bareName)}`, c.rollupUri, null);
    }
    plan.ambiguous.push({ bareName, alternatives });
  }

  return plan;
}

/**
 * The name a given source's copy of a table actually answers to.
 *
 * The semantic context MUST describe tables by the name that resolves, not by
 * the name in `product_tables`. Those differ exactly when the collision rule
 * fired, and describing the bare name there would hand the model a table it
 * has been carefully prevented from reaching — turning a safety feature into
 * a guaranteed query failure. One rule, one lookup, both callers.
 */
export function registeredNameFor(
  plan: RegistrationPlan,
  bareName: string,
  connectionId: number,
): string {
  const clash = plan.ambiguous.find((a) => a.bareName === bareName);
  if (!clash) return bareName;
  const mine = clash.alternatives.find((alt) => alt.connectionId === connectionId);
  return mine ? mine.name : bareName;
}

/**
 * Register the monthly rollup beside its fact.
 *
 * Split out because it has to happen on the agreed path and the ambiguous
 * path alike, and because the pairing is load-bearing: the semantic context
 * advertises `rollup_monthly_<fact>` and the dashboard prompt tells the model
 * to PREFER it, so a rollup that is advertised but not registered is a
 * guaranteed query failure. Fix both or neither.
 */
function registerRollups(
  plan: RegistrationPlan,
  claimants: RegisterableTable[],
  bareName: string,
  opts: { crossSource: boolean; rollupName: (table: string) => string },
  add: (name: string, uri: string, schema: string | null) => void,
): void {
  const withRollup = claimants.find((c) => c.rollupUri);
  if (!withRollup?.rollupUri) return;
  add(
    opts.rollupName(bareName),
    withRollup.rollupUri,
    opts.crossSource
      ? sourceSlug(withRollup.connectionName, withRollup.connectionId)
      : withRollup.productName,
  );
}
