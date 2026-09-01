/**
 * schemas.ts — Zod validation schemas for all API endpoints.
 *
 * Grouped by route module. Each schema validates { body?, query?, params? }.
 * Used with the validate() middleware from validate.ts.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const positiveInt = z.coerce.number().int().positive();
const optionalPositiveInt = z.coerce.number().int().positive().optional();
const email = z.string().email('Valid email required').transform((v) => v.toLowerCase().trim());
const nonEmptyString = z.string().min(1, 'Required').transform((v) => v.trim());
const optionalString = z.string().optional();
const booleanish = z.union([z.boolean(), z.literal('true'), z.literal('false')]).transform((v) => v === true || v === 'true');

// Non-transforming "must contain non-whitespace" check. Unlike nonEmptyString
// it does NOT trim the value — handlers that store the raw string keep
// exactly what the client sent (behaviour-preserving for valid requests).
const nonBlankString = z.string().refine((v) => v.trim().length > 0, 'Required');
// Body ids arrive as JSON numbers; null is a meaningful "clear this" value on
// several PATCH surfaces, so we deliberately avoid z.coerce here (coerce turns
// null into 0 and destroys the null semantics).
const idNumber = z.number().int().positive();
const nullableId = z.number().int().nullable().optional();
const nullableOptionalString = z.string().nullable().optional();
const jsonObject = z.record(z.string(), z.unknown());
const dataLayerEnum = z.enum(['product', 'source']).optional();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  body: z.object({
    companyName: nonEmptyString,
    email,
    password: z.string().min(8, 'Password must be at least 8 characters'),
    displayName: nonEmptyString,
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z.object({
    email,
  }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    email,
    token: nonEmptyString,
    password: z.string().min(8, 'Password must be at least 8 characters'),
  }),
});

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const testConnectionSchema = z.object({
  body: z.object({
    type: z.enum(['sqlite', 'postgres', 'postgresql', 'mysql', 'mssql', 'duckdb']),
    config: z.record(z.string(), z.unknown()),
  }),
});

export const createConnectionSchema = z.object({
  body: z.object({
    name: nonEmptyString,
    type: z.enum(['sqlite', 'postgres', 'postgresql', 'mysql', 'mssql', 'duckdb']),
    config: z.record(z.string(), z.unknown()),
    domains: z.array(z.string()).optional(),
  }),
});

export const updateConnectionSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Connection ID must be a number'),
  }),
  body: z.object({
    name: optionalString,
    config: z.record(z.string(), z.unknown()).optional(),
    domains: z.array(z.string()).optional(),
  }).refine((data) => Object.keys(data).length > 0, 'At least one field to update is required'),
});

export const connectionIdParam = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Connection ID must be a number'),
  }),
});

// ---------------------------------------------------------------------------
// Semantic
// ---------------------------------------------------------------------------

export const semanticConnectionQuery = z.object({
  query: z.object({
    connectionId: z.string().regex(/^\d+$/, 'connectionId must be a number'),
  }),
});

// PATCH /semantic/tables/:id — the handler forwards the whole body to
// graph.updateTable + the version/audit trail, so the schema is passthrough:
// it type-checks the known fields without stripping anything. Frontend echoes
// DB values back, so nullable strings/booleans are part of the real contract.
export const updateTableSchema = z.object({
  body: z.object({
    display_name: nullableOptionalString,
    description: nullableOptionalString,
    owner_name: nullableOptionalString,
    is_active: z.boolean().nullable().optional(),
    grain: nullableOptionalString,
    business_key_column: nullableOptionalString,
    approval_status: nullableOptionalString,
    ai_draft: z.boolean().optional(),
    domains: z.union([z.array(z.string()), z.string()]).nullable().optional(),
    change_reason: nullableOptionalString,
  }).passthrough(),
});

// PATCH /semantic/columns/:id — same passthrough rationale as tables.
export const updateColumnSchema = z.object({
  body: z.object({
    display_name: nullableOptionalString,
    description: nullableOptionalString,
    owner_name: nullableOptionalString,
    is_dimension: z.boolean().nullable().optional(),
    is_measure: z.boolean().nullable().optional(),
    approval_status: nullableOptionalString,
    ai_draft: z.boolean().optional(),
  }).passthrough(),
});

// POST /semantic/relationships
export const createRelationshipSchema = z.object({
  body: z.object({
    from_table_id: idNumber,
    to_table_id: idNumber,
    from_column_id: nullableId,
    to_column_id: nullableId,
    relationship_type: optionalString,
    description: nullableOptionalString,
    // 'match' marks a cross-source identity assertion rather than a join.
    kind: z.enum(['join', 'match']).optional(),
    match_keys: z.unknown().optional(),
    measured: z.unknown().optional(),
  }).passthrough(),
});

// PATCH /semantic/relationships/:id — an empty body is a valid "confirm"
// (server flips ai_draft=false); null column ids mean "clear the column".
export const updateRelationshipSchema = z.object({
  body: z.object({
    relationship_type: optionalString,
    description: nullableOptionalString,
    from_column_id: nullableId,
    to_column_id: nullableId,
    ai_draft: z.boolean().optional(),
    // The relationship canvas sends back what it measured, so an edge can show
    // its containment and shape without re-running the check on every load.
    measured: z.unknown().optional(),
  }).passthrough(),
});

// POST /semantic/kpis (source-layer KPI create)
export const createKpiSchema = z.object({
  body: z.object({
    connection_id: positiveInt,
    name: nonBlankString,
    description: nullableOptionalString,
    formula_plain_text: nullableOptionalString,
    formula_sql: nullableOptionalString,
    owner_name: nullableOptionalString,
  }).passthrough(),
});

// POST /semantic/glossary — examples/tags accept an array OR a JSON string
// (the handler's parseJsonArray handles both). Whitespace-only term/meaning is
// still rejected by the handler's own trim check (kept — stricter than this).
export const createGlossarySchema = z.object({
  body: z.object({
    term: z.string(),
    meaning: z.string(),
    examples: z.union([z.array(z.unknown()), z.string()]).nullable().optional(),
    tags: z.union([z.array(z.unknown()), z.string()]).nullable().optional(),
  }).passthrough(),
});

// PATCH /semantic/glossary/:id
export const updateGlossarySchema = z.object({
  body: z.object({
    term: optionalString,
    meaning: optionalString,
    examples: z.union([z.array(z.unknown()), z.string()]).nullable().optional(),
    tags: z.union([z.array(z.unknown()), z.string()]).nullable().optional(),
    ai_draft: z.boolean().optional(),
  }).passthrough(),
});

export const previewTableSchema = z.object({
  query: z.object({
    connectionId: z.string().regex(/^\d+$/),
    table: nonEmptyString,
    limit: z.string().regex(/^\d+$/).optional(),
  }),
});

// ---------------------------------------------------------------------------
// Query (NL→SQL chat)
// ---------------------------------------------------------------------------

// POST /query — matches what the handler actually reads (connectionId,
// question, domains, conversationId, dataLayer, dashboardContext).
// Passthrough so auxiliary fields some callers send (e.g. selectedEntity from
// the disambiguation flow) survive untouched.
export const askQuestionSchema = z.object({
  body: z.object({
    question: nonBlankString,
    connectionId: positiveInt,
    domains: z.array(z.string()).optional(),
    conversationId: nullableId,
    dataLayer: dataLayerEnum,
    dashboardContext: optionalString,
  }).passthrough(),
});

// POST /query/think — the streaming chat path. Same contract as POST /query
// plus the optional product focus. Validation runs BEFORE the SSE stream
// opens, so a malformed body gets a normal 400 JSON response.
export const thinkQuerySchema = z.object({
  body: z.object({
    question: nonBlankString,
    connectionId: positiveInt,
    domains: z.array(z.string()).optional(),
    conversationId: nullableId,
    dataLayer: dataLayerEnum,
    productId: optionalPositiveInt,
    // Worksheet: the step being asked FROM (ancestor-path history).
    parentMessageId: optionalPositiveInt,
    // Worksheet: bounded re-answer instruction (assumption flip / re-run).
    directive: z.string().max(600).optional(),
  }).passthrough(),
});

// POST /query/repair — the agentic repair loop. The client echoes back the
// original SQL/rows/warning plus (on clarification resume) the accumulated
// model conversation. Bounded here so a hostile client can't feed the model
// arbitrary megabytes: history capped at 40 turns, rows at 200.
export const repairQuerySchema = z.object({
  body: z.object({
    connectionId: positiveInt,
    question: nonBlankString,
    originalSql: nonBlankString,
    originalRows: z.array(z.record(z.string(), z.unknown())).max(200),
    warning: z.string(),
    conversationHistory: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(200_000),
    })).max(40).optional(),
    clarificationAnswer: optionalString,
    dataLayer: dataLayerEnum,
    conversationId: optionalPositiveInt,
    messageServerId: optionalPositiveInt,
  }).passthrough(),
});

// POST /query/cross-view
export const crossViewQuerySchema = z.object({
  body: z.object({
    viewId: positiveInt,
    question: nonBlankString,
    conversationId: nullableId,
  }).passthrough(),
});

// POST /query/forecast
export const forecastQuerySchema = z.object({
  body: z.object({
    connectionId: positiveInt,
    question: nonBlankString,
    domains: z.array(z.string()).optional(),
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

// POST /dashboards — real contract is { connectionId, title, description,
// spec, folder }. connectionId may be null (dashboards without a connection
// are allowed — the test suite exercises this).
export const createDashboardSchema = z.object({
  body: z.object({
    connectionId: z.number().int().nullable(),
    title: nonBlankString,
    description: nullableOptionalString,
    spec: jsonObject,
    folder: nullableOptionalString,
  }).passthrough(),
});

// PATCH /dashboards/:id — every field optional; an empty body is a valid
// no-op today (handler returns the row unchanged).
export const updateDashboardSchema = z.object({
  body: z.object({
    title: optionalString,
    description: nullableOptionalString,
    folder: nullableOptionalString,
    is_shared: z.boolean().optional(),
    shared_permission: optionalString,
    auto_refresh_seconds: z.number().int().nullable().optional(),
    spec: jsonObject.optional(),
  }).passthrough(),
});

// POST /dashboards/batch-execute + /batch-execute-stream
export const batchExecuteSchema = z.object({
  body: z.object({
    connectionId: idNumber,
    widgets: z.array(
      z.object({
        id: z.string(),
        sql: z.string(),
        filterValues: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()]),
        ).nullable().optional(),
      }).passthrough(),
    ).min(1, 'widgets array required'),
    dataLayer: dataLayerEnum,
    crossFilter: z.object({
      sourceWidgetId: z.string(),
      dimension: z.string(),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }).passthrough().optional(),
  }).passthrough(),
});

// POST /dashboards/generate — the AI generation call. `answers` accepts both
// the current {question, answer} pairs and the legacy bare-string form so an
// older client (or a cached bundle) keeps working.
export const generateDashboardSchema = z.object({
  body: z.object({
    connectionId: nullableId,
    request: nonBlankString,
    answers: z.array(
      z.union([
        z.string(),
        z.object({ question: z.string(), answer: z.string() }).passthrough(),
      ]),
    ).optional(),
    productIds: z.array(z.number().int()).optional(),
    dataLayer: dataLayerEnum,
  }).passthrough(),
});

// POST /dashboards/refine-spec — edits an existing spec. The handler still
// owns the semantic checks; this guards the shape (was the one dashboard AI
// route with no request validation).
export const refineSpecSchema = z.object({
  body: z.object({
    connectionId: nullableId,
    refinement: nonBlankString,
    currentSpec: z.object({
      widgets: z.array(z.object({ id: z.string() }).passthrough()).min(1),
      filters: z.array(z.object({}).passthrough()),
    }).passthrough(),
    productIds: z.array(z.number().int()).optional(),
    dataLayer: dataLayerEnum,
    // Set when the user is editing ONE card ("change this card") rather than
    // the dashboard. The route checks the id against the submitted spec and
    // filters every planned op down to that widget.
    scopeWidgetId: z.string().min(1).max(200).optional(),
  }).passthrough(),
});

// POST /dashboards/refine — clarifying-questions step before generation.
// Passthrough: the frontend also sends `domains` which the handler ignores.
export const refineDashboardSchema = z.object({
  body: z.object({
    connectionId: nullableId,
    request: nonBlankString,
    productIds: z.array(z.number().int()).optional(),
    dataLayer: dataLayerEnum,
  }).passthrough(),
});

// POST /dashboards/fix-widget — render-time self-heal for one widget. The
// handler still owns the "widgetId exists in spec" check (404, not 400).
export const fixWidgetSchema = z.object({
  body: z.object({
    connectionId: nullableId,
    spec: z.object({
      widgets: z.array(z.object({ id: z.string() }).passthrough()).min(1),
    }).passthrough(),
    widgetId: nonBlankString,
    productIds: z.array(z.number().int()).optional(),
    dataLayer: dataLayerEnum,
  }).passthrough(),
});

export const dashboardIdParam = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/),
  }),
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const generateReportSchema = z.object({
  body: z.object({
    connectionId: positiveInt,
    kpiIds: z.array(positiveInt).min(1, 'At least one KPI required'),
    period: nullableOptionalString,
    title: nullableOptionalString,
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const inviteUserSchema = z.object({
  body: z.object({
    email,
    displayName: nonEmptyString,
    role: z.enum(['admin', 'analyst', 'viewer']),
  }),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const markNotificationReadSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/),
  }),
});

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export const profileTableSchema = z.object({
  params: z.object({
    connId: z.string().regex(/^\d+$/),
    table: nonEmptyString,
  }),
});

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

// POST /conversations — real contract is { title?, sourceKey? }; both are
// optional (the handler defaults title to "New conversation").
export const createConversationSchema = z.object({
  body: z.object({
    title: nullableOptionalString,
    sourceKey: nullableOptionalString,
  }).passthrough().optional(),
});

// PATCH /conversations/:id — title is required and must be non-blank.
export const updateConversationSchema = z.object({
  body: z.object({
    title: nonBlankString,
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Saved questions (Ask AI Release 3)
// ---------------------------------------------------------------------------

export const createSavedQuestionSchema = z.object({
  body: z.object({
    question: nonBlankString,
    sql: nonBlankString,
    tablesUsed: z.array(z.string()).optional(),
    visualization: jsonObject.optional(),
    connectionId: positiveInt,
    dataLayer: dataLayerEnum,
    // Honoured only for admin/analyst callers; forced false otherwise.
    verified: z.boolean().optional(),
  }).passthrough(),
});

export const verifySavedQuestionSchema = z.object({
  params: z.object({ id: positiveInt }),
  body: z.object({ verified: z.boolean() }).passthrough(),
});

export const deleteSavedQuestionSchema = z.object({
  params: z.object({ id: positiveInt }),
});

// POST /dashboards/pin-widget — append a chat answer to a dashboard (or start
// a new one from it). The widget SQL is client-derived from the answer's SQL
// + visualization hint; it is still guarded (assertSafeReadQuery) and runs
// under the same sqlGuard + policy machinery as every dashboard widget.
export const pinWidgetSchema = z.object({
  body: z.object({
    dashboardId: optionalPositiveInt,
    connectionId: positiveInt,
    title: optionalString,
    widget: z.object({
      type: z.enum(['kpi_card', 'bar_chart', 'line_chart', 'stacked_bar_chart', 'pie_chart', 'data_table']),
      title: nonBlankString,
      sql: nonBlankString,
    }).passthrough(),
  }).passthrough(),
});

// PATCH /conversations/:id/messages/:messageId — in-place update of a stored
// message (the repair loop's corrected-answer persistence). Every field is
// optional; the handler 400s when nothing updatable was sent.
export const updateConversationMessageSchema = z.object({
  params: z.object({
    id: positiveInt,
    messageId: positiveInt,
  }),
  body: z.object({
    content: optionalString,
    sql: optionalString,
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    confidence: z.number().min(0).max(1).optional(),
    warning: nullableOptionalString,
    wasRepaired: z.boolean().optional(),
    meta: jsonObject.optional(),
    // Worksheet spine edits (migration 84): rename a step / star it.
    label: z.string().max(120).nullable().optional(),
    starred: z.boolean().optional(),
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

// POST /products
export const createProductSchema = z.object({
  body: z.object({
    name: nonBlankString,
    description: nullableOptionalString,
    connectionId: nullableId,
    sourceTables: z.array(
      z.object({
        sourceTableId: z.number().int(),
        tableName: z.string(),
      }).passthrough(),
    ).nullable().optional(),
  }).passthrough(),
});

// PUT /products/:id
export const updateProductSchema = z.object({
  body: z.object({
    name: optionalString,
    description: nullableOptionalString,
    status: optionalString,
    // Build-page visibility toggle: hidden topics stay fully built but drop
    // out of the rail. Only `true` means hidden (null/false = visible).
    hidden: z.boolean().optional(),
  }).passthrough(),
});

// PATCH /products/tables/:tableId — description / display_name only
export const updateProductTableSchema = z.object({
  body: z.object({
    description: nullableOptionalString,
    display_name: nullableOptionalString,
    // Plain-language paragraph shown first on Manage mode's "How it's built"
    // card, above the provenance trail and the (collapsed) SQL.
    plain_summary: nullableOptionalString,
  }).passthrough(),
});

// PUT /products/tables/:tableId/sql — transformation SQL edit
export const updateProductTableSqlSchema = z.object({
  body: z.object({
    sql: z.string(),
  }).passthrough(),
});

// PUT /products/columns/:columnId — the handler applies a fixed allow-list;
// this validates the types of those allowed fields.
export const updateProductColumnSchema = z.object({
  body: z.object({
    column_name: nullableOptionalString,
    data_type: nullableOptionalString,
    display_name: nullableOptionalString,
    description: nullableOptionalString,
    column_role: nullableOptionalString,
    fk_target_table: nullableOptionalString,
    fk_target_column: nullableOptionalString,
    transformation_expression: nullableOptionalString,
    additivity: nullableOptionalString,
    scd_type: nullableOptionalString,
    sort_order: z.number().int().nullable().optional(),
  }).passthrough(),
});

// POST /products/:id/kpis (product-layer KPI create — camelCase contract)
export const createProductKpiSchema = z.object({
  body: z.object({
    name: nonBlankString,
    description: nullableOptionalString,
    formulaPlainText: nullableOptionalString,
    formulaSql: nullableOptionalString,
    ownerName: nullableOptionalString,
    // First-person phrasing shown on the topic page's "Try asking" rows.
    questionText: nullableOptionalString,
  }).passthrough(),
});

// PUT /products/kpis/:kpiId (snake_case allow-list contract)
export const updateProductKpiSchema = z.object({
  body: z.object({
    name: optionalString,
    description: nullableOptionalString,
    formula_plain_text: nullableOptionalString,
    formula_sql: nullableOptionalString,
    owner_name: nullableOptionalString,
    question_text: nullableOptionalString,
    ai_draft: z.boolean().optional(),
  }).passthrough(),
});

// POST /products/:id/refresh-start — body may be absent entirely
export const productRefreshStartSchema = z.object({
  body: z.object({
    syncSource: z.boolean().optional(),
  }).passthrough().optional(),
});

// POST /products/build-chat — the Build page's "Ask about your subjects" chat
export const buildChatSchema = z.object({
  body: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(4000),
    })).min(1).max(16),
  }),
});

// POST /products/bus-matrix/extend-start — add ONE subject next to the build
export const busMatrixExtendStartSchema = z.object({
  body: z.object({
    connectionId: z.number().int().positive(),
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    focus: z.string().max(300).optional(),
    entities: z.array(z.string().min(1).max(200)).min(1).max(12),
  }),
});

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

// POST /pipelines/saved
export const createPipelineSchema = z.object({
  body: z.object({
    name: nonBlankString,
    description: nullableOptionalString,
    scope: jsonObject,
    triggers: z.array(z.unknown()).nullable().optional(),
    enabled: z.boolean().optional(),
  }).passthrough(),
});

// PUT /pipelines/saved/:id
export const updatePipelineSchema = z.object({
  body: z.object({
    name: optionalString,
    description: nullableOptionalString,
    scope: jsonObject.optional(),
    triggers: z.array(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  }).passthrough(),
});

// POST /pipelines/run-pipeline — pipelineId XOR adhocScope; the either-or
// check stays inline in the handler (it is part of the resolution logic).
export const runPipelineSchema = z.object({
  body: z.object({
    pipelineId: optionalString,
    adhocScope: jsonObject.optional(),
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Notebooks
// ---------------------------------------------------------------------------

// POST /notebooks — everything optional (handler supplies defaults)
export const createNotebookSchema = z.object({
  body: z.object({
    title: nullableOptionalString,
    description: nullableOptionalString,
    connectionId: nullableId,
  }).passthrough().optional(),
});

// PATCH /notebooks/:id — title/description must be strings when present
// (the handler calls .trim() on them); connectionId null clears the pin.
export const updateNotebookSchema = z.object({
  body: z.object({
    title: optionalString,
    description: optionalString,
    connectionId: z.number().int().nullable().optional(),
  }).passthrough(),
});

// POST /notebooks/:id/cells
export const createNotebookCellSchema = z.object({
  body: z.object({
    cellType: optionalString,
    source: optionalString,
    position: z.number().int().optional(),
  }).passthrough().optional(),
});

// PATCH /notebooks/cells/:cellId
export const updateNotebookCellSchema = z.object({
  body: z.object({
    source: optionalString,
    cellType: optionalString,
    position: z.number().int().optional(),
  }).passthrough(),
});

// POST /notebooks/generate — natural language → SQL/Python for a cell.
export const generateNotebookCodeSchema = z.object({
  body: z.object({
    connectionId: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(4000),
    cellType: z.enum(['sql', 'python']),
    scope: z.enum(['sources', 'products']).optional(),
    existingCode: z.string().max(50_000).optional(),
    /**
     * Prior turns of the same notebook conversation, so "now group it by
     * month" means something. Capped: the schema context already dominates
     * the prompt, and an unbounded history is an unbounded bill.
     */
    history: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(20_000),
    })).max(12).optional(),
  }).passthrough(),
});

// DELETE /users/:id — GDPR erasure. No body required; schema present so the
// validate-coverage ratchet is satisfied and extra fields are tolerated.
export const eraseUserSchema = z.object({
  body: z.object({}).passthrough().optional(),
});

// POST /settings/delete-tenant — irreversible full account closure. Requires
// the caller to re-confirm their password AND type the exact org name.
export const deleteTenantSchema = z.object({
  body: z.object({
    confirmName: z.string().min(1, 'Type your organisation name to confirm'),
    password: z.string().min(1, 'Password is required to confirm deletion'),
  }),
});

// POST /relationships/measure — does a proposed relationship hold in the data?
// All four ids are required: a measurement names a column on each side, and a
// table alone cannot be measured against another table.
// POST /relationships/match-preview — how well two SOURCES line up. Same four
// ids as a measurement, plus how hard to normalise before comparing.
export const matchPreviewSchema = z.object({
  body: z.object({
    fromTableId: positiveInt,
    fromColumnId: positiveInt,
    toTableId: positiveInt,
    toColumnId: positiveInt,
    normalisation: z.enum(['exact', 'loose']).optional(),
  }),
});

/**
 * Raise or clear a flag on a relationship. The reason is optional and short —
 * it is a note to whoever comes back to it, not documentation.
 */
export const flagRelationshipSchema = z.object({
  body: z.object({
    flagged: z.boolean(),
    reason: z.string().max(500).optional().nullable(),
  }),
});

/**
 * Re-check an existing relationship. Everything needed is on the row, so the
 * body carries only how thorough to be — `withExamples: false` for a
 * table-wide sweep, where sampling values would cost a third query per link.
 */
export const checkRelationshipSchema = z.object({
  body: z.object({
    withExamples: z.boolean().optional(),
  }),
});

export const measureRelationshipSchema = z.object({
  body: z.object({
    fromTableId: positiveInt,
    fromColumnId: positiveInt,
    toTableId: positiveInt,
    toColumnId: positiveInt,
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Managed grids — the in-Clarion editable tables (budgets, mappings, lists)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A column as the client submits it. `key` is optional — the server derives
 * one from the name when absent, and validates it strictly when present
 * (it becomes a warehouse identifier). Deeper semantic validation (key
 * uniqueness, count caps) lives in `services/managedGrids.normalizeColumns`.
 */
const gridColumnInput = z.object({
  key: z.string().max(60).optional().nullable(),
  name: z.string().min(1).max(80),
  type: z.enum(['text', 'number', 'date', 'boolean']),
  // "This column contains values of <product table>.<column>" — validated
  // against strict identifier rules in the service, resolved at use time.
  link: z.object({ table: z.string().max(128), column: z.string().max(128) })
    .nullable().optional(),
});

/**
 * ?table=&column= for the linked-column value list; optional &column2= (same
 * table) returns distinct PAIRS — the seed of a two-field mapping.
 */
export const gridLinkValuesSchema = z.object({
  query: z.object({
    table: z.string().min(1).max(128),
    column: z.string().min(1).max(128),
    column2: z.string().min(1).max(128).optional(),
  }).passthrough(),
});

export const createManagedGridSchema = z.object({
  body: z.object({
    name: nonBlankString,
    kind: z.enum(['budget', 'mapping', 'list']).optional(),
    description: z.string().max(500).nullable().optional(),
    columns: z.array(gridColumnInput).min(1).max(40),
  }).passthrough(),
});

/** Numeric :id — a non-numeric id must 400, not turn into `WHERE id = NaN`. */
const gridIdParams = z.object({ id: z.string().regex(/^\d+$/, 'Invalid id') }).passthrough();

export const gridIdParamsSchema = z.object({ params: gridIdParams });

export const updateManagedGridSchema = z.object({
  params: gridIdParams,
  body: z.object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    columns: z.array(gridColumnInput).min(1).max(40).optional(),
  }).passthrough(),
});

/**
 * Full row replacement — the save model is "the grid as the editor shows it".
 * Row order in the array is the stored order. Cell values are validated per
 * column type in the service (a Zod schema can't see the grid's columns).
 */
export const saveManagedGridRowsSchema = z.object({
  params: gridIdParams,
  body: z.object({
    rows: z.array(z.object({ data: jsonObject }).passthrough()).max(10_000),
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Feature flags (operator console)
// ---------------------------------------------------------------------------

/**
 * A flag key is an identifier, never free text — it is matched against the
 * code registry, so anything outside this shape is a client bug, not a flag.
 */
const featureKeyParams = z
  .object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'Invalid flag key') })
  .passthrough();

export const featureKeyParamsSchema = z.object({ params: featureKeyParams });

export const setFeatureRolloutSchema = z.object({
  params: featureKeyParams,
  body: z.object({
    rollout: z.enum(['off', 'tenants', 'all']),
    // The audience is capped: a rollout that names hundreds of tenants
    // individually is a rollout that should have been 'all'.
    tenantIds: z.array(z.number().int().positive()).max(200).optional(),
  }).passthrough(),
});

// ---------------------------------------------------------------------------
// Personal API tokens (Excel add-in and other non-browser clients)
// ---------------------------------------------------------------------------

const tokenIdParams = z
  .object({ id: z.coerce.number().int().positive() })
  .passthrough();

export const createApiTokenSchema = z.object({
  body: z.object({
    // Shown back to the user in the token list; this is the only thing that
    // makes a year-old credential identifiable, so it is required.
    name: z.string().trim().min(1).max(80),
    // Bounded rather than optional-forever: a token with no expiry is a
    // credential nobody ever revisits. One year is the ceiling.
    ttlDays: z.number().int().min(1).max(365).optional(),
  }).passthrough(),
});

export const revokeApiTokenSchema = z.object({ params: tokenIdParams });

export const runSavedQuestionSchema = z.object({
  params: tokenIdParams,
  body: z.object({
    // The add-in pages results into a worksheet; the cap is what one sheet
    // can sensibly hold and what one response should carry.
    limit: z.number().int().min(1).max(10_000).optional(),
  }).passthrough().optional(),
});
