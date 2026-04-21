'use client';

import { useState, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';
import { useToast } from '@/components/ui/Toast';

const inputCls =
  'w-full px-3 py-2 rounded-md text-[13px] bg-raised border border-line text-ink-2 placeholder-muted-2 ' +
  'focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors';

interface Profile {
  id: number; email: string; display_name: string; role: string;
  avatar_url: string | null; created_at: string;
  tenant: { name: string; slug: string } | null;
}

export default function ProfilePage() {
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    try {
      const res = await api.get('/users/profile');
      setProfile(res.data.data); setNameInput(res.data.data.display_name);
    } catch {
      const p = getTokenPayload();
      if (p) { setProfile({ id: p.sub, email: p.email, display_name: p.displayName, role: p.role, created_at: '', tenant: null, avatar_url: null }); setNameInput(p.displayName); }
    } finally { setLoading(false); }
  }

  async function handleSaveName() {
    if (!nameInput.trim()) return;
    setSavingName(true);
    try { await api.patch('/users/profile', { displayName: nameInput.trim() }); await loadProfile(); setEditingName(false); }
    catch { toast.error('Could not update name'); } finally { setSavingName(false); }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault(); setPwMessage(null);
    if (newPw.length < 8) { setPwMessage({ type: 'error', text: 'New password must be at least 8 characters' }); return; }
    if (newPw !== confirmPw) { setPwMessage({ type: 'error', text: 'Passwords do not match' }); return; }
    setSavingPw(true);
    try {
      await api.post('/users/profile/password', { currentPassword: currentPw, newPassword: newPw });
      setPwMessage({ type: 'success', text: 'Password updated successfully' });
      setCurrentPw(''); setNewPw(''); setConfirmPw(''); setShowPassword(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to change password';
      setPwMessage({ type: 'error', text: msg });
    } finally { setSavingPw(false); }
  }

  const roleLabels: Record<string, string> = { admin: 'Administrator', analyst: 'Analyst', viewer: 'Viewer' };

  return (
    <AppShell showSearch={false}>
      {loading ? (
        <div className="p-8 text-[11px] font-mono tracking-[0.08em] uppercase text-muted">Loading…</div>
      ) : !profile ? (
        <div className="p-8 text-[11px] font-mono tracking-[0.08em] uppercase text-muted">Could not load profile</div>
      ) : (
        <div className="max-w-2xl mx-auto px-6 pt-10 pb-10 space-y-6">
          <header>
            <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-2">Profile</p>
            <h1 className="font-display text-[32px] text-ink leading-tight tracking-[-0.02em]">
              Your account
            </h1>
          </header>

          {/* Avatar + name */}
          <div className="bg-raised border border-line rounded-lg p-6 flex items-center gap-5">
            <label className="relative cursor-pointer group" title="Click to change avatar">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="" className="w-16 h-16 rounded-full object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-ocean-softer text-ocean flex items-center justify-center text-[22px] font-display font-medium">
                  {profile.display_name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="absolute inset-0 rounded-full bg-ink/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0]; if (!file) return;
                if (file.size > 375000) { toast.error('Image too large', { description: 'Maximum 375 KB.' }); return; }
                const reader = new FileReader();
                reader.onload = async () => {
                  try { await api.post('/users/profile/avatar', { avatar: reader.result }); loadProfile(); toast.success('Avatar updated'); }
                  catch { toast.error('Could not upload avatar'); }
                };
                reader.readAsDataURL(file);
              }} />
            </label>
            <div>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input type="text" value={nameInput} onChange={(e) => setNameInput(e.target.value)} autoFocus
                    className={`${inputCls} w-auto`} />
                  <button onClick={handleSaveName} disabled={savingName}
                    className="text-[12px] font-medium bg-ocean text-white px-3 py-1.5 rounded-md hover:bg-ocean-hover disabled:opacity-50 transition-colors">
                    {savingName ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => { setEditingName(false); setNameInput(profile.display_name); }}
                    className="text-[11px] font-mono tracking-[0.08em] uppercase text-muted hover:text-ink-2 transition-colors">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em]">{profile.display_name}</h2>
                  <button onClick={() => setEditingName(true)} className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors">Edit</button>
                </div>
              )}
              <p className="text-[13px] text-ink-3 mt-1">{profile.email}</p>
            </div>
          </div>

          {/* Details */}
          <div className="bg-raised border border-line rounded-lg p-6 space-y-3">
            {[
              { label: 'Role', value: roleLabels[profile.role] ?? profile.role },
              ...(profile.tenant ? [{ label: 'Organization', value: profile.tenant.name }] : []),
              ...(profile.created_at ? [{ label: 'Member since', value: new Date(profile.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) }] : []),
            ].map((item) => (
              <div key={item.label} className="flex justify-between items-center">
                <span className="text-[10px] font-mono tracking-[0.1em] uppercase text-muted">{item.label}</span>
                <span className="text-[13px] text-ink">{item.value}</span>
              </div>
            ))}
          </div>

          {/* Password */}
          <div className="bg-raised border border-line rounded-lg overflow-hidden">
            <div className="px-6 py-4 flex items-center justify-between border-b border-line">
              <h2 className="text-[14px] font-medium text-ink">Password</h2>
              <button onClick={() => { setShowPassword(!showPassword); setPwMessage(null); }}
                className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors">
                {showPassword ? 'Cancel' : 'Change password'}
              </button>
            </div>
            {showPassword && (
              <form onSubmit={handleChangePassword} className="px-6 py-5 space-y-4">
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Current password</label>
                  <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} required className={inputCls} />
                </div>
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">New password</label>
                  <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={8} className={inputCls} />
                </div>
                <div>
                  <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Confirm new password</label>
                  <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required className={inputCls} />
                </div>
                <button type="submit" disabled={savingPw}
                  className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50 transition-colors">
                  {savingPw ? 'Updating…' : 'Update password'}
                </button>
                {pwMessage && (
                  <div className={`p-3 rounded-md text-[12px] border border-line ${pwMessage.type === 'success' ? 'bg-ok-soft text-ok' : 'bg-err-soft text-err'}`}>
                    {pwMessage.text}
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
