'use client';

/**
 * Role helpers — role-aware UI gating for the catalog surfaces.
 *
 * The detail panels (TableDetailPanel, ProductTableDetailPanel,
 * ProductRootPanel, SourceRootPanel) all show admin/analyst affordances
 * inline today. Viewers got the same UI but the underlying API would
 * 403 their saves — bad UX.
 *
 * Use `useRole()` to read the current role inside any component, and
 * the predicates below to gate features:
 *
 *   const role = useRole();
 *   {canCurate(role) && <button>Edit</button>}
 *   {!isViewer(role) && <Tab>SQL</Tab>}
 *
 * The role is read from the JWT once on mount. There's no real-time
 * subscription — if the user's role changes mid-session (rare), they
 * need to re-login. That's consistent with how the rest of the app
 * uses getTokenPayload().
 */

import { useEffect, useState } from 'react';
import { getTokenPayload } from './auth';

export type Role = 'admin' | 'analyst' | 'viewer';

/** Read the current role from the JWT. Falls back to 'viewer' if missing
 *  — safer default than 'admin' if the token shape ever drifts. */
export function getRole(): Role {
  const r = getTokenPayload()?.role;
  if (r === 'admin' || r === 'analyst' || r === 'viewer') return r;
  return 'viewer';
}

/** Hook variant — reactive on mount. Useful inside `'use client'` components. */
export function useRole(): Role {
  const [role, setRole] = useState<Role>('viewer');
  useEffect(() => { setRole(getRole()); }, []);
  return role;
}

/** Can this user curate / edit definitions? (admin + analyst) */
export function canCurate(role: Role): boolean {
  return role === 'admin' || role === 'analyst';
}

/** Admin-only? (Delete, role management, irreversible actions) */
export function isAdminRole(role: Role): boolean {
  return role === 'admin';
}

/** Pure viewer — for the few places we want to render *less*, not gate
 *  individual items (e.g. hide a whole tab). Equivalent to !canCurate(). */
export function isViewer(role: Role): boolean {
  return role === 'viewer';
}
