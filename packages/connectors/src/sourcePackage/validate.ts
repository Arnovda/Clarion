/**
 * Source-package validation — the JSON Schema for shape, then the
 * cross-references the schema cannot express. Both return human-readable
 * violations (empty = valid) so the conformance suite can `toEqual([])` and
 * name exactly what is wrong.
 *
 * The projections (`project.ts`) are additionally held to the existing
 * connector validators — `validateEntityCatalog`, `validateKnownRelationships`
 * with the documented columns, `validateStarSchemaTemplate` — so nothing that
 * used to be checked on the TypeScript data is checked less on the YAML.
 */
import Ajv from 'ajv';
import schema from './schema.json';
import {
  isModelledDataset,
  isSourceDataset,
  type PackageDataset,
  type SourcePackage,
} from './types';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(schema as object);

const MODELLED_NAME = /^[a-z][a-z0-9_]*$/;
const SOURCE_ROLES = new Set(['measure', 'dimension']);
const MODELLED_ROLES = new Set(['surrogate_key', 'natural_key', 'foreign_key', 'measure', 'attribute', 'degenerate_dimension']);

function looksLikeSql(sql: string): boolean {
  const stripped = sql.replace(/^\s*--[^\n]*\n/g, '').trimStart();
  return /^(SELECT|WITH)\b/i.test(stripped);
}

/** JSON-Schema shape check only. */
export function validateSourcePackageShape(pkg: unknown): string[] {
  if (validateShape(pkg)) return [];
  return (validateShape.errors ?? []).map((e) => {
    const extra = (e.params as { additionalProperty?: string; allowedValues?: unknown[] } | undefined);
    const where = e.instancePath || '/';
    if (extra?.additionalProperty) return `${where}: unknown key '${extra.additionalProperty}'`;
    if (extra?.allowedValues) return `${where} ${e.message} (${extra.allowedValues.join(', ')})`;
    return `${where} ${e.message ?? 'invalid'}`;
  });
}

/**
 * Full validation: shape, then every cross-reference. A shape error stops
 * early — the semantic checks assume the shape.
 */
export function validateSourcePackage(pkg: unknown): string[] {
  const shape = validateSourcePackageShape(pkg);
  if (shape.length > 0) return shape;
  const p = pkg as SourcePackage;
  const errs: string[] = [];
  const at = (s: string) => errs.push(`[${p.name}] ${s}`);
  // With partial field lists, "not a documented field" proves nothing.
  const complete = p.clarion.fieldCoverage === 'complete';

  // ── datasets ──
  const seen = new Map<string, string>();
  const source = new Map<string, PackageDataset>();
  const modelled = new Map<string, PackageDataset>();
  for (const d of p.datasets) {
    const lower = d.name.toLowerCase();
    if (seen.has(lower)) at(`dataset '${d.name}' collides with '${seen.get(lower)}' (warehouse names are case-insensitive)`);
    seen.set(lower, d.name);
    if (isSourceDataset(d)) source.set(d.name, d);
    else modelled.set(d.name, d);
  }

  const products = new Map(p.clarion.template?.products.map((x) => [x.name, x]) ?? []);
  if (p.clarion.template) {
    const orders = new Set<number>();
    for (const pr of p.clarion.template.products) {
      if (orders.has(pr.buildOrder)) at(`template product '${pr.name}': duplicate buildOrder ${pr.buildOrder}`);
      orders.add(pr.buildOrder);
    }
    if (products.size !== p.clarion.template.products.length) at('template products must have unique names');
  }
  if (modelled.size > 0 && !p.clarion.template) at('modelled datasets exist but clarion.template is missing');
  const cats = p.clarion.categories ?? [];
  if (new Set(cats).size !== cats.length) at('clarion.categories has a duplicate');
  for (const d of source.values()) {
    if (cats.length > 0 && d.clarion.category && !cats.includes(d.clarion.category)) {
      at(`dataset '${d.name}': category '${d.clarion.category}' is not in clarion.categories`);
    }
  }

  for (const d of source.values()) {
    const c = d.clarion;
    const id = `dataset '${d.name}'`;
    if (!d.description?.trim()) at(`${id}: description is required (playbook Phase C)`);
    for (const k of ['product', 'sourceEntities', 'grain', 'factTableType', 'dimensionsUsed'] as const) {
      if (c[k] !== undefined) at(`${id}: '${k}' is a modelled-dataset key`);
    }
    if (c.sync?.cursor && !d.primary_key) {
      at(`${id}: declares a sync cursor but no primary_key — incremental sync would wipe unchanged rows`);
    }
    checkFields(d, 'source');
  }

  for (const d of modelled.values()) {
    const c = d.clarion;
    const id = `${c.kind} '${d.name}'`;
    if (!MODELLED_NAME.test(d.name)) at(`${id}: name must match ${MODELLED_NAME}`);
    if (!d.source || !looksLikeSql(d.source)) at(`${id}: source must be the table's SELECT/WITH`);
    if (!d.description?.trim()) at(`${id}: description is required`);
    if (!c.product) at(`${id}: clarion.product is required`);
    else if (!products.has(c.product)) at(`${id}: product '${c.product}' is not a template product`);
    if (!c.sourceEntities || c.sourceEntities.length === 0) at(`${id}: clarion.sourceEntities is required`);
    for (const e of c.sourceEntities ?? []) {
      if (!source.has(e)) at(`${id}: sourceEntities names '${e}', not a source dataset`);
    }
    if (!d.fields || d.fields.length === 0) at(`${id}: fields is required`);
    for (const k of ['category', 'sync', 'estimatedRowCount'] as const) {
      if (c[k] !== undefined) at(`${id}: '${k}' is a source-dataset key`);
    }
    if (c.kind === 'fact') {
      if (!c.grain || !/^One row per /i.test(c.grain)) at(`${id}: grain must start with 'One row per'`);
      if (!c.factTableType) at(`${id}: factTableType is required`);
      for (const dim of c.dimensionsUsed ?? []) {
        if (dim !== 'dim_date' && modelled.get(dim)?.clarion.kind !== 'dimension') {
          at(`${id}: dimensionsUsed names '${dim}', not a template dimension`);
        }
      }
    } else {
      for (const k of ['grain', 'factTableType', 'dimensionsUsed'] as const) {
        if (c[k] !== undefined) at(`${id}: '${k}' is a fact key`);
      }
    }
    checkFields(d, 'modelled');
  }

  // Every product builds at least one table.
  const used = new Set([...modelled.values()].map((d) => d.clarion.product));
  for (const name of products.keys()) {
    if (!used.has(name)) at(`template product '${name}' builds no table`);
  }

  // ── relationships: curated SOURCE joins only ──
  const relKeys = new Set<string>();
  for (const r of p.relationships ?? []) {
    const id = `relationship ${r.from}.${r.from_columns[0]}→${r.to}.${r.to_columns[0]}`;
    if (modelled.has(r.from) || modelled.has(r.to)) {
      at(`${id}: template joins are written on the fact's foreign-key field (clarion.references), not here`);
      continue;
    }
    const from = source.get(r.from);
    const to = source.get(r.to);
    if (!from) at(`${id}: from is not a source dataset`);
    if (!to) at(`${id}: to is not a source dataset`);
    if (complete && from?.fields?.length && !from.fields.some((f) => f.name === r.from_columns[0])) {
      at(`${id}: from column is not a documented field of ${r.from}`);
    }
    if (complete && to?.fields?.length && !to.fields.some((f) => f.name === r.to_columns[0])) {
      at(`${id}: to column is not a documented field of ${r.to}`);
    }
    const key = `${r.from}.${r.from_columns[0]}→${r.to}.${r.to_columns[0]}`;
    if (relKeys.has(key)) at(`${id}: duplicate relationship`);
    relKeys.add(key);
  }

  // ── metrics ──
  const metricNames = new Set<string>();
  for (const m of p.metrics ?? []) {
    const id = `metric '${m.name}'`;
    if (metricNames.has(m.name)) at(`${id}: duplicate name`);
    metricNames.add(m.name);
    if (!looksLikeSql(m.expression)) at(`${id}: expression must be a SELECT/WITH`);
    if (!products.has(m.clarion.product)) at(`${id}: product '${m.clarion.product}' is not a template product`);
    for (const t of m.clarion.requiresTables) {
      if (!modelled.has(t)) at(`${id}: requiresTables names '${t}', not a modelled dataset`);
    }
  }

  return errs;

  function checkFields(d: PackageDataset, layer: 'source' | 'modelled') {
    const id = `dataset '${d.name}'`;
    const names = new Set<string>();
    for (const f of d.fields ?? []) {
      const fid = `${id} field '${f.name}'`;
      if (names.has(f.name)) at(`${fid}: duplicate field`);
      names.add(f.name);
      const c = f.clarion ?? {};
      if (c.role !== undefined) {
        const ok = layer === 'source' ? SOURCE_ROLES.has(c.role) : MODELLED_ROLES.has(c.role);
        if (!ok) at(`${fid}: role '${c.role}' is not a ${layer}-field role`);
      }
      if (layer === 'source') {
        for (const k of ['technical', 'additivity', 'lineage'] as const) {
          if (c[k] !== undefined) at(`${fid}: '${k}' is a modelled-field key`);
        }
        if (c.references) {
          const target = source.get(c.references.dataset);
          if (!target) at(`${fid}: references '${c.references.dataset}', not a source dataset`);
          else if (complete && target.fields?.length && !target.fields.some((x) => x.name === c.references!.field)) {
            at(`${fid}: references ${c.references.dataset}.${c.references.field}, not a documented field`);
          }
        }
      } else {
        if (c.role === 'foreign_key' && !c.references) at(`${fid}: foreign_key needs clarion.references`);
        if (c.references) {
          const target = modelled.get(c.references.dataset);
          if (!target) at(`${fid}: references '${c.references.dataset}', not a modelled dataset`);
          else if (!(target.fields ?? []).some((x) => x.name === c.references!.field)) {
            at(`${fid}: references ${c.references.dataset}.${c.references.field}, which that table does not declare`);
          }
        }
        if (c.lineage) {
          const src = source.get(c.lineage.dataset);
          if (!src) at(`${fid}: lineage names '${c.lineage.dataset}', not a source dataset`);
          else if (complete && src.fields?.length && !src.fields.some((x) => x.name === c.lineage!.field)) {
            at(`${fid}: lineage ${c.lineage.dataset}.${c.lineage.field} is not a documented field — no guessed field names`);
          }
        }
        if (!f.datatype) at(`${fid}: datatype (the DuckDB type the SQL produces) is required`);
      }
    }
  }
}

/** True when `d` is a template dimension or fact. Re-exported for convenience. */
export { isModelledDataset };
