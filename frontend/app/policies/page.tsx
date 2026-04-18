'use client';

import { useState, useEffect, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { isAdmin } from '@/lib/auth';
import { useRouter } from 'next/navigation';

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
  'w-full px-3.5 py-2.5 rounded-xl text-body-md bg-surface-container-low text-on-surface placeholder:text-on-surface-variant/40 border-b-2 border-transparent focus:border-primary focus:outline-none transition-colors';

function TypeBadge({ type }: { type: string }) {
  const isMask = type === 'column_mask';
  return (
    <span
      className={`text-label-md px-2.5 py-0.5 rounded-pill font-semibold ${
        isMask ? 'bg-purple-500/10 text-purple-400' : 'bg-cyan-500/10 text-cyan-400'
      }`}
    >
      {isMask ? 'Column Mask' : 'Row Filter'}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-primary/10 text-primary',
    analyst: 'bg-cyan-500/10 text-cyan-400',
    viewer: 'bg-amber-500/10 text-amber-400',
  };
  return (
    <span
      className={`text-label-md px-2.5 py-0.5 rounded-pill font-semibold ${
        colors[role] ?? 'bg-surface-container text-on-surface-variant'
      }`}
    >
      {role}
    </span>
  );
}

export default function PoliciesPage() {
  const router = useRouter();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PolicyForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isAdmin()) {
      router.push('/query');
      return;
    }
    loadData();
  }, [router]);

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
      } else {
        await api.post('/policies', payload);
      }
      setShowModal(false);
      loadData();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to save policy';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this policy? This cannot be undone.')) return;
    try {
      await api.delete(`/policies/${id}`);
      loadData();
    } catch {
      alert('Failed to delete policy');
    }
  }

  async function handleToggle(p: Policy) {
    try {
      await api.put(`/policies/${p.id}`, { is_active: !p.is_active });
      loadData();
    } catch {
      alert('Failed to update policy');
    }
  }

  function updateForm(patch: Partial<PolicyForm>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  const contextPanel = (
    <div className="p-4 space-y-4">
      <div className="text-label-md text-on-surface-variant font-semibold uppercase tracking-wider">
        Summary
      </div>
      <div className="space-y-2">
        <div className="flex justify-between text-body-sm">
          <span className="text-on-surface-variant">Total</span>
          <span className="text-on-surface font-semibold">{policies.length}</span>
        </div>
        <div className="flex justify-between text-body-sm">
          <span className="text-on-surface-variant">Active</span>
          <span className="text-on-surface font-semibold">
            {policies.filter((p) => p.is_active).length}
          </span>
        </div>
        <div className="flex justify-between text-body-sm">
          <span className="text-on-surface-variant">Row Filters</span>
          <span className="text-on-surface font-semibold">
            {policies.filter((p) => p.policy_type === 'row_filter').length}
          </span>
        </div>
        <div className="flex justify-between text-body-sm">
          <span className="text-on-surface-variant">Column Masks</span>
          <span className="text-on-surface font-semibold">
            {policies.filter((p) => p.policy_type === 'column_mask').length}
          </span>
        </div>
      </div>
    </div>
  );

  return (
    <AppShell
      title="Data Policies"
      subtitle="Control which data rows and columns users can access"
      contextPanel={contextPanel}
    >
      {loading ? (
        <div className="p-8 text-on-surface-variant">Loading...</div>
      ) : (
        <div className="p-6 max-w-5xl">
          {/* Header action */}
          <div className="flex justify-end mb-5">
            <button
              onClick={openCreate}
              className="px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 transition-all"
            >
              Create Policy
            </button>
          </div>

          {policies.length === 0 ? (
            <div className="text-center py-16 text-on-surface-variant">
              <p className="text-headline-sm font-headline mb-2">No policies yet</p>
              <p className="text-body-md">
                Create your first data access policy to control who sees what.
              </p>
            </div>
          ) : (
            <div className="bg-surface-container-lowest rounded-2xl shadow-ambient overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-surface-container-low">
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Policy
                    </th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Target
                    </th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Table
                    </th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Type
                    </th>
                    <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Filter
                    </th>
                    <th className="text-right px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p, i) => (
                    <tr
                      key={p.id}
                      className={`transition-colors hover:bg-surface-container-low ${
                        i % 2 === 1 ? 'bg-surface/50' : ''
                      } ${!p.is_active ? 'opacity-50' : ''}`}
                    >
                      <td className="px-5 py-3.5">
                        <p className="text-body-sm font-semibold text-on-surface">{p.name}</p>
                        {p.description && (
                          <p className="text-label-sm text-on-surface-variant mt-0.5 line-clamp-1">
                            {p.description}
                          </p>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        {p.user_display_name ? (
                          <div>
                            <p className="text-body-sm text-on-surface">{p.user_display_name}</p>
                            <p className="text-label-sm text-on-surface-variant">{p.user_email}</p>
                          </div>
                        ) : p.role ? (
                          <RoleBadge role={p.role} />
                        ) : (
                          <span className="text-on-surface-variant text-body-sm">--</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="text-body-sm text-on-surface font-mono">{p.table_name}</span>
                        {p.column_name && (
                          <span className="text-label-sm text-on-surface-variant font-mono ml-1">
                            .{p.column_name}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <TypeBadge type={p.policy_type} />
                      </td>
                      <td className="px-5 py-3.5">
                        <code className="text-label-sm text-on-surface-variant bg-surface-container px-2 py-1 rounded-lg font-mono">
                          {p.filter_expression}
                        </code>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleToggle(p)}
                            className={`text-label-md font-medium transition-colors ${
                              p.is_active
                                ? 'text-on-surface-variant/60 hover:text-on-surface-variant'
                                : 'text-secondary hover:text-primary'
                            }`}
                            title={p.is_active ? 'Deactivate' : 'Activate'}
                          >
                            {p.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => openEdit(p)}
                            className="text-label-md text-secondary font-medium hover:text-primary transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(p.id)}
                            className="text-label-md text-error/60 hover:text-error font-medium transition-colors"
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
          <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div
              className="bg-surface-container-lowest rounded-2xl shadow-ambient w-full max-w-lg max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-6">
                <h2 className="font-headline text-headline-sm font-bold text-on-surface mb-5">
                  {editingId ? 'Edit Policy' : 'Create Policy'}
                </h2>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* Name */}
                  <div>
                    <label className="block text-label-lg text-on-surface mb-1.5">Name</label>
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
                    <label className="block text-label-lg text-on-surface mb-1.5">
                      Description <span className="text-on-surface-variant/40">(optional)</span>
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
                    <label className="block text-label-lg text-on-surface mb-1.5">Apply to</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                        <input
                          type="radio"
                          name="targetType"
                          value="role"
                          checked={form.targetType === 'role'}
                          onChange={() => updateForm({ targetType: 'role' })}
                          className="accent-cyan-400"
                        />
                        Role
                      </label>
                      <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                        <input
                          type="radio"
                          name="targetType"
                          value="user"
                          checked={form.targetType === 'user'}
                          onChange={() => updateForm({ targetType: 'user' })}
                          className="accent-cyan-400"
                        />
                        Specific User
                      </label>
                    </div>
                  </div>

                  {/* Role or User select */}
                  {form.targetType === 'role' ? (
                    <div>
                      <label className="block text-label-lg text-on-surface mb-1.5">Role</label>
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
                      <label className="block text-label-lg text-on-surface mb-1.5">User</label>
                      <select
                        required
                        value={form.user_id}
                        onChange={(e) => updateForm({ user_id: e.target.value })}
                        className={inputCls}
                      >
                        <option value="">Select a user...</option>
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
                    <label className="block text-label-lg text-on-surface mb-1.5">Table Name</label>
                    <input
                      type="text"
                      required
                      value={form.table_name}
                      onChange={(e) => updateForm({ table_name: e.target.value })}
                      placeholder="e.g., orders"
                      className={inputCls}
                    />
                  </div>

                  {/* Policy type */}
                  <div>
                    <label className="block text-label-lg text-on-surface mb-1.5">Policy Type</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                        <input
                          type="radio"
                          name="policyType"
                          value="row_filter"
                          checked={form.policy_type === 'row_filter'}
                          onChange={() => updateForm({ policy_type: 'row_filter' })}
                          className="accent-cyan-400"
                        />
                        Row Filter
                      </label>
                      <label className="flex items-center gap-2 text-body-sm text-on-surface cursor-pointer">
                        <input
                          type="radio"
                          name="policyType"
                          value="column_mask"
                          checked={form.policy_type === 'column_mask'}
                          onChange={() => updateForm({ policy_type: 'column_mask' })}
                          className="accent-cyan-400"
                        />
                        Column Mask
                      </label>
                    </div>
                  </div>

                  {/* Column name (only for column mask) */}
                  {form.policy_type === 'column_mask' && (
                    <div>
                      <label className="block text-label-lg text-on-surface mb-1.5">Column Name</label>
                      <input
                        type="text"
                        required
                        value={form.column_name}
                        onChange={(e) => updateForm({ column_name: e.target.value })}
                        placeholder="e.g., salary"
                        className={inputCls}
                      />
                    </div>
                  )}

                  {/* Filter expression */}
                  <div>
                    <label className="block text-label-lg text-on-surface mb-1.5">
                      Filter Expression
                    </label>
                    <input
                      type="text"
                      required
                      value={form.filter_expression}
                      onChange={(e) => updateForm({ filter_expression: e.target.value })}
                      placeholder="e.g., region = 'EMEA'"
                      className={`${inputCls} font-mono`}
                    />
                    <p className="text-label-sm text-on-surface-variant/50 mt-1">
                      SQL WHERE clause fragment that restricts data access
                    </p>
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="p-3 bg-error-container/30 rounded-xl text-body-sm text-error">
                      {error}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex justify-end gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowModal(false)}
                      className="px-4 py-2.5 rounded-xl text-body-sm text-on-surface-variant hover:bg-surface-container transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={saving}
                      className="px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 disabled:opacity-50 transition-all"
                    >
                      {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
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
