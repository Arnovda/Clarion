'use client';

/**
 * <KeyboardShortcuts> — global "?" overlay listing the keyboard shortcuts
 * available across the relationship views. Mounted by SourceRootPanel so
 * the overlay is reachable from any tab.
 *
 * Shortcuts intentionally don't trigger when an input/textarea is focused.
 */

import { useEffect, useState } from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutGroup {
  label: string;
  items: Array<{ keys: string[]; description: string }>;
}

const GROUPS: ShortcutGroup[] = [
  {
    label: 'Anywhere',
    items: [
      { keys: ['?'],         description: 'Show / hide this overlay' },
      { keys: ['/'],         description: 'Focus the search box' },
      { keys: ['Esc'],       description: 'Close any open dialog or overlay' },
    ],
  },
  {
    label: 'Review queue',
    items: [
      { keys: ['Y', 'Enter'], description: 'Confirm the current AI draft' },
      { keys: ['N'],          description: 'Reject the current AI draft' },
      { keys: ['E'],          description: 'Edit the current AI draft' },
      { keys: ['→'],          description: 'Next draft' },
      { keys: ['←'],          description: 'Previous draft' },
    ],
  },
  {
    label: 'Diagram',
    items: [
      { keys: ['C'],          description: 'Toggle compact mode (relationship columns only)' },
    ],
  },
];

export default function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    }

    function onKey(e: KeyboardEvent) {
      // "?" is shift+/ on most layouts — guard against modifier-only collisions.
      if (e.key === '?' && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
        return;
      }
      // "/" focuses the first search input on the page (top-bar search).
      if (e.key === '/' && !isTypingTarget(e.target)) {
        const search = document.querySelector<HTMLInputElement>('input[type="text"][placeholder*="Search"]');
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Floating help button — small, low-profile, bottom-right */}
      <button
        onClick={() => setOpen(true)}
        title="Keyboard shortcuts (?)"
        aria-label="Show keyboard shortcuts"
        className="fixed bottom-4 right-4 z-30 inline-flex items-center justify-center w-9 h-9 rounded-full bg-raised border border-line text-muted-2 hover:text-ink hover:border-line-strong shadow-sm transition"
      >
        <Keyboard className="w-4 h-4" strokeWidth={1.8} />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[520px] max-w-[calc(100vw-32px)] bg-raised border border-line rounded-xl shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h3 className="font-display text-[18px] tracking-[-0.01em] text-ink">Keyboard shortcuts</h3>
              <button
                onClick={() => setOpen(false)}
                className="text-muted-2 hover:text-ink p-1 -mr-1"
                aria-label="Close"
              >
                <X className="w-4 h-4" strokeWidth={2} />
              </button>
            </div>
            <div className="p-5 space-y-5 max-h-[calc(100vh-200px)] overflow-y-auto">
              {GROUPS.map((group) => (
                <section key={group.label}>
                  <h4 className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted mb-2">
                    {group.label}
                  </h4>
                  <ul className="space-y-1.5">
                    {group.items.map((item) => (
                      <li key={item.description} className="flex items-center gap-3 text-[12.5px]">
                        <span className="flex items-center gap-1 flex-shrink-0">
                          {item.keys.map((k, i) => (
                            <kbd
                              key={i}
                              className="inline-flex items-center justify-center min-w-[24px] px-1.5 py-0.5 text-[10px] font-mono bg-softer border border-line rounded text-ink"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                        <span className="text-ink-2">{item.description}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-line bg-softer/40 text-[11px] text-muted">
              Tip: shortcuts only fire when you're not typing in an input.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
