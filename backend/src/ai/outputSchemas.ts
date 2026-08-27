/**
 * Runtime validation for AI (Claude) JSON outputs that get PERSISTED.
 *
 * `parseJson<T>` in AIService trusts the model to return the right shape — it
 * ends in `JSON.parse(...) as T`, a compile-time cast with zero runtime
 * checking. For outputs that flow straight into the database (star-schema
 * designs, dashboard specs, schema drafts), a syntactically-valid but
 * semantically-wrong response would be written as-is and fail deep downstream
 * (or corrupt a product/dashboard). These Zod schemas are the guard: the
 * consumer validates before persisting, and a mismatch throws a clear error
 * the caller's repair/retry path can act on.
 *
 * Design choices:
 *   • `.passthrough()` everywhere — we assert the REQUIRED structure and key
 *     field types, but tolerate extra/optional fields the model may add and
 *     that the prompt types mark optional. The point is to catch *malformed*
 *     output, not to reject every superset.
 *   • Schemas are intentionally structural (arrays present, names are strings,
 *     enums where the downstream code switches on them). They mirror the
 *     interfaces in ai/prompts/* — keep them in sync when those change.
 */

import { z } from 'zod';
import { REQUIRED_WIDGET_COLUMNS } from '../shared/widgetContracts';
import type { DashboardSpec } from './prompts/dashboardPrompt';
import type { SchemaDraftOutput } from './prompts/schemaDraftPrompt';
import type { StarSchemaDesignOutput } from './prompts/starSchemaPrompt';

// ─── Dashboard spec ─────────────────────────────────────────────────────────
const filterSpecSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['date_range', 'select']),
  label: z.string(),
  table: z.string(),
  column: z.string(),
}).passthrough();

const widgetSpecSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'kpi_card', 'bar_chart', 'vertical_bar_chart', 'stacked_bar_chart',
    'line_chart', 'pie_chart', 'top_list', 'data_table', 'combo_chart',
    'radar_chart', 'treemap_chart', 'pivot_table', 'scatter_chart',
    'bullet_chart',
  ]),
  title: z.string(),
  sql: z.string().min(1),
}).passthrough();

export const dashboardSpecSchema = z.object({
  title: z.string(),
  description: z.string(),
  filters: z.array(filterSpecSchema),
  widgets: z.array(widgetSpecSchema).min(1),
}).passthrough();

// ─── Schema draft (table/column descriptions) ───────────────────────────────
export const schemaDraftSchema = z.object({
  tables: z.array(z.object({
    table_name: z.string().min(1),
    display_name: z.string(),
    description: z.string(),
    suggested_relationships: z.array(z.object({
      to_table: z.string(),
      via_column: z.string(),
      to_column: z.string(),
      type: z.string(),
    }).passthrough()).default([]),
  }).passthrough()),
  columns: z.array(z.object({
    table_name: z.string().min(1),
    column_name: z.string().min(1),
    display_name: z.string(),
    description: z.string(),
    is_dimension: z.boolean(),
    is_measure: z.boolean(),
  }).passthrough()),
}).passthrough();

// ─── Star-schema design ─────────────────────────────────────────────────────
const columnDesignSchema = z.object({
  column_name: z.string().min(1),
  data_type: z.string(),
  display_name: z.string(),
  column_role: z.enum([
    'surrogate_key', 'natural_key', 'foreign_key',
    'measure', 'attribute', 'degenerate_dimension',
  ]),
}).passthrough();

const tableDesignSchema = z.object({
  table_name: z.string().min(1),
  display_name: z.string(),
  table_role: z.enum(['fact', 'dimension', 'bridge', 'junk']),
  columns: z.array(columnDesignSchema).min(1),
}).passthrough();

export const starSchemaDesignSchema = z.object({
  star_schema: z.object({
    name: z.string(),
    tables: z.array(tableDesignSchema).min(1),
    relationships: z.array(z.object({
      from_table_name: z.string(),
      from_column_name: z.string(),
      to_table_name: z.string(),
      to_column_name: z.string(),
    }).passthrough()).default([]),
  }).passthrough(),
  proposed_kpis: z.array(z.object({
    name: z.string(),
    formula_sql: z.string(),
  }).passthrough()).default([]),
}).passthrough();

// Compile-time guarantee that each schema is assignable to its interface — if a
// prompt interface changes shape incompatibly, this fails the build.
const _dash: z.ZodType<unknown> = dashboardSpecSchema;
const _draft: z.ZodType<unknown> = schemaDraftSchema;
const _star: z.ZodType<unknown> = starSchemaDesignSchema;
void _dash; void _draft; void _star;

// Typed re-exports so callers get the interface type back, not `unknown`.
export const AI_OUTPUT_SCHEMAS = {
  dashboardSpec: dashboardSpecSchema as unknown as z.ZodType<DashboardSpec>,
  schemaDraft: schemaDraftSchema as unknown as z.ZodType<SchemaDraftOutput>,
  starSchemaDesign: starSchemaDesignSchema as unknown as z.ZodType<StarSchemaDesignOutput>,
};

// ─── JSON Schema for Anthropic structured outputs (constrained decoding) ────
// Passed as `output_format.schema` when AI_STRUCTURED_OUTPUTS=1 — the API then
// guarantees the response parses as JSON matching this schema. Mirrors the Zod
// schema above (`additionalProperties: true` ≙ `.passthrough()`); the widget
// type enum derives from REQUIRED_WIDGET_COLUMNS so all three spec surfaces
// (contract union, Zod enum, this schema) stay aligned via the contract test.
export const DASHBOARD_SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['title', 'description', 'filters', 'widgets'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    filters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'type', 'label', 'table', 'column'],
        properties: {
          id: { type: 'string', minLength: 1 },
          type: { enum: ['date_range', 'select'] },
          label: { type: 'string' },
          table: { type: 'string' },
          column: { type: 'string' },
          allLabel: { type: 'string' },
          defaultPreset: {
            enum: [
              'last_7_days', 'last_30_days', 'last_90_days', 'last_3_months',
              'last_6_months', 'last_12_months', 'this_year', 'all_time',
            ],
          },
          defaultValue: { type: 'string' },
        },
      },
    },
    widgets: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'type', 'title', 'sql'],
        properties: {
          id: { type: 'string', minLength: 1 },
          type: { enum: Object.keys(REQUIRED_WIDGET_COLUMNS) },
          title: { type: 'string' },
          sql: { type: 'string', minLength: 1 },
          drillDownSql: { type: 'string' },
          drillDownLabel: { type: 'string' },
          format: { enum: ['currency', 'number', 'percentage'] },
          colSpan: { enum: [1, 2, 3, 4] },
          featured: { type: 'boolean' },
          crossFilterKey: { type: 'string' },
          // User-arranged placement — the refine prompt instructs the model to
          // echo it verbatim; declaring it here keeps constrained decoding from
          // ever mangling its shape. Deterministic preservation is layered on
          // top in services/dashboardSpecMerge.ts.
          layout: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'w', 'h'],
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              w: { type: 'integer' },
              h: { type: 'integer' },
            },
          },
        },
      },
    },
  },
};
