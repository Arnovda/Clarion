'use client';

/**
 * The acceptance gate (P0-7): once the legal documents are in force, a
 * signed-in user who has not accepted the CURRENT versions sees this dialog
 * on every screen and nothing else until they do — an existing customer on
 * their next visit, everyone again after a version bump.
 *
 * Mounted by TopBar so BOTH copies of the chrome carry it (the
 * FeaturesProvider lesson). While LEGAL_IN_FORCE is false it renders
 * nothing and fetches nothing — the flag is compiled in, so the draft state
 * costs no request. Cannot be dismissed: no close button, no overlay click,
 * no Escape — the only ways out are agreeing or signing out.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '@/lib/api';
import { clearToken } from '@/lib/auth';
import { LEGAL_IN_FORCE } from '@/lib/legal/versions';

interface LegalStatus {
  inForce: boolean;
  acceptanceRequired: boolean;
  accepted: { terms: string; privacy: string; dpa: string } | null;
  versions: { terms: string; privacy: string; dpa: string };
}

export default function LegalAcceptanceGate() {
  const [status, setStatus] = useState<LegalStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!LEGAL_IN_FORCE) return;
    let cancelled = false;
    api.get('/legal/status')
      .then((res) => { if (!cancelled) setStatus(res.data?.data ?? null); })
      .catch(() => { /* the shell must never depend on this */ });
    return () => { cancelled = true; };
  }, []);

  if (!LEGAL_IN_FORCE || !status?.acceptanceRequired || typeof window === 'undefined') return null;

  const isUpdate = !!status.accepted;

  async function accept() {
    setBusy(true); setError('');
    try {
      const res = await api.post('/legal/accept', { acceptTerms: true });
      setStatus(res.data?.data ?? { ...status!, acceptanceRequired: false });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Could not record your acceptance. Please try again.');
    } finally { setBusy(false); }
  }

  function signOut() {
    clearToken();
    window.location.href = '/';
  }

  return createPortal(
    <div className="fixed inset-0 bg-ink/50 backdrop-blur-[2px] z-[60] flex items-start justify-center overflow-y-auto">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-gate-title"
        className="bg-raised rounded-lg shadow-3 max-w-[520px] w-[calc(100%-32px)] mt-[12vh] mb-10 overflow-hidden"
      >
        <div className="px-7 py-5 border-b border-softer">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1">
            {isUpdate ? 'Updated terms' : 'Before you continue'}
          </div>
          <h2 id="legal-gate-title" className="font-display text-[22px] text-ink leading-tight tracking-[-0.01em]">
            {isUpdate ? 'Our terms have changed.' : 'Please accept our terms.'}
          </h2>
        </div>
        <div className="px-7 py-5 space-y-4 text-[13.5px] text-ink-2 leading-relaxed">
          <p>
            {isUpdate
              ? 'A new version of the documents that govern your workspace is in force. Please read them and accept to keep using Clarion.'
              : 'Your workspace is governed by the documents below. Please read them and accept to continue.'}
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><a href="/legal/terms" target="_blank" rel="noreferrer" className="text-ocean hover:text-ocean-hover">Terms of Service</a> <span className="text-muted font-mono text-[11px]">v{status.versions.terms}</span></li>
            <li><a href="/legal/privacy" target="_blank" rel="noreferrer" className="text-ocean hover:text-ocean-hover">Privacy Policy</a> <span className="text-muted font-mono text-[11px]">v{status.versions.privacy}</span></li>
            <li><a href="/legal/dpa" target="_blank" rel="noreferrer" className="text-ocean hover:text-ocean-hover">Data Processing Agreement</a> <span className="text-muted font-mono text-[11px]">v{status.versions.dpa}</span></li>
          </ul>
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 accent-ocean"
              disabled={busy}
            />
            <span>I have read and accept the Terms of Service, the Privacy Policy and the Data Processing Agreement on behalf of my organisation.</span>
          </label>
          {error && <div className="font-mono text-[10.5px] text-err uppercase tracking-[0.04em]">{error}</div>}
        </div>
        <div className="px-7 py-4 border-t border-softer flex items-center justify-between gap-3">
          <button type="button" onClick={signOut} className="text-[12.5px] text-muted hover:text-ink" disabled={busy}>
            Sign out instead
          </button>
          <button
            type="button"
            onClick={accept}
            disabled={!checked || busy}
            className="px-4 py-2 rounded-md bg-ocean text-white text-[13px] font-medium disabled:opacity-50 hover:bg-ocean-hover transition-colors"
          >
            {busy ? 'Recording…' : 'Accept and continue'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
