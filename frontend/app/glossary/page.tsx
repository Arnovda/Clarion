'use client';

import AppShell from '@/components/layout/AppShell';
import GlossaryPanel from '@/components/semantic/GlossaryPanel';
import { getTokenPayload } from '@/lib/auth';

export default function GlossaryPage() {
  const role = typeof window !== 'undefined' ? getTokenPayload()?.role : 'viewer';
  const canEdit = role === 'admin' || role === 'analyst';

  return (
    <AppShell>
      <div className="bg-raised border-b border-line px-6 py-4 flex-shrink-0">
        <p className="text-[10px] font-mono tracking-[0.14em] uppercase text-muted mb-0.5">Discover</p>
        <h1 className="font-display text-[22px] text-ink leading-tight tracking-[-0.02em]">Glossary</h1>
        <p className="text-[12px] text-muted mt-1 leading-relaxed">
          Organization-wide terms and abbreviations the AI uses as context across queries, dashboards, and definitions.
        </p>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <GlossaryPanel canEdit={canEdit} />
      </div>
    </AppShell>
  );
}
