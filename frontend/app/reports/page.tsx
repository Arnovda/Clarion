'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Reports have been consolidated into the Dashboards page.
 * Dashboards support KPI cards, charts, executive summaries, and PDF export —
 * covering everything the old report builder did.
 * This page redirects for anyone who has it bookmarked.
 */
export default function ReportsPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/dashboards'); }, [router]);
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-400 text-sm">
      Redirecting to Dashboards...
    </div>
  );
}
