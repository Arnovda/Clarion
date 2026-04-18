'use client';

import { useState, useRef, useEffect } from 'react';

interface HelpTooltipProps {
  text: string;
  /** Optional wider width for longer explanations */
  wide?: boolean;
  children?: React.ReactNode;
}

/**
 * Contextual help tooltip — hover the "?" icon to see an explanation.
 * Use next to labels, section headers, or concepts that need clarification.
 */
export default function HelpTooltip({ text, wide = false, children }: HelpTooltipProps) {
  const [show, setShow] = useState(false);
  const [above, setAbove] = useState(true);
  const triggerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (show && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setAbove(rect.top > 120);
    }
  }, [show]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children ?? (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-slate-200 text-slate-500 text-[10px] font-bold cursor-help hover:bg-blue-100 hover:text-blue-600 transition-colors">
          ?
        </span>
      )}
      {show && (
        <span
          className={`absolute z-50 ${above ? 'bottom-full mb-2' : 'top-full mt-2'} left-1/2 -translate-x-1/2 ${
            wide ? 'w-72' : 'w-56'
          } px-3 py-2 text-xs text-white bg-slate-800 rounded-lg shadow-lg leading-relaxed pointer-events-none`}
        >
          {text}
          <span
            className={`absolute left-1/2 -translate-x-1/2 ${
              above ? 'top-full -mt-[1px] border-t-slate-800 border-l-transparent border-r-transparent border-b-transparent' : 'bottom-full -mb-[1px] border-b-slate-800 border-l-transparent border-r-transparent border-t-transparent'
            } border-[5px]`}
          />
        </span>
      )}
    </span>
  );
}
