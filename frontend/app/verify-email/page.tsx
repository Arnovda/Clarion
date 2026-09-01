'use client';

/**
 * Landing page for the emailed verification link
 * (`/verify-email?token=…&email=…`). Posts the token once on mount and
 * reports the outcome; on an invalid/expired link it offers a resend.
 *
 * The query string is read from window.location in a mount effect rather
 * than useSearchParams — the house pattern (see dashboards' deep-link
 * restore) that avoids needing a Suspense boundary for a page whose whole
 * content depends on the params anyway.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import AuthLayout from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/Button';

type Phase = 'verifying' | 'done' | 'failed' | 'resent';

export default function VerifyEmailPage() {
  const [phase, setPhase] = useState<Phase>('verifying');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') ?? '';
    const addr = params.get('email') ?? '';
    setEmail(addr);

    if (!token || !addr) {
      setPhase('failed');
      return;
    }
    api
      .post('/auth/verify-email', { email: addr, token })
      .then(() => setPhase('done'))
      .catch(() => setPhase('failed'));
  }, []);

  async function resend() {
    if (!email) return;
    setBusy(true);
    try {
      await api.post('/auth/resend-verification', { email });
      setPhase('resent');
    } catch {
      // The endpoint is enumeration-safe and near-infallible; a network
      // failure is the only realistic cause. Stay on 'failed' so the
      // button remains available.
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="Email verification"
      title={<em>One last step.</em>}
      lede="Confirming the address that owns this workspace."
      footer={
        <>
          Already confirmed?{' '}
          <Link href="/" className="text-ocean font-medium hover:text-ocean-hover transition-colors duration-1">
            Sign in
          </Link>
        </>
      }
    >
      <div className="flex flex-col gap-4" suppressHydrationWarning>
        {phase === 'verifying' && (
          <div className="text-[13px] text-ink-2 leading-relaxed">Checking your verification link…</div>
        )}

        {phase === 'done' && (
          <>
            <div className="text-[13px] text-ink-2 leading-relaxed">
              Your email address is confirmed. Your workspace is active — sign in to get started.
            </div>
            <Link href="/">
              <Button size="lg" className="w-full justify-center mt-1">Go to sign in</Button>
            </Link>
          </>
        )}

        {phase === 'failed' && (
          <>
            <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">
              This verification link is invalid or has expired.
            </div>
            <div className="text-[13px] text-ink-2 leading-relaxed">
              Links are valid for 24 hours and only the most recent one works.
              {email ? ' We can send you a fresh one.' : ' Open the newest email we sent you, or register again.'}
            </div>
            {email && (
              <Button
                size="lg"
                className="w-full justify-center mt-1"
                loading={busy}
                onClick={resend}
              >
                {busy ? 'Sending…' : 'Send a new link'}
              </Button>
            )}
          </>
        )}

        {phase === 'resent' && (
          <div className="text-[13px] text-ink-2 leading-relaxed">
            If an unverified account exists for <span className="font-medium">{email}</span>, a new
            confirmation link is on its way. Check your inbox.
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
