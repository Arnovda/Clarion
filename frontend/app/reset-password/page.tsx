'use client';

import { Suspense, useState, useEffect } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import AuthLayout from '@/components/layout/AuthLayout';

const inputCls = "w-full px-3.5 py-2.5 rounded-xl text-body-md bg-surface-container-low text-on-surface placeholder:text-on-surface-variant/40 border-b-2 border-transparent focus:border-primary focus:outline-none transition-colors";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const [token, setTokenVal]            = useState('');
  const [email, setEmail]               = useState('');
  const [newPassword, setNewPassword]   = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [success, setSuccess]           = useState(false);
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  useEffect(() => {
    setTokenVal(searchParams.get('token') ?? '');
    setEmail(searchParams.get('email') ?? '');
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return; }

    setLoading(true);
    try {
      await api.post('/auth/reset-password', { email, token, newPassword });
      setSuccess(true);
    } catch {
      setError('Invalid or expired reset link. Please request a new one.');
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="text-center space-y-4 py-4">
        <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto">
          <svg className="w-7 h-7 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="font-headline text-headline-sm font-bold text-on-surface">Password reset</h2>
        <p className="text-body-md text-on-surface-variant">Your password has been updated. You can now sign in.</p>
        <Link href="/" className="inline-block mt-2 text-label-lg text-secondary font-semibold hover:text-primary transition-colors">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-label-lg text-on-surface mb-1.5">New password</label>
        <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Minimum 8 characters" className={inputCls} required />
      </div>
      <div>
        <label className="block text-label-lg text-on-surface mb-1.5">Confirm new password</label>
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
          className={inputCls} required />
      </div>

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-error-container/30 text-error text-body-sm">
          <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {error}
        </div>
      )}

      <button type="submit" disabled={loading}
        className="w-full py-3 rounded-xl text-title-md gradient-primary text-on-primary hover:opacity-90 disabled:opacity-50 transition-all shadow-glow-primary">
        {loading ? 'Resetting...' : 'Reset password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthLayout subtitle="Set a new password">
      <Suspense fallback={<div className="text-center text-body-sm text-on-surface-variant py-8">Loading...</div>}>
        <ResetPasswordForm />
      </Suspense>
    </AuthLayout>
  );
}
