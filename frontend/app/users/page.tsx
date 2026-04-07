'use client';

import { useState, useEffect } from 'react';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { isAdmin } from '@/lib/auth';
import { useRouter } from 'next/navigation';

interface User {
  id: number;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const ROLES = ['admin', 'analyst', 'viewer'] as const;

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, string> = {
    admin: 'bg-purple-100 text-purple-700',
    analyst: 'bg-blue-100 text-blue-700',
    viewer: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[role] ?? 'bg-slate-100 text-slate-500'}`}>
      {role}
    </span>
  );
}

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('analyst');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url?: string; error?: string } | null>(null);
  const [editingUser, setEditingUser] = useState<number | null>(null);
  const [editRole, setEditRole] = useState('');

  useEffect(() => {
    if (!isAdmin()) {
      router.push('/query');
      return;
    }
    loadUsers();
  }, [router]);

  async function loadUsers() {
    try {
      const res = await api.get('/users');
      setUsers(res.data.data ?? []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteResult(null);
    try {
      const res = await api.post('/users/invite', {
        email: inviteEmail,
        displayName: inviteName,
        role: inviteRole,
      });
      setInviteResult({ url: res.data.invite_url });
      setInviteEmail('');
      setInviteName('');
      setInviteRole('analyst');
      loadUsers();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to invite user';
      setInviteResult({ error: msg });
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId: number, role: string) {
    try {
      await api.patch(`/users/${userId}`, { role });
      setEditingUser(null);
      loadUsers();
    } catch {
      alert('Failed to update role');
    }
  }

  async function handleDeactivate(userId: number) {
    if (!confirm('Deactivate this user? They will lose access immediately.')) return;
    try {
      await api.patch(`/users/${userId}/deactivate`);
      loadUsers();
    } catch {
      alert('Failed to deactivate user');
    }
  }

  async function handleReactivate(userId: number) {
    try {
      await api.patch(`/users/${userId}/reactivate`);
      loadUsers();
    } catch {
      alert('Failed to reactivate user');
    }
  }

  if (loading) return <div className="min-h-screen bg-slate-50"><Nav /><div className="p-8 text-slate-400">Loading...</div></div>;

  const activeUsers = users.filter((u) => u.is_active);
  const deactivatedUsers = users.filter((u) => !u.is_active);

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Team Members</h1>
            <p className="text-sm text-slate-500 mt-1">{activeUsers.length} active user{activeUsers.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => { setShowInvite(!showInvite); setInviteResult(null); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700"
          >
            {showInvite ? 'Cancel' : 'Invite User'}
          </button>
        </div>

        {/* Invite form */}
        {showInvite && (
          <div className="bg-white rounded-xl border border-slate-200 p-6 mb-6">
            <h2 className="text-lg font-semibold text-slate-800 mb-4">Invite a new user</h2>
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com"
                    required
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Display Name</label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Jan Janssens"
                    required
                    className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Role</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="admin">Admin — full access</option>
                  <option value="analyst">Analyst — query, dashboards, reports</option>
                  <option value="viewer">Viewer — read-only access</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={inviting}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {inviting ? 'Sending...' : 'Send Invite'}
              </button>
            </form>

            {inviteResult?.url && (
              <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
                <p className="font-medium">Invite created successfully!</p>
                <p className="mt-1 text-xs">Invite link (dev only):</p>
                <code className="block mt-1 text-xs bg-green-100 p-2 rounded break-all">{inviteResult.url}</code>
              </div>
            )}
            {inviteResult?.error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {inviteResult.error}
              </div>
            )}
          </div>
        )}

        {/* User list */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">User</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Role</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Joined</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeUsers.map((user) => (
                <tr key={user.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-sm font-medium">
                        {user.display_name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-800">{user.display_name}</p>
                        <p className="text-xs text-slate-400">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {editingUser === user.id ? (
                      <select
                        value={editRole}
                        onChange={(e) => handleRoleChange(user.id, e.target.value)}
                        onBlur={() => setEditingUser(null)}
                        autoFocus
                        className="text-xs border border-slate-300 rounded px-2 py-1"
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <button
                        onClick={() => { setEditingUser(user.id); setEditRole(user.role); }}
                        className="cursor-pointer"
                        title="Click to change role"
                      >
                        <RoleBadge role={user.role} />
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400">
                    {new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDeactivate(user.id)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Deactivate
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Deactivated users */}
        {deactivatedUsers.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-medium text-slate-500 mb-3">Deactivated Users</h2>
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full">
                <tbody className="divide-y divide-slate-100">
                  {deactivatedUsers.map((user) => (
                    <tr key={user.id} className="opacity-60">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center text-sm font-medium">
                            {user.display_name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm text-slate-600">{user.display_name}</p>
                            <p className="text-xs text-slate-400">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><RoleBadge role={user.role} /></td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleReactivate(user.id)}
                          className="text-xs text-blue-500 hover:text-blue-700"
                        >
                          Reactivate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
