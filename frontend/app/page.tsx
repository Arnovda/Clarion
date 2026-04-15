'use client';

import { useState } from 'react';
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
      if (payload?.role === 'viewer') {
        // Viewers land on dashboards — their primary consumption surface
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
        // Analysts land on query
        router.push('/query');
      }
    } catch {
      setError('Invalid email or password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface">
      {/* Background tonal shift */}
      <div className="absolute inset-0 bg-gradient-to-br from-surface via-surface-container-low to-surface-container opacity-80" />

      <div className="relative w-full max-w-sm z-10">
        {/* Logo + tagline */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center">
              <span className="text-white font-headline font-bold text-lg">D</span>
            </div>
            <span className="font-headline text-headline-md font-bold text-on-surface">DataBridge</span>
          </div>
          <p className="text-body-md text-on-surface-variant">AI-powered data intelligence</p>
        </div>

        {/* Login form — tonal card (no border, color shift) */}
        <form
          onSubmit={handleSubmit}
          suppressHydrationWarning
          className="bg-surface-container-lowest rounded-2xl shadow-ambient p-8 space-y-5"
        >
          <div>
            <label className="block text-label-lg text-on-surface mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="
                w-full px-3.5 py-2.5 rounded-xl text-body-md
                bg-surface-container-low text-on-surface
                placeholder:text-on-surface-variant/40
                border-b-2 border-transparent
                focus:border-primary focus:outline-none
                transition-colors
              "
              required
            />
          </div>

          <div>
            <label className="block text-label-lg text-on-surface mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="
                w-full px-3.5 py-2.5 rounded-xl text-body-md
                bg-surface-container-low text-on-surface
                border-b-2 border-transparent
                focus:border-primary focus:outline-none
                transition-colors
              "
              required
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-error-container/30 text-error text-body-sm">
              <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="
              w-full py-3 rounded-xl text-title-md
              gradient-primary text-on-primary
              hover:opacity-90 disabled:opacity-50
              transition-all duration-200
              shadow-glow-primary hover:shadow-ambient
            "
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing in...
              </span>
            ) : (
              'Sign in'
            )}
          </button>

          <div className="flex items-center justify-between pt-2">
            <Link href="/forgot-password" className="text-label-md text-on-surface-variant hover:text-secondary transition-colors">
              Forgot password?
            </Link>
            <Link href="/register" className="text-label-md text-secondary font-semibold hover:text-primary transition-colors">
              Create account
            </Link>
          </div>
        </form>

        {/* Footer */}
        <p className="text-center text-label-sm text-on-surface-variant/40 mt-8">
          Powered by Claude AI
        </p>
      </div>
    </div>
  );
}
