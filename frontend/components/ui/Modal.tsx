'use client';

import { ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  closeOnOverlay?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  className,
  closeOnOverlay = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open || typeof window === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-ink/40 backdrop-blur-[2px] z-50"
      onMouseDown={(e) => {
        if (closeOnOverlay && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
        ref={dialogRef}
        className={cn(
          'bg-raised rounded-lg shadow-3 max-w-[480px] w-[calc(100%-32px)] mx-auto mt-[15vh]',
          'overflow-hidden',
          className
        )}
      >
        {(title || eyebrow) && (
          <div className="px-7 py-5 border-b border-softer">
            {eyebrow && (
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1">
                {eyebrow}
              </div>
            )}
            {title && (
              <div
                id="modal-title"
                className="font-display font-medium text-[22px] tracking-[-0.02em] text-ink leading-[1.2]"
              >
                {title}
              </div>
            )}
          </div>
        )}
        <div className="px-7 py-6 text-[14px] text-ink-2">{children}</div>
        {footer && (
          <div className="px-7 py-4 border-t border-softer flex gap-2 justify-end bg-surface rounded-b-lg">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
