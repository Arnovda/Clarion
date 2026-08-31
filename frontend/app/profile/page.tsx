'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { startRegistration } from '@simplewebauthn/browser';
import AppShell from '@/components/layout/AppShell';
import api from '@/lib/api';
import { clearToken, getRefreshToken, getTokenPayload } from '@/lib/auth';
import { useToast } from '@/components/ui/Toast';
import ApiTokensSection from './ApiTokensSection';

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
  const router = useRouter();
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
  const [confirmingLogoutAll, setConfirmingLogoutAll] = useState(false);
  const [logoutAllBusy, setLogoutAllBusy] = useState(false);

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

  async function handleLogoutAll() {
    setLogoutAllBusy(true);
    try {
      // Best-effort: also revoke the current refresh token explicitly. The
      // logout-all call below revokes every token for the user including
      // this one, but sending the refresh token gives the server a stable
      // audit trail of "this device asked to log out everywhere."
      const refresh = getRefreshToken();
      if (refresh) {
        try { await api.post('/auth/logout', { refreshToken: refresh }); }
        catch { /* ignore — logout-all is what counts */ }
      }
      await api.post('/auth/logout-all');
      clearToken();
      toast.success('Signed out of every device');
      router.push('/');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not sign out everywhere';
      toast.error(msg);
      setLogoutAllBusy(false);
      setConfirmingLogoutAll(false);
    }
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

          {/* Two-factor authentication */}
          <MfaSection />

          {/* Security keys / passkeys */}
          <WebauthnSection />

          <ApiTokensSection />

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

          {/* Sessions */}
          <div className="bg-raised border border-line rounded-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-line">
              <h2 className="text-[14px] font-medium text-ink">Active sessions</h2>
              <p className="text-[11.5px] text-muted-2 mt-0.5">
                Revoke every session on every device. Use this if you think your account may have been compromised.
              </p>
            </div>
            <div className="px-6 py-5">
              {!confirmingLogoutAll ? (
                <button
                  type="button"
                  onClick={() => setConfirmingLogoutAll(true)}
                  className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-err hover:text-err/80"
                >
                  Sign out of every device
                </button>
              ) : (
                <div className="space-y-3">
                  <p className="text-[13px] text-ink-2">
                    This will sign you out everywhere, including this browser. You&rsquo;ll need to log in again.
                  </p>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleLogoutAll}
                      disabled={logoutAllBusy}
                      className="px-4 py-2 bg-err text-white rounded-md text-[13px] font-medium hover:bg-err/80 disabled:opacity-50"
                    >
                      {logoutAllBusy ? 'Signing out…' : 'Yes, sign out everywhere'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingLogoutAll(false)}
                      disabled={logoutAllBusy}
                      className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// MfaSection — enrol / disable TOTP. Three-state widget:
//   - !enabled && !enrolment   → "Set up 2FA" button
//   - !enabled && enrolment    → QR code + code prompt
//   - enabled                  → "2FA is on" + disable button + regen-codes
// Backup codes are shown ONCE on enable; user must save them before
// confirming.
// ───────────────────────────────────────────────────────────────────────────

function MfaSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enrolment, setEnrolment] = useState<{ secret: string; qrCodeDataUrl: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Disable flow state
  const [disabling, setDisabling] = useState(false);
  const [dispassword, setDispassword] = useState('');
  const [discode, setDiscode] = useState('');

  useEffect(() => {
    api.get('/auth/mfa/status').then((r) => {
      setEnabled(!!r.data?.data?.enabled);
    }).catch(() => setEnabled(false));
  }, []);

  async function handleStart() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/mfa/setup');
      setEnrolment(r.data.data);
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not start MFA setup');
    } finally { setBusy(false); }
  }

  async function handleConfirm() {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/auth/mfa/enable', { code: confirmCode.trim() });
      setBackupCodes(r.data.data.backupCodes);
      setEnabled(true);
      setEnrolment(null);
      setConfirmCode('');
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Invalid code');
    } finally { setBusy(false); }
  }

  async function handleDisable() {
    setBusy(true); setErr(null);
    try {
      await api.post('/auth/mfa/disable', { password: dispassword, code: discode.trim() });
      setEnabled(false);
      setDisabling(false);
      setDispassword('');
      setDiscode('');
    } catch (e) {
      setErr((e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not disable MFA');
    } finally { setBusy(false); }
  }

  if (enabled === null) return null;

  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between border-b border-line">
        <div>
          <h2 className="text-[14px] font-medium text-ink">Two-factor authentication</h2>
          <p className="text-[11.5px] text-muted-2 mt-0.5">
            Time-based one-time passwords (TOTP). Compatible with Google
            Authenticator, 1Password, Authy, Bitwarden.
          </p>
        </div>
        {enabled && !disabling && (
          <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.1em] bg-ok-soft text-ok border border-ok/30 rounded">
            On
          </span>
        )}
      </div>

      <div className="px-6 py-5 space-y-4">
        {/* CASE 1: not enabled, no enrolment yet */}
        {!enabled && !enrolment && (
          <>
            <p className="text-[13px] text-ink-2">
              Add a second factor to your account. After enabling, you&rsquo;ll need a
              6-digit code from your authenticator app every time you sign in.
            </p>
            <button
              type="button"
              onClick={handleStart}
              disabled={busy}
              className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Set up 2FA'}
            </button>
          </>
        )}

        {/* CASE 2: enrolment in progress, show QR + confirm */}
        {!enabled && enrolment && !backupCodes && (
          <>
            <p className="text-[12.5px] text-ink-2">
              1. Scan this QR with your authenticator app.<br/>
              2. Enter the first 6-digit code below to confirm.
            </p>
            <div className="bg-white border border-line rounded-md p-3 inline-block">
              <img src={enrolment.qrCodeDataUrl} alt="MFA QR code" width={180} height={180} />
            </div>
            <p className="text-[11.5px] text-muted-2">
              Or enter this secret manually:{' '}
              <code className="font-mono text-[12px] px-2 py-0.5 bg-softer rounded border border-line">
                {enrolment.secret}
              </code>
            </p>
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                6-digit code
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                placeholder="123 456"
                className={inputCls + ' max-w-[180px]'}
              />
            </div>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy || !confirmCode.trim()}
              className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50"
            >
              {busy ? 'Verifying…' : 'Confirm and enable'}
            </button>
          </>
        )}

        {/* CASE 3: just enabled, show backup codes ONCE */}
        {enabled && backupCodes && (
          <>
            <div className="p-3 bg-warn-soft border border-warn/30 rounded-md text-[13px] text-ink leading-snug">
              <strong>Save these backup codes.</strong> Each one works once and
              substitutes for your 2FA code when you don&rsquo;t have your authenticator.
              You won&rsquo;t see them again.
            </div>
            <div className="grid grid-cols-2 gap-2">
              {backupCodes.map((c) => (
                <code key={c} className="font-mono text-[12px] px-2 py-1.5 bg-softer rounded border border-line text-ink">
                  {c}
                </code>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBackupCodes(null)}
              className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover"
            >
              I&rsquo;ve saved them
            </button>
          </>
        )}

        {/* CASE 4: enabled, idle */}
        {enabled && !backupCodes && !disabling && (
          <>
            <p className="text-[13px] text-ink-2">
              2FA is active on your account. You&rsquo;ll be prompted for a code
              on every sign-in.
            </p>
            <button
              type="button"
              onClick={() => setDisabling(true)}
              className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-err hover:text-err/80"
            >
              Disable 2FA
            </button>
          </>
        )}

        {/* CASE 5: disable confirmation */}
        {enabled && disabling && (
          <>
            <p className="text-[12.5px] text-ink-2">
              To disable 2FA, confirm your password and a current authenticator code.
            </p>
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Password</label>
              <input type="password" value={dispassword} onChange={(e) => setDispassword(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">Current 6-digit code</label>
              <input type="text" inputMode="numeric" value={discode} onChange={(e) => setDiscode(e.target.value)} placeholder="123 456" className={inputCls + ' max-w-[180px]'} />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleDisable}
                disabled={busy || !dispassword || !discode.trim()}
                className="px-4 py-2 bg-err text-white rounded-md text-[13px] font-medium hover:bg-err/80 disabled:opacity-50"
              >
                {busy ? 'Disabling…' : 'Confirm disable'}
              </button>
              <button
                type="button"
                onClick={() => { setDisabling(false); setErr(null); }}
                className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </>
        )}

        {err && (
          <div className="p-2 bg-err-soft text-err border border-err/30 rounded-md text-[12px]">{err}</div>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// WebauthnSection — register / list / remove hardware keys + passkeys.
// Phishing-resistant alternative to TOTP. A user can have BOTH enrolled;
// the login flow surfaces whichever is available. Removing the last
// WebAuthn credential does NOT remove TOTP — they're independent factors.
// ───────────────────────────────────────────────────────────────────────────

interface WebauthnCredential {
  id: number;
  nickname: string;
  created_at: string;
  last_used_at: string | null;
  device_type: string | null;
  backed_up: boolean;
}

function WebauthnSection() {
  const toast = useToast();
  const [credentials, setCredentials] = useState<WebauthnCredential[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The browser's PublicKeyCredential is only defined in secure contexts
  // (HTTPS or localhost). Avoid offering the feature when it won't work.
  const supported = typeof window !== 'undefined' && !!window.PublicKeyCredential;

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const r = await api.get('/auth/webauthn/credentials');
      setCredentials(r.data?.data ?? []);
    } catch {
      setCredentials([]);
    }
  }

  async function handleAdd() {
    if (!nickname.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const opts = await api.post('/auth/webauthn/register-options');
      const optionsJSON = opts.data?.data?.options;
      const challengeToken = opts.data?.data?.challengeToken;
      if (!optionsJSON || !challengeToken) throw new Error('Server did not return registration options');

      const attestation = await startRegistration({ optionsJSON });

      await api.post('/auth/webauthn/register-verify', {
        response: attestation,
        challengeToken,
        nickname: nickname.trim(),
      });

      toast.success('Security key added');
      setNickname('');
      setAdding(false);
      await load();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (e as { message?: string })?.message
        ?? 'Could not register security key';
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(c: WebauthnCredential) {
    if (!confirm(`Remove "${c.nickname}"? You won't be able to sign in with this device until you register it again.`)) return;
    try {
      await api.delete(`/auth/webauthn/credentials/${c.id}`);
      toast.success('Security key removed');
      await load();
    } catch {
      toast.error('Could not remove security key');
    }
  }

  if (credentials === null) return null;

  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between border-b border-line">
        <div>
          <h2 className="text-[14px] font-medium text-ink">Security keys &amp; passkeys</h2>
          <p className="text-[11.5px] text-muted-2 mt-0.5">
            YubiKey, Touch ID, Windows Hello, password-manager passkeys. Phishing-resistant — bound
            to this site&rsquo;s domain.
          </p>
        </div>
        {credentials.length > 0 && (
          <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.1em] bg-ok-soft text-ok border border-ok/30 rounded">
            {credentials.length} active
          </span>
        )}
      </div>

      <div className="px-6 py-5 space-y-4">
        {!supported && (
          <div className="p-2 bg-warn-soft text-ink border border-warn/30 rounded-md text-[12px]">
            Your browser doesn&rsquo;t support security keys. Try a recent Chrome, Edge, Safari, or Firefox.
          </div>
        )}

        {credentials.length > 0 && (
          <ul className="divide-y divide-line border border-line rounded-md overflow-hidden">
            {credentials.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink truncate">{c.nickname}</div>
                  <div className="text-[11px] text-muted-2 mt-0.5">
                    Added {new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {c.last_used_at && ` · last used ${new Date(c.last_used_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`}
                    {c.backed_up && ' · passkey (synced)'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(c)}
                  className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-err transition-colors"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {!adding && supported && (
          <button
            type="button"
            onClick={() => { setAdding(true); setErr(null); }}
            className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50"
          >
            {credentials.length === 0 ? 'Add a security key' : 'Add another'}
          </button>
        )}

        {adding && supported && (
          <div className="space-y-3">
            <div>
              <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
                Name this device
              </label>
              <input
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="e.g. YubiKey 5C — work laptop"
                maxLength={64}
                autoFocus
                className={inputCls + ' max-w-[360px]'}
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleAdd}
                disabled={busy || !nickname.trim()}
                className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50"
              >
                {busy ? 'Waiting for device…' : 'Register'}
              </button>
              <button
                type="button"
                onClick={() => { setAdding(false); setNickname(''); setErr(null); }}
                disabled={busy}
                className="text-[11.5px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {err && (
          <div className="p-2 bg-err-soft text-err border border-err/30 rounded-md text-[12px]">{err}</div>
        )}
      </div>
    </div>
  );
}
