'use client';

import { ReactNode } from 'react';

function ObservatoryArt() {
  return (
    <svg viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full" aria-hidden="true">
      <defs>
        <radialGradient id="auth-glow" cx="50%" cy="42%" r="55%">
          <stop offset="0%"   stopColor="#164e63" stopOpacity="0.6" />
          <stop offset="45%"  stopColor="#164e63" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#0f1a22" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="auth-amb" cx="50%" cy="50%" r="50%">
          <stop offset="0%"   stopColor="#c08a5e" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#0f1a22" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect width="600" height="800" fill="#0f1a22" />
      <circle cx="300" cy="340" r="420" fill="url(#auth-glow)" />
      <circle cx="300" cy="340" r="240" fill="url(#auth-amb)" />

      {/* Concentric observatory rings */}
      <g transform="translate(300 340)" fill="none" stroke="#d0e1e6" strokeOpacity="0.28" strokeWidth="0.6">
        <circle r="40" /><circle r="80" /><circle r="130" />
        <circle r="190" /><circle r="260" /><circle r="340" />
      </g>

      {/* Axis lines */}
      <g transform="translate(300 340)" stroke="#d0e1e6" strokeOpacity="0.14" strokeWidth="0.5">
        <line x1="-340" y1="0" x2="340" y2="0" />
        <line x1="0" y1="-340" x2="0" y2="340" />
        <line x1="-280" y1="-160" x2="280" y2="160" />
        <line x1="-280" y1="160" x2="280" y2="-160" />
      </g>

      {/* Tick marks on main axes */}
      <g transform="translate(300 340)" stroke="#d0e1e6" strokeOpacity="0.35" strokeWidth="0.8">
        <g>
          <line x1="40"  y1="-3" x2="40"  y2="3" /><line x1="80"  y1="-3" x2="80"  y2="3" />
          <line x1="130" y1="-3" x2="130" y2="3" /><line x1="190" y1="-3" x2="190" y2="3" />
          <line x1="260" y1="-3" x2="260" y2="3" />
        </g>
        <g>
          <line x1="-40"  y1="-3" x2="-40"  y2="3" /><line x1="-80"  y1="-3" x2="-80"  y2="3" />
          <line x1="-130" y1="-3" x2="-130" y2="3" /><line x1="-190" y1="-3" x2="-190" y2="3" />
          <line x1="-260" y1="-3" x2="-260" y2="3" />
        </g>
      </g>

      {/* Orbit points (data) */}
      <g transform="translate(300 340)" fill="#c08a5e">
        <circle cx="112"  cy="-56"  r="2"   />
        <circle cx="-92"  cy="80"   r="2.5" />
        <circle cx="175"  cy="95"   r="2"   />
        <circle cx="-210" cy="-42"  r="2"   />
        <circle cx="50"   cy="-180" r="2.5" />
        <circle cx="-140" cy="-180" r="2"   />
        <circle cx="230"  cy="-80"  r="2"   />
      </g>

      {/* Central mark */}
      <g transform="translate(300 340)">
        <circle r="18" fill="none" stroke="#d0e1e6" strokeWidth="1.2" />
        <circle r="6" fill="#d0e1e6" />
      </g>

      {/* Faint curves */}
      <g transform="translate(300 340)" fill="none" stroke="#c08a5e" strokeOpacity="0.25" strokeWidth="0.8">
        <path d="M-340,60 Q-100,-40 100,-10 T340,-80" />
        <path d="M-340,140 Q-50,60 140,90 T340,40" />
      </g>
    </svg>
  );
}

function ObservatoryMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="8"  stroke="currentColor" strokeWidth="1.2" />
      <circle cx="16" cy="16" r="3"  fill="currentColor" />
    </svg>
  );
}

export interface AuthLayoutProps {
  /** Mono eyebrow above the title, e.g. "SIGN IN" */
  eyebrow: string;
  /** Serif H2. Pass JSX with <em> for italic accents. */
  title: ReactNode;
  /** Short supporting copy under the title. */
  lede?: ReactNode;
  /** Form children. */
  children: ReactNode;
  /** Optional meta row below the CTA (e.g. "New to Clarion? Request an invite →"). */
  footer?: ReactNode;
}

export default function AuthLayout({ eyebrow, title, lede, children, footer }: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4 md:p-10">
      <div className="w-full max-w-[1280px] grid md:grid-cols-[1.1fr_1fr] bg-raised border border-line rounded-lg shadow-2 overflow-hidden">
        {/* Art */}
        <div className="relative bg-[#0f1a22] min-h-[40vh] md:min-h-[600px]">
          <ObservatoryArt />
          <div className="relative h-full p-8 md:p-11 flex flex-col justify-between text-[#e3e6ea]">
            <div className="flex items-center gap-2.5 font-display font-medium text-[22px] tracking-[-0.02em] text-white">
              <ObservatoryMark size={26} className="text-ocean-soft" />
              Clarion
            </div>

            <blockquote className="font-display italic text-[22px] md:text-[26px] leading-[1.35] tracking-[-0.01em] text-[#e3e6ea] max-w-[440px] m-0">
              <span className="block font-mono not-italic font-medium text-[11px] tracking-[0.14em] uppercase text-white mb-3.5">
                Observatory · Est. 2025
              </span>
              The quiet place from which you see your company&rsquo;s data in full — and act on what you see.
            </blockquote>

            <div className="font-mono text-[10.5px] tracking-[0.08em] uppercase text-[#8891a0]">
              SOC 2 Type II · EU-hosted · AES-256
            </div>
          </div>
        </div>

        {/* Form */}
        <div className="px-8 py-12 md:px-16 md:py-14 flex flex-col justify-center min-h-[480px] md:min-h-[600px]">
          <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted font-medium mb-[18px]">
            {eyebrow}
          </div>
          <h2 className="font-display font-medium text-[38px] leading-[1.1] tracking-[-0.025em] text-ink m-0 mb-2.5 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
            {title}
          </h2>
          {lede && (
            <p className="text-[14.5px] text-muted max-w-[360px] leading-[1.55] m-0 mb-9">
              {lede}
            </p>
          )}
          {children}
          {footer && (
            <div className="mt-9 pt-5 border-t border-softer text-[13px] text-muted">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
