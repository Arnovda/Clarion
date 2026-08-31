'use client';

import IconRail from './IconRail';
import TopBar from './TopBar';
import { FeaturesProvider } from '@/lib/features';

/**
 * ShellLayout — full app chrome (top bar + left rail) around page content.
 * Used as a Next.js route-group layout for pages that can't use AppShell directly.
 *
 * IT MUST PROVIDE THE FLAGS, and for a while it did not. AppShell owns a
 * `FeaturesProvider`; this second copy of the chrome did not, so on the twelve
 * routes that use it — Home, Dashboards, Catalog, Build, Subjects and the rest
 * — the rail's `useIsOperator()` and the top bar's preview marker read the
 * context default instead of the answer. Nobody saw an error: an operator
 * simply had no operator entry in the nav on most of the app. Two components
 * rendering the same chrome must provide the same context, or the chrome means
 * different things depending on which door you came through.
 */
export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <FeaturesProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-bg">
        <TopBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <IconRail />
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">{children}</div>
        </div>
      </div>
    </FeaturesProvider>
  );
}
