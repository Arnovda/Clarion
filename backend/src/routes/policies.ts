/**
 * Data Policy Management API routes
 *
 * GET    /api/policies       — list all policies (admin only)
 * GET    /api/policies/mine  — get policies applying to current user (any role)
 * POST   /api/policies       — create a policy (admin only)
 * PUT    /api/policies/:id   — update a policy (admin only)
 * DELETE /api/policies/:id   — delete a policy (admin only)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { semanticDb } from '../db/knex';
import { requireAuth, requireRole } from '../middleware/auth';
import { validateFilterExpression } from '../services/policyEngine';
import { reqDb } from '../db/reqDb';
import { recordAudit } from '../services/auditService';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---------------------------------------------------------------------------
// GET /api/policies — list all policies in current tenant (admin only)
// ---------------------------------------------------------------------------
router.get('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = await semanticDb('data_policies')
      .where({ tenant_id: req.user!.tenantId })
      .leftJoin('users as u', 'data_policies.user_id', 'u.id')
      .leftJoin('users as cb', 'data_policies.created_by', 'cb.id')
      .select(
        'data_policies.*',
        'u.display_name as user_display_name',
        'u.email as user_email',
        'cb.display_name as created_by_name',
      )
      .orderBy('data_policies.created_at', 'desc');

    res.json({ ok: true, data: policies });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/policies/mine — get policies that apply to current user
// ---------------------------------------------------------------------------
router.get('/mine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const policies = await semanticDb('data_policies')
      .where({ tenant_id: req.user!.tenantId, is_active: true })
      .andWhere(function () {
        this.where({ user_id: req.user!.sub }).orWhere({ role: req.user!.role });
      })
      .select('id', 'name', 'description', 'table_name', 'column_name', 'filter_expression', 'policy_type')
      .orderBy('table_name');

    res.json({ ok: true, data: policies });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/policies — create a new data policy (admin only)
// ---------------------------------------------------------------------------
router.post('/', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const {
      name, description, user_id, role, table_name,
      column_name, filter_expression, policy_type,
    } = req.body as {
      name: string;
      description?: string;
      user_id?: number;
      role?: string;
      table_name: string;
      column_name?: string;
      filter_expression: string;
      policy_type?: string;
    };

    // Validation
    if (!name?.trim()) {
      res.status(400).json({ ok: false, error: 'Policy name is required' });
      return;
    }
    if (!table_name?.trim()) {
      res.status(400).json({ ok: false, error: 'Table name is required' });
      return;
    }
    if (!filter_expression?.trim()) {
      res.status(400).json({ ok: false, error: 'Filter expression is required' });
      return;
    }
    if (!user_id && !role) {
      res.status(400).json({ ok: false, error: 'Either user_id or role must be specified' });
      return;
    }
    if (user_id && role) {
      res.status(400).json({ ok: false, error: 'Specify either user_id or role, not both' });
      return;
    }
    if (role && !['analyst', 'viewer'].includes(role)) {
      res.status(400).json({ ok: false, error: 'Role must be analyst or viewer' });
      return;
    }
    if (policy_type && !['row_filter', 'column_mask'].includes(policy_type)) {
      res.status(400).json({ ok: false, error: 'Policy type must be row_filter or column_mask' });
      return;
    }
    if (policy_type === 'column_mask' && !column_name?.trim()) {
      res.status(400).json({ ok: false, error: 'Column name is required for column_mask policies' });
      return;
    }

    // Sanitize filter expression
    const filterError = validateFilterExpression(filter_expression);
    if (filterError) {
      res.status(400).json({ ok: false, error: filterError });
      return;
    }

    // If user_id is specified, verify user exists in the same tenant
    if (user_id) {
      const targetUser = await db('users')
        .where({ id: user_id, tenant_id: req.user!.tenantId })
        .first();
      if (!targetUser) {
        res.status(404).json({ ok: false, error: 'Target user not found' });
        return;
      }
    }

    const [policy] = await db('data_policies')
      .insert({
        tenant_id: req.user!.tenantId,
        name: name.trim(),
        description: description?.trim() || null,
        user_id: user_id || null,
        role: role || null,
        table_name: table_name.trim(),
        column_name: column_name?.trim() || null,
        filter_expression: filter_expression.trim(),
        policy_type: policy_type || 'row_filter',
        is_active: true,
        created_by: req.user!.sub,
      })
      .returning('*');

    await recordAudit(req, {
      action:     'policy.create',
      entityType: 'policy',
      entityId:   (policy as { id: number }).id,
      context:    { name, table_name, target_user_id: user_id ?? null, target_role: role ?? null, policy_type },
    });

    res.json({ ok: true, data: policy });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /api/policies/:id — update a policy (admin only)
// ---------------------------------------------------------------------------
router.put('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const policyId = Number(req.params.id);
    const {
      name, description, user_id, role, table_name,
      column_name, filter_expression, policy_type, is_active,
    } = req.body as {
      name?: string;
      description?: string;
      user_id?: number | null;
      role?: string | null;
      table_name?: string;
      column_name?: string | null;
      filter_expression?: string;
      policy_type?: string;
      is_active?: boolean;
    };

    // Check policy exists in this tenant
    const existing = await db('data_policies')
      .where({ id: policyId, tenant_id: req.user!.tenantId })
      .first();
    if (!existing) {
      res.status(404).json({ ok: false, error: 'Policy not found' });
      return;
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (name !== undefined) {
      if (!name.trim()) { res.status(400).json({ ok: false, error: 'Policy name cannot be empty' }); return; }
      update.name = name.trim();
    }
    if (description !== undefined) update.description = description?.trim() || null;
    if (table_name !== undefined) {
      if (!table_name.trim()) { res.status(400).json({ ok: false, error: 'Table name cannot be empty' }); return; }
      update.table_name = table_name.trim();
    }
    if (column_name !== undefined) update.column_name = column_name?.trim() || null;
    if (filter_expression !== undefined) {
      const filterError = validateFilterExpression(filter_expression);
      if (filterError) { res.status(400).json({ ok: false, error: filterError }); return; }
      update.filter_expression = filter_expression.trim();
    }
    if (policy_type !== undefined) {
      if (!['row_filter', 'column_mask'].includes(policy_type)) {
        res.status(400).json({ ok: false, error: 'Policy type must be row_filter or column_mask' });
        return;
      }
      update.policy_type = policy_type;
    }
    if (is_active !== undefined) update.is_active = is_active;
    if (user_id !== undefined) update.user_id = user_id;
    if (role !== undefined) {
      if (role && !['analyst', 'viewer'].includes(role)) {
        res.status(400).json({ ok: false, error: 'Role must be analyst or viewer' });
        return;
      }
      update.role = role;
    }

    await db('data_policies').where({ id: policyId }).update(update);

    const updated = await db('data_policies').where({ id: policyId }).first();

    await recordAudit(req, {
      action:     'policy.update',
      entityType: 'policy',
      entityId:   policyId,
      context:    { fields_changed: Object.keys(update) },
    });

    res.json({ ok: true, data: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// DELETE /api/policies/:id — delete a policy (admin only)
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const db = reqDb(req);
    const policyId = Number(req.params.id);

    const count = await db('data_policies')
      .where({ id: policyId, tenant_id: req.user!.tenantId })
      .delete();

    if (count === 0) {
      res.status(404).json({ ok: false, error: 'Policy not found' });
      return;
    }

    await recordAudit(req, {
      action:     'policy.delete',
      entityType: 'policy',
      entityId:   policyId,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
