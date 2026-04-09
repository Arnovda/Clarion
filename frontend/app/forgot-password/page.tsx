'use client';

import { useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import AuthLayout from '@/components/layout/AuthLayout';

const inputCls = "w-full px-3.5 py-2.5 rounded-xl text-body-md bg-surface-container-low text-on-surface placeholder:text-on-surface-variant/40 border-b-2 border-transparent focus:border-primary focus:outline-none transition-colors";

export default function ForgotPasswordPage() {
  const [email, setEmail]     = useState('');
  const [sent, setSent]       = useState(false);
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout subtitle="Reset your password">
      {sent ? (
        <div className="text-center space-y-4 py-4">
          <div className="w-14 h-14 rounded-full bg-secondary-container/30 flex items-center justify-center mx-auto">
            <svg className="w-7 h-7 text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
            </svg>
          </div>
          <h2 className="font-headline text-headline-sm font-bold text-on-surface">Check your email</h2>
          <p className="text-body-md text-on-surface-variant">
            If an account exists for <strong className="text-on-surface">{email}</strong>, we sent a password reset link.
          </p>
          <Link href="/" className="inline-block mt-2 text-label-lg text-secondary font-semibold hover:text-primary transition-colors">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="block text-label-lg text-on-surface mb-1.5">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com" className={inputCls} required />
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
            {loading ? 'Sending...' : 'Send reset link'}
          </button>

          <p className="text-center text-label-md text-on-surface-variant pt-1">
            <Link href="/" className="text-secondary font-semibold hover:text-primary transition-colors">Back to sign in</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
