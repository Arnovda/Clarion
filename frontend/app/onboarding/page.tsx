'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

/* ──────────────────────────────────────────────────────────────
 * Onboarding — 5-step full-page wizard
 * Route: /onboarding
 * Presentation-layer only: local state, no API calls.
 * Finish → /query (the Ask screen)
 * ────────────────────────────────────────────────────────────── */

type StepId = 1 | 2 | 3 | 4 | 5;

const STEP_LABELS: Record<StepId, string> = {
  1: 'Connect',
  2: 'Permissions',
  3: 'Profile',
  4: 'First question',
  5: 'Invite team',
};

/* ── Observatory mark (shared) ─────────────────────────────── */

function ObservatoryMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="8"  stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="3"  fill="currentColor" />
    </svg>
  );
}

/* ── Page ──────────────────────────────────────────────────── */

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep]               = useState<StepId>(1);
  const [sources, setSources]         = useState<Set<string>>(new Set());
  const [consent, setConsent]         = useState(false);
  const [question, setQuestion]       = useState('');
  const [invites, setInvites]         = useState<Array<{ email: string; role: string }>>([
    { email: '', role: 'analyst' },
  ]);

  // Step 3 — simulated table-scan progress
  const TABLES = [
    { name: 'fact_sales',    desc: 'Transactional sales by order line · 1.25M rows' },
    { name: 'dim_customer',  desc: 'One row per customer, all channels · 84K rows' },
    { name: 'dim_product',   desc: 'Product catalog with category hierarchy · 12.8K rows' },
    { name: 'dim_region',    desc: 'Analyzing column semantics…' },
    { name: 'dim_date',      desc: 'Queued' },
    { name: 'dim_employee',  desc: 'Queued' },
  ];
  const [scanIndex, setScanIndex] = useState(0);

  useEffect(() => {
    if (step !== 3) return;
    setScanIndex(0);
    const iv = setInterval(() => {
      setScanIndex((i) => Math.min(i + 1, TABLES.length - 1));
    }, 900);
    return () => clearInterval(iv);
  }, [step]);

  /* ── Gate conditions for Continue button ───────────────────── */
  const canContinue =
    step === 1 ? sources.size > 0
    : step === 2 ? consent
    : step === 3 ? true
    : step === 4 ? question.trim().length > 0
    : step === 5 ? true
    : false;

  function goBack() {
    if (step === 1) return;
    setStep((s) => (s - 1) as StepId);
  }

  function goNext() {
    if (!canContinue) return;
    if (step === 5) { finish(); return; }
    setStep((s) => (s + 1) as StepId);
  }

  function finish() {
    router.push('/query');
  }

  function skip() {
    router.push('/query');
  }

  function askAndFinish() {
    if (!question.trim()) return;
    router.push(`/query?q=${encodeURIComponent(question)}`);
  }

  /* ── Render ────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-bg pt-10 pb-16 px-4">
      <div className="max-w-[920px] mx-auto bg-raised border border-line rounded-lg shadow-2 overflow-hidden">

        {/* Header: wordmark + progress + step n/5 */}
        <div className="flex items-center gap-6 px-9 py-[22px] border-b border-line">
          <div className="flex items-center gap-2.5 font-display font-medium text-[18px] text-ink leading-none">
            <ObservatoryMark size={20} className="text-ocean" />
            DataBridge
          </div>
          <div className="flex-1 flex gap-1.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <div
                key={n}
                className={cn(
                  'flex-1 h-[3px] rounded-[2px]',
                  n < step ? 'bg-ocean' : n === step ? 'bg-ocean' : 'bg-soft'
                )}
              />
            ))}
          </div>
          <div className="font-mono text-[10.5px] tracking-[0.1em] text-muted uppercase whitespace-nowrap">
            Step {step} / 5
          </div>
        </div>

        {/* Body */}
        <div className="px-14 py-12 min-h-[440px]">
          {step === 1 && <Step1Connect sources={sources} setSources={setSources} />}
          {step === 2 && <Step2Permissions consent={consent} setConsent={setConsent} />}
          {step === 3 && <Step3Profile tables={TABLES} scanIndex={scanIndex} />}
          {step === 4 && (
            <Step4Question
              value={question}
              onChange={setQuestion}
              onSubmit={askAndFinish}
            />
          )}
          {step === 5 && <Step5Invite invites={invites} setInvites={setInvites} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-9 py-[18px] border-t border-line bg-surface">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1}
            className={cn(
              'text-[13px] transition-colors duration-1',
              step === 1
                ? 'text-muted-2 cursor-not-allowed opacity-50'
                : 'text-muted hover:text-ink'
            )}
          >
            ← Back
          </button>
          <div className="flex items-center gap-4">
            {step >= 3 && (
              <span className="hidden md:inline font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
                You can skip — we&rsquo;ll finish in the background
              </span>
            )}
            {step >= 3 && step < 5 && (
              <Button variant="secondary" size="sm" onClick={skip}>
                Skip to workspace
              </Button>
            )}
            <Button variant="primary" size="md" onClick={goNext} disabled={!canContinue}>
              {step === 5 ? 'Finish setup' : 'Continue →'}
            </Button>
          </div>
        </div>
      </div>

      {/* Journey map below the card */}
      <div className="max-w-[920px] mx-auto mt-5 flex justify-center flex-wrap gap-x-9 gap-y-2 font-mono text-[10.5px] tracking-[0.08em] uppercase text-muted">
        {([1, 2, 3, 4, 5] as StepId[]).map((n) => (
          <span
            key={n}
            className={cn(
              'flex items-center gap-2',
              n === step ? 'text-ocean' : n < step ? 'text-ink-3' : 'text-muted-2'
            )}
          >
            <span className="tabular-nums">{n}</span>
            <span>·</span>
            <span>{STEP_LABELS[n]}</span>
          </span>
        ))}
      </div>

      <div className="max-w-[920px] mx-auto mt-8 text-center">
        <Link
          href="/"
          className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted-2 hover:text-ink transition-colors duration-1"
        >
          ← Sign out & come back later
        </Link>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Step 1 — Connect
 * ═══════════════════════════════════════════════════════════════ */

const SOURCE_OPTIONS = [
  { id: 'postgres',   name: 'Postgres',   abbr: 'P',  desc: 'PostgreSQL · any version 12+' },
  { id: 'mysql',      name: 'MySQL',      abbr: 'MY', desc: 'MySQL / MariaDB database' },
  { id: 'snowflake',  name: 'Snowflake',  abbr: 'SN', desc: 'Cloud data warehouse' },
  { id: 'bigquery',   name: 'BigQuery',   abbr: 'BQ', desc: 'Google Cloud warehouse' },
  { id: 'redshift',   name: 'Redshift',   abbr: 'RS', desc: 'AWS warehouse' },
  { id: 'csv',        name: 'CSV upload', abbr: 'CSV', desc: 'Flat file upload' },
];

function Step1Connect({
  sources,
  setSources,
}: {
  sources: Set<string>;
  setSources: (s: Set<string>) => void;
}) {
  function toggle(id: string) {
    const next = new Set(sources);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSources(next);
  }

  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ocean font-medium mb-3.5">
        Connect
      </div>
      <h2 className="font-display font-medium text-[36px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        <em>Where does your data live?</em>
      </h2>
      <p className="text-[15px] text-muted max-w-[540px] leading-[1.55] m-0 mb-8">
        Pick the warehouse or database DataBridge should connect to. You can add more later.
      </p>

      <div className="grid grid-cols-3 gap-3">
        {SOURCE_OPTIONS.map((s) => {
          const on = sources.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              aria-pressed={on}
              className={cn(
                'text-left p-4 rounded-sm border transition-all duration-1 ease-observatory bg-raised',
                'focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]',
                on
                  ? 'border-ocean bg-ocean-softer shadow-[0_0_0_3px_var(--ocean-soft)]'
                  : 'border-line hover:border-line-strong hover:bg-softer'
              )}
            >
              <div
                className={cn(
                  'w-8 h-8 rounded-sm flex items-center justify-center font-mono text-[13px] font-semibold mb-3',
                  on ? 'bg-ocean text-white' : 'bg-softer text-ink'
                )}
              >
                {s.abbr}
              </div>
              <div className={cn('font-mono text-[12.5px] font-medium mb-0.5', on ? 'text-ocean' : 'text-ink')}>
                {s.name}
              </div>
              <div className="text-[11.5px] text-muted tracking-[0.02em]">{s.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Step 2 — Permissions
 * ═══════════════════════════════════════════════════════════════ */

function Step2Permissions({
  consent,
  setConsent,
}: {
  consent: boolean;
  setConsent: (v: boolean) => void;
}) {
  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ocean font-medium mb-3.5">
        Permissions
      </div>
      <h2 className="font-display font-medium text-[36px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        <em>What DataBridge can do.</em>
      </h2>
      <p className="text-[15px] text-muted max-w-[540px] leading-[1.55] m-0 mb-8">
        Read-only by default. You stay in control.
      </p>

      <div className="grid grid-cols-2 gap-4 mb-8">
        <div className="border border-line rounded-md p-5 bg-raised">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-ok font-medium mb-3">
            ✓ We can
          </div>
          <ul className="space-y-2.5 text-[13.5px] text-ink-2 list-none p-0 m-0">
            <li>Read schema metadata (tables, columns, keys)</li>
            <li>Sample rows to learn column meaning</li>
            <li>Execute read-only SELECT queries you approve</li>
            <li>Profile data quality (null %, distinct %, ranges)</li>
          </ul>
        </div>

        <div className="border border-line rounded-md p-5 bg-raised">
          <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-err font-medium mb-3">
            ✗ We won&rsquo;t
          </div>
          <ul className="space-y-2.5 text-[13.5px] text-ink-2 list-none p-0 m-0">
            <li>Modify, insert, update, or delete any data</li>
            <li>Drop or alter tables, views, or schemas</li>
            <li>Share data outside your workspace</li>
            <li>Train models on your data without consent</li>
          </ul>
        </div>
      </div>

      <label className="flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded-xs border border-line-strong accent-ocean cursor-pointer"
        />
        <span className="text-[13.5px] text-ink-2 leading-[1.55]">
          I confirm DataBridge may connect to the source(s) selected above with read-only access,
          and that I have the authority to grant this on behalf of my organization.
        </span>
      </label>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Step 3 — Profile (animated scan)
 * ═══════════════════════════════════════════════════════════════ */

function Tick({ state }: { state: 'done' | 'loading' | 'pending' }) {
  if (state === 'done') {
    return (
      <span className="w-3.5 h-3.5 rounded-full bg-ok-soft text-ok flex items-center justify-center shrink-0">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (state === 'loading') {
    return (
      <span className="w-3.5 h-3.5 rounded-full bg-ocean-softer text-ocean flex items-center justify-center shrink-0">
        <svg className="animate-spin" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="8 20" transform="rotate(-90 5 5)" />
        </svg>
      </span>
    );
  }
  return (
    <span className="w-3.5 h-3.5 rounded-full bg-soft text-muted flex items-center justify-center shrink-0 text-[9px] font-mono">
      ·
    </span>
  );
}

function Step3Profile({
  tables,
  scanIndex,
}: {
  tables: Array<{ name: string; desc: string }>;
  scanIndex: number;
}) {
  const elapsed = scanIndex * 6;
  const left = Math.max(0, (tables.length - 1 - scanIndex) * 6 + 12);
  const mm = (v: number) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;

  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ocean font-medium mb-3.5">
        Profiling
      </div>
      <h2 className="font-display font-medium text-[36px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        <em>Reading your data.</em>
      </h2>
      <p className="text-[15px] text-muted max-w-[540px] leading-[1.55] m-0 mb-8">
        We&rsquo;re scanning your source to learn its shape — tables, relationships, and what each column likely means. This takes about two minutes.
      </p>

      <div className="bg-surface border border-line rounded-md p-7">
        <div className="flex items-center gap-3 mb-4">
          <span
            className="w-2 h-2 rounded-full bg-ok"
            style={{ animation: 'pulse 2s infinite' }}
            aria-hidden="true"
          />
          <span className="font-display text-[17px] tracking-[-0.01em] text-ink">wholesale-erp-prod</span>
          <Badge variant="ai" dot>Claude · {Math.min(100, 20 + scanIndex * 13)}%</Badge>
          <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">
            {mm(elapsed)} elapsed · {mm(left)} left
          </span>
        </div>

        <ul className="flex flex-col gap-0 text-[13.5px] text-ink-2 list-none p-0 m-0">
          {tables.map((t, i) => {
            const state: 'done' | 'loading' | 'pending' =
              i < scanIndex ? 'done' : i === scanIndex ? 'loading' : 'pending';
            return (
              <li
                key={t.name}
                className="flex gap-3 items-center py-2 border-b border-softer last:border-b-0"
              >
                <Tick state={state} />
                <span className="font-mono text-[12px] text-ink shrink-0 min-w-[170px]">{t.name}</span>
                <span
                  className={cn(
                    'font-display text-[14px]',
                    state === 'pending' ? 'italic text-muted-2' : 'text-ink-2'
                  )}
                >
                  {state === 'done'
                    ? t.desc.includes('rows') ? t.desc : 'Ready.'
                    : state === 'loading' ? 'Analyzing column semantics…'
                    : 'Queued'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <style jsx>{`
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
      `}</style>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Step 4 — First question
 * ═══════════════════════════════════════════════════════════════ */

const SUGGESTIONS = [
  "What's our biggest customer?",
  'Revenue by channel last quarter',
  'Which products are growing?',
];

function Step4Question({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ocean font-medium mb-3.5">
        First question
      </div>
      <h2 className="font-display font-medium text-[36px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        <em>Ask something.</em>
      </h2>
      <p className="text-[15px] text-muted max-w-[540px] leading-[1.55] m-0 mb-8">
        Type a question in plain language. No SQL. Claude will find the answer in what you just connected.
      </p>

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit();
        }}
        rows={2}
        placeholder="e.g. What drove revenue growth last quarter?"
        className={cn(
          'w-full font-display italic text-[20px] leading-[1.4] text-ink',
          'px-5 py-4 rounded-md border border-line bg-raised',
          'outline-none transition-all duration-1 ease-observatory resize-none',
          'placeholder:text-muted-2',
          'focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)]'
        )}
      />

      <div className="mt-5 flex flex-wrap gap-2">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onChange(q)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-sm border border-line bg-raised text-[13px] text-ink-2 hover:border-line-strong hover:bg-softer transition-colors duration-1 ease-observatory"
          >
            {q}
          </button>
        ))}
      </div>

      <div className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2">
        ⌘ + Enter to send now — or Continue to finish onboarding and ask later
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
 *  Step 5 — Invite team
 * ═══════════════════════════════════════════════════════════════ */

function Step5Invite({
  invites,
  setInvites,
}: {
  invites: Array<{ email: string; role: string }>;
  setInvites: (v: Array<{ email: string; role: string }>) => void;
}) {
  function updateRow(i: number, patch: Partial<{ email: string; role: string }>) {
    setInvites(invites.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setInvites([...invites, { email: '', role: 'analyst' }]);
  }
  function removeRow(i: number) {
    if (invites.length === 1) return;
    setInvites(invites.filter((_, idx) => idx !== i));
  }

  return (
    <div>
      <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-ocean font-medium mb-3.5">
        Invite team
      </div>
      <h2 className="font-display font-medium text-[36px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        <em>Bring people in.</em>
      </h2>
      <p className="text-[15px] text-muted max-w-[540px] leading-[1.55] m-0 mb-8">
        Optional. Analysts build dashboards and ask questions. Viewers consume. Admins manage sources.
      </p>

      <div className="flex flex-col gap-3">
        {invites.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_180px_auto] gap-3 items-end">
            <Input
              label={i === 0 ? 'Work email' : undefined}
              type="email"
              placeholder="colleague@company.com"
              value={row.email}
              onChange={(e) => updateRow(i, { email: e.target.value })}
            />
            <Select
              label={i === 0 ? 'Role' : undefined}
              value={row.role}
              onChange={(e) => updateRow(i, { role: e.target.value })}
            >
              <option value="admin">Admin</option>
              <option value="analyst">Analyst</option>
              <option value="viewer">Viewer</option>
            </Select>
            <button
              type="button"
              onClick={() => removeRow(i)}
              disabled={invites.length === 1}
              aria-label="Remove row"
              className={cn(
                'h-[42px] w-[42px] flex items-center justify-center rounded-sm',
                'text-muted-2 hover:text-err hover:bg-err-soft/50 transition-colors duration-1',
                invites.length === 1 && 'opacity-30 cursor-not-allowed'
              )}
            >
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={addRow}
          className="self-start font-mono text-[10.5px] uppercase tracking-[0.08em] text-ocean hover:text-ocean-hover transition-colors duration-1 mt-1"
        >
          + Add another
        </button>
      </div>

      <div className="mt-6 font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted-2">
        You can always invite more people from the Team page.
      </div>
    </div>
  );
}
