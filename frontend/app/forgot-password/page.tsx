'use client';

import { useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import AuthLayout from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

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

  if (sent) {
    return (
      <AuthLayout
        eyebrow="Check your email"
        title={<em>We sent a link.</em>}
        lede={
          <>
            If an account exists for <b className="text-ink-2">{email}</b>, you&rsquo;ll find a reset link in your inbox shortly.
          </>
        }
        footer={
          <Link
            href="/"
            className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
          >
            ← Back to sign in
          </Link>
        }
      >
        <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">
          Didn&rsquo;t arrive? Check spam, or{' '}
          <button
            type="button"
            onClick={() => setSent(false)}
            className="text-ocean hover:text-ocean-hover tracking-[0.08em] transition-colors duration-1"
          >
            try a different email
          </button>
          .
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Forgot password"
      title={<em>Start a reset.</em>}
      lede="Enter the email on your account. We'll send a link to set a new password."
      footer={
        <Link
          href="/"
          className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
        >
          ← Back to sign in
        </Link>
      }
    >
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

        {error && (
          <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
            {error}
          </div>
        )}

        <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}
