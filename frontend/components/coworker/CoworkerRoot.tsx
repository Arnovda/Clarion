'use client';

/**
 * Mounts the Studio coworker once, in the root layout, for the life of the tab.
 *
 * Renders nothing — not even a request — outside Studio or when signed out,
 * and nothing when the `ai_coworker` flag is off for the tenant (the provider
 * asks /api/coworker/status). While the panel is open it publishes its width
 * as `--coworker-w`; both shells pad their content by it, so the panel sits
 * NEXT to the page instead of over it.
 */
import { useEffect, type ReactNode } from 'react';
import { CoworkerProvider, useCoworker } from '@/lib/coworker/CoworkerProvider';
import CoworkerDock, { COWORKER_WIDTH } from './CoworkerDock';

function DockSpace() {
  const cw = useCoworker();
  const docked = !!cw && cw.enabled === true && cw.open;
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--coworker-w', docked ? `${COWORKER_WIDTH}px` : '0px');
    return () => { root.style.setProperty('--coworker-w', '0px'); };
  }, [docked]);
  return null;
}

export default function CoworkerRoot({ children }: { children: ReactNode }) {
  return (
    <CoworkerProvider>
      {children}
      <DockSpace />
      <CoworkerDock />
    </CoworkerProvider>
  );
}
