'use client';

import IconRail from './IconRail';
import TopBar from './TopBar';

/**
 * ShellLayout — full app chrome (top bar + left rail) around page content.
 * Used as a Next.js route-group layout for pages that can't use AppShell directly.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <TopBar />
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <IconRail />
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
