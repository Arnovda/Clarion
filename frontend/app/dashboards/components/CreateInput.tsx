'use client';

/**
 * Text input + Go button for describing a new dashboard in plain language.
 * Used in the empty-state hero and the compact sidebar.
 */

import type { RefObject } from 'react';

interface CreateInputProps {
  value:     string;
  onChange:  (v: string) => void;
  onSubmit:  () => void;
  loading:   boolean;
  compact?:  boolean;
  inputRef?: RefObject<HTMLInputElement>;
}

export function CreateInput({
  value, onChange, onSubmit, loading, compact, inputRef,
}: CreateInputProps) {
  return (
    <div className={`flex gap-2 ${compact ? 'w-full' : 'w-full max-w-lg'}`}>
      <input
        ref={compact ? undefined : inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        placeholder={compact ? 'Describe a dashboard…' : 'e.g. Sales overview by product and region'}
        className={`flex-1 min-w-0 px-3 py-2 text-[13px] rounded-md border transition-colors
          bg-raised border-line text-ink-2 placeholder-muted-2
          focus:outline-none focus:border-ocean focus:ring-1 focus:ring-ocean/30
          disabled:opacity-50`}
        disabled={loading}
      />
      <button
        onClick={onSubmit}
        disabled={loading || !value.trim()}
        className={`${compact ? 'px-3' : 'px-4'} py-2 text-[13px] font-medium rounded-md bg-ocean text-white hover:bg-ocean-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0`}
      >
        {loading ? '…' : 'Go'}
      </button>
    </div>
  );
}
