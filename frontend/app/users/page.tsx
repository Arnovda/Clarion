'use client';

import { useState, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
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
    admin:   'bg-primary/10 text-primary',
    analyst: 'bg-cyan-500/10 text-cyan-700',
    viewer:  'bg-amber-500/10 text-amber-700',
  };
  return (
    <span className={`text-label-md px-2.5 py-0.5 rounded-pill font-semibold ${colors[role] ?? 'bg-surface-container text-on-surface-variant'}`}>
      {role}
    </span>
  );
}

const inputCls = "w-full px-3.5 py-2.5 rounded-xl text-body-md bg-surface-container-low text-on-surface placeholder:text-on-surface-variant/40 border-b-2 border-transparent focus:border-primary focus:outline-none transition-colors";

export default function UsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePill, setActivePill] = useState('members');
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('analyst');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url?: string; error?: string } | null>(null);
  const [editingUser, setEditingUser] = useState<number | null>(null);
  const [editRole, setEditRole] = useState('');

  useEffect(() => {
    if (!isAdmin()) { router.push('/query'); return; }
    loadUsers();
  }, [router]);

  async function loadUsers() {
    try {
      const res = await api.get('/users');
      setUsers(res.data.data ?? []);
    } catch {} finally { setLoading(false); }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setInviteResult(null);
    try {
      const res = await api.post('/users/invite', { email: inviteEmail, displayName: inviteName, role: inviteRole });
      setInviteResult({ url: res.data.invite_url });
      setInviteEmail(''); setInviteName(''); setInviteRole('analyst');
      loadUsers();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to invite user';
      setInviteResult({ error: msg });
    } finally { setInviting(false); }
  }

  async function handleRoleChange(userId: number, role: string) {
    try { await api.patch(`/users/${userId}`, { role }); setEditingUser(null); loadUsers(); }
    catch { alert('Failed to update role'); }
  }

  async function handleDeactivate(userId: number) {
    if (!confirm('Deactivate this user? They will lose access immediately.')) return;
    try { await api.patch(`/users/${userId}/deactivate`); loadUsers(); }
    catch { alert('Failed to deactivate user'); }
  }

  async function handleReactivate(userId: number) {
    try { await api.patch(`/users/${userId}/reactivate`); loadUsers(); }
    catch { alert('Failed to reactivate user'); }
  }

  const activeUsers = users.filter((u) => u.is_active);
  const deactivatedUsers = users.filter((u) => !u.is_active);

  const contextPanel = (
    <div className="p-4 space-y-4">
      <div className="text-label-md text-on-surface-variant font-semibold uppercase tracking-wider">Team</div>
      {activeUsers.map((u) => (
        <div key={u.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-surface-container transition-colors">
          <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-label-md font-semibold">
            {u.display_name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="text-body-sm font-medium text-on-surface truncate">{u.display_name}</p>
            <p className="text-label-sm text-on-surface-variant/50">{u.role}</p>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <AppShell
      title="Team"
      subtitle={`${activeUsers.length} active member${activeUsers.length !== 1 ? 's' : ''}`}
      contextPanel={contextPanel}
      pills={[{ key: 'members', label: 'Members' }, { key: 'invites', label: 'Invites' }]}
      activePill={activePill}
      onPillChange={setActivePill}
    >
      {loading ? (
        <div className="p-8 text-on-surface-variant">Loading...</div>
      ) : activePill === 'members' ? (
        <div className="p-6 max-w-4xl">
          {/* User table */}
          <div className="bg-surface-container-lowest rounded-2xl shadow-ambient overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-surface-container-low">
                  <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">User</th>
                  <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Role</th>
                  <th className="text-left px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Joined</th>
                  <th className="text-right px-5 py-3 text-label-md font-semibold text-on-surface-variant uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeUsers.map((user, i) => (
                  <tr key={user.id} className={`transition-colors hover:bg-surface-container-low ${i % 2 === 1 ? 'bg-surface/50' : ''}`}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-body-sm font-semibold">
                          {user.display_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-body-sm font-semibold text-on-surface">{user.display_name}</p>
                          <p className="text-label-sm text-on-surface-variant">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      {editingUser === user.id ? (
                        <select value={editRole} onChange={(e) => handleRoleChange(user.id, e.target.value)}
                          onBlur={() => setEditingUser(null)} autoFocus
                          className="text-body-sm bg-surface-container-low rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-cyan-400">
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <button onClick={() => { setEditingUser(user.id); setEditRole(user.role); }} className="cursor-pointer" title="Click to change role">
                          <RoleBadge role={user.role} />
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-body-sm text-on-surface-variant">
                      {new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button onClick={() => handleDeactivate(user.id)}
                        className="text-label-md text-error/60 hover:text-error font-medium transition-colors">
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
            <div className="mt-8">
              <h2 className="text-label-lg font-semibold text-on-surface-variant mb-3">Deactivated Users</h2>
              <div className="bg-surface-container-lowest rounded-2xl shadow-ambient overflow-hidden opacity-60">
                <table className="w-full">
                  <tbody>
                    {deactivatedUsers.map((user) => (
                      <tr key={user.id}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-surface-container text-on-surface-variant flex items-center justify-center text-body-sm font-medium">
                              {user.display_name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="text-body-sm text-on-surface-variant">{user.display_name}</p>
                              <p className="text-label-sm text-on-surface-variant/50">{user.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3"><RoleBadge role={user.role} /></td>
                        <td className="px-5 py-3 text-right">
                          <button onClick={() => handleReactivate(user.id)}
                            className="text-label-md text-secondary font-medium hover:text-primary transition-colors">
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
      ) : (
        /* Invites pill */
        <div className="p-6 max-w-2xl">
          <div className="bg-surface-container-lowest rounded-2xl shadow-ambient p-6">
            <h2 className="font-headline text-headline-sm font-bold text-on-surface mb-5">Invite a new team member</h2>
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-label-lg text-on-surface mb-1.5">Email</label>
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com" required className={inputCls} />
                </div>
                <div>
                  <label className="block text-label-lg text-on-surface mb-1.5">Display Name</label>
                  <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Jan Janssens" required className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-label-lg text-on-surface mb-1.5">Role</label>
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}
                  className={inputCls}>
                  <option value="admin">Admin — full access</option>
                  <option value="analyst">Analyst — query, dashboards, products</option>
                  <option value="viewer">Viewer — ask questions, view dashboards</option>
                </select>
              </div>
              <button type="submit" disabled={inviting}
                className="px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 disabled:opacity-50 transition-all">
                {inviting ? 'Sending...' : 'Send Invite'}
              </button>
            </form>

            {inviteResult?.url && (
              <div className="mt-5 p-4 bg-green-50 rounded-xl text-body-sm text-green-800">
                <p className="font-semibold">Invite created!</p>
                <code className="block mt-2 text-label-sm bg-green-100 p-2 rounded-lg break-all">{inviteResult.url}</code>
              </div>
            )}
            {inviteResult?.error && (
              <div className="mt-5 p-4 bg-error-container/30 rounded-xl text-body-sm text-error">
                {inviteResult.error}
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
