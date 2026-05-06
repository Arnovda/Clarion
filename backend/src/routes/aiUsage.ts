/**
 * AI usage routes — admin-only cost dashboard backend.
 *
 *   GET /api/admin/ai-usage/summary?days=30
 *     Headline numbers: today, this month, prior month, top user.
 *
 *   GET /api/admin/ai-usage/daily?days=30
 *     One row per day: date, total cost, total calls, by-category breakdown.
 *
 *   GET /api/admin/ai-usage/by-category?days=30
 *     Per-category totals: cost, call count, avg cost per call.
 *
 *   GET /api/admin/ai-usage/by-user?days=30
 *     Per-user totals (joined to users.display_name).
 *
 *   GET /api/admin/ai-usage/by-call-label?days=30
 *     Per-label totals — finest grain. Useful for pinpointing the
 *     specific calls that drift highest.
 *
 *   GET /api/admin/ai-usage/recent?limit=100
 *     Most recent calls (useful for debugging a sudden spike).
 *
 * All endpoints are tenant-scoped (RLS) + admin-only. The dashboard
 * page lives at /admin/ai-usage on the frontend.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { tenantQuery } from '../services/tenantQuery';

const router = Router();

router.use(requireAuth, requireRole('admin'));

function parseDays(req: Request): number {
  const n = Number(req.query.days);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.min(Math.max(Math.floor(n), 1), 365);
}

// ───────────────────────────────────────────────────────────────────────────
// Summary — KPI strip at the top of the dashboard
// ───────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const data = await tenantQuery(tenantId, async (trx) => {
      // We compute everything from one base CTE so the numbers are
      // self-consistent (i.e. "today" + "earlier this month" = "this month").
      // Knex's .sum().count() chain doesn't always type clean, so use
      // raw selects that return a single row with both aggregates.
      type AggRow = { s: string | null; c: string };
      const todayRow = await trx('ai_call_log')
        .whereRaw(`created_at >= date_trunc('day', now())`)
        .select(trx.raw(`COALESCE(SUM(cost_usd), 0) as s`))
        .select(trx.raw(`COUNT(*) as c`))
        .first() as unknown as AggRow | undefined;

      const monthRow = await trx('ai_call_log')
        .whereRaw(`created_at >= date_trunc('month', now())`)
        .select(trx.raw(`COALESCE(SUM(cost_usd), 0) as s`))
        .select(trx.raw(`COUNT(*) as c`))
        .first() as unknown as AggRow | undefined;

      const priorMonthRow = await trx('ai_call_log')
        .whereRaw(`created_at >= date_trunc('month', now()) - interval '1 month'`)
        .whereRaw(`created_at <  date_trunc('month', now())`)
        .select(trx.raw(`COALESCE(SUM(cost_usd), 0) as s`))
        .first() as unknown as { s: string | null } | undefined;

      // Top user this month — left-joined to users for display name.
      const topUserRow = await trx('ai_call_log as l')
        .leftJoin('users as u', 'l.user_id', 'u.id')
        .whereRaw(`l.created_at >= date_trunc('month', now())`)
        .whereNotNull('l.user_id')
        .groupBy('l.user_id', 'u.display_name', 'u.email')
        .orderByRaw('SUM(l.cost_usd) DESC')
        .limit(1)
        .select(
          'l.user_id',
          'u.display_name',
          'u.email',
          trx.raw('SUM(l.cost_usd) as cost'),
          trx.raw('COUNT(*) as calls'),
        )
        .first();

      return {
        today_cost_usd:        Number(todayRow?.s ?? 0),
        today_calls:           Number(todayRow?.c ?? 0),
        month_cost_usd:        Number(monthRow?.s ?? 0),
        month_calls:           Number(monthRow?.c ?? 0),
        prior_month_cost_usd:  Number(priorMonthRow?.s ?? 0),
        top_user: topUserRow ? {
          user_id:      Number((topUserRow as { user_id: number }).user_id),
          display_name: (topUserRow as { display_name: string | null }).display_name ?? null,
          email:        (topUserRow as { email: string | null }).email ?? null,
          cost_usd:     Number((topUserRow as { cost: string }).cost),
          calls:        Number((topUserRow as { calls: string }).calls),
        } : null,
      };
    });
    res.json({ ok: true, data });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// Daily — one row per day for the LAST N DAYS, including days with no calls.
// Drives the trend chart. We LEFT JOIN against generate_series so the chart
// always shows N evenly-spaced day slots (most rendering as zero-height
// bars when there's no activity); without this the chart auto-zoomed to
// just the days that had data, making sparse usage windows look "empty".
// ───────────────────────────────────────────────────────────────────────────
router.get('/daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const days = parseDays(req);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx
        .select(trx.raw(`gs.day::date as day`))
        .select(trx.raw(`COALESCE(SUM(acl.cost_usd), 0) as cost_usd`))
        .select(trx.raw(`COUNT(acl.id) as calls`))
        .from(trx.raw(
          `generate_series(
             (now() - interval '${days - 1} days')::date,
             now()::date,
             '1 day'::interval
           ) as gs(day)`,
        ))
        .leftJoin(
          { acl: 'ai_call_log' },
          // Equality on the day plus a redundant created_at >= filter so
          // Postgres prunes by index on created_at instead of scanning the
          // full table — important when ai_call_log grows large.
          trx.raw(
            `date_trunc('day', acl.created_at)::date = gs.day::date `
            + `AND acl.created_at >= now() - interval '${days} days'`,
          ),
        )
        .groupByRaw('gs.day')
        .orderByRaw('gs.day asc'),
    );
    res.json({
      ok: true,
      data: (rows as unknown as Array<{ day: unknown; cost_usd: unknown; calls: unknown }>).map((r) => ({
        day:      String(r.day),
        cost_usd: Number(r.cost_usd),
        calls:    Number(r.calls),
      })),
    });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// By category — the "where the cost actually lives" view
// ───────────────────────────────────────────────────────────────────────────
router.get('/by-category', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const days = parseDays(req);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx('ai_call_log')
        .select('category')
        .select(trx.raw(`COALESCE(SUM(cost_usd), 0) as cost_usd`))
        .select(trx.raw(`COUNT(*) as calls`))
        .select(trx.raw(`COALESCE(AVG(cost_usd), 0) as avg_cost_usd`))
        .whereRaw(`created_at >= now() - interval '${days} days'`)
        .groupBy('category')
        .orderByRaw(`SUM(cost_usd) DESC`),
    );
    res.json({
      ok: true,
      data: (rows as unknown as Array<{ category: unknown; cost_usd: unknown; calls: unknown; avg_cost_usd: unknown }>).map((r) => ({
        category:    String(r.category),
        cost_usd:    Number(r.cost_usd),
        calls:       Number(r.calls),
        avg_cost_usd: Number(r.avg_cost_usd),
      })),
    });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// By user — who's burning the most
// ───────────────────────────────────────────────────────────────────────────
router.get('/by-user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const days = parseDays(req);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx('ai_call_log as l')
        .leftJoin('users as u', 'l.user_id', 'u.id')
        .select('l.user_id', 'u.display_name', 'u.email')
        .select(trx.raw(`COALESCE(SUM(l.cost_usd), 0) as cost_usd`))
        .select(trx.raw(`COUNT(*) as calls`))
        .whereRaw(`l.created_at >= now() - interval '${days} days'`)
        .groupBy('l.user_id', 'u.display_name', 'u.email')
        .orderByRaw(`SUM(l.cost_usd) DESC`)
        .limit(20),
    );
    res.json({
      ok: true,
      data: (rows as unknown as Array<{
        user_id: unknown; display_name: unknown; email: unknown;
        cost_usd: unknown; calls: unknown;
      }>).map((r) => ({
        user_id:      r.user_id != null ? Number(r.user_id) : null,
        display_name: r.display_name ? String(r.display_name) : null,
        email:        r.email ? String(r.email) : null,
        cost_usd:     Number(r.cost_usd),
        calls:        Number(r.calls),
      })),
    });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// By call label — finest grain. "Which exact call is most expensive?"
// ───────────────────────────────────────────────────────────────────────────
router.get('/by-call-label', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const days = parseDays(req);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx('ai_call_log')
        .select('call_label', 'category', 'model')
        .select(trx.raw(`COALESCE(SUM(cost_usd), 0) as cost_usd`))
        .select(trx.raw(`COUNT(*) as calls`))
        .select(trx.raw(`COALESCE(AVG(cost_usd), 0) as avg_cost_usd`))
        .select(trx.raw(`COALESCE(AVG(input_tokens), 0) as avg_input`))
        .select(trx.raw(`COALESCE(AVG(output_tokens), 0) as avg_output`))
        .select(trx.raw(`SUM(CASE WHEN cache_used THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) as cache_hit_rate`))
        .whereRaw(`created_at >= now() - interval '${days} days'`)
        .groupBy('call_label', 'category', 'model')
        .orderByRaw(`SUM(cost_usd) DESC`)
        .limit(50),
    );
    res.json({
      ok: true,
      data: (rows as unknown as Array<{
        call_label: unknown; category: unknown; model: unknown;
        cost_usd: unknown; calls: unknown; avg_cost_usd: unknown;
        avg_input: unknown; avg_output: unknown; cache_hit_rate: unknown;
      }>).map((r) => ({
        call_label:     String(r.call_label),
        category:       String(r.category),
        model:          String(r.model),
        cost_usd:       Number(r.cost_usd),
        calls:          Number(r.calls),
        avg_cost_usd:   Number(r.avg_cost_usd),
        avg_input:      Number(r.avg_input),
        avg_output:     Number(r.avg_output),
        cache_hit_rate: r.cache_hit_rate != null ? Number(r.cache_hit_rate) : null,
      })),
    });
  } catch (err) { next(err); }
});

// ───────────────────────────────────────────────────────────────────────────
// Recent — last N calls. Surfaced for debugging spikes.
// ───────────────────────────────────────────────────────────────────────────
router.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user!.tenantId;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 10), 500);
    const rows = await tenantQuery(tenantId, (trx) =>
      trx('ai_call_log as l')
        .leftJoin('users as u', 'l.user_id', 'u.id')
        .select(
          'l.id', 'l.created_at', 'l.user_id', 'u.display_name',
          'l.model', 'l.call_label', 'l.category',
          'l.input_tokens', 'l.output_tokens',
          'l.cache_read_tokens', 'l.cache_creation_tokens',
          'l.cost_usd', 'l.duration_ms',
          'l.cache_used', 'l.failed', 'l.error_code',
        )
        .orderBy('l.created_at', 'desc')
        .limit(limit),
    );
    // Cast every numeric column to Number — pg returns `decimal` as a
    // STRING by default (preserves precision) and `bigint` likewise,
    // which then crashes the frontend's number formatters when it tries
    // String.toFixed(). Doing the cast here keeps the API contract clean.
    res.json({
      ok: true,
      data: (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
        id:                    Number(r.id),
        created_at:            String(r.created_at),
        user_id:               r.user_id != null ? Number(r.user_id) : null,
        display_name:          r.display_name ? String(r.display_name) : null,
        model:                 String(r.model),
        call_label:            String(r.call_label),
        category:              String(r.category),
        input_tokens:          Number(r.input_tokens ?? 0),
        output_tokens:         Number(r.output_tokens ?? 0),
        cache_read_tokens:     Number(r.cache_read_tokens ?? 0),
        cache_creation_tokens: Number(r.cache_creation_tokens ?? 0),
        cost_usd:              Number(r.cost_usd ?? 0),
        duration_ms:           Number(r.duration_ms ?? 0),
        cache_used:            !!r.cache_used,
        failed:                !!r.failed,
        error_code:            r.error_code ? String(r.error_code) : null,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
