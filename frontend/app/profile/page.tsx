'use client';

import { useState, useEffect } from 'react';
import Nav from '@/components/Nav';
import api from '@/lib/api';
import { getTokenPayload } from '@/lib/auth';

interface Profile {
  id: number;
  email: string;
  display_name: string;
  role: string;
  avatar_url: string | null;
  created_at: string;
  tenant: { name: string; slug: string } | null;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  // Display name edit
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Password change
  const [showPassword, setShowPassword] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwMessage, setPwMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const res = await api.get('/users/profile');
      setProfile(res.data.data);
      setNameInput(res.data.data.display_name);
    } catch {
      // fallback to JWT data
      const payload = getTokenPayload();
      if (payload) {
        setProfile({
          id: payload.sub,
          email: payload.email,
          display_name: payload.displayName,
          role: payload.role,
          created_at: '',
          tenant: null,
        });
        setNameInput(payload.displayName);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveName() {
    if (!nameInput.trim()) return;
    setSavingName(true);
    try {
      await api.patch('/users/profile', { displayName: nameInput.trim() });
      await loadProfile();
      setEditingName(false);
    } catch {
      alert('Failed to update name');
    } finally {
      setSavingName(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMessage(null);

    if (newPw.length < 8) {
      setPwMessage({ type: 'error', text: 'New password must be at least 8 characters' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMessage({ type: 'error', text: 'Passwords do not match' });
      return;
    }

    setSavingPw(true);
    try {
      await api.post('/users/profile/password', {
        currentPassword: currentPw,
        newPassword: newPw,
      });
      setPwMessage({ type: 'success', text: 'Password updated successfully' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setShowPassword(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Failed to change password';
      setPwMessage({ type: 'error', text: msg });
    } finally {
      setSavingPw(false);
    }
  }

  if (loading) return <div className="min-h-screen bg-slate-50"><Nav /><div className="p-8 text-slate-400">Loading...</div></div>;
  if (!profile) return <div className="min-h-screen bg-slate-50"><Nav /><div className="p-8 text-slate-400">Could not load profile</div></div>;

  const roleLabels: Record<string, string> = {
    admin: 'Administrator',
    analyst: 'Analyst',
    viewer: 'Viewer',
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <Nav />
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-slate-800 mb-6">Profile</h1>

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          {/* Avatar + basic info */}
          <div className="px-6 py-6 flex items-center gap-4 border-b border-slate-100">
            <label className="relative cursor-pointer group" title="Click to change avatar">
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="" className="w-16 h-16 rounded-full object-cover" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-2xl font-semibold">
                  {profile.display_name.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="absolute inset-0 rounded-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 375000) {
                    alert('Image too large (max 375KB)');
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = async () => {
                    try {
                      await api.post('/users/profile/avatar', { avatar: reader.result });
                      loadProfile();
                    } catch { alert('Failed to upload avatar'); }
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            <div>
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    className="border border-slate-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    disabled={savingName}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {savingName ? 'Saving...' : 'Save'}
                  </button>
                  <button onClick={() => { setEditingName(false); setNameInput(profile.display_name); }} className="text-xs text-slate-400 hover:text-slate-600">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-semibold text-slate-800">{profile.display_name}</h2>
                  <button onClick={() => setEditingName(true)} className="text-xs text-blue-500 hover:text-blue-700">
                    Edit
                  </button>
                </div>
              )}
              <p className="text-sm text-slate-500">{profile.email}</p>
            </div>
          </div>

          {/* Details */}
          <div className="px-6 py-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-slate-500">Role</span>
              <span className="text-sm font-medium text-slate-700">{roleLabels[profile.role] ?? profile.role}</span>
            </div>
            {profile.tenant && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Organization</span>
                <span className="text-sm font-medium text-slate-700">{profile.tenant.name}</span>
              </div>
            )}
            {profile.created_at && (
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">Member since</span>
                <span className="text-sm text-slate-600">
                  {new Date(profile.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Password change */}
        <div className="mt-6 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Password</h2>
            <button
              onClick={() => { setShowPassword(!showPassword); setPwMessage(null); }}
              className="text-xs text-blue-500 hover:text-blue-700"
            >
              {showPassword ? 'Cancel' : 'Change password'}
            </button>
          </div>

          {showPassword && (
            <form onSubmit={handleChangePassword} className="px-6 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Current password</label>
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">New password</label>
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  required
                  minLength={8}
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Confirm new password</label>
                <input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  required
                  className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                type="submit"
                disabled={savingPw}
                className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {savingPw ? 'Updating...' : 'Update Password'}
              </button>

              {pwMessage && (
                <div className={`p-3 rounded-lg text-sm ${
                  pwMessage.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {pwMessage.text}
                </div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
