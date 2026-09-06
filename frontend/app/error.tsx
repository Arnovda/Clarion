'use client';

/**
 * Route error boundary (assessment 9-1): any render throw below the root
 * layout lands here instead of on the stock Next.js error page. Offers the
 * two things a person can do — try again, or go somewhere that works — and
 * shows the digest so a report to support can be matched to the server
 * log. Never the error message itself: a render error can carry SQL,
 * paths or a customer's data.
 */
import { useEffect } from 'react';
import Link from 'next/link';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[route error]', error);
  }, [error]);

  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-[480px] bg-raised border border-line rounded-lg shadow-2 px-8 py-10">
        <p className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted mb-3">Something went wrong</p>
        <h1 className="font-display font-medium text-[30px] leading-[1.15] tracking-[-0.02em] text-ink mb-3">
          This page could not be shown.
        </h1>
        <p className="text-[14px] text-muted leading-relaxed mb-8">
          Nothing you did caused this. Trying again usually works; if it keeps happening, tell us
          and quote the reference below.
        </p>
        <div className="flex flex-wrap gap-3 mb-6">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center px-4 py-2 rounded-md bg-ocean text-white text-[13px] font-medium hover:bg-ocean-hover transition-colors"
          >
            Try again
          </button>
          <Link href="/home" className="inline-flex items-center px-4 py-2 rounded-md border border-line bg-raised text-ink-2 text-[13px] font-medium hover:bg-softer transition-colors no-underline">
            Go to home
          </Link>
        </div>
        {error.digest && (
          <p className="font-mono text-[10.5px] text-muted-2">reference {error.digest}</p>
        )}
      </div>
    </main>
  );
}
