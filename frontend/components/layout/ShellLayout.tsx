'use client';

import IconRail from './IconRail';

/**
 * ShellLayout — wraps page content with the IconRail sidebar.
 * Used as a Next.js layout for pages that can't use AppShell directly
 * (due to SWC limitations with large files containing nested JSX components).
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <IconRail />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
