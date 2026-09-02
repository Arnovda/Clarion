'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import api from '@/lib/api';
import { setAuthTokens, getTokenPayload } from '@/lib/auth';
import AuthLayout from '@/components/layout/AuthLayout';
import { useT } from '@/lib/i18n';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';

export default function LoginPage() {
  const router = useRouter();
  const t = useT();
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);

  // After a successful password check, the server may demand a second
  // factor. We can have TOTP, WebAuthn, or both available — the user
  // picks. preferredMethod tracks the active panel.
  const [mfaChallenge, setMfaChallenge] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [webauthnOptions, setWebauthnOptions] = useState<unknown>(null);
  const [webauthnChallenge, setWebauthnChallenge] = useState<string | null>(null);
  const [preferredMethod, setPreferredMethod] = useState<'totp' | 'webauthn'>('totp');

  // The server refuses login with code `email_unverified` until the
  // registration email is confirmed — offer a resend instead of the
  // generic wrong-password message.
  const [unverified, setUnverified] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');

  async function resendVerification() {
    if (!email || resendState === 'sending') return;
    setResendState('sending');
    try {
      await api.post('/auth/resend-verification', { email });
      setResendState('sent');
    } catch {
      setResendState('idle');
    }
  }

  async function landAfterLogin() {
    const payload = getTokenPayload();
    // Send admins-with-no-connections to /sources so they can connect
    // their first source — Home is empty without one. Everyone else
    // lands on /home, the daily-driver page (data health + alerts +
    // pinned dashboards + recent questions).
    if (payload?.role === 'admin') {
      try {
        const connRes = await api.get('/connections');
        const hasConnections = (connRes.data.data?.length ?? 0) > 0;
        router.push(hasConnections ? '/home' : '/sources');
      } catch {
        router.push('/home');
      }
    } else {
      router.push('/home');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setUnverified(false);
    setResendState('idle');
    setLoading(true);
    try {
      const res = await api.post('/auth/login', { email, password });
      const data = res.data?.data ?? {};
      // 2FA gate — server returns whichever factors the user has
      // enrolled. We default to WebAuthn when available (one tap on
      // their phone / hardware key), with TOTP as the fallback choice.
      if (data.mfaRequired || data.webauthnRequired) {
        if (data.mfaChallengeToken) setMfaChallenge(data.mfaChallengeToken);
        if (data.webauthnOptions && data.webauthnChallengeToken) {
          setWebauthnOptions(data.webauthnOptions);
          setWebauthnChallenge(data.webauthnChallengeToken);
          setPreferredMethod('webauthn');
        }
        return;
      }
      setAuthTokens(data.token, data.refreshToken);
      await landAfterLogin();
    } catch (err: unknown) {
      const body = (err as { response?: { data?: { code?: string } } })?.response?.data;
      if (body?.code === 'email_unverified') {
        // The password was right; the address just isn't confirmed yet.
        setUnverified(true);
        setError(t.login.confirmEmailFirst);
      } else {
        setError(t.login.invalidCredentials);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.post('/auth/mfa/verify', {
        mfaChallengeToken: mfaChallenge,
        code: mfaCode.trim(),
      });
      setAuthTokens(res.data.data.token, res.data.data.refreshToken);
      clearChallenge();
      await landAfterLogin();
    } catch {
      setError(t.login.invalidCode);
    } finally {
      setLoading(false);
    }
  }

  async function handleWebauthnSubmit() {
    setError('');
    setLoading(true);
    try {
      // startAuthentication takes the options object the server built
      // and presents the platform's WebAuthn picker. The user picks an
      // authenticator (hardware key, Touch ID, Windows Hello, etc.);
      // result is the assertion the server verifies.
      const assertion = await startAuthentication({
        optionsJSON: webauthnOptions as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });
      const res = await api.post('/auth/webauthn/login-verify', {
        response: assertion,
        challengeToken: webauthnChallenge,
      });
      setAuthTokens(res.data.data.token, res.data.data.refreshToken);
      clearChallenge();
      await landAfterLogin();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data?.error
        ?? (err as { message?: string })?.message
        ?? t.login.webauthnFailed;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  function clearChallenge() {
    setMfaChallenge(null);
    setMfaCode('');
    setWebauthnOptions(null);
    setWebauthnChallenge(null);
    setPreferredMethod('totp');
    setError('');
  }

  const challengeActive = mfaChallenge != null || webauthnOptions != null;

  return (
    <AuthLayout
      eyebrow={t.login.eyebrow}
      title={<em>{t.login.title}</em>}
      lede={t.login.lede}
      footer={
        <>
          {t.login.newTo}{' '}
          <Link
            href="/register"
            className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1"
          >
            {t.login.requestInvite}
          </Link>
        </>
      }
    >
      {challengeActive ? (
        // 2FA challenge. Password was correct; the user must complete a
        // second factor. We show WebAuthn first when available (one tap
        // vs. typing a 6-digit code), TOTP otherwise, and let the user
        // switch between them via the small link below.
        <div className="flex flex-col gap-4" suppressHydrationWarning>
          {preferredMethod === 'webauthn' && webauthnOptions ? (
            <>
              <div className="text-[13px] text-ink-2 leading-relaxed">
                {t.login.webauthnPrompt}
              </div>
              {error && (
                <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
                  {error}
                </div>
              )}
              <Button
                type="button"
                size="lg"
                className="w-full justify-center mt-3"
                loading={loading}
                onClick={handleWebauthnSubmit}
              >
                {loading ? t.login.waiting : t.login.useSecurityKey}
              </Button>
              {mfaChallenge && (
                <button
                  type="button"
                  onClick={() => { setPreferredMethod('totp'); setError(''); }}
                  className="text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover"
                >
                  {t.login.useTotpInstead}
                </button>
              )}
            </>
          ) : (
            <form onSubmit={handleMfaSubmit} className="flex flex-col gap-4">
              <div className="text-[13px] text-ink-2 leading-relaxed">
                {t.login.mfaPrompt}
              </div>
              <Input
                label={t.login.code}
                type="text"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                placeholder="123 456"
                autoComplete="one-time-code"
                autoFocus
                required
                disabled={loading}
              />
              {error && (
                <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
                  {error}
                </div>
              )}
              <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
                {loading ? t.login.verifying : t.login.verify}
              </Button>
              {webauthnOptions != null && (
                <button
                  type="button"
                  onClick={() => { setPreferredMethod('webauthn'); setError(''); }}
                  className="text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover"
                >
                  {t.login.useWebauthnInstead}
                </button>
              )}
            </form>
          )}
          <button
            type="button"
            onClick={clearChallenge}
            className="text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink"
          >
            {t.login.backToSignIn}
          </button>
        </div>
      ) : (
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" suppressHydrationWarning>
        <Input
          label={t.login.workEmail}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.login.emailPlaceholder}
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
              {t.login.password}
            </label>
            <Link
              href="/forgot-password"
              className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors duration-1"
            >
              {t.login.forgot}
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

        {unverified && (
          <button
            type="button"
            onClick={resendVerification}
            disabled={resendState === 'sending'}
            className="self-start text-[11px] font-mono uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover disabled:opacity-50"
          >
            {resendState === 'sent'
              ? t.login.resendSent
              : resendState === 'sending'
                ? t.login.resendSending
                : t.login.resendLink}
          </button>
        )}

        <Button type="submit" size="lg" className="w-full justify-center mt-3" loading={loading}>
          {loading ? t.login.signingIn : t.login.signIn}
        </Button>
      </form>
      )}
    </AuthLayout>
  );
}
