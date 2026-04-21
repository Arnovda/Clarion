'use client';

/**
 * Global toast system.
 *
 * Low-level primitive (<Toast />) + global dispatch (<Toaster />, useToast()).
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success('Dashboard saved');
 *   toast.error('Could not save', { description: msg });
 *
 * Drop <Toaster /> once in the root layout.
 */

import { ReactNode, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

// ─── Low-level primitive (kept for existing callers) ─────────────────────────

export type ToastVariant = 'success' | 'error' | 'info' | 'warn';

export interface ToastProps {
  variant?: ToastVariant;
  title: ReactNode;
  body?: ReactNode;
  onClose?: () => void;
  className?: string;
}

const accentClasses: Record<ToastVariant, string> = {
  success: 'border-l-2 border-l-ok',
  error:   'border-l-2 border-l-err',
  warn:    'border-l-2 border-l-warn',
  info:    'border-l-2 border-l-ocean',
};

export function Toast({ variant = 'info', title, body, onClose, className }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'bg-raised border border-line rounded-md shadow-3',
        'px-4 py-3 flex gap-3 items-start min-w-[320px] max-w-[440px]',
        accentClasses[variant],
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="font-sans font-medium text-[13.5px] text-ink">{title}</div>
        {body && <div className="text-[12.5px] text-ink-3 mt-0.5">{body}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss"
          className="shrink-0 text-muted-2 hover:text-ink transition-colors duration-1 focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--ocean-soft)] rounded-xs -mr-1 px-1"
        >
          <X width={14} height={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export interface ToastViewportProps {
  children: ReactNode;
}

export function ToastViewport({ children }: ToastViewportProps) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <div className="pointer-events-auto flex flex-col gap-2">{children}</div>
    </div>
  );
}

// ─── Global dispatch store ───────────────────────────────────────────────────

interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  /** Auto-dismiss after ms. 0 = sticky. Default 4500. */
  duration?: number;
}

interface ToastOptions {
  description?: string;
  duration?: number;
}

interface ToastApi {
  show: (variant: ToastVariant, title: string, opts?: ToastOptions) => void;
  success: (title: string, opts?: ToastOptions) => void;
  error:   (title: string, opts?: ToastOptions) => void;
  warn:    (title: string, opts?: ToastOptions) => void;
  info:    (title: string, opts?: ToastOptions) => void;
}

const listeners = new Set<(items: ToastItem[]) => void>();
let queue: ToastItem[] = [];

function push(item: ToastItem) {
  queue = [...queue, item];
  listeners.forEach((l) => l(queue));
}

function dismiss(id: string) {
  queue = queue.filter((i) => i.id !== id);
  listeners.forEach((l) => l(queue));
}

/**
 * Hook for any component to dispatch toasts.
 * Works without a provider — reads/writes the module-level queue directly.
 */
export function useToast(): ToastApi {
  return useMemo(() => {
    const show: ToastApi['show'] = (variant, title, opts) => {
      const id = Math.random().toString(36).slice(2);
      const item: ToastItem = { id, variant, title, duration: 4500, ...opts };
      push(item);
      if (item.duration && item.duration > 0) {
        setTimeout(() => dismiss(id), item.duration);
      }
    };
    return {
      show,
      success: (t, o) => show('success', t, o),
      error:   (t, o) => show('error',   t, o),
      warn:    (t, o) => show('warn',    t, o),
      info:    (t, o) => show('info',    t, o),
    };
  }, []);
}

/**
 * Mount once in the root layout. Renders the active toast queue.
 */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    listeners.add(setItems);
    setItems(queue);
    return () => { listeners.delete(setItems); };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[420px]"
    >
      {items.map((t) => (
        <div key={t.id} className="pointer-events-auto animate-[slideUp_0.22s_ease-out]">
          <Toast
            variant={t.variant}
            title={t.title}
            body={t.description}
            onClose={() => dismiss(t.id)}
          />
        </div>
      ))}
    </div>
  );
}
