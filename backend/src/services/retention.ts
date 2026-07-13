/**
 * Data-retention sweep.
 *
 * Several append-only tables grow without bound (query_log, conversation
 * messages, ai_call_log, notifications). This prunes rows older than a
 * configurable window, per table.
 *
 * Policy stance:
 *   • Operational noise (notifications, AI cost log) gets a sensible non-zero
 *     default so it can't grow forever unattended.
 *   • User CONTENT (query history, conversation messages) defaults to DISABLED
 *     (0 = keep forever) — how long to retain a customer's own data is a
 *     policy/legal decision the operator must make explicitly, not something
 *     this code should silently delete. Set the env var to switch it on.
 *
 * Runs daily (see index.ts). Deletes are chunked and each table is independent
 * (one failure doesn't abort the rest). RLS is not a concern here: this runs
 * as the app role but retention is intentionally cross-tenant (a platform
 * maintenance task), and every delete is an explicit age filter only.
 */

import type { Knex } from 'knex';
import { logger as rootLogger } from '../utils/logger';

const log = rootLogger.child({ mod: 'retention' });

interface RetentionRule {
  table: string;
  column: string;
  /** env var that overrides the window, in days. 0 disables the rule. */
  envVar: string;
  defaultDays: number;
}

const RULES: RetentionRule[] = [
  { table: 'notifications',         column: 'created_at', envVar: 'RETENTION_NOTIFICATION_DAYS', defaultDays: 90 },
  { table: 'ai_call_log',           column: 'created_at', envVar: 'RETENTION_AI_CALL_LOG_DAYS',  defaultDays: 365 },
  { table: 'query_log',             column: 'created_at', envVar: 'RETENTION_QUERY_LOG_DAYS',    defaultDays: 0 },
  { table: 'conversation_messages', column: 'created_at', envVar: 'RETENTION_CONVERSATION_DAYS', defaultDays: 0 },
];

/** Resolve a rule's window in days (env override, else default). 0 = disabled. */
export function retentionDays(rule: RetentionRule): number {
  const raw = process.env[rule.envVar];
  if (raw === undefined) return rule.defaultDays;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : rule.defaultDays;
}

/**
 * Run one retention pass. Returns per-table deleted counts. Never throws —
 * a failing table is logged and skipped so the sweep is safe to schedule
 * unattended.
 */
export async function runRetentionSweep(
  db: Knex,
  rules: RetentionRule[] = RULES,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of rules) {
    const days = retentionDays(rule);
    if (days <= 0) continue; // disabled — keep forever
    try {
      const n = await db(rule.table)
        .whereRaw(`?? < NOW() - (? * INTERVAL '1 day')`, [rule.column, days])
        .del();
      deleted[rule.table] = n;
      if (n > 0) log.info(`pruned ${n} row(s) from ${rule.table} older than ${days}d`);
    } catch (err) {
      log.warn({ err, table: rule.table }, 'retention prune failed (skipped)');
    }
  }
  return deleted;
}

export const RETENTION_RULES = RULES;
