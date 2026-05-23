'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import AuthLayout from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [token, setTokenVal]                  = useState('');
  const [email, setEmail]                     = useState('');
  const [newPassword, setNewPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [success, setSuccess]                 = useState(false);
  const [error, setError]                     = useState('');
  const [loading, setLoading]                 = useState(false);

  useEffect(() => {
    setTokenVal(searchParams.get('token') ?? '');
    setEmail(searchParams.get('email') ?? '');
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (newPassword.length < 8)          { setError('Password must be at least 8 characters.'); return; }

    setLoading(true);
    try {
      // Backend's Zod schema (middleware/schemas.ts:resetPasswordSchema)
      // requires the field be named `password`, not `newPassword`. Sending
      // the wrong key fails validation with 400 in <2ms before the route
      // handler runs, and the frontend rendered that as "Invalid or expired
      // reset link" — misleading but technically the API rejected the body.
      await api.post('/auth/reset-password', { email, token, password: newPassword });
      setSuccess(true);
    } catch {
      setError('Invalid or expired reset link. Please request a new one.');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="flex flex-col gap-3">
        <div className="font-display text-[17px] leading-[1.55] text-ink-2">
          Your password has been updated. You can sign in with your new password now.
        </div>
        <Link
          href="/"
          className="mt-2 inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none px-4 py-[9px] rounded-sm border bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover transition-all duration-1 ease-observatory w-fit"
        >
          Sign in →
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="New password"
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        placeholder="Minimum 8 characters"
        autoComplete="new-password"
        required
        disabled={loading}
      />
      <Input
        label="Confirm new password"
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
        {loading ? 'Resetting…' : 'Reset password'}
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout
      eyebrow="Reset password"
      title={<em>Set a new one.</em>}
      lede="Pick something you haven't used before. At least eight characters."
      footer={
        <Link
          href="/"
          className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
        >
          ← Back to sign in
        </Link>
      }
    >
      <Suspense fallback={
        <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 py-6">
          Loading…
        </div>
      }>
        <ResetPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
