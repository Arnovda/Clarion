'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setToken, getTokenPayload } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      setToken(res.data.data.token);
      const payload = getTokenPayload();
      if (payload?.role === 'viewer') {
        router.push('/dashboards');
      } else if (payload?.role === 'admin') {
        try {
          const connRes = await api.get('/connections');
          const hasConnections = (connRes.data.data?.length ?? 0) > 0;
          router.push(hasConnections ? '/query' : '/setup');
        } catch {
          router.push('/setup');
        }
      } else {
        router.push('/query');
      }
    } catch {
      setError('Invalid email or password.');
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
          New to DataBridge?{' '}
          <Link
            href="/register"
            className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
          >
            Request an invite →
          </Link>
        </>
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
    </AuthLayout>
  );
}
