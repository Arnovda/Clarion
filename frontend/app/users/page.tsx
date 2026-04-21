'use client';

import { useState, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
import RequireRole from '@/components/RequireRole';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';

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
    admin:   'bg-ocean-softer text-ocean',
    analyst: 'bg-ai-soft text-ai',
    viewer:  'bg-softer text-muted',
  };
  return (
    <span className={`text-[10px] font-mono tracking-[0.08em] uppercase px-2 py-0.5 rounded border border-line ${colors[role] ?? 'bg-softer text-muted'}`}>
      {role}
    </span>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-md text-[13px] bg-raised border border-line text-ink-2 placeholder-muted-2 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors';

function UsersPageInner() {
  const toast = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [activePill, setActivePill] = useState('members');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('analyst');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ url?: string; error?: string } | null>(null);
  const [editingUser, setEditingUser] = useState<number | null>(null);
  const [editRole, setEditRole] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

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
    try {
      await api.patch(`/users/${userId}`, { role });
      setEditingUser(null);
      loadUsers();
      toast.success('Role updated');
    } catch (err) {
      toast.error('Could not update role', { description: extractError(err) });
    }
  }

  async function handleDeactivate(userId: number) {
    if (!confirm('Deactivate this user? They will lose access immediately.')) return;
    try {
      await api.patch(`/users/${userId}/deactivate`);
      loadUsers();
      toast.success('User deactivated');
    } catch (err) {
      toast.error('Could not deactivate user', { description: extractError(err) });
    }
  }

  async function handleReactivate(userId: number) {
    try {
      await api.patch(`/users/${userId}/reactivate`);
      loadUsers();
      toast.success('User reactivated');
    } catch (err) {
      toast.error('Could not reactivate user', { description: extractError(err) });
    }
  }

  const activeUsers = users.filter((u) => u.is_active);
  const deactivatedUsers = users.filter((u) => !u.is_active);

  const contextPanel = (
    <div className="flex flex-col h-full">
      <div className="px-4 pt-5 pb-3">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted">Team</p>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin pb-2">
        {activeUsers.map((u) => (
          <div key={u.id} className="flex items-center gap-2.5 px-4 py-2 border-l-2 border-transparent hover:bg-softer transition-colors">
            <div className="w-7 h-7 rounded-full bg-ocean-softer text-ocean flex items-center justify-center text-[11px] font-medium shrink-0">
              {u.display_name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-[13px] text-ink-2 truncate leading-snug">{u.display_name}</p>
              <p className="text-[10px] font-mono tracking-[0.06em] uppercase text-muted-2 mt-0.5">{u.role}</p>
            </div>
          </div>
        ))}
        {activeUsers.length === 0 && !loading && (
          <p className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted-2 text-center mt-6 px-4">No team members yet</p>
        )}
      </div>
    </div>
  );

  return (
    <AppShell
      contextPanel={contextPanel}
      pills={[{ key: 'members', label: 'Members' }, { key: 'invites', label: 'Invites' }]}
      activePill={activePill}
      onPillChange={setActivePill}
    >
      {loading ? (
        <div className="p-8 text-[11px] font-mono tracking-[0.08em] uppercase text-muted">Loading…</div>
      ) : activePill === 'members' ? (
        <div className="max-w-4xl mx-auto px-6 pt-10 pb-10 space-y-8">
          <header>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Team</p>
            <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
              {activeUsers.length} active member{activeUsers.length !== 1 ? 's' : ''}
            </h1>
          </header>

          {/* User table */}
          <div className="bg-raised border border-line rounded-lg overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-softer border-b border-line">
                  <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">User</th>
                  <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Role</th>
                  <th className="text-left px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Joined</th>
                  <th className="text-right px-5 py-3 text-[10px] font-mono font-medium text-muted uppercase tracking-[0.1em]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activeUsers.map((user) => (
                  <tr key={user.id} className="border-b border-line last:border-b-0 transition-colors hover:bg-softer">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-ocean-softer text-ocean flex items-center justify-center text-[12px] font-medium">
                          {user.display_name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-[13px] font-medium text-ink">{user.display_name}</p>
                          <p className="text-[11px] text-muted">{user.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      {editingUser === user.id ? (
                        <select value={editRole} onChange={(e) => handleRoleChange(user.id, e.target.value)}
                          onBlur={() => setEditingUser(null)} autoFocus
                          className="text-[12px] bg-raised border border-line rounded-md px-2 py-1 focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30">
                          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                      ) : (
                        <button onClick={() => { setEditingUser(user.id); setEditRole(user.role); }} className="cursor-pointer" title="Click to change role">
                          <RoleBadge role={user.role} />
                        </button>
                      )}
                    </td>
                    <td className="px-5 py-3 text-[12px] text-ink-3">
                      {new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button onClick={() => handleDeactivate(user.id)}
                        className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-err transition-colors">
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
            <div>
              <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">Deactivated</p>
              <div className="bg-raised border border-line rounded-lg overflow-hidden opacity-60">
                <table className="w-full">
                  <tbody>
                    {deactivatedUsers.map((user) => (
                      <tr key={user.id} className="border-b border-line last:border-b-0">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-softer border border-line text-muted flex items-center justify-center text-[12px]">
                              {user.display_name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <p className="text-[13px] text-ink-2">{user.display_name}</p>
                              <p className="text-[11px] text-muted">{user.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3"><RoleBadge role={user.role} /></td>
                        <td className="px-5 py-3 text-right">
                          <button onClick={() => handleReactivate(user.id)}
                            className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors">
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
        <div className="max-w-2xl mx-auto px-6 pt-10 pb-10">
          <header className="mb-6">
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Invites</p>
            <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
              Invite a new team member
            </h1>
          </header>

          <div className="bg-raised border border-line rounded-lg p-6">
            <form onSubmit={handleInvite} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Email</label>
                  <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="colleague@company.com" required className={inputCls} />
                </div>
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Display name</label>
                  <input type="text" value={inviteName} onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Jan Janssens" required className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Role</label>
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className={inputCls}>
                  <option value="admin">Admin — full access</option>
                  <option value="analyst">Analyst — query, dashboards, products</option>
                  <option value="viewer">Viewer — ask questions, view dashboards</option>
                </select>
              </div>
              <button type="submit" disabled={inviting}
                className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50 transition-colors">
                {inviting ? 'Sending…' : 'Send invite'}
              </button>
            </form>

            {inviteResult?.url && (
              <div className="mt-5 p-4 bg-ok-soft border border-line rounded-md text-[12px] text-ink-2">
                <p className="text-[10px] font-mono tracking-[0.08em] uppercase text-ok mb-1">Invite created</p>
                <code className="block mt-2 text-[11px] font-mono bg-raised border border-line text-ink-3 p-2 rounded break-all">{inviteResult.url}</code>
              </div>
            )}
            {inviteResult?.error && (
              <div className="mt-5 p-4 bg-err-soft border border-line rounded-md text-[12px] text-err">
                {inviteResult.error}
              </div>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

function extractError(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
  return e?.response?.data?.error ?? e?.response?.data?.message ?? e?.message ?? 'Please try again.';
}

export default function UsersPage() {
  return (
    <RequireRole roles={['admin']}>
      <UsersPageInner />
    </RequireRole>
  );
}
