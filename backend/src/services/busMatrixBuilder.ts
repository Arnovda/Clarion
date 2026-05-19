/**
 * Bus matrix builder — persists an AI-designed bus matrix to the DB.
 *
 * Extracted from routes/products.ts so the same transaction can run both
 * synchronously (legacy /build-bus-matrix endpoint) and from a BullMQ
 * worker (new /bus-matrix/start job-based flow).
 */

import { semanticDb } from '../db/knex';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';

export interface BuildBusMatrixOptions {
  connectionId: number;
  tenantId: number | undefined;
  userEmail: string | undefined;
  busMatrix: BusMatrixOutput;
}

export interface BuiltProduct { name: string; id: number; status: string; build_order: number }

export interface BuildBusMatrixResult {
  products: BuiltProduct[];
}

/**
 * Decide is_technical for a column when the AI didn't set it explicitly.
 *
 * Two layers:
 *   1. If the AI provided `is_technical`, trust it.
 *   2. Otherwise fall back to heuristics — surrogate keys and foreign
 *      keys in facts are always technical; UUID-typed columns are
 *      always technical; everything else is business-visible by
 *      default.
 *
 * The flag firewalls technical IDs from chat results, narratives, and
 * default sample previews. They remain available for JOINs in NL→SQL.
 */
function inferIsTechnical(col: {
  column_name?: string;
  data_type?: string;
  column_role?: string;
  is_technical?: boolean;
}): boolean {
  if (typeof col.is_technical === 'boolean') return col.is_technical;
  if (col.column_role === 'surrogate_key' || col.column_role === 'foreign_key') return true;
  const type = (col.data_type ?? '').toUpperCase();
  if (type.includes('UUID') || type === 'BLOB' || type.startsWith('BINARY')) return true;
  // Trailing-key heuristic — `*_key` in a fact is a surrogate FK by
  // naming convention even when the AI tags it differently.
  if (/_key$/.test(col.column_name ?? '')) return true;
  return false;
}

/**
 * When the bus-matrix AI call hits max_tokens, the JSON-repair pass closes
 * unclosed brackets but the fields that come AFTER conformed_dimensions +
 * fact_tables in the schema (data_products, relationships, proposed_kpis,
 * dim_date_range) never landed in the stream. Rather than throw away the
 * dims/facts the user just waited 5-10 minutes to design, synthesize the
 * missing scaffolding from what we have so the build can proceed.
 *
 * The synthesized data_products grouping is deliberately minimal —
 * "Foundation" (all dims) + "Analytics" (all facts). The user can split
 * these into business-meaningful products in the UI after the build.
 *
 * Returns true if any recovery was applied (so the orchestrator can warn).
 */
export function recoverIncompleteBusMatrix(busMatrix: BusMatrixOutput): {
  recovered: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  const hasDims = Array.isArray(busMatrix.conformed_dimensions) && busMatrix.conformed_dimensions.length > 0;
  const hasFacts = Array.isArray(busMatrix.fact_tables) && busMatrix.fact_tables.length > 0;
  if (!hasDims || !hasFacts) return { recovered: false, notes };

  let recovered = false;

  if (!Array.isArray(busMatrix.data_products) || busMatrix.data_products.length === 0) {
    busMatrix.data_products = [
      {
        name: 'Foundation',
        description: 'Reference data — conformed dimensions (auto-grouped after AI output was truncated; rename in the UI).',
        build_order: 1,
        fact_tables: [],
        owned_dimensions: busMatrix.conformed_dimensions.map((d) => d.table_name),
      },
      {
        name: 'Analytics',
        description: 'Business facts and metrics (auto-grouped after AI output was truncated; split into business products in the UI).',
        build_order: 2,
        fact_tables: busMatrix.fact_tables.map((f) => f.table_name),
        owned_dimensions: [],
      },
    ];
    notes.push('data_products synthesized as Foundation + Analytics (rename/split in UI)');
    recovered = true;
  }

  if (!Array.isArray(busMatrix.relationships)) {
    const rels: BusMatrixOutput['relationships'] = [];
    for (const fact of busMatrix.fact_tables) {
      for (const dimName of fact.dimensions_used ?? []) {
        if (dimName === 'dim_date') continue;
        const dim = busMatrix.conformed_dimensions.find((d) => d.table_name === dimName);
        if (!dim) continue;
        const dimSk = dim.columns?.find((c) => c.column_role === 'surrogate_key');
        if (!dimSk) continue;
        const factFk =
          fact.columns?.find((c) => c.fk_target_table === dimName) ??
          fact.columns?.find((c) => c.column_name === dimSk.column_name);
        if (!factFk) continue;
        rels.push({
          from_table_name: fact.table_name,
          from_column_name: factFk.column_name,
          to_table_name: dim.table_name,
          to_column_name: dimSk.column_name,
          relationship_type: 'fact_to_dim',
        });
      }
    }
    busMatrix.relationships = rels;
    notes.push(`relationships synthesized (${rels.length} fact→dim links derived from fact columns)`);
    recovered = true;
  }

  if (!Array.isArray(busMatrix.proposed_kpis)) {
    busMatrix.proposed_kpis = [];
    notes.push('proposed_kpis defaulted to empty (add KPIs in the product page)');
    recovered = true;
  }

  if (!busMatrix.dim_date_range || !busMatrix.dim_date_range.start || !busMatrix.dim_date_range.end) {
    busMatrix.dim_date_range = { start: '2020-01-01', end: '2027-12-31' };
    notes.push('dim_date_range defaulted to 2020-01-01 → 2027-12-31');
    recovered = true;
  }

  return { recovered, notes };
}

/**
 * Validate the AI-output shape. Returns an array of human-readable errors;
 * empty array means the spec is good enough to attempt persistence.
 */
export function validateBusMatrix(busMatrix: BusMatrixOutput): string[] {
  const errors: string[] = [];
  if (!Array.isArray(busMatrix.conformed_dimensions)) errors.push('conformed_dimensions missing or not an array');
  if (!Array.isArray(busMatrix.fact_tables)) errors.push('fact_tables missing or not an array');
  if (!Array.isArray(busMatrix.data_products)) errors.push('data_products missing or not an array');
  (busMatrix.data_products ?? []).forEach((dp, i) => {
    if (!dp.name) errors.push(`data_products[${i}].name missing`);
    if (!Array.isArray(dp.owned_dimensions)) errors.push(`data_products[${i}] "${dp.name}": owned_dimensions missing`);
    if (!Array.isArray(dp.fact_tables)) errors.push(`data_products[${i}] "${dp.name}": fact_tables missing`);
    if (typeof dp.build_order !== 'number') errors.push(`data_products[${i}] "${dp.name}": build_order missing`);
  });
  // Save-time guard: when the AI returns prose where SQL should be (e.g.
  // "I need to check what tables are available…" instead of a SELECT) we
  // CANNOT persist it. Doing so kicks off a death spiral where every
  // subsequent run feeds Claude its own apology text and gets worse output.
  // Reject non-SQL here so the bus-matrix flow surfaces a clear error and
  // the user can re-run "Prepare my data" cleanly.
  const looksLikeSql = (sql: unknown): boolean => {
    if (typeof sql !== 'string' || !sql.trim()) return false;
    const stripped = sql.replace(/^\s*--[^\n]*\n/g, '').replace(/^\s+/, '').replace(/^\(+/, '').replace(/^\s+/, '');
    return /^(SELECT|WITH)\b/i.test(stripped);
  };

  (busMatrix.conformed_dimensions ?? []).forEach((d, i) => {
    if (!d.table_name) errors.push(`conformed_dimensions[${i}].table_name missing`);
    if (!Array.isArray(d.columns)) errors.push(`conformed_dimensions[${i}] "${d.table_name}": columns missing`);
    if (!Array.isArray(d.source_tables)) errors.push(`conformed_dimensions[${i}] "${d.table_name}": source_tables missing`);
    if (!d.transformation_sql) errors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql missing`);
    else if (!looksLikeSql(d.transformation_sql)) {
      errors.push(`conformed_dimensions[${i}] "${d.table_name}": transformation_sql is not SQL (must start with SELECT or WITH)`);
    }
  });
  (busMatrix.fact_tables ?? []).forEach((f, i) => {
    if (!f.table_name) errors.push(`fact_tables[${i}].table_name missing`);
    if (!Array.isArray(f.columns)) errors.push(`fact_tables[${i}] "${f.table_name}": columns missing`);
    if (!Array.isArray(f.source_tables)) errors.push(`fact_tables[${i}] "${f.table_name}": source_tables missing`);
    if (!Array.isArray(f.dimensions_used)) errors.push(`fact_tables[${i}] "${f.table_name}": dimensions_used missing`);
    if (!f.transformation_sql) errors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql missing`);
    else if (!looksLikeSql(f.transformation_sql)) {
      errors.push(`fact_tables[${i}] "${f.table_name}": transformation_sql is not SQL (must start with SELECT or WITH)`);
    }
  });
  return errors;
}

/**
 * Persist a bus matrix to the DB in a single transaction. Creates data
 * products, star schemas, tables (with SQL), columns, relationships,
 * dependencies, and KPIs. dim_date is auto-injected for build_order=1
 * products.
 */
export async function buildBusMatrix(opts: BuildBusMatrixOptions): Promise<BuildBusMatrixResult> {
  const { connectionId, tenantId, userEmail, busMatrix } = opts;
  const { DIM_DATE_SQL, DIM_DATE_COLUMNS } = await import('../ai/prompts/starSchemaPrompt');

  const products = await semanticDb.transaction(async (trx) => {
    if (tenantId) await trx.raw(`SET LOCAL app.current_tenant = '${Number(tenantId)}'`);

    const dimByName = new Map(busMatrix.conformed_dimensions.map((d) => [d.table_name, d]));
    const factByName = new Map(busMatrix.fact_tables.map((f) => [f.table_name, f]));

    const sortedProducts = [...busMatrix.data_products].sort((a, b) => a.build_order - b.build_order);

    const productIdByName = new Map<string, number>();
    const _results: BuiltProduct[] = [];

    const allSourceTablesByProduct = new Map<string, Set<string>>();
    for (const dp of sortedProducts) {
      const srcSet = new Set<string>();
      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (dim) dim.source_tables.forEach((s) => srcSet.add(s));
      }
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (fact) fact.source_tables.forEach((s) => srcSet.add(s));
      }
      allSourceTablesByProduct.set(dp.name, srcSet);
    }

    const dimOwnerProduct = new Map<string, string>();
    for (const dp of sortedProducts) {
      for (const dimName of dp.owned_dimensions) {
        dimOwnerProduct.set(dimName, dp.name);
      }
    }

    for (const dp of sortedProducts) {
      // Catalog split: a product with no fact tables is reference-shaped —
      // it only contains entities to slice by (Customer, Item, Date, …),
      // never anything to measure. The /catalog endpoint reads this `kind`
      // column to route the product to the right column (reference) vs
      // left column (analytics) and to unfold reference products into
      // individual entity cards. Without this flag every bus-matrix product
      // defaults to 'analytics' and dim-only products like "Reference"
      // end up in the analytics column with 0 metrics / 0 facts — exactly
      // the regression migration 20260510000054 was meant to prevent.
      const productKind = dp.fact_tables.length === 0 ? 'reference' : 'analytics';

      const [productRow] = await trx('data_products').insert({
        connection_id: connectionId,
        name: dp.name,
        description: dp.description,
        status: 'draft',
        kind: productKind,
        created_by: userEmail || 'ai',
        tenant_id: tenantId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');

      const pid = typeof productRow === 'object' ? (productRow as { id: number }).id : (productRow as number);
      productIdByName.set(dp.name, pid);

      const depProductNames = new Set<string>();
      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;
        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          const owner = dimOwnerProduct.get(dimName);
          if (owner && owner !== dp.name) depProductNames.add(owner);
        }
      }
      for (const depName of depProductNames) {
        const sourceId = productIdByName.get(depName);
        if (sourceId) {
          await trx('data_product_dependencies').insert({
            dependent_product_id: pid,
            source_product_id: sourceId,
            tenant_id: tenantId,
          }).onConflict(['dependent_product_id', 'source_product_id']).ignore();
        }
      }

      const primaryFact = dp.fact_tables[0] ? factByName.get(dp.fact_tables[0]) : null;
      const [schemaRow] = await trx('star_schemas').insert({
        data_product_id: pid,
        name: dp.name,
        description: dp.description,
        grain: primaryFact?.grain ?? 'Conformed dimensions',
        fact_table_type: primaryFact?.fact_table_type ?? 'transaction',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const schemaId = typeof schemaRow === 'object' ? (schemaRow as { id: number }).id : (schemaRow as number);

      const tableNameToId = new Map<string, number>();

      for (const dimName of dp.owned_dimensions) {
        const dim = dimByName.get(dimName);
        if (!dim) continue;

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: dim.table_name,
          display_name: dim.display_name,
          description: dim.description,
          table_role: 'dimension',
          // OWNER row — this product materialises the dim. Stubs in
          // downstream products that reference this dim are inserted with
          // is_shared_dimension=true (see fact-tables loop below).
          is_shared_dimension: false,
          dag_order: 0,
          transformation_sql: dim.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(dim.table_name, tableId);

        for (const col of dim.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            is_technical: inferIsTechnical(col),
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }
      }

      for (const factName of dp.fact_tables) {
        const fact = factByName.get(factName);
        if (!fact) continue;

        const [tableRow] = await trx('product_tables').insert({
          star_schema_id: schemaId,
          table_name: fact.table_name,
          display_name: fact.display_name,
          description: fact.description,
          table_role: 'fact',
          is_shared_dimension: false,
          dag_order: 1,
          transformation_sql: fact.transformation_sql,
          transformation_status: 'draft',
          load_mode: 'full',
          ai_draft: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).returning('id');
        const tableId = typeof tableRow === 'object' ? (tableRow as { id: number }).id : (tableRow as number);
        tableNameToId.set(fact.table_name, tableId);

        for (const col of fact.columns) {
          const [colRow] = await trx('product_columns').insert({
            product_table_id: tableId,
            column_name: col.column_name,
            data_type: col.data_type,
            display_name: col.display_name,
            description: col.description,
            column_role: col.column_role,
            fk_target_table: col.fk_target_table ?? null,
            fk_target_column: col.fk_target_column ?? null,
            transformation_expression: col.transformation_expression,
            additivity: col.additivity ?? null,
            scd_type: col.scd_type ?? 1,
            sort_order: col.sort_order ?? 0,
            is_technical: inferIsTechnical(col),
            ai_draft: true,
          }).returning('id');
          const colId = typeof colRow === 'object' ? (colRow as { id: number }).id : (colRow as number);

          const validLineage = (col.lineage ?? []).filter((l) => l.source_table_name && l.source_column_name);
          if (validLineage.length) {
            await trx('column_lineage').insert(
              validLineage.map((l) => ({
                product_column_id: colId,
                source_table_name: l.source_table_name,
                source_column_name: l.source_column_name,
                transformation_description: l.transformation_description ?? null,
              })),
            );
          }
        }

        for (const dimName of fact.dimensions_used) {
          if (dimName === 'dim_date') continue;
          if (dp.owned_dimensions.includes(dimName)) continue;
          const dim = dimByName.get(dimName);
          if (!dim || tableNameToId.has(dimName)) continue;

          const [stubRow] = await trx('product_tables').insert({
            star_schema_id: schemaId,
            table_name: dim.table_name,
            display_name: dim.display_name,
            description: dim.description,
            table_role: 'dimension',
            is_shared_dimension: true,
            dag_order: 0,
            transformation_sql: null,
            transformation_status: 'draft',
            load_mode: 'full',
            ai_draft: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).returning('id');
          const stubId = typeof stubRow === 'object' ? (stubRow as { id: number }).id : (stubRow as number);
          tableNameToId.set(dim.table_name, stubId);

          for (const col of dim.columns) {
            await trx('product_columns').insert({
              product_table_id: stubId,
              column_name: col.column_name,
              data_type: col.data_type,
              display_name: col.display_name,
              description: col.description,
              column_role: col.column_role,
              fk_target_table: col.fk_target_table ?? null,
              fk_target_column: col.fk_target_column ?? null,
              transformation_expression: col.transformation_expression,
              additivity: col.additivity ?? null,
              scd_type: col.scd_type ?? 1,
              sort_order: col.sort_order ?? 0,
              is_technical: inferIsTechnical(col),
              ai_draft: true,
            });
          }
        }
      }

      const dateRange = busMatrix.dim_date_range ?? { start: '2020-01-01', end: '2027-12-31' };
      const isFirstBuilder = dp.build_order === 1;
      const [dimDateRow] = await trx('product_tables').insert({
        star_schema_id: schemaId,
        table_name: 'dim_date',
        display_name: 'Date',
        description: 'Auto-generated calendar dimension',
        table_role: 'dimension',
        // Only the first product in build order materializes dim_date.
        // All later products treat it as a conformed (shared) dimension and
        // load it from the owning product's parquet at run time.
        is_shared_dimension: !isFirstBuilder,
        dag_order: 0,
        transformation_sql: isFirstBuilder ? DIM_DATE_SQL(dateRange.start, dateRange.end) : null,
        transformation_status: 'draft',
        ai_draft: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const dimDateId = typeof dimDateRow === 'object' ? (dimDateRow as { id: number }).id : (dimDateRow as number);
      tableNameToId.set('dim_date', dimDateId);

      for (const col of DIM_DATE_COLUMNS) {
        await trx('product_columns').insert({
          product_table_id: dimDateId,
          column_name: col.column_name,
          data_type: col.data_type,
          display_name: col.display_name,
          description: col.description,
          column_role: col.column_role,
          transformation_expression: col.transformation_expression,
          scd_type: col.scd_type,
          sort_order: col.sort_order,
          ai_draft: false,
        });
      }

      for (const rel of busMatrix.relationships) {
        const fromId = tableNameToId.get(rel.from_table_name);
        const toId = tableNameToId.get(rel.to_table_name);
        if (fromId && toId) {
          await trx('product_relationships').insert({
            star_schema_id: schemaId,
            from_table_id: fromId,
            from_column_name: rel.from_column_name,
            to_table_id: toId,
            to_column_name: rel.to_column_name,
            relationship_type: rel.relationship_type,
          });
        }
      }

      const srcSet = allSourceTablesByProduct.get(dp.name);
      if (srcSet && srcSet.size > 0) {
        const sourceTblRows = await trx('source_tables')
          .where({ connection_id: connectionId })
          .whereIn('table_name', [...srcSet])
          .select('id', 'table_name');
        if (sourceTblRows.length > 0) {
          await trx('data_product_sources').insert(
            sourceTblRows.map((r: { id: number; table_name: string }) => ({
              data_product_id: pid,
              source_table_id: r.id,
              table_name: r.table_name,
            })),
          );
        }
      }

      const productKpis = (busMatrix.proposed_kpis ?? []).filter((k) => k.product_name === dp.name);
      if (productKpis.length > 0) {
        await trx('product_kpis').insert(
          productKpis.map((k) => ({
            data_product_id: pid,
            name: k.name,
            description: k.description,
            formula_plain_text: k.formula_plain_text,
            formula_sql: k.formula_sql,
            ai_draft: true,
          })),
        );
      }

      await trx('data_products').where({ id: pid }).update({
        status: 'approved',
        updated_at: new Date().toISOString(),
      });

      _results.push({ name: dp.name, id: pid, status: 'created', build_order: dp.build_order });
    }

    return _results;
  });

  return { products };
}
