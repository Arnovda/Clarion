'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setToken } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';

const inputCls = "w-full px-3.5 py-2.5 rounded-xl text-body-md bg-surface-container-low text-on-surface placeholder:text-on-surface-variant/40 border-b-2 border-transparent focus:border-primary focus:outline-none transition-colors";

export default function RegisterPage() {
  const router = useRouter();
  const [companyName, setCompanyName]   = useState('');
  const [displayName, setDisplayName]   = useState('');
  const [email, setEmail]               = useState('');
  const [password, setPassword]         = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError]               = useState('');
  const [loading, setLoading]           = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }

    setLoading(true);
    try {
      const res = await api.post('/auth/register', { companyName, email, password, displayName });
      setToken(res.data.data.token);
      router.push('/setup');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout subtitle="Create your account">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-label-lg text-on-surface mb-1.5">Company name</label>
          <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
            placeholder="Acme BV" className={inputCls} required />
        </div>
        <div>
          <label className="block text-label-lg text-on-surface mb-1.5">Your name</label>
          <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jan Janssens" className={inputCls} required />
        </div>
        <div>
          <label className="block text-label-lg text-on-surface mb-1.5">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com" className={inputCls} required />
        </div>
        <div>
          <label className="block text-label-lg text-on-surface mb-1.5">Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="Minimum 8 characters" className={inputCls} required />
        </div>
        <div>
          <label className="block text-label-lg text-on-surface mb-1.5">Confirm password</label>
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
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              Creating account...
            </span>
          ) : 'Create account'}
        </button>

        <p className="text-center text-label-md text-on-surface-variant pt-1">
          Already have an account?{' '}
          <Link href="/" className="text-secondary font-semibold hover:text-primary transition-colors">Sign in</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
