'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setAuthTokens, getTokenPayload } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');

  async function landAfterLogin() {
    const payload = getTokenPayload();
    // Send admins-with-no-connections to /sources so they can connect
    // their first source — Home is empty without one. Everyone else
    // lands on /home, the daily-driver page (data health + alerts +
    // pinned dashboards + recent questions).
    if (payload?.role === 'admin') {
      try {
        const connRes = await api.get('/connections');
        const hasConnections = (connRes.data.data?.length ?? 0) > 0;
        router.push(hasConnections ? '/home' : '/sources');
      } catch {
        router.push('/home');
      }
    } else {
      router.push('/home');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      // MFA gate — server tells us "password OK but TOTP required".
      // Show the code prompt; keep the challenge token in state. The
      // user then submits the 6-digit code via handleMfaSubmit.
      if (res.data?.data?.mfaRequired) {
        setMfaChallenge(res.data.data.mfaChallengeToken);
        return;
      }
      setAuthTokens(res.data.data.token, res.data.data.refreshToken);
      await landAfterLogin();
    } catch {
      setError('Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/mfa/verify', {
        mfaChallengeToken: mfaChallenge,
        code: mfaCode.trim(),
      });
      setAuthTokens(res.data.data.token, res.data.data.refreshToken);
      setMfaChallenge(null);
      setMfaCode('');
      await landAfterLogin();
    } catch {
      setError('Invalid code. Try again or use a backup code.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Sign in"
      title={<em>Welcome back.</em>}
      lede="Your workspace is one step away."
      footer={
        <>
          New to Clarion?{' '}
          <Link
            href="/register"
            className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
          >
            Request an invite →
          </Link>
        </>
      }
    >
      {mfaChallenge ? (
        // MFA challenge step. Password was correct; user must prove
        // possession of their 2FA device. Backup codes (in XXXXX-XXXXX
        // format) are accepted by the same field.
        <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4" suppressHydrationWarning>
          <div className="text-[13px] text-ink-2 leading-relaxed">
            Enter the 6-digit code from your authenticator app — or a backup code
            in <code className="text-[12px] font-mono">XXXXX-XXXXX</code> format.
          </div>
          <Input
            label="Code"
            type="text"
            value={mfaCode}
            onChange={(e) => setMfaCode(e.target.value)}
            placeholder="123 456"
            autoComplete="one-time-code"
            autoFocus
            required
            disabled={loading}
          />
          {error && (
            <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
              {error}
            </div>
          )}
          <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
            {loading ? 'Verifying…' : 'Verify'}
          </Button>
          <button
            type="button"
            onClick={() => { setMfaChallenge(null); setMfaCode(''); setError(''); }}
            className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
          >
            Back to sign in
          </button>
        </form>
      ) : (
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" suppressHydrationWarning>
        <Input
          label="Work email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          autoComplete="email"
          required
          disabled={loading}
        />

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="login-password"
              className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted font-medium"
            >
              Password
            </label>
            <Link
              href="/forgot-password"
              className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors duration-1"
            >
              Forgot?
            </Link>
          </div>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            disabled={loading}
            className="font-sans text-[14px] px-[13px] py-[10px] rounded-sm border border-line bg-raised text-ink outline-none transition-all duration-1 ease-observatory placeholder:text-muted-2 focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-softer"
          />
        </div>

        {error && (
          <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
            {error}
          </div>
        )}

        <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      )}
    </AuthLayout>
  );
}
