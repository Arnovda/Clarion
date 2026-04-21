'use client';

/**
 * Empty-state landing for /dashboards — Observatory hero with the create input
 * and three suggested-prompt chips.
 */

import type { RefObject } from 'react';
import { CreateInput } from './CreateInput';

interface EmptyDashboardHeroProps {
  createInput:  string;
  setCreateInput: (v: string) => void;
  onInitiate:   () => void;
  onChooseDirect: () => void;
  loading:      boolean;
  error:        string;
  inputRef?:    RefObject<HTMLInputElement>;
}

const SUGGESTIONS = ['Sales overview', 'Customer analysis', 'Product performance'];

export function EmptyDashboardHero({
  createInput,
  setCreateInput,
  onInitiate,
  onChooseDirect,
  loading,
  error,
  inputRef,
}: EmptyDashboardHeroProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex flex-col items-center text-center px-4 py-20 max-w-[680px] mx-auto w-full">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted font-medium mb-4">
          Dashboards
        </div>
        <h1 className="font-display font-medium text-[44px] leading-[1.05] tracking-[-0.03em] text-ink m-0 mb-3 [&_em]:italic [&_em]:font-normal [&_em]:text-ink-2">
          <em>Build your first</em> dashboard.
        </h1>
        <p className="text-[15px] text-ink-3 mb-8 leading-relaxed">
          Describe what you want to see and let AI design it for you.
        </p>
        <div className="w-full max-w-lg">
          <CreateInput
            value={createInput}
            onChange={setCreateInput}
            onSubmit={onInitiate}
            loading={loading}
            inputRef={inputRef}
          />
        </div>
        {error && <p className="text-[12px] text-err mt-3">{error}</p>}
        <div className="mt-10 w-full">
          <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-3">Try one of these</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {SUGGESTIONS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => { setCreateInput(prompt); onChooseDirect(); }}
                className="px-4 py-3 text-[13px] text-left text-ink-2 bg-raised border border-line rounded-md hover:border-line-strong hover:bg-softer transition-colors"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
