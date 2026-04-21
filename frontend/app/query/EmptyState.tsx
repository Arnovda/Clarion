'use client';

/**
 * Pre-chat landing for /query — big serif headline + input + starter chips.
 * When arrived from a data product, shows product-specific KPI questions.
 */

import type { FormEvent } from 'react';

const STARTERS = [
  'Who are my top 5 customers by total order value?',
  'What was total revenue last month?',
  'Which products have the highest profit margin?',
  'How many orders did we process this quarter?',
  'What is the average order value per customer?',
  'Which invoices are still unpaid?',
];

interface EmptyStateProps {
  onStarter:      (q: string) => void;
  productContext?: { name: string; kpis: string[] } | null;
  input:          string;
  setInput:       (v: string) => void;
  onSubmit:       (e: FormEvent) => void;
  loading?:       boolean;
}

export default function EmptyState({
  onStarter,
  productContext,
  input,
  setInput,
  onSubmit,
  loading,
}: EmptyStateProps) {
  // Build suggested questions: product KPIs first, then generic starters (capped at 4 per spec)
  const kpiQuestions = (productContext?.kpis ?? []).slice(0, 4).map((kpi) => `What is the ${kpi}?`);
  const questions = (kpiQuestions.length > 0 ? kpiQuestions : STARTERS).slice(0, 4);

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-16 max-w-[680px] mx-auto w-full">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted font-medium mb-4">
        Ask
      </div>
      <h1 className="font-display font-medium text-[44px] leading-[1.05] tracking-[-0.03em] text-ink m-0 mb-3 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
        {productContext ? (
          <>Ask about <em>{productContext.name.toLowerCase()}.</em></>
        ) : (
          <><em>What do you want</em> to know?</>
        )}
      </h1>
      <p className="text-[15px] text-muted leading-[1.55] m-0 mb-10 max-w-[520px]">
        {productContext
          ? `Type a question about your ${productContext.name.toLowerCase()} data. No SQL needed.`
          : 'Type a question in plain language. Claude finds the answer in your connected data.'}
      </p>

      <form onSubmit={onSubmit} className="w-full">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit(e as unknown as FormEvent);
            }
          }}
          rows={2}
          disabled={loading}
          placeholder={productContext
            ? 'e.g. What drove revenue growth last quarter?'
            : 'e.g. Who were our top 5 customers last month?'}
          className="w-full font-display italic text-[20px] leading-[1.45] text-ink px-5 py-4 rounded-md border border-line bg-raised outline-none transition-all duration-1 ease-observatory resize-none placeholder:text-muted-2 focus:border-ocean focus:shadow-[0_0_0_3px_var(--ocean-soft)] disabled:opacity-50"
        />
        <div className="mt-3 flex items-center justify-between gap-3 text-left">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2">
            ⌘ + Enter to send
          </span>
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center gap-2 font-sans font-medium text-[13.5px] leading-none px-[18px] py-[10px] rounded-sm border bg-ocean text-white border-ocean hover:bg-ocean-hover hover:border-ocean-hover transition-all duration-1 ease-observatory disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)]"
          >
            {loading ? 'Thinking…' : 'Ask →'}
          </button>
        </div>
      </form>

      <div className="mt-10 w-full">
        <div className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-2 font-medium mb-3 text-left">
          Try one of these
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {questions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onStarter(q)}
              className="text-left px-4 py-3 rounded-sm border border-line bg-raised text-[13.5px] text-ink-2 hover:border-line-strong hover:bg-softer hover:text-ink transition-colors duration-1 ease-observatory"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
