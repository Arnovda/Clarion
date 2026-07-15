/**
 * Connector star-schema templates → bus-matrix bridge.
 *
 * For connectors that ship a deterministic star-schema template
 * (`SourceConnector.getStarSchemaTemplate`, docs/SOURCE_ONBOARDING.md
 * Phase F), this module instantiates the template against the tables the
 * customer actually synced and maps it onto the SAME `BusMatrixOutput` shape
 * the AI designer produces — so validation, persistence (`buildBusMatrix`)
 * and the transformation phases run completely unchanged.
 *
 * The AI designer remains the fallback: no template, template disabled via
 * `STAR_SCHEMA_TEMPLATES_DISABLED=1`, or no fact survives the entity filter
 * → return null and the caller proceeds with the AI phases as before.
 */

import {
  getConnector as getSourceConnector,
  instantiateStarSchemaTemplate,
  type StarSchemaTemplate,
  type TemplateColumn,
} from '@databridge/connectors';
import type { BusMatrixOutput } from '../ai/prompts/busMatrixPrompt';
import type { ColumnDesign } from '../ai/prompts/starSchemaPrompt';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'starSchemaTemplates' });

export interface TemplateBusMatrix {
  busMatrix: BusMatrixOutput;
  templateVersion: number;
}

function mapColumn(c: TemplateColumn, index: number): ColumnDesign {
  return {
    column_name: c.name,
    data_type: c.dataType,
    display_name: c.displayName,
    description: c.description,
    column_role: c.role,
    fk_target_table: c.fkTargetTable,
    fk_target_column: c.fkTargetColumn,
    is_technical: c.isTechnical,
    transformation_expression: c.sourceEntity && c.sourceColumn
      ? `${c.sourceEntity}.${c.sourceColumn}`
      : c.name,
    additivity: c.additivity,
    scd_type: 1,
    sort_order: index,
    lineage: c.sourceEntity && c.sourceColumn
      ? [{
          source_table_name: c.sourceEntity,
          source_column_name: c.sourceColumn,
          transformation_description: 'Template mapping',
        }]
      : [],
  };
}

function toBusMatrix(t: StarSchemaTemplate, connectorType: string): BusMatrixOutput {
  const year = new Date().getFullYear();
  return {
    rationale: `Deterministic ${connectorType} star-schema template v${t.version} — instantiated from the connector's built-in design, no AI involved.`,
    conformed_dimensions: t.dimensions.map((d) => ({
      table_name: d.tableName,
      display_name: d.displayName,
      description: d.description,
      transformation_sql: d.sql,
      source_tables: [...d.sourceEntities],
      columns: d.columns.map(mapColumn),
    })),
    fact_tables: t.facts.map((f) => ({
      table_name: f.tableName,
      display_name: f.displayName,
      description: f.description,
      grain: f.grain,
      fact_table_type: f.factTableType,
      transformation_sql: f.sql,
      source_tables: [...f.sourceEntities],
      dimensions_used: [...f.dimensionsUsed],
      columns: f.columns.map(mapColumn),
    })),
    relationships: t.relationships.map((r) => ({
      from_table_name: r.fromTable,
      from_column_name: r.fromColumn,
      to_table_name: r.toTable,
      to_column_name: r.toColumn,
      relationship_type: r.type,
    })),
    data_products: t.products.map((p) => ({
      name: p.name,
      description: p.description,
      build_order: p.buildOrder,
      fact_tables: [...p.factTables],
      owned_dimensions: [...p.ownedDimensions],
    })),
    proposed_kpis: t.kpis.map((k) => ({
      name: k.name,
      description: k.description,
      formula_plain_text: k.formulaPlainText,
      formula_sql: k.formulaSql,
      additivity: k.additivity,
      product_name: k.productName,
    })),
    // Templates can't know the customer's data range; a generous default is
    // fine — dim_date is cheap and facts join it by date value.
    dim_date_range: { start: '2015-01-01', end: `${year + 2}-12-31` },
  };
}

/**
 * Instantiate the connector's template against the synced tables. Returns
 * null (→ AI fallback) when the connector has no template, templates are
 * disabled, or no fact table survives the entity filter.
 */
export function tryBuildBusMatrixFromTemplate(
  connectorType: string | null,
  availableTableNames: readonly string[],
): TemplateBusMatrix | null {
  if (!connectorType) return null;
  if (process.env.STAR_SCHEMA_TEMPLATES_DISABLED === '1') {
    log.info('star-schema templates disabled via STAR_SCHEMA_TEMPLATES_DISABLED');
    return null;
  }

  let template: StarSchemaTemplate | null = null;
  try {
    const connector = getSourceConnector(connectorType);
    template = connector.getStarSchemaTemplate?.() ?? null;
  } catch {
    return null; // unknown connector type (legacy DB connections) → AI path
  }
  if (!template) return null;

  const instantiated = instantiateStarSchemaTemplate(template, availableTableNames);
  if (!instantiated) {
    log.info(
      { connectorType, availableTables: availableTableNames.length },
      'star-schema template did not cover the synced entities — falling back to AI design',
    );
    return null;
  }

  log.info(
    {
      connectorType,
      version: template.version,
      dims: instantiated.dimensions.length,
      facts: instantiated.facts.length,
      products: instantiated.products.length,
    },
    'instantiated connector star-schema template',
  );
  return {
    busMatrix: toBusMatrix(instantiated, connectorType),
    templateVersion: template.version,
  };
}
