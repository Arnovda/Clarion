'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

interface Policy {
  id: number;
  name: string;
  description: string | null;
  user_id: number | null;
  role: string | null;
  table_name: string;
  column_name: string | null;
  filter_expression: string;
  policy_type: 'row_filter' | 'column_mask';
  is_active: boolean;
  created_by: number;
  user_display_name: string | null;
  user_email: string | null;
  created_by_name: string | null;
}

interface User {
  id: number;
  email: string;
  display_name: string;
  role: string;
}

interface PolicyForm {
  name: string;
  description: string;
  targetType: 'user' | 'role';
  user_id: string;
  role: string;
  table_name: string;
  policy_type: 'row_filter' | 'column_mask';
  column_name: string;
  filter_expression: string;
}

const emptyForm: PolicyForm = {
  name: '',
  description: '',
  targetType: 'role',
  user_id: '',
  role: 'viewer',
  table_name: '',
  policy_type: 'row_filter',
  column_name: '',
  filter_expression: '',
};

const inputCls =
  'w-full px-3 py-2 rounded-md text-[13px] bg-raised border border-line text-ink-2 placeholder-muted-2 ' +
  'focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors';

const BADGE_CLS = 'text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line';

function TypeBadge({ type }: { type: string }) {
  const isMask = type === 'column_mask';
  return (
    <span className={`${BADGE_CLS} ${isMask ? 'bg-ai-soft text-ai' : 'bg-ocean-softer text-ocean'}`}>
      {isMask ? 'Column mask' : 'Row filter'}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin:   'bg-ocean-softer text-ocean',
    analyst: 'bg-ai-soft text-ai',
    viewer:  'bg-softer text-muted',
  };
  return (
    <span className={`${BADGE_CLS} ${colors[role] ?? 'bg-softer text-muted'}`}>
      {role}
    </span>
  );
}

function PoliciesPageInner() {
  const toast = useToast();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PolicyForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [pRes, uRes] = await Promise.all([
        api.get('/policies'),
        api.get('/users'),
      ]);
      setPolicies(pRes.data.data ?? pRes.data ?? []);
      setUsers(uRes.data.data ?? uRes.data ?? []);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setError('');
    setShowModal(true);
  }

  function openEdit(p: Policy) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      description: p.description ?? '',
      targetType: p.user_id ? 'user' : 'role',
      user_id: p.user_id ? String(p.user_id) : '',
      role: p.role ?? 'viewer',
      table_name: p.table_name,
      policy_type: p.policy_type,
      column_name: p.column_name ?? '',
      filter_expression: p.filter_expression,
    });
    setError('');
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');

    const payload: Record<string, unknown> = {
      name: form.name,
      description: form.description || null,
      table_name: form.table_name,
      filter_expression: form.filter_expression,
      policy_type: form.policy_type,
      column_name: form.policy_type === 'column_mask' ? form.column_name || null : null,
    };

    if (form.targetType === 'user') {
      payload.user_id = Number(form.user_id);
      payload.role = null;
    } else {
      payload.user_id = null;
      payload.role = form.role;
    }

    try {
      if (editingId) {
        await api.put(`/policies/${editingId}`, payload);
        toast.success('Policy updated');
      } else {
        await api.post('/policies', payload);
        toast.success('Policy created');
      }
      setShowModal(false);
      loadData();
    } catch (err) {
      const msg = extractErr(err);
      setError(msg);
      toast.error('Could not save policy', { description: msg });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this policy? This cannot be undone.')) return;
    try {
      await api.delete(`/policies/${id}`);
      loadData();
      toast.success('Policy deleted');
    } catch (err) {
      toast.error('Could not delete policy', { description: extractErr(err) });
    }
  }

  async function handleToggle(p: Policy) {
    try {
      await api.put(`/policies/${p.id}`, { is_active: !p.is_active });
      loadData();
      toast.success(p.is_active ? 'Policy disabled' : 'Policy enabled');
    } catch (err) {
      toast.error('Could not update policy', { description: extractErr(err) });
    }
  }

  function updateForm(patch: Partial<PolicyForm>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  const contextPanel = (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-3">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Summary</p>
      </div>
      <div className="px-4 space-y-2">
        {[
          { label: 'Total',         value: policies.length },
          { label: 'Active',        value: policies.filter((p) => p.is_active).length },
          { label: 'Row filters',   value: policies.filter((p) => p.policy_type === 'row_filter').length },
          { label: 'Column masks',  value: policies.filter((p) => p.policy_type === 'column_mask').length },
        ].map((row) => (
          <div key={row.label} className="flex justify-between items-center">
            <span className="text-[12px] text-ink-3">{row.label}</span>
            <span className="text-[13px] font-medium text-ink tabular-nums">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <AppShell contextPanel={contextPanel}>
      {loading ? (
        <div className="p-8 text-[11px] font-mono tracking-[0.08em] uppercase text-muted">Loading…</div>
      ) : (
        <div className="max-w-5xl mx-auto px-6 pt-10 pb-10 space-y-6">
          <header className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Policies</p>
              <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
                Data access control
              </h1>
              <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
                Control which rows and columns users can access.
              </p>
            </div>
            <button
              onClick={openCreate}
              className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover transition-colors"
            >
              Create policy
            </button>
          </header>

          {policies.length === 0 ? (
            <div className="bg-raised border border-line rounded-lg p-12 text-center">
              <p className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em] mb-2">No policies yet</p>
              <p className="text-[13px] text-ink-3 leading-relaxed max-w-md mx-auto">
                Create your first data-access policy to control who sees what.
              </p>
            </div>
          ) : (
            <div className="bg-raised border border-line rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-softer border-b border-line">
                    {['Policy', 'Target', 'Table', 'Type', 'Filter'].map((h) => (
                      <th key={h} className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">{h}</th>
                    ))}
                    <th className="text-right px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr
                      key={p.id}
                      className={`border-b border-line last:border-b-0 transition-colors hover:bg-softer ${
                        !p.is_active ? 'opacity-50' : ''
                      }`}
                    >
                      <td className="px-5 py-3">
                        <p className="text-[13px] font-medium text-ink">{p.name}</p>
                        {p.description && (
                          <p className="text-[11px] text-ink-3 mt-0.5 line-clamp-1">
                            {p.description}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {p.user_display_name ? (
                          <div>
                            <p className="text-[13px] text-ink-2">{p.user_display_name}</p>
                            <p className="text-[11px] text-muted">{p.user_email}</p>
                          </div>
                        ) : p.role ? (
                          <RoleBadge role={p.role} />
                        ) : (
                          <span className="text-muted-2 text-[13px]">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span className="text-[12px] text-ink-2 font-mono">{p.table_name}</span>
                        {p.column_name && (
                          <span className="text-[11px] text-muted font-mono ml-1">
                            .{p.column_name}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <TypeBadge type={p.policy_type} />
                      </td>
                      <td className="px-5 py-3">
                        <code className="text-[11px] text-ink-3 bg-softer border border-line px-2 py-0.5 rounded font-mono">
                          {p.filter_expression}
                        </code>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleToggle(p)}
                            className={`text-[11px] font-mono tracking-[0.08em] uppercase transition-colors ${
                              p.is_active
                                ? 'text-muted hover:text-ink-2'
                                : 'text-ocean hover:text-ocean-hover'
                            }`}
                            title={p.is_active ? 'Deactivate' : 'Activate'}
                          >
                            {p.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => openEdit(p)}
                            className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(p.id)}
                            className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-err transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Create / Edit Modal */}
      {showModal && (
        <>
          <div className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px]" onClick={() => setShowModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="bg-raised border border-line rounded-lg shadow-2 w-full max-w-lg max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6">
                <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-1">Policy</p>
                <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em] mb-5">
                  {editingId ? 'Edit policy' : 'Create policy'}
                </h2>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Name */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Name</label>
                    <input
                      type="text"
                      required
                      value={form.name}
                      onChange={(e) => updateForm({ name: e.target.value })}
                      placeholder="e.g., EMEA region filter"
                      className={inputCls}
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                      Description <span className="text-muted-2 normal-case">(optional)</span>
                    </label>
                    <textarea
                      value={form.description}
                      onChange={(e) => updateForm({ description: e.target.value })}
                      rows={2}
                      placeholder="What does this policy do?"
                      className={inputCls}
                    />
                  </div>

                  {/* Target type */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Apply to</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
                        <input
                          type="radio"
                          name="targetType"
                          value="role"
                          checked={form.targetType === 'role'}
                          onChange={() => updateForm({ targetType: 'role' })}
                          className="accent-ocean"
                        />
                        Role
                      </label>
                      <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
                        <input
                          type="radio"
                          name="targetType"
                          value="user"
                          checked={form.targetType === 'user'}
                          onChange={() => updateForm({ targetType: 'user' })}
                          className="accent-ocean"
                        />
                        Specific user
                      </label>
                    </div>
                  </div>

                  {/* Role or User select */}
                  {form.targetType === 'role' ? (
                    <div>
                      <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Role</label>
                      <select
                        value={form.role}
                        onChange={(e) => updateForm({ role: e.target.value })}
                        className={inputCls}
                      >
                        <option value="analyst">Analyst</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">User</label>
                      <select
                        required
                        value={form.user_id}
                        onChange={(e) => updateForm({ user_id: e.target.value })}
                        className={inputCls}
                      >
                        <option value="">Select a user…</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.display_name} ({u.email})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Table name */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Table name</label>
                    <input
                      type="text"
                      required
                      value={form.table_name}
                      onChange={(e) => updateForm({ table_name: e.target.value })}
                      placeholder="e.g., orders"
                      className={`${inputCls} font-mono`}
                    />
                  </div>

                  {/* Policy type */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Policy type</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
                        <input
                          type="radio"
                          name="policyType"
                          value="row_filter"
                          checked={form.policy_type === 'row_filter'}
                          onChange={() => updateForm({ policy_type: 'row_filter' })}
                          className="accent-ocean"
                        />
                        Row filter
                      </label>
                      <label className="flex items-center gap-2 text-[13px] text-ink-2 cursor-pointer">
                        <input
                          type="radio"
                          name="policyType"
                          value="column_mask"
                          checked={form.policy_type === 'column_mask'}
                          onChange={() => updateForm({ policy_type: 'column_mask' })}
                          className="accent-ocean"
                        />
                        Column mask
                      </label>
                    </div>
                  </div>

                  {/* Column name (only for column mask) */}
                  {form.policy_type === 'column_mask' && (
                    <div>
                      <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Column name</label>
                      <input
                        type="text"
                        required
                        value={form.column_name}
                        onChange={(e) => updateForm({ column_name: e.target.value })}
                        placeholder="e.g., salary"
                        className={`${inputCls} font-mono`}
                      />
                    </div>
                  )}

                  {/* Filter expression */}
                  <div>
                    <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                      Filter expression
                    </label>
                    <input
                      type="text"
                      required
                      value={form.filter_expression}
                      onChange={(e) => updateForm({ filter_expression: e.target.value })}
                      placeholder="e.g., region = 'EMEA'"
                      className={`${inputCls} font-mono`}
                    />
                    <p className="text-[11px] text-muted mt-1 leading-relaxed">
                      SQL WHERE clause fragment that restricts data access.
                    </p>
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="p-3 bg-err-soft border border-line rounded-md text-[12px] text-err">
                      {error}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="px-3 py-2 rounded-md text-[13px] text-muted hover:text-ink-2 hover:bg-softer transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50 transition-colors"
                    >
                      {saving ? 'Saving…' : editingId ? 'Update' : 'Create'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}

function extractErr(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Please try again.';
}

export default function PoliciesPage() {
  return (
    <RequireRole roles={['admin']}>
      <PoliciesPageInner />
    </RequireRole>
  );
}
