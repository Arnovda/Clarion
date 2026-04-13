'use client';

/**
 * PageWrapper — wraps legacy pages in the icon rail layout.
 * Uses a plain div wrapper to avoid SWC JSX parser issues with
 * component names after nested function components.
 */

import IconRail from './IconRail';

export function IconRailSidebar() {
  return <IconRail />;
}
