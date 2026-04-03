'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setToken, getTokenPayload } from '@/lib/auth';

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
      if (payload?.role === 'admin') {
        // Go to setup only if no connection exists yet; otherwise go to dashboards
        try {
          const connRes = await api.get('/connections');
          const hasConnections = (connRes.data.data?.length ?? 0) > 0;
          router.push(hasConnections ? '/dashboards' : '/setup');
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
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <Image src="/logo.svg" alt="DataBridge" width={180} height={40} priority className="mx-auto" />
          <p className="text-slate-500 mt-2 text-sm">AI-powered data platform</p>
        </div>

        <form onSubmit={handleSubmit} suppressHydrationWarning className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>

          <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
            <Link href="/forgot-password" className="hover:text-blue-600 transition-colors">
              Forgot password?
            </Link>
            <Link href="/register" className="hover:text-blue-600 transition-colors">
              Create account
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
