'use client';

import Link from 'next/link';

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}

/**
 * Reusable empty state with guidance — shown when a page or section has no data yet.
 */
export default function EmptyState({ icon, title, description, actionLabel, actionHref, onAction }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4">
      <div className="text-5xl mb-4">{icon}</div>
      <h3 className="text-title-md font-semibold text-on-surface mb-1">{title}</h3>
      <p className="text-body-sm text-on-surface-variant max-w-md mb-6 leading-relaxed">{description}</p>
      {actionLabel && actionHref && (
        <Link href={actionHref}
          className="inline-flex items-center gap-2 px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 transition-all shadow-glow-primary">
          {actionLabel}
        </Link>
      )}
      {actionLabel && onAction && !actionHref && (
        <button
          onClick={onAction}
          className="inline-flex items-center gap-2 px-5 py-2.5 gradient-primary text-on-primary rounded-xl text-title-md hover:opacity-90 transition-all shadow-glow-primary"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
