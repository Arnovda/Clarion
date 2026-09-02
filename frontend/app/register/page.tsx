'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { setAuthTokens } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';
import { useT } from '@/lib/i18n';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function RegisterPage() {
  const router = useRouter();
  const t = useT();
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
    if (password !== confirmPassword) { setError(t.register.passwordsDontMatch); return; }
    if (password.length < 8)          { setError(t.register.passwordTooShort); return; }

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
      setError(msg || t.register.registrationFailed);
    } finally {
      setLoading(false);
    }
  }

  if (awaitingVerification) {
    return (
      <AuthLayout
        eyebrow={t.register.almostThere}
        title={<em>{t.register.checkInbox}</em>}
        lede={t.register.oneClickLeft}
        footer={
          <>
            {t.register.wrongAddress}{' '}
            <Link href="/register" className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1">
              {t.register.registerAgain}
            </Link>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="text-[13px] text-ink-2 leading-relaxed">
            {t.register.sentLinkBefore} <span className="font-medium">{email}</span>
            {t.register.sentLinkAfter}
          </div>
          <div className="text-[13px] text-muted leading-relaxed">
            {t.register.nothingArriving}
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow={t.register.eyebrow}
      title={<em>{t.register.title}</em>}
      lede={t.register.lede}
      footer={
        <>
          {t.register.alreadyAccount}{' '}
          <Link href="/" className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1">
            {t.register.signIn}
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" suppressHydrationWarning>
        <Input
          label={t.register.workspaceName}
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          placeholder={t.register.workspacePlaceholder}
          autoComplete="organization"
          required
          disabled={loading}
        />
        <Input
          label={t.register.yourName}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t.register.namePlaceholder}
          autoComplete="name"
          required
          disabled={loading}
        />
        <Input
          label={t.register.workEmail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.register.emailPlaceholder}
          autoComplete="email"
          required
          disabled={loading}
        />
        <Input
          label={t.register.password}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t.register.passwordPlaceholder}
          autoComplete="new-password"
          required
          disabled={loading}
        />
        <Input
          label={t.register.confirmPassword}
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
          {loading ? t.register.creatingWorkspace : t.register.createWorkspace}
        </Button>
      </form>
    </AuthLayout>
  );
}
