'use client';

/**
 * Personal API tokens, on the profile page because they belong to a PERSON,
 * not to the company: a token acts as its owner and carries exactly their
 * role, so it sits next to their password and their sessions rather than in
 * an admin screen.
 *
 * The screen is built around one fact: the token is shown ONCE. Everything
 * else — the copy button, the plain warning, the fact that the panel stays
 * open until dismissed — exists so nobody loses it by clicking away.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { formatDate, formatRelative } from '@/lib/dates';

const inputCls =
  'w-full px-3 py-2 rounded-md text-[13px] bg-raised border border-line text-ink-2 placeholder-muted-2 ' +
  'focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30 transition-colors';

interface TokenRow {
  id: number;
  name: string;
  prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export default function ApiTokensSection() {
  const toast = useToast();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  /** The one moment the plaintext exists on this screen. */
  const [justCreated, setJustCreated] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const res = await api.get('/api-tokens');
      setTokens(res.data.data ?? []);
    } catch {
      toast.error('Could not load your tokens');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await api.post('/api-tokens', { name: name.trim() });
      setJustCreated({ name: res.data.data.name, token: res.data.data.token });
      setName('');
      setCreating(false);
      setCopied(false);
      await load();
    } catch {
      toast.error('Could not create the token');
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: number, tokenName: string) {
    try {
      await api.delete(`/api-tokens/${id}`);
      toast.success(`"${tokenName}" can no longer be used`);
      await load();
    } catch {
      toast.error('Could not revoke the token');
    }
  }

  async function copy() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.token);
      setCopied(true);
    } catch {
      // Clipboard is blocked in some embedded browsers; the token is on
      // screen and selectable, so this is a convenience, not the only route.
      toast.error('Copy it manually', { description: 'The clipboard is not available in this browser.' });
    }
  }

  return (
    <div className="bg-raised border border-line rounded-lg overflow-hidden">
      <div className="px-6 py-4 flex items-center justify-between border-b border-line">
        <div>
          <h2 className="text-[14px] font-medium text-ink">Access tokens</h2>
          <p className="text-[11.5px] text-muted-2 mt-0.5">
            For the Excel add-in and anything else that reads your data outside the browser.
            A token can do exactly what you can do — no more.
          </p>
        </div>
        <button
          onClick={() => { setCreating(!creating); setJustCreated(null); }}
          className="text-[11px] font-mono tracking-[0.08em] uppercase text-ocean hover:text-ocean-hover transition-colors shrink-0 ml-4"
        >
          {creating ? 'Cancel' : 'New token'}
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="px-6 py-5 space-y-3 border-b border-line">
          <div>
            <label className="block text-[10px] font-mono tracking-[0.12em] uppercase text-muted mb-1.5">
              What is it for?
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Excel on my laptop"
              maxLength={80}
              required
              className={inputCls}
            />
            <p className="text-[11px] text-muted-2 mt-1">
              You will see this name when deciding which token to revoke later.
            </p>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-ocean text-white rounded-md text-[13px] font-medium hover:bg-ocean-hover disabled:opacity-50 transition-colors"
          >
            {saving ? 'Creating…' : 'Create token'}
          </button>
        </form>
      )}

      {justCreated && (
        <div className="px-6 py-5 border-b border-line bg-warn-soft/40">
          <p className="text-[13px] text-ink font-medium mb-1">
            Copy this now — it will not be shown again.
          </p>
          <p className="text-[11.5px] text-muted-2 mb-3">
            Clarion stores only a fingerprint of it. If you lose it, create a new one.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-md bg-soft border border-line text-[12px] font-mono text-ink break-all select-all">
              {justCreated.token}
            </code>
            <button
              onClick={copy}
              className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-md border border-line text-[12px] text-ink-2 hover:bg-soft transition-colors"
            >
              {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setJustCreated(null)}
            className="mt-3 text-[11px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink-2"
          >
            I have saved it
          </button>
        </div>
      )}

      <div className="px-6 py-5">
        {loading ? (
          <p className="text-[13px] text-muted-2">Loading…</p>
        ) : tokens.length === 0 ? (
          <p className="text-[13px] text-muted-2">
            No tokens yet. You need one to connect the Excel add-in.
          </p>
        ) : (
          <ul className="space-y-3">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <KeyRound size={14} className="text-muted shrink-0" />
                    <span className="text-[13px] text-ink truncate">{t.name}</span>
                    <code className="text-[11px] font-mono text-muted-2">{t.prefix}…</code>
                  </div>
                  <p className="text-[11px] text-muted-2 mt-0.5 ml-[22px]">
                    {t.last_used_at ? `Last used ${formatRelative(t.last_used_at)}` : 'Never used'}
                    {t.expires_at ? ` · expires ${formatDate(t.expires_at)}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => revoke(t.id, t.name)}
                  title="Revoke this token"
                  className="shrink-0 flex items-center gap-1.5 text-[11.5px] font-mono uppercase tracking-[0.08em] text-err hover:text-err/80"
                >
                  <Trash2 size={13} />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
