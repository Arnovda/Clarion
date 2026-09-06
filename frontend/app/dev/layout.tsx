/**
 * /dev/* is the internal playground (widget gallery, UI tokens). It shipped
 * to production unauthenticated (assessment 9-5); a production build now
 * answers 404 for it. The widget-render-gate CI job runs a production
 * build against /dev/widgets on purpose and sets CLARION_DEV_PAGES=1 for
 * both its build and its server — the only place that variable belongs.
 */
import { notFound } from 'next/navigation';

export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production' && process.env.CLARION_DEV_PAGES !== '1') notFound();
  return <>{children}</>;
}
