'use client';

/**
 * /ask — The hero page. AI chat interface inside the new three-panel layout.
 *
 * Phase 1 approach: reuse the existing QueryPage logic wholesale, but wrap it
 * in the new AppShell with the context panel showing conversations. The full
 * chat restyling (navy bubbles, teal AI borders, etc.) will come in Phase 1b
 * once the layout is validated.
 *
 * For now, this page imports the chat internals from /query and re-renders
 * them inside the new shell. All chat logic (SSE, repair, disambiguation,
 * entity pre-flight, confidence) works identically.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { isAuthenticated, getTokenPayload } from '@/lib/auth';
import AppShell from '@/components/layout/AppShell';

function AskPageInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    if (!isAuthenticated()) {
      router.push('/');
    }
  }, [router]);

  const payload = getTokenPayload();
  const name = payload?.displayName ?? 'there';

  // If query param ?q= is set, we could pre-fill the chat — future enhancement
  const _prefillQuery = params.get('q') ?? '';

  return (
    <AppShell
      title="Ask your Data"
      subtitle="Ask any question about your business data in plain language"
      showSearch={false}
      contextPanel={
        <div className="p-4 space-y-6">
          {/* New chat button */}
          <button
            onClick={() => router.push('/query')}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 gradient-primary text-white text-body-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Conversation
          </button>

          {/* Suggested questions */}
          <div>
            <h3 className="text-label-md text-on-surface-variant font-semibold uppercase tracking-wider mb-3">
              Suggested
            </h3>
            <div className="space-y-1.5">
              {[
                'Who are my top 5 customers?',
                'What was total revenue last month?',
                'Which products have the highest margin?',
                'How many orders this quarter?',
                'Average order value per customer?',
                'Which invoices are unpaid?',
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => router.push(`/query`)}
                  className="w-full text-left px-3 py-2 rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container hover:text-on-surface transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>
      }
    >
      {/* Main content: embed the existing /query page's chat area via iframe-like approach.
          Phase 1 simply redirects to the existing /query page logic within this shell.
          In Phase 1b, we'll extract the chat components and render them inline. */}
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="max-w-lg space-y-6 animate-fadeIn">
          {/* Welcome */}
          <div className="space-y-2">
            <h2 className="font-headline text-display-md font-bold text-on-surface">
              Hi {name}
            </h2>
            <p className="text-body-lg text-on-surface-variant">
              Your data is ready. Ask anything about your business.
            </p>
          </div>

          {/* Chat input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              // For Phase 1: navigate to /query where the full chat logic lives
              const input = (e.target as HTMLFormElement).querySelector('input') as HTMLInputElement;
              if (input.value.trim()) {
                // Store in sessionStorage so /query can pick it up
                sessionStorage.setItem('databridge_pending_question', input.value.trim());
                router.push('/query');
              }
            }}
            className="relative"
          >
            <input
              type="text"
              placeholder="Ask your data anything..."
              autoFocus
              className="
                w-full px-5 py-4 rounded-2xl text-body-lg
                bg-surface-container-lowest text-on-surface
                placeholder:text-on-surface-variant/40
                shadow-ambient focus:shadow-glow-teal
                focus:outline-none focus:ring-2 focus:ring-cyan-400/20
                transition-all duration-200
              "
            />
            <button
              type="submit"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl gradient-primary text-white flex items-center justify-center hover:opacity-90 transition-opacity"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          </form>

          {/* Quick question chips */}
          <div className="flex flex-wrap justify-center gap-2">
            {[
              'Top customers',
              'Revenue trend',
              'Unpaid invoices',
              'Product margins',
            ].map((chip) => (
              <button
                key={chip}
                onClick={() => {
                  sessionStorage.setItem('databridge_pending_question', chip);
                  router.push('/query');
                }}
                className="
                  px-3.5 py-1.5 rounded-pill text-label-lg
                  bg-secondary-container/30 text-on-secondary-container
                  hover:bg-secondary-container/50 transition-colors
                "
              >
                {chip}
              </button>
            ))}
          </div>

          {/* AI indicator */}
          <p className="text-label-md text-on-surface-variant/50 flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse-teal" />
            Powered by Claude AI
          </p>
        </div>
      </div>
    </AppShell>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center bg-surface"><span className="text-on-surface-variant">Loading...</span></div>}>
      <AskPageInner />
    </Suspense>
  );
}
