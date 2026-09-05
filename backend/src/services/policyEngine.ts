/**
 * Policy Engine — applies row-level data access policies to AI-generated SQL.
 *
 * Loads active policies for the current user (by user_id AND by role),
 * finds table names in the SQL, and injects filter expressions as WHERE clauses.
 *
 * For row_filter policies: wraps the original SQL as a subquery with filters applied.
 * For column_mask policies: replaces column references with masked values.
 */

import { tenantQuery } from './tenantQuery';

// Dangerous SQL keywords that must never appear in filter expressions
const FORBIDDEN_PATTERNS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|UNION)\b/i;
const FORBIDDEN_CHARS = /;/;

export interface DataPolicy {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  user_id: number | null;
  role: string | null;
  table_name: string;
  column_name: string | null;
  filter_expression: string;
  policy_type: 'row_filter' | 'column_mask';
  is_active: boolean;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyApplicationResult {
  sql: string;
  policiesApplied: number;
  policyNames: string[];
}

/**
 * Validate a filter expression for basic safety.
 * Returns null if valid, or an error message if invalid.
 */
export function validateFilterExpression(expr: string): string | null {
  if (!expr || !expr.trim()) {
    return 'Filter expression cannot be empty';
  }
  if (FORBIDDEN_CHARS.test(expr)) {
    return 'Filter expression cannot contain semicolons';
  }
  if (FORBIDDEN_PATTERNS.test(expr)) {
    return 'Filter expression contains forbidden SQL keywords (DROP, DELETE, INSERT, UPDATE, ALTER, CREATE, TRUNCATE, EXEC, GRANT, REVOKE, UNION)';
  }
  // Check for balanced parentheses
  let depth = 0;
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return 'Filter expression has unbalanced parentheses';
  }
  if (depth !== 0) return 'Filter expression has unbalanced parentheses';

  return null;
}

/**
 * Load all active policies that apply to a given user.
 * Matches on: exact user_id OR matching role.
 */
async function loadPoliciesForUser(
  userId: number,
  userRole: string,
  tenantId: number,
): Promise<DataPolicy[]> {
  // Under tenant context (P0-4, 2026-09-05): this read ran on the root pool
  // and, from a worker or a request whose fallback SET had not reached this
  // connection, saw ZERO policies under the production role — which is
  // fail-OPEN for a security control. The explicit tenant_id filter stays.
  return tenantQuery(tenantId, (trx) =>
    trx('data_policies')
      .where({ tenant_id: tenantId, is_active: true })
      .andWhere(function () {
        this.where({ user_id: userId }).orWhere({ role: userRole });
      })
      .orderBy('table_name'),
  );
}

/** Every active policy of the tenant, whoever it targets (unattended reads). */
async function loadAllPoliciesForTenant(tenantId: number): Promise<DataPolicy[]> {
  return tenantQuery(tenantId, (trx) =>
    trx('data_policies')
      .where({ tenant_id: tenantId, is_active: true })
      .orderBy('table_name'),
  );
}

/**
 * Extract table names from SQL by looking at FROM and JOIN clauses.
 * Returns a Set of lowercased table names found in the SQL.
 */
function extractTableNames(sql: string): Set<string> {
  const tables = new Set<string>();

  // Match: FROM table_name, FROM "table_name", FROM schema.table_name
  // Match: JOIN table_name, LEFT JOIN table_name, etc.
  const patterns = [
    /\bFROM\s+["']?(\w+)["']?/gi,
    /\bJOIN\s+["']?(\w+)["']?/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(sql)) !== null) {
      tables.add(match[1].toLowerCase());
    }
  }

  return tables;
}

/**
 * Apply data access policies to an AI-generated SQL query.
 *
 * Strategy:
 * - For row_filter policies: wraps the SQL in a CTE and adds WHERE conditions
 * - For column_mask policies: replaces column references with '***'
 *
 * Returns the modified SQL and metadata about which policies were applied.
 */
export async function applyDataPolicies(
  sql: string,
  userId: number,
  userRole: string,
  tenantId: number,
): Promise<PolicyApplicationResult> {
  // Admins bypass all data policies
  if (userRole === 'admin') {
    return { sql, policiesApplied: 0, policyNames: [] };
  }

  const policies = await loadPoliciesForUser(userId, userRole, tenantId);
  return applyPolicyRows(sql, policies);
}

/**
 * Apply EVERY active policy of the tenant, regardless of the user or role
 * it targets. For reads with no acting user — a scheduled report email, the
 * brief's KPI snapshot — content leaves the platform unattended, so it gets
 * the most restrictive view any policy in the tenant describes. Masking
 * more than one recipient needed is conservative; showing a masked column
 * because the schedule's creator happened to be an admin is the failure
 * this prevents.
 */
export async function applyAllTenantPolicies(
  sql: string,
  tenantId: number,
): Promise<PolicyApplicationResult> {
  const policies = await loadAllPoliciesForTenant(tenantId);
  return applyPolicyRows(sql, policies);
}

/** The pure rewrite, shared by the per-user and the whole-tenant entry points. */
export function applyPolicyRows(sql: string, policies: DataPolicy[]): PolicyApplicationResult {
  if (policies.length === 0) {
    return { sql, policiesApplied: 0, policyNames: [] };
  }

  const tablesInSql = extractTableNames(sql);
  let modifiedSql = sql;
  const appliedNames: string[] = [];

  // Collect row filters grouped by table
  const rowFilters = new Map<string, string[]>();
  const columnMasks: DataPolicy[] = [];

  for (const policy of policies) {
    const policyTableLower = policy.table_name.toLowerCase();
    if (!tablesInSql.has(policyTableLower)) continue;

    if (policy.policy_type === 'row_filter') {
      if (!rowFilters.has(policyTableLower)) rowFilters.set(policyTableLower, []);
      rowFilters.get(policyTableLower)!.push(policy.filter_expression);
      appliedNames.push(policy.name);
    } else if (policy.policy_type === 'column_mask' && policy.column_name) {
      columnMasks.push(policy);
      appliedNames.push(policy.name);
    }
  }

  // Apply column masks first (simple text replacement)
  for (const mask of columnMasks) {
    // Replace "table.column" and standalone "column" references
    // Use word-boundary matching to avoid partial replacements
    const colName = mask.column_name!;
    const tableName = mask.table_name;
    const token = `\u0000MASK_${colName}\u0000`;

    // Replace qualified references: table.column -> mask
    const qualifiedPattern = new RegExp(
      `\\b${escapeRegex(tableName)}\\.${escapeRegex(colName)}\\b`,
      'gi',
    );
    modifiedSql = modifiedSql.replace(qualifiedPattern, token);

    // Replace unqualified references in SELECT (only if the table is referenced)
    // Be conservative: only replace if it looks like a column reference
    const unqualifiedPattern = new RegExp(
      `(?<=SELECT\\s[\\s\\S]*?)\\b${escapeRegex(colName)}\\b(?=[\\s,])`,
      'gi',
    );
    modifiedSql = modifiedSql.replace(unqualifiedPattern, token);

    // THE COLUMN KEEPS ITS NAME in the select list (P0-4, 2026-09-05): a bare
    // `'***'` produced a result column literally named `'***'`, so a widget
    // bound to `iban` rendered nothing and a masked answer lost its header.
    // In the select list (before the first FROM) the mask is aliased back to
    // the column; everywhere else — WHERE, ORDER BY — a bare literal is what
    // an expression position accepts.
    const fromAt = modifiedSql.search(/\bfrom\b/i);
    const head = fromAt === -1 ? modifiedSql : modifiedSql.slice(0, fromAt);
    const tail = fromAt === -1 ? '' : modifiedSql.slice(fromAt);
    modifiedSql =
      head.split(token).join(`'***' AS ${colName} /* masked */`) +
      tail.split(token).join(`'***' /* ${colName} masked */`);
  }

  // Apply row filters by wrapping SQL in a CTE
  if (rowFilters.size > 0) {
    const allConditions: string[] = [];
    for (const [, filters] of rowFilters) {
      for (const filter of filters) {
        allConditions.push(`(${filter})`);
      }
    }

    // Wrap original query as a subquery and add WHERE conditions
    const trimmedSql = modifiedSql.replace(/;\s*$/, ''); // Remove trailing semicolon
    modifiedSql = `SELECT * FROM (${trimmedSql}) AS _policy_filtered WHERE ${allConditions.join(' AND ')}`;
  }

  return {
    sql: modifiedSql,
    policiesApplied: appliedNames.length,
    policyNames: appliedNames,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
