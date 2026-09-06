/**
 * 404 — the App Router's not-found boundary (assessment 9-1). Before this
 * file existed a mistyped URL showed the stock Next.js page with no way
 * back. Server component, no shell: the shell needs a session and this
 * page must render for a signed-out visitor too.
 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-[480px] bg-raised border border-line rounded-lg shadow-2 px-8 py-10">
        <p className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-muted mb-3">Not found</p>
        <h1 className="font-display font-medium text-[30px] leading-[1.15] tracking-[-0.02em] text-ink mb-3">
          There is nothing at this address.
        </h1>
        <p className="text-[14px] text-muted leading-relaxed mb-8">
          The link may be old, or the page may have moved. Everything you have access to is
          reachable from the home page.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/home" className="inline-flex items-center px-4 py-2 rounded-md bg-ocean text-white text-[13px] font-medium hover:bg-ocean-hover transition-colors no-underline">
            Go to home
          </Link>
          <Link href="/query" className="inline-flex items-center px-4 py-2 rounded-md border border-line bg-raised text-ink-2 text-[13px] font-medium hover:bg-softer transition-colors no-underline">
            Ask a question
          </Link>
        </div>
      </div>
    </main>
  );
}
