/**
 * ONE way to prepare user- or model-authored SQL for execution on a read
 * surface: guard first, then apply data policies, then hand back the SQL to
 * run. Every read path — Ask AI, dashboards, notebooks, saved questions,
 * reports, scheduled emails, investigations, morning briefs — must go
 * through one of the two functions here.
 *
 * Why this exists (2026-09-05 market-readiness assessment v2, P0-4):
 * `applyDataPolicies` ran on Ask AI and the Excel add-in only. A column an
 * admin masked for the Sales role was `***` in Ask AI and the real IBAN on
 * the dashboard the same answer was pinned to — and those rows went on to
 * the insights prompt. The DPA lists data policies as an Annex II measure;
 * a control that holds on one surface out of seven is not a control.
 *
 * Order matters and is fixed here: the GUARD runs on the raw SQL (the policy
 * wrapper is ours and would pass anyway), then POLICIES rewrite it. Callers
 * never see the intermediate, so nothing can execute the pre-policy text.
 *
 * Two flavours:
 *  - `prepareUserRead`: a request with a real user — that user's row filters
 *    and column masks (admins bypass, as everywhere).
 *  - `prepareUnattendedRead`: no user (a scheduled report, a brief
 *    snapshot). Content leaving the platform unattended gets the MOST
 *    restrictive view: every active policy in the tenant, whoever it
 *    targets. A report that shows a masked column to a recipient because
 *    the schedule's creator happened to be an admin is the failure this
 *    avoids; a report that masks more than one recipient needed is merely
 *    conservative.
 */
import type { Request } from 'express';
import { assertSafeReadQuery } from '../utils/sqlGuard';
import { applyDataPolicies, applyAllTenantPolicies, type PolicyApplicationResult } from './policyEngine';

export interface ReadActor {
  userId: number;
  role: string;
  tenantId: number;
}

/** The actor of an authenticated request. */
export function actorOf(req: Request): ReadActor {
  const u = req.user!;
  return { userId: u.sub, role: u.role, tenantId: u.tenantId };
}

export interface PreparedRead {
  /** The SQL to execute — guarded, then policy-rewritten. */
  sql: string;
  policy: PolicyApplicationResult;
}

/** Guard, then apply the acting user's policies. Throws UnsafeSqlError on a refused query. */
export async function prepareUserRead(sql: string, actor: ReadActor): Promise<PreparedRead> {
  const clean = assertSafeReadQuery(sql);
  const policy = await applyDataPolicies(clean, actor.userId, actor.role, actor.tenantId);
  return { sql: policy.sql, policy };
}

/** Guard, then apply EVERY active policy of the tenant (no user to scope by). */
export async function prepareUnattendedRead(sql: string, tenantId: number): Promise<PreparedRead> {
  const clean = assertSafeReadQuery(sql);
  const policy = await applyAllTenantPolicies(clean, tenantId);
  return { sql: policy.sql, policy };
}
