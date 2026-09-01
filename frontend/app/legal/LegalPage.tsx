/**
 * Shared renderer for the /legal pages (P0-4).
 *
 * The documents are plain strings with markdown-style headings in
 * lib/legal/*.ts — one source each, rendered here deterministically (no
 * markdown dependency; the grammar is four line shapes and inline bold).
 *
 * LEGAL_IN_FORCE gates the draft banner. It stays FALSE until the documents
 * have been reviewed by a lawyer (docs/legal/README.md is the checklist):
 * presenting unreviewed AI-drafted text as the binding agreement is the one
 * thing the P0-4 work was instructed never to do. Flipping it — and wiring
 * acceptance into registration — is the owner's act after that review.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

export const LEGAL_IN_FORCE = false;

const DOCS = [
  { href: '/legal/terms', label: 'Terms of Service' },
  { href: '/legal/privacy', label: 'Privacy Policy' },
  { href: '/legal/dpa', label: 'Data Processing Agreement' },
  { href: '/legal/subprocessors', label: 'Subprocessors' },
];

/** Inline pass: only **bold** is supported — the documents use nothing else. */
function inline(text: string): ReactNode[] {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-medium text-ink">{part}</strong> : part,
  );
}

function renderBody(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(
      <p key={key++} className="text-[13.5px] text-ink-2 leading-relaxed mb-4">
        {inline(paragraph.join(' '))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(
      <ul key={key++} className="list-disc pl-5 mb-4 space-y-1.5">
        {list.map((item, i) => (
          <li key={i} className="text-[13.5px] text-ink-2 leading-relaxed">{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (line.startsWith('# ')) {
      flushParagraph(); flushList();
      out.push(
        <h1 key={key++} className="font-display text-[26px] font-medium tracking-[-0.02em] text-ink mb-2">
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith('## ')) {
      flushParagraph(); flushList();
      out.push(
        <h2 key={key++} className="font-display text-[17px] font-medium tracking-[-0.01em] text-ink mt-8 mb-2.5">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('- ')) {
      flushParagraph();
      list.push(line.slice(2));
    } else if (line.startsWith('*') && line.endsWith('*') && !line.startsWith('**')) {
      flushParagraph(); flushList();
      out.push(
        <p key={key++} className="text-[12.5px] italic text-muted mb-6">{line.slice(1, -1)}</p>,
      );
    } else if (line === '') {
      flushParagraph(); flushList();
    } else if (list.length > 0) {
      // continuation of a wrapped list item
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph(); flushList();
  return out;
}

export default function LegalPage({ body, current }: { body: string; current: string }) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="max-w-[760px] mx-auto px-5 py-10 md:py-14">
        <div className="flex items-center justify-between mb-8">
          <Link href="/" className="font-display font-medium text-[17px] tracking-[-0.02em] text-ink no-underline">
            Clarion
          </Link>
          <nav className="flex gap-4">
            {DOCS.map((d) => (
              <Link
                key={d.href}
                href={d.href}
                className={`text-[12px] no-underline ${d.href === current ? 'text-ink font-medium' : 'text-muted hover:text-ink-2'}`}
              >
                {d.label}
              </Link>
            ))}
          </nav>
        </div>

        {!LEGAL_IN_FORCE && (
          <div className="border border-line bg-warn-soft rounded-md px-4 py-3 mb-8">
            <div className="font-mono text-[10.5px] tracking-[0.12em] uppercase text-warn mb-1">
              Draft — not yet in force
            </div>
            <div className="text-[12.5px] text-ink-2 leading-relaxed">
              This document is a working draft under legal review. It does not
              yet bind Clarion or its customers; the version in force will be
              announced with its effective date.
            </div>
          </div>
        )}

        <article>{renderBody(body)}</article>
      </div>
    </div>
  );
}
