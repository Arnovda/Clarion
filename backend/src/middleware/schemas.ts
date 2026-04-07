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

export const updateTableSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/) }),
  body: z.object({
    display_name: optionalString,
    description: optionalString,
    owner_name: optionalString,
    is_active: z.boolean().optional(),
    grain: optionalString,
    business_key_column: optionalString,
  }),
});

export const updateColumnSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/) }),
  body: z.object({
    display_name: optionalString,
    description: optionalString,
    owner_name: optionalString,
    is_dimension: z.boolean().optional(),
    is_measure: z.boolean().optional(),
  }),
});

export const createKpiSchema = z.object({
  body: z.object({
    connection_id: positiveInt,
    name: nonEmptyString,
    description: optionalString,
    formula_plain_text: optionalString,
    formula_sql: optionalString,
    owner_name: optionalString,
  }),
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

export const askQuestionSchema = z.object({
  body: z.object({
    question: nonEmptyString,
    connectionId: positiveInt,
    conversationId: optionalString,
    selectedEntity: z.object({
      value: z.string(),
      column: z.string(),
      table: z.string(),
    }).optional(),
  }),
});

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export const createDashboardSchema = z.object({
  body: z.object({
    title: nonEmptyString,
    description: optionalString,
    connection_id: positiveInt,
    spec: z.record(z.string(), z.unknown()),
    source_question: optionalString,
    folder_id: z.number().int().nullable().optional(),
  }),
});

export const updateDashboardSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/) }),
  body: z.object({
    title: optionalString,
    description: optionalString,
    spec: z.record(z.string(), z.unknown()).optional(),
    folder_id: z.number().int().nullable().optional(),
  }),
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
    period: optionalString,
    title: optionalString,
  }),
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

export const createConversationSchema = z.object({
  body: z.object({
    title: nonEmptyString,
    connection_id: positiveInt,
  }),
});

export const updateConversationSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/) }),
  body: z.object({
    title: optionalString,
    is_pinned: z.boolean().optional(),
  }),
});
