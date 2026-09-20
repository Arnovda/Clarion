/**
 * Projections — from a source package to the contracts the platform already
 * consumes. The package is the source of truth; these are the ONLY readers,
 * so the connector contract (`EntityDescriptor`, `ColumnDoc`,
 * `KnownRelationship`, `StarSchemaTemplate`) did not have to change and
 * every existing validator and test keeps running against the same shapes.
 *
 * Nothing here is inferred. Where a value is derived (supportsIncremental
 * from the cursor, a template's relationships from its foreign-key fields, a
 * product's tables from `clarion.product`) the derivation is a one-line rule
 * stated in the package types, not a heuristic.
 */
import type { ColumnDoc, EntityDescriptor, KnownRelationship } from '../types';
import type {
  StarSchemaTemplate, TemplateColumn, TemplateDimension, TemplateFact, TemplateKpi, TemplateProduct, TemplateRelationship,
} from '../starSchema';
import {
  isModelledDataset,
  isSourceDataset,
  type PackageDataset,
  type PackageField,
  type SourcePackage,
} from './types';

/** The vendor's entities — datasets with `kind: source`, in package order. */
export function sourceDatasets(pkg: SourcePackage): PackageDataset[] {
  return pkg.datasets.filter(isSourceDataset);
}

/** The template's dimensions and facts — datasets with `kind: dimension | fact`. */
export function modelledDatasets(pkg: SourcePackage): PackageDataset[] {
  return pkg.datasets.filter(isModelledDataset);
}

/** Drop `undefined` values so projected objects equal hand-written ones key for key. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

/**
 * Source datasets → `EntityDescriptor`s. Connectors that carry extra facts
 * per entity (Exact's API path, Odoo's model name) read `dataset.source` and
 * `dataset.clarion` themselves; this is the platform-facing projection.
 */
export function toEntityDescriptors(pkg: SourcePackage): EntityDescriptor[] {
  return sourceDatasets(pkg).map((d) => {
    const cursor = d.clarion.sync?.cursor;
    return compact<EntityDescriptor>({
      name: d.name,
      displayName: d.label,
      category: d.clarion.category,
      description: d.description,
      estimatedRowCount: d.clarion.estimatedRowCount,
      supportsIncremental: !!cursor,
      incrementalCursor: cursor ? { field: cursor.field, type: cursor.type } : undefined,
      businessKey: d.primary_key?.[0],
    });
  });
}

/**
 * Source datasets' fields → the `describeEntities` column docs, keyed by
 * entity name. A dataset without documented fields is absent (the profiler's
 * AI pipeline covers it), never present as an empty list.
 */
export function toColumnDocs(pkg: SourcePackage): Record<string, readonly ColumnDoc[]> {
  const out: Record<string, readonly ColumnDoc[]> = {};
  for (const d of sourceDatasets(pkg)) {
    if (!d.fields || d.fields.length === 0) continue;
    out[d.name] = d.fields.map((f) => compact<ColumnDoc>({
      name: f.name,
      displayName: f.label,
      description: f.description,
      role: f.clarion?.role as ColumnDoc['role'],
      dataType: f.datatype,
      references: f.clarion?.references
        ? { table: f.clarion.references.dataset, column: f.clarion.references.field }
        : undefined,
    }));
  }
  return out;
}

/** The curated source-layer relationships → `KnownRelationship`s. */
export function toKnownRelationships(pkg: SourcePackage): KnownRelationship[] {
  return (pkg.relationships ?? []).map((r) => compact<KnownRelationship>({
    fromTable: r.from,
    fromColumn: r.from_columns[0],
    toTable: r.to,
    toColumn: r.to_columns[0],
    type: r.cardinality ?? 'many_to_one',
    description: r.description,
  }));
}

function toTemplateColumn(f: PackageField): TemplateColumn {
  const c = f.clarion ?? {};
  return compact<TemplateColumn>({
    name: f.name,
    dataType: f.datatype ?? '',
    displayName: f.label ?? f.name,
    description: f.description ?? '',
    role: (c.role as TemplateColumn['role']) ?? 'attribute',
    fkTargetTable: c.references?.dataset,
    fkTargetColumn: c.references?.field,
    isTechnical: c.technical,
    additivity: c.additivity,
    sourceEntity: c.lineage?.dataset,
    sourceColumn: c.lineage?.field,
  });
}

/**
 * Modelled datasets + template products + metrics → the `StarSchemaTemplate`
 * the platform instantiates. Null when the package ships no template.
 *
 * Derived, not stored: a fact's `dimensionsUsed` (from its FK fields, when
 * the package does not list it), every template relationship (from the FK
 * fields — `fact_to_dim` off a fact, `dim_to_dim` off a dimension), and each
 * product's tables (from `clarion.product`).
 */
export function toStarSchemaTemplate(pkg: SourcePackage): StarSchemaTemplate | null {
  const tpl = pkg.clarion.template;
  const tables = modelledDatasets(pkg);
  if (!tpl || tables.length === 0) return null;

  const dimensions: TemplateDimension[] = [];
  const facts: TemplateFact[] = [];
  const relationships: TemplateRelationship[] = [];

  for (const d of tables) {
    const c = d.clarion;
    const columns = (d.fields ?? []).map(toTemplateColumn);
    const base: TemplateDimension = {
      tableName: d.name,
      displayName: d.label ?? d.name,
      description: d.description ?? '',
      sourceEntities: [...(c.sourceEntities ?? [])],
      sql: d.source ?? '',
      columns,
    };
    for (const col of columns) {
      if (col.role === 'foreign_key' && col.fkTargetTable && col.fkTargetColumn) {
        relationships.push({
          fromTable: d.name,
          fromColumn: col.name,
          toTable: col.fkTargetTable,
          toColumn: col.fkTargetColumn,
          type: c.kind === 'fact' ? 'fact_to_dim' : 'dim_to_dim',
        });
      }
    }
    if (c.kind === 'fact') {
      const derivedDims = [...new Set(columns
        .filter((col) => col.role === 'foreign_key' && col.fkTargetTable)
        .map((col) => col.fkTargetTable as string))];
      facts.push({
        ...base,
        grain: c.grain ?? '',
        factTableType: c.factTableType ?? 'transaction',
        dimensionsUsed: c.dimensionsUsed ? [...c.dimensionsUsed] : derivedDims,
      });
    } else {
      dimensions.push(base);
    }
  }

  const products: TemplateProduct[] = tpl.products
    .slice()
    .sort((a, b) => a.buildOrder - b.buildOrder)
    .map((p) => ({
      name: p.name,
      description: p.description,
      buildOrder: p.buildOrder,
      factTables: facts.filter((f) => tables.find((t) => t.name === f.tableName)?.clarion.product === p.name).map((f) => f.tableName),
      ownedDimensions: dimensions.filter((dm) => tables.find((t) => t.name === dm.tableName)?.clarion.product === p.name).map((dm) => dm.tableName),
    }));

  const kpis: TemplateKpi[] = (pkg.metrics ?? []).map((m) => ({
    name: m.name,
    description: m.description ?? '',
    formulaPlainText: m.clarion.formulaPlainText,
    formulaSql: m.expression,
    additivity: m.clarion.additivity,
    productName: m.clarion.product,
    requiresTables: [...m.clarion.requiresTables],
  }));

  return { version: tpl.version, dimensions, facts, products, relationships, kpis };
}
