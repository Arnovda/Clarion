'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setAuthTokens } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function RegisterPage() {
  const router = useRouter();
  const [companyName, setCompanyName]         = useState('');
  const [displayName, setDisplayName]         = useState('');
  const [email, setEmail]                     = useState('');
  const [password, setPassword]               = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);
  // Set when the server withholds tokens pending email verification —
  // the form is replaced by a check-your-inbox notice.
  const [awaitingVerification, setAwaitingVerification] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 8)          { setError('Password must be at least 8 characters.'); return; }

    setLoading(true);
    try {
      const res = await api.post('/auth/register', { companyName, email, password, displayName });
      const data = res.data?.data ?? {};
      if (data.requiresVerification) {
        // No tokens until the address is confirmed via the emailed link.
        setAwaitingVerification(true);
        return;
      }
      setAuthTokens(data.token, data.refreshToken);
      router.push('/sources');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (awaitingVerification) {
    return (
      <AuthLayout
        eyebrow="Almost there"
        title={<em>Check your inbox.</em>}
        lede="One click left before your workspace opens."
        footer={
          <>
            Wrong address?{' '}
            <Link href="/register" className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1">
              Register again
            </Link>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="text-[13px] text-ink-2 leading-relaxed">
            We sent a confirmation link to <span className="font-medium">{email}</span>.
            Click it to activate your workspace, then sign in. The link is valid for 24 hours.
          </div>
          <div className="text-[13px] text-muted leading-relaxed">
            Nothing arriving? Check your spam folder, or request a new link from the sign-in
            screen once you try to log in.
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Create workspace"
      title={<em>Start observing.</em>}
      lede="A workspace is your company's private view. Invite teammates after you connect your first source."
      footer={
        <>
          Already have an account?{' '}
          <Link href="/" className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" suppressHydrationWarning>
        <Input
          label="Workspace name"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder="Acme BV"
          autoComplete="organization"
          required
          disabled={loading}
        />
        <Input
          label="Your name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Jan Janssens"
          autoComplete="name"
          required
          disabled={loading}
        />
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
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Minimum 8 characters"
          autoComplete="new-password"
          required
          disabled={loading}
        />
        <Input
          label="Confirm password"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          required
          disabled={loading}
        />

        {error && (
          <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
            {error}
          </div>
        )}

        <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
          {loading ? 'Creating workspace…' : 'Create workspace'}
        </Button>
      </form>
    </AuthLayout>
  );
}
